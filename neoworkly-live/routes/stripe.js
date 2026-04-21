const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const fs = require('fs');
const { getDB } = require('../db/database');
const { authClient } = require('../middleware/auth');

const PLANS = {
  starter: { priceId: process.env.STRIPE_PRICE_STARTER },
  pro:     { priceId: process.env.STRIPE_PRICE_PRO },
  agency:  { priceId: process.env.STRIPE_PRICE_AGENCY }
};

const DISCOUNTS_PATH = path.join(__dirname, '../discounts.json');

function loadDiscounts() {
  try {
    return JSON.parse(fs.readFileSync(DISCOUNTS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveDiscounts(data) {
  fs.writeFileSync(DISCOUNTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Validate discount code (public – no auth needed so landing page can use it too)
router.post('/validate-code', authClient, (req, res) => {
  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: 'Zadajte kód' });

  const discounts = loadDiscounts();
  const key = code.trim().toUpperCase();
  const entry = discounts[key];

  if (!entry || entry.active === false || key.startsWith('_')) {
    return res.status(404).json({ error: 'Neplatný zľavový kód' });
  }
  if (entry.maxUses !== null && entry.uses >= entry.maxUses) {
    return res.status(410).json({ error: 'Tento kód bol already použitý príliš veľakrát' });
  }

  res.json({
    valid: true,
    type: entry.type,
    plan: entry.plan || null,
    description: entry.description
  });
});

// Apply a FREE discount code (sets plan directly, no Stripe)
router.post('/apply-code', authClient, (req, res) => {
  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: 'Zadajte kód' });

  const discounts = loadDiscounts();
  const key = code.trim().toUpperCase();
  const entry = discounts[key];

  if (!entry || entry.active === false || key.startsWith('_')) {
    return res.status(404).json({ error: 'Neplatný zľavový kód' });
  }
  if (entry.maxUses !== null && entry.uses >= entry.maxUses) {
    return res.status(410).json({ error: 'Kód bol použitý príliš veľakrát' });
  }
  if (entry.type !== 'free') {
    return res.status(400).json({ error: 'Tento kód nie je bezplatný — použite platobný formulár' });
  }
  if (!PLANS[entry.plan]) {
    return res.status(400).json({ error: 'Neplatný plán v kóde' });
  }

  const db = getDB();
  db.prepare("UPDATE clients SET plan = ?, stripe_subscription_id = ? WHERE id = ?")
    .run(entry.plan, `free_code_${key}`, req.clientId);

  // Increment usage counter
  entry.uses = (entry.uses || 0) + 1;
  saveDiscounts(discounts);

  res.json({ ok: true, plan: entry.plan, description: entry.description });
});

// Create checkout session (with optional Stripe coupon code)
router.post('/checkout', authClient, async (req, res) => {
  const { plan, discountCode } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const db = getDB();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.clientId);

  try {
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: client.email });
      customerId = customer.id;
      db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.clientId);
    }

    const sessionParams = {
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PLANS[plan].priceId, quantity: 1 }],
      success_url: `${process.env.LIVE_APP_URL}/dashboard?plan_success=1`,
      cancel_url: `${process.env.LIVE_APP_URL}/dashboard?plan_cancel=1`,
      metadata: { clientId: req.clientId, plan }
    };

    // Apply Stripe coupon if provided
    if (discountCode) {
      const discounts = loadDiscounts();
      const key = discountCode.trim().toUpperCase();
      const entry = discounts[key];
      if (entry?.type === 'stripe_coupon' && entry.stripeCouponId && entry.active !== false) {
        sessionParams.discounts = [{ coupon: entry.stripeCouponId }];
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// Stripe webhook
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  const db = getDB();

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { clientId, plan } = session.metadata;
    if (clientId) {
      db.prepare('UPDATE clients SET plan = ?, stripe_subscription_id = ? WHERE id = ?')
        .run(plan, session.subscription, clientId);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    db.prepare("UPDATE clients SET plan = 'free' WHERE stripe_subscription_id = ?").run(sub.id);
  }

  res.json({ received: true });
});

// Billing portal
router.post('/portal', authClient, async (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT stripe_customer_id FROM clients WHERE id = ?').get(req.clientId);
  if (!client.stripe_customer_id) return res.status(400).json({ error: 'No subscription' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripe_customer_id,
      return_url: `${process.env.LIVE_APP_URL}/dashboard`
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: 'Portal failed' });
  }
});

module.exports = router;
