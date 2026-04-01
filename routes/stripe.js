'use strict';

const express = require('express');
const Stripe = require('stripe');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function getStripe() {
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

// POST /api/stripe/checkout — create Stripe Checkout Session
router.post('/checkout', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, stripe_customer_id, subscription_status FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  if (user.subscription_status === 'active') {
    return res.json({ url: '/dashboard' });
  }

  const stripe = getStripe();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  try {
    // Get or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${baseUrl}/onboarding?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?canceled=1`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      locale: 'sk',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby: ' + err.message });
  }
});

// POST /api/stripe/webhook — Stripe webhook (raw body required)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getDb();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.customer) {
        db.prepare(`
          UPDATE users SET subscription_status = 'active', subscription_id = ?
          WHERE stripe_customer_id = ?
        `).run(session.subscription, session.customer);
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : 'inactive';
      db.prepare(`UPDATE users SET subscription_status = ?, subscription_id = ? WHERE stripe_customer_id = ?`)
        .run(status, sub.id, sub.customer);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      db.prepare(`UPDATE users SET subscription_status = 'inactive' WHERE stripe_customer_id = ?`)
        .run(sub.customer);
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      db.prepare(`UPDATE users SET subscription_status = 'past_due' WHERE stripe_customer_id = ?`)
        .run(inv.customer);
      break;
    }
  }

  res.json({ received: true });
});

// POST /api/stripe/portal — customer billing portal
router.post('/portal', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.userId);
  if (!user?.stripe_customer_id) return res.status(400).json({ error: 'Žiadny zákazník.' });

  const stripe = getStripe();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${baseUrl}/dashboard`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stripe/status — subscription status for current user
router.get('/status', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT subscription_status, onboarding_done FROM users WHERE id = ?').get(req.userId);
  res.json({
    active: user?.subscription_status === 'active',
    status: user?.subscription_status || 'inactive',
    onboarding_done: Boolean(user?.onboarding_done),
  });
});

// POST /api/stripe/verify-session — verify checkout session after redirect
// (fallback if webhook is slow)
router.post('/verify-session', requireAuth, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId povinný.' });

  const stripe = getStripe();
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' || session.status === 'complete') {
      const db = getDb();
      db.prepare(`
        UPDATE users SET subscription_status = 'active', subscription_id = ?
        WHERE stripe_customer_id = ?
      `).run(session.subscription, session.customer);
      res.json({ active: true });
    } else {
      res.json({ active: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
