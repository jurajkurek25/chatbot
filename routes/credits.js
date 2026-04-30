'use strict';

const express = require('express');
const Stripe = require('stripe');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BASE_RESPONSES = 500;
const PACKAGES = [
  { id: 'p5',  amount_eur: 5,  credits: 100 },
  { id: 'p8r', amount_eur: 8,  credits: 200 }, // auto-refill pack
  { id: 'p15', amount_eur: 15, credits: 350 },
];
// White Label volume packages — 33 responses/€ (vs standard 20/€)
const WL_PACKAGES = [
  { id: 'wl_p50',  amount_eur: 50,  credits: 1000, note: 'Štandard' },
  { id: 'wl_p100', amount_eur: 100, credits: 3300, note: 'Volume zľava -40%' },
  { id: 'wl_p250', amount_eur: 250, credits: 8250, note: 'Volume zľava -40%' },
];

function getStripe() {
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

// Trigger auto-reload off-session charge for a user
// Called from chat.js when credits drop below threshold
async function triggerAutoReload(userId, user) {
  const db = getDb();
  const euros = user.auto_reload_amount_eur || 8;
  const credits = euros * 20;
  const now = Math.floor(Date.now() / 1000);

  // Atomic claim: only proceed if no other request triggered within last 600s
  const result = db.prepare(
    'UPDATE users SET auto_reload_last_at = ? WHERE id = ? AND (auto_reload_last_at IS NULL OR auto_reload_last_at < ?)'
  ).run(now, userId, now - 600);
  if (result.changes === 0) return; // Another concurrent call already claimed this reload

  const stripe = getStripe();
  try {
    const pi = await stripe.paymentIntents.create({
      amount: euros * 100,
      currency: 'eur',
      customer: user.stripe_customer_id,
      payment_method: user.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: { type: 'auto_reload', userId, credits: String(credits) },
      description: `Neoworkly auto-reload – ${credits} AI odpovedí`,
    });

    if (pi.status === 'succeeded') {
      // Payment completed synchronously — add credits immediately so user isn't left waiting
      // for the webhook. Webhook will skip if this note already exists (idempotency).
      const { v4: uuidv4 } = require('uuid');
      const already = db.prepare("SELECT id FROM credit_transactions WHERE note = ?").get(`auto_reload:${pi.id}`);
      if (!already) {
        db.prepare('UPDATE users SET extra_response_credits = extra_response_credits + ? WHERE id = ?').run(credits, userId);
        db.prepare('INSERT OR IGNORE INTO credit_transactions (id, user_id, type, amount, note) VALUES (?, ?, ?, ?, ?)')
          .run(uuidv4(), userId, 'auto_reload', credits, `auto_reload:${pi.id}`);
        console.log(`[auto_reload] +${credits} credits added immediately (sync) for user ${userId}`);
      }
    } else {
      console.log(`[auto_reload] PaymentIntent ${pi.id} status=${pi.status} — waiting for webhook`);
    }
  } catch (err) {
    console.error(`[auto_reload] Payment failed for user ${userId}:`, err.message);
    // Notify user so they can fix card manually
    try {
      const { sendAutoReloadFailedEmail } = require('../services/email');
      const userFull = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
      if (userFull) {
        sendAutoReloadFailedEmail({ toEmail: userFull.email, name: userFull.name, euros }).catch(() => {});
      }
    } catch { /* ignore */ }
  }
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
    'SELECT ai_responses_this_month, ai_responses_reset_at, extra_response_credits, subscription_plan FROM users WHERE id = ?'
  ).get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  const thisMonth = maybeResetUsage(db, req.userId, user);
  const extra = user.extra_response_credits || 0;

  // Reload reset_at after potential reset
  const freshUser = db.prepare('SELECT ai_responses_reset_at FROM users WHERE id = ?').get(req.userId);

  const baseUsed = Math.min(thisMonth, BASE_RESPONSES);
  const baseRemaining = Math.max(0, BASE_RESPONSES - thisMonth);
  const usagePct = Math.min(100, Math.round((thisMonth / BASE_RESPONSES) * 100));
  const isWL = user.subscription_plan === 'white_label';

  res.json({
    base_responses: BASE_RESPONSES,
    used_this_month: thisMonth,
    base_remaining: baseRemaining,
    extra_credits: extra,
    usage_pct: usagePct,
    reset_at: freshUser.ai_responses_reset_at,
    packages: PACKAGES,
    wl_packages: isWL ? WL_PACKAGES : null,
    is_white_label: isWL,
  });
});

