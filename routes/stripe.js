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

    const from = req.body?.from === 'dashboard' ? 'dashboard' : 'onboarding';
    const successUrl = from === 'dashboard'
      ? `${baseUrl}/dashboard?tab=seo&success_boost=1&session_id={CHECKOUT_SESSION_ID}`
      : `${baseUrl}/onboarding?success_boost=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = from === 'dashboard'
      ? `${baseUrl}/dashboard?tab=seo`
      : `${baseUrl}/onboarding?step=5`;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
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

      // Gift card purchase — generate code and store in DB
      if (session.mode === 'payment' && session.metadata?.type === 'gift_card') {
        const { generateCode } = require('./gift-cards');
        const amountEur = parseFloat(session.metadata.amount_eur || '0');
        if (amountEur > 0) {
          const { v4: uuidv4 } = require('uuid');
          let code;
          let attempts = 0;
          do { code = generateCode(); attempts++; } while (
            db.prepare('SELECT id FROM gift_cards WHERE code = ?').get(code) && attempts < 10
          );
          db.prepare(`INSERT INTO gift_cards (id, code, amount_eur, buyer_email, buyer_name, recipient_email, message, stripe_session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(uuidv4(), code, amountEur,
              session.metadata.buyer_email || session.customer_details?.email || '',
              session.metadata.buyer_name || '',
              session.metadata.recipient_email || '',
              session.metadata.message || '',
              session.id);
          console.log(`[gift-card] Code ${code} generated (€${amountEur}, session ${session.id})`);
        }
        break;
      }

      // Growth Boost one-time payment
      if (session.mode === 'payment' && session.metadata?.type === 'growth_boost') {
        const userId = session.metadata.userId;
        if (userId) {
          db.prepare('UPDATE users SET boost_credits = boost_credits + 1 WHERE id = ?').run(userId);

          // Auto-unlock the latest completed audit so user sees results immediately
          const latestAudit = db.prepare(`
            SELECT id FROM seo_audits
            WHERE user_id = ? AND status = 'done' AND boost_unlocked = 0
            ORDER BY completed_at DESC LIMIT 1
          `).get(userId);
          if (latestAudit) {
            db.prepare('UPDATE seo_audits SET boost_unlocked = 1 WHERE id = ?').run(latestAudit.id);
            db.prepare('UPDATE users SET boost_credits = boost_credits - 1 WHERE id = ?').run(userId);
            console.log(`[growth_boost] auto-unlocked audit ${latestAudit.id} for user ${userId}`);
          } else {
            console.log(`[growth_boost] +1 credit for user ${userId} (no audit to auto-unlock)`);
          }
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
        // If save_card was requested, save the payment method for auto-reload
        if (session.metadata?.save_card === '1' && session.payment_intent && userId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
            if (pi.payment_method) {
              const pm = await stripe.paymentMethods.retrieve(pi.payment_method);
              db.prepare(
                'UPDATE users SET stripe_payment_method_id = ?, auto_reload_card_last4 = ?, auto_reload_card_brand = ? WHERE id = ?'
              ).run(pi.payment_method, pm.card?.last4 || '', pm.card?.brand || '', userId);
              console.log(`[credits] Saved payment method ${pi.payment_method} for user ${userId}`);
            }
          } catch (e) {
            console.error('[credits] Failed to save payment method:', e.message);
          }
        }
        break;
      }

      // Card setup for auto-reload (mode: 'setup')
      if (session.mode === 'setup' && session.metadata?.type === 'setup_payment_method') {
        const userId = session.metadata.userId;
        if (userId && session.setup_intent) {
          try {
            const si = await stripe.setupIntents.retrieve(session.setup_intent);
            if (si.payment_method) {
              const pm = await stripe.paymentMethods.retrieve(si.payment_method);
              db.prepare(
                'UPDATE users SET stripe_payment_method_id = ?, auto_reload_card_last4 = ?, auto_reload_card_brand = ? WHERE id = ?'
              ).run(si.payment_method, pm.card?.last4 || '', pm.card?.brand || '', userId);
              console.log(`[setup_pm] Saved payment method ${si.payment_method} for user ${userId}`);
            }
          } catch (e) {
            console.error('[setup_pm] Failed to save payment method:', e.message);
          }
        }
        break;
      }

      if (session.mode === 'subscription' && session.customer) {
        const user = await resolveUser(session.customer);

        if (user) {
          const plan = session.metadata?.plan || 'pro';

          // Person add-on subscription
          if (plan === 'person_addon') {
            db.prepare('UPDATE users SET person_addon_active = 1, person_addon_subscription_id = ? WHERE id = ?')
              .run(session.subscription, user.id);
            console.log(`[person] Add-on activated for user ${user.id}`);
            break;
          }

          // White Label extra client slots subscription
          if (plan === 'wl_extra_slots') {
            const slots = parseInt(session.metadata?.slots || '0', 10);
            db.prepare('UPDATE users SET white_label_extra_slots = ?, white_label_extra_sub_id = ? WHERE id = ?')
              .run(slots, session.subscription, user.id);
            console.log(`[wl-slots] ${slots} extra slots activated for user ${user.id}`);
            break;
          }

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
      const subPriceId = sub.items?.data?.[0]?.price?.id;

      // Person add-on subscription (monthly or yearly)
      if (subPriceId === process.env.STRIPE_PRICE_ID_PERSON || subPriceId === process.env.STRIPE_PRICE_ID_PERSON_YEARLY) {
        const user = await resolveUser(sub.customer);
        if (user) {
          db.prepare('UPDATE users SET person_addon_active = ?, person_addon_subscription_id = ? WHERE id = ?')
            .run(isActive ? 1 : 0, sub.id, user.id);
          console.log(`[person] Add-on ${isActive ? 'active' : 'inactive'} for user ${user.id}`);
        }
        break;
      }

      // White Label extra slots subscription — sync quantity
      if (subPriceId === process.env.STRIPE_PRICE_ID_WL_EXTRA_SLOT) {
        const user = await resolveUser(sub.customer);
        if (user) {
          const qty = isActive ? (sub.items?.data?.[0]?.quantity || 0) : 0;
          db.prepare('UPDATE users SET white_label_extra_slots = ?, white_label_extra_sub_id = ? WHERE id = ?')
            .run(qty, isActive ? sub.id : null, user.id);
          console.log(`[wl-slots] Extra slots ${isActive ? `set to ${qty}` : 'deactivated'} for user ${user.id}`);
        }
        break;
      }

      const status = isActive ? 'active' : 'inactive';
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
      const subPriceId = sub.items?.data?.[0]?.price?.id;

      // Person add-on cancelled (monthly or yearly)
      if (subPriceId === process.env.STRIPE_PRICE_ID_PERSON || subPriceId === process.env.STRIPE_PRICE_ID_PERSON_YEARLY) {
        const user = await resolveUser(sub.customer);
        if (user) {
          db.prepare('UPDATE users SET person_addon_active = 0, person_addon_subscription_id = NULL WHERE id = ?').run(user.id);
          console.log(`[person] Add-on cancelled for user ${user.id}`);
        }
        break;
      }

      // White Label extra slots cancelled
      if (subPriceId === process.env.STRIPE_PRICE_ID_WL_EXTRA_SLOT) {
        const user = await resolveUser(sub.customer);
        if (user) {
          db.prepare('UPDATE users SET white_label_extra_slots = 0, white_label_extra_sub_id = NULL WHERE id = ?').run(user.id);
          console.log(`[wl-slots] Extra slots cancelled for user ${user.id}`);
        }
        break;
      }

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
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      if (pi.metadata?.type === 'auto_reload') {
        const credits = parseInt(pi.metadata.credits || '0', 10);
        const userId = pi.metadata.userId;
        if (credits > 0 && userId) {
          db.prepare('UPDATE users SET extra_response_credits = extra_response_credits + ? WHERE id = ?').run(credits, userId);
          console.log(`[auto_reload] +${credits} credits added to user ${userId} via auto-reload`);
        }
      }
      break;
    }
  }

  res.json({ received: true });
});

