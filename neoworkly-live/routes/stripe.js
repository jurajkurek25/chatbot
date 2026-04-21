const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getDB } = require('../db/database');
const { authClient } = require('../middleware/auth');

const PLANS = {
  starter: { priceId: process.env.STRIPE_PRICE_STARTER, operators: 3 },
  pro:     { priceId: process.env.STRIPE_PRICE_PRO,     operators: 10 },
  agency:  { priceId: process.env.STRIPE_PRICE_AGENCY,  operators: 999 }
};

// Create checkout session
router.post('/checkout', authClient, async (req, res) => {
  const { plan } = req.body;
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

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PLANS[plan].priceId, quantity: 1 }],
      success_url: `${process.env.LIVE_APP_URL}/dashboard?plan_success=1`,
      cancel_url: `${process.env.LIVE_APP_URL}/dashboard?plan_cancel=1`,
      metadata: { clientId: req.clientId, plan }
    });

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

// Get billing portal
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