// POST /api/credits/buy — create Stripe Checkout (one-time payment)
// Optional: save_card:true → saves payment method for auto-reload
router.post('/buy', requireAuth, async (req, res) => {
  const { package_id, custom_eur, save_card } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, stripe_customer_id, subscription_plan FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  const isWL = user.subscription_plan === 'white_label';
  let amountEur, creditsToAdd;

  // Check WL packages first
  const wlPkg = isWL ? WL_PACKAGES.find(p => p.id === package_id) : null;
  const pkg = PACKAGES.find(p => p.id === package_id);

  if (wlPkg) {
    amountEur = wlPkg.amount_eur;
    creditsToAdd = wlPkg.credits;
  } else if (pkg) {
    amountEur = pkg.amount_eur;
    creditsToAdd = pkg.credits;
  } else if (custom_eur && Number(custom_eur) >= 1) {
    amountEur = Math.floor(Number(custom_eur));
    // WL volume discount: ≥€100 → 33 cr/€, otherwise standard 20 cr/€
    const rate = (isWL && amountEur >= 100) ? 33 : 20;
    creditsToAdd = amountEur * rate;
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

    const sessionParams = {
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: amountEur * 100,
          product_data: {
            name: `Neoworkly – ${creditsToAdd} AI odpovedí${isWL && amountEur >= 100 ? ' (WL volume)' : ''}`,
            description: `Kredit pre AI chatbot`,
          },
        },
        quantity: 1,
      }],
      metadata: { type: 'credits', userId: user.id, credits: String(creditsToAdd), save_card: save_card ? '1' : '0' },
      success_url: `${baseUrl}/dashboard?credits_added=1`,
      cancel_url: `${baseUrl}/dashboard`,
      locale: 'sk',
    };

    // If save_card requested, tell Stripe to save the payment method for future off-session use
    if (save_card) {
      sessionParams.payment_intent_data = { setup_future_usage: 'off_session' };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Credits checkout error:', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby.' });
  }
});

// GET /api/credits/auto-reload — get current auto-reload settings + card status
router.get('/auto-reload', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare(
    'SELECT auto_reload_enabled, auto_reload_threshold, auto_reload_amount_eur, stripe_payment_method_id, auto_reload_card_last4, auto_reload_card_brand FROM users WHERE id = ?'
  ).get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  res.json({
    enabled:      !!user.auto_reload_enabled,
    threshold:    user.auto_reload_threshold ?? 50,
    amount_eur:   user.auto_reload_amount_eur ?? 8,
    has_card:     !!user.stripe_payment_method_id,
    card_last4:   user.auto_reload_card_last4 || null,
    card_brand:   user.auto_reload_card_brand || null,
  });
});

// POST /api/credits/setup-reload — save auto-reload settings
// If enabled and no card saved, returns setup_url to save card via Stripe Checkout
router.post('/setup-reload', requireAuth, async (req, res) => {
  const { enabled, threshold, amount_eur } = req.body;
  if (amount_eur !== undefined && (Number(amount_eur) < 1 || Number(amount_eur) > 500)) {
    return res.status(400).json({ error: 'Suma musí byť medzi 1 € a 500 €.' });
  }

  const db = getDb();
  const user = db.prepare(
    'SELECT id, email, name, stripe_customer_id, stripe_payment_method_id FROM users WHERE id = ?'
  ).get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  db.prepare(
    'UPDATE users SET auto_reload_enabled = ?, auto_reload_threshold = ?, auto_reload_amount_eur = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, Math.max(0, parseInt(threshold) || 50), Math.floor(Number(amount_eur) || 8), req.userId);

  // If enabling but no card → redirect to Stripe card setup
  if (enabled && !user.stripe_payment_method_id) {
    try {
      const stripe = getStripe();
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

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
        mode: 'setup',
        payment_method_types: ['card'],
        metadata: { type: 'setup_payment_method', userId: req.userId },
        success_url: `${baseUrl}/dashboard?payment_setup=1`,
        cancel_url: `${baseUrl}/dashboard`,
        locale: 'sk',
      });
      return res.json({ setup_url: session.url });
    } catch (err) {
      console.error('Setup payment error:', err.message);
      return res.status(500).json({ error: 'Chyba pri nastavovaní karty.' });
    }
  }

  res.json({ ok: true });
});

// POST /api/credits/setup-payment — create standalone Stripe setup session (save card without buying)
router.post('/setup-payment', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, stripe_customer_id FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

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
      mode: 'setup',
      payment_method_types: ['card'],
      metadata: { type: 'setup_payment_method', userId: req.userId },
      success_url: `${baseUrl}/dashboard?payment_setup=1`,
      cancel_url: `${baseUrl}/dashboard`,
      locale: 'sk',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Setup payment error:', err.message);
    res.status(500).json({ error: 'Chyba pri nastavovaní karty.' });
  }
});

// POST /api/credits/remove-card — remove saved payment method and disable auto-reload
router.post('/remove-card', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT stripe_payment_method_id FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  if (user.stripe_payment_method_id) {
    try {
      await getStripe().paymentMethods.detach(user.stripe_payment_method_id);
    } catch { /* ignore if already detached */ }
  }

  db.prepare(
    'UPDATE users SET stripe_payment_method_id = NULL, auto_reload_card_last4 = NULL, auto_reload_card_brand = NULL, auto_reload_enabled = 0 WHERE id = ?'
  ).run(req.userId);

  res.json({ ok: true });
});

// GET /api/credits/widget-usage — per-widget AI response count this month (WL only)
router.get('/widget-usage', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT subscription_plan FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });
  if (user.subscription_plan !== 'white_label') return res.status(403).json({ error: 'Len pre White Label plán.' });

  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  const usage = db.prepare(`
    SELECT w.id, w.name, w.bot_name, COUNT(m.id) as response_count
    FROM widgets w
    LEFT JOIN conversations c ON c.widget_id = w.id
    LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'assistant' AND m.created_at >= ?
    WHERE w.user_id = ?
    GROUP BY w.id, w.name, w.bot_name
    ORDER BY response_count DESC
  `).all(monthStart, req.userId);

  res.json({ usage, month_start: monthStart });
});

module.exports = { router, BASE_RESPONSES, nextMonthReset, maybeResetUsage, triggerAutoReload };
