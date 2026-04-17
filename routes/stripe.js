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
  const user = db.prepare('SELECT id, email, name, stripe_customer_id, subscription_status, referred_by FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  if (user.subscription_status === 'active') {
    return res.json({ url: '/dashboard' });
  }

  const stripe = getStripe();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  const { plan } = req.body; // 'pro' (default) or 'white_label'
  const isWhiteLabel = plan === 'white_label' && process.env.STRIPE_PRICE_ID_WHITE_LABEL;

  // White label plan takes precedence; otherwise use discounted price for referrals
  const priceId = isWhiteLabel
    ? process.env.STRIPE_PRICE_ID_WHITE_LABEL
    : (user.referred_by && process.env.STRIPE_PRICE_ID_DISCOUNTED
        ? process.env.STRIPE_PRICE_ID_DISCOUNTED
        : process.env.STRIPE_PRICE_ID);

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
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${baseUrl}/onboarding?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?canceled=1`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      locale: 'sk',
      metadata: { plan: isWhiteLabel ? 'white_label' : 'pro' },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby: ' + err.message });
  }
});

// POST /api/stripe/checkout-boost — Growth Boost one-time payment
router.post('/checkout-boost', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, stripe_customer_id, growth_boost_paid FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });
  if (user.growth_boost_paid) return res.json({ url: '/dashboard?tab=seo' });

  const priceId = process.env.STRIPE_PRICE_ID_GROWTH_BOOST;
  if (!priceId) return res.status(500).json({ error: 'Growth Boost price nie je nakonfigurovaná.' });

  const stripe = getStripe();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  try {
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${baseUrl}/onboarding?success_boost=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/onboarding?step=5`,
      locale: 'sk',
      metadata: { type: 'growth_boost', userId: user.id },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Growth Boost checkout error:', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby: ' + err.message });
  }
});