// POST /api/stripe/checkout-person — subscribe to Person add-on (monthly or yearly)
router.post('/checkout-person', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, stripe_customer_id, subscription_status, person_addon_active FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  if (user.subscription_status !== 'active') {
    return res.status(402).json({ error: 'Person add-on vyžaduje aktívny Pro plán.' });
  }
  if (user.person_addon_active) {
    return res.json({ url: '/dashboard' });
  }

  const billing = req.body?.billing === 'yearly' ? 'yearly' : 'monthly';
  const priceId = billing === 'yearly'
    ? process.env.STRIPE_PRICE_ID_PERSON_YEARLY
    : process.env.STRIPE_PRICE_ID_PERSON;
  if (!priceId) return res.status(500).json({ error: 'Person add-on price nie je nakonfigurovaná.' });

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
      mode: 'subscription',
      success_url: `${baseUrl}/dashboard?person_activated=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/dashboard`,
      locale: 'sk',
      metadata: { plan: 'person_addon', userId: user.id },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[person checkout]', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby: ' + err.message });
  }
});

// POST /api/stripe/checkout-wl-slots — monthly subscription for extra White Label client slots (€15/slot/mes)
router.post('/checkout-wl-slots', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, stripe_customer_id, subscription_status, subscription_plan, white_label_extra_sub_id FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });
  if (user.subscription_plan !== 'white_label') {
    return res.status(403).json({ error: 'Extra sloty sú dostupné len pre White Label plán.' });
  }

  const priceId = process.env.STRIPE_PRICE_ID_WL_EXTRA_SLOT;
  if (!priceId) return res.status(500).json({ error: 'Extra slot price nie je nakonfigurovaná (STRIPE_PRICE_ID_WL_EXTRA_SLOT).' });

  const slots = parseInt(req.body?.slots || '1', 10);
  if (!slots || slots < 1 || slots > 200) {
    return res.status(400).json({ error: 'Počet slotov musí byť medzi 1 a 200.' });
  }

  const stripe = getStripe();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  try {
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    // If user already has an extra-slots subscription, update its quantity instead of new checkout
    if (user.white_label_extra_sub_id) {
      try {
        const existingSub = await stripe.subscriptions.retrieve(user.white_label_extra_sub_id);
        if (existingSub.status === 'active' || existingSub.status === 'trialing') {
          const itemId = existingSub.items.data[0]?.id;
          if (itemId) {
            await stripe.subscriptions.update(user.white_label_extra_sub_id, {
              items: [{ id: itemId, quantity: slots }],
              proration_behavior: 'create_prorations',
            });
            db.prepare('UPDATE users SET white_label_extra_slots = ? WHERE id = ?').run(slots, user.id);
            console.log(`[wl-slots] Updated existing sub ${user.white_label_extra_sub_id} to ${slots} slots`);
            return res.json({ updated: true, slots });
          }
        }
      } catch (e) {
        console.error('[wl-slots] Failed to update existing sub, creating new:', e.message);
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: slots }],
      success_url: `${baseUrl}/dashboard?wl_slots_added=${slots}`,
      cancel_url: `${baseUrl}/dashboard`,
      locale: 'sk',
      metadata: { plan: 'wl_extra_slots', userId: user.id, slots: String(slots) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[wl-slots checkout]', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby: ' + err.message });
  }
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
  const user = db.prepare('SELECT email, subscription_status, subscription_plan, stripe_customer_id, onboarding_done, free_until, person_addon_active, white_label_extra_slots, white_label_extra_sub_id FROM users WHERE id = ?').get(req.userId);
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
    person_addon: Boolean(user?.person_addon_active),
    white_label_extra_slots: user?.white_label_extra_slots || 0,
    white_label_extra_sub_id: user?.white_label_extra_sub_id || null,
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
