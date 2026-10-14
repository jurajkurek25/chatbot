'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const payments = require('../services/payments');
require('../services/bookingPayments'); // registers the 'booking' fulfilment handler

const router = express.Router();

/** GET /api/payments/status — connection + recent online payments */
router.get('/status', requireAuth, (req, res) => {
  const recent = getDb().prepare(`
    SELECT b.id, b.customer_name, b.customer_email, b.service_name, b.date, b.start_time, b.status, b.payment_status,
           b.amount_paid, b.amount_refunded, b.currency, b.created_at, w.name AS widget_name
    FROM bookings b JOIN widgets w ON w.id = b.widget_id
    WHERE w.user_id = ? AND b.payment_status IN ('paid', 'refunded', 'partially_refunded')
    ORDER BY b.created_at DESC LIMIT 50`).all(req.userId);
  const orders = getDb().prepare(`
    SELECT id, name AS customer_name, email AS customer_email, product_title AS service_name, status, amount AS amount_paid,
           amount_refunded, currency, created_at, CASE WHEN amount_refunded >= amount THEN 'refunded' WHEN amount_refunded > 0 THEN 'partially_refunded' ELSE 'paid' END AS payment_status
    FROM orders WHERE user_id = ? AND amount > 0 AND status IN ('paid', 'refunded') ORDER BY created_at DESC LIMIT 50`).all(req.userId);
  const all = [...recent.map(r => ({ ...r, type: 'booking' })), ...orders.map(o => ({ ...o, type: 'order' }))]
    .sort((a, b) => b.created_at - a.created_at).slice(0, 50);
  res.json({ ...payments.publicStatus(payments.getMerchant(req.userId)), recent: all });
});

/* ── Webhooks (raw body kept by express.json's verify hook) ─────── */

async function dispatch(event, userId, res) {
  try { await payments.handleEvent(event, userId); res.json({ received: true }); }
  catch (e) { console.error('[payments webhook]', e.message); res.status(500).json({ error: 'handler failed' }); }
}

/**
 * Events from a merchant's own Stripe account (endpoint created automatically with their keys).
 * Merchants connected via Stripe Connect send payment events to the platform's Connect
 * endpoint /api/webhook/connect (handled by the funnel module).
 */
router.post('/webhook/u/:userId', (req, res) => {
  let event;
  try { event = payments.constructUserEvent(req.params.userId, req.rawBody, req.headers['stripe-signature']); }
  catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  return dispatch(event, req.params.userId, res);
});

module.exports = router;