// POST /api/stripe/webhook — Stripe webhook (raw body parsed in server.js)
router.post('/webhook', async (req, res) => {
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
  const stripe = getStripe();

  // Helper: find user by stripe_customer_id, with email fallback
  // If found via email, also saves the customer_id for future lookups
  async function resolveUser(customerId) {
    let user = db.prepare('SELECT id, referred_by FROM users WHERE stripe_customer_id = ?').get(customerId);
    if (user) return user;

    // Fallback: look up customer email from Stripe → match by email in our DB
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer.deleted && customer.email) {
        const email = customer.email.toLowerCase();
        user = db.prepare('SELECT id, referred_by FROM users WHERE LOWER(email) = ?').get(email);
        if (user) {
          db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
          console.log(`[stripe] Linked customer ${customerId} to user ${user.id} via email ${customer.email}`);
        }
      }
    } catch (err) {
      console.error('[stripe] Could not retrieve customer for email fallback:', err.message);
    }
    return user || null;
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;

      // Growth Boost one-time payment
      if (session.mode === 'payment' && session.metadata?.type === 'growth_boost') {
        const userId = session.metadata.userId;
        if (userId) {
          db.prepare('UPDATE users SET growth_boost_paid = 1 WHERE id = ?').run(userId);
          console.log(`[growth_boost] Unlocked for user ${userId}`);
        }
        break;
      }

      // Credit top-up (one-time payment)
      if (session.mode === 'payment' && session.metadata?.type === 'credits') {
        const credits = parseInt(session.metadata.credits || '0', 10);
        const userId = session.metadata.userId;
        if (credits > 0 && userId) {
          db.prepare('UPDATE users SET extra_response_credits = extra_response_credits + ? WHERE id = ?').run(credits, userId);
          console.log(`[credits] +${credits} credits added to user ${userId}`);
        }
        break;
      }

      if (session.mode === 'subscription' && session.customer) {
        const user = await resolveUser(session.customer);

        if (user) {
          const plan = session.metadata?.plan || 'pro';
          db.prepare(`UPDATE users SET subscription_status = 'active', subscription_id = ?, subscription_plan = ? WHERE id = ?`)
            .run(session.subscription, plan, user.id);
          db.prepare('UPDATE widgets SET active = 1 WHERE user_id = ?').run(user.id);
          console.log(`[stripe] Subscription activated for user ${user.id}`);

          // Award 15€ credit to referrer (only on first activation)
          if (user.referred_by) {
            const already = db.prepare('SELECT referral_credits FROM users WHERE id = ?').get(user.id);
            if (!already?.referral_credits) {
              db.prepare('UPDATE users SET referral_credits = referral_credits + 15 WHERE id = ?').run(user.referred_by);
              console.log(`[affiliate] +15€ credit awarded to referrer ${user.referred_by}`);
            }
          }
        } else {
          console.log(`[stripe] checkout.session.completed: no user found for customer ${session.customer} — will sync on next login`);
        }
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const isActive = sub.status === 'active' || sub.status === 'trialing';
      const status = isActive ? 'active' : 'inactive';
      const subPriceId = sub.items?.data?.[0]?.price?.id;
      const plan = subPriceId === process.env.STRIPE_PRICE_ID_WHITE_LABEL ? 'white_label' : 'pro';

      const user = await resolveUser(sub.customer);
      if (user) {
        db.prepare('UPDATE users SET subscription_status = ?, subscription_id = ?, subscription_plan = ? WHERE id = ?')
          .run(status, sub.id, plan, user.id);
        db.prepare('UPDATE widgets SET active = ? WHERE user_id = ?').run(isActive ? 1 : 0, user.id);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const user = await resolveUser(sub.customer);
      if (user) {
        db.prepare('UPDATE users SET subscription_status = ? WHERE id = ?').run('inactive', user.id);
        db.prepare('UPDATE widgets SET active = 0 WHERE user_id = ?').run(user.id);
      }
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const user = await resolveUser(inv.customer);
      if (user) {
        db.prepare('UPDATE users SET subscription_status = ? WHERE id = ?').run('past_due', user.id);
        db.prepare('UPDATE widgets SET active = 0 WHERE user_id = ?').run(user.id);
      }
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
// If user has no stripe_customer_id yet, searches Stripe by email to auto-link
router.get('/status', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT email, subscription_status, subscription_plan, stripe_customer_id, onboarding_done, free_until FROM users WHERE id = ?').get(req.userId);
  const now = Math.floor(Date.now() / 1000);
  const inFreePeriod = user?.free_until && user.free_until > now;

  // If not yet active and no customer_id, try to find & sync from Stripe by email
  if (user && user.subscription_status !== 'active' && !inFreePeriod && !user.stripe_customer_id) {
    try {
      const stripe = getStripe();
      const customers = await stripe.customers.list({ email: user.email.toLowerCase(), limit: 5 });
      for (const customer of customers.data) {
        const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
        if (subs.data.length > 0) {
          const sub = subs.data[0];
          db.prepare('UPDATE users SET stripe_customer_id = ?, subscription_status = ?, subscription_id = ? WHERE id = ?')
            .run(customer.id, 'active', sub.id, req.userId);
          db.prepare('UPDATE widgets SET active = 1 WHERE user_id = ?').run(req.userId);
          console.log(`[stripe] Auto-linked customer ${customer.id} to user ${req.userId} via email on status check`);
          return res.json({ active: true, status: 'active', onboarding_done: Boolean(user.onboarding_done), free_until: null, in_free_period: false });
        }
      }
    } catch (err) {
      console.error('[stripe] Email sync on status check failed:', err.message);
      // Fall through to return current DB status
    }
  }

  res.json({
    active: user?.subscription_status === 'active' || !!inFreePeriod,
    status: user?.subscription_status || 'inactive',
    plan: user?.subscription_plan || 'pro',
    onboarding_done: Boolean(user?.onboarding_done),
    free_until: user?.free_until || null,
    in_free_period: !!inFreePeriod,
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
