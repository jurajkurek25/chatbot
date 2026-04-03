'use strict';

const express = require('express');
const Stripe = require('stripe');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BASE_RESPONSES = 1500;
const PACKAGES = [
  { id: 'p5',  amount_eur: 5,  credits: 500  },
  { id: 'p10', amount_eur: 10, credits: 1200 },
];

function getStripe() {
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

function nextMonthReset() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
  return Math.floor(next.getTime() / 1000);
}

function maybeResetUsage(db, userId, user) {
  const now = Math.floor(Date.now() / 1000);
  if (!user.ai_responses_reset_at || now >= user.ai_responses_reset_at) {
    db.prepare(`
      UPDATE users SET
        ai_responses_this_month = 0,
        ai_responses_reset_at = ?,
        usage_notified_80 = 0,
        usage_notified_100 = 0
      WHERE id = ?
    `).run(nextMonthReset(), userId);
    return 0;
  }
  return user.ai_responses_this_month || 0;
}

// GET /api/credits/status
router.get('/status', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare(
    'SELECT ai_responses_this_month, ai_responses_reset_at, extra_response_credits FROM users WHERE id = ?'
  ).get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  const thisMonth = maybeResetUsage(db, req.userId, user);
  const extra = user.extra_response_credits || 0;

  // Reload reset_at after potential reset
  const freshUser = db.prepare('SELECT ai_responses_reset_at FROM users WHERE id = ?').get(req.userId);

  const baseUsed = Math.min(thisMonth, BASE_RESPONSES);
  const baseRemaining = Math.max(0, BASE_RESPONSES - thisMonth);
  const usagePct = Math.min(100, Math.round((thisMonth / BASE_RESPONSES) * 100));

  res.json({
    base_responses: BASE_RESPONSES,
    used_this_month: thisMonth,
    base_remaining: baseRemaining,
    extra_credits: extra,
    usage_pct: usagePct,
    reset_at: freshUser.ai_responses_reset_at,
    packages: PACKAGES,
  });
});

// POST /api/credits/buy — create Stripe Checkout (one-time payment)
router.post('/buy', requireAuth, async (req, res) => {
  const { package_id, custom_eur } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, stripe_customer_id FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  let amountEur, creditsToAdd;

  const pkg = PACKAGES.find(p => p.id === package_id);
  if (pkg) {
    amountEur = pkg.amount_eur;
    creditsToAdd = pkg.credits;
  } else if (custom_eur && Number(custom_eur) >= 1) {
    amountEur = Math.floor(Number(custom_eur));
    creditsToAdd = amountEur * 100;
  } else {
    return res.status(400).json({ error: 'Neplatný balík alebo suma (min. 1 €).' });
  }

  const stripe = getStripe();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  try {
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, name: user.name, metadata: { userId: user.id },
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: amountEur * 100,
          product_data: {
            name: `NeuraDeskApp – ${creditsToAdd} AI odpovedí`,
            description: `Kredit pre AI chatbot`,
          },
        },
        quantity: 1,
      }],
      metadata: { type: 'credits', userId: user.id, credits: String(creditsToAdd) },
      success_url: `${baseUrl}/dashboard?credits_added=1`,
      cancel_url: `${baseUrl}/dashboard`,
      locale: 'sk',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Credits checkout error:', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby.' });
  }
});

module.exports = { router, BASE_RESPONSES, nextMonthReset, maybeResetUsage };
