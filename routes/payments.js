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
  res.json({ ...payments.publicStatus(payments.getMerchant(req.userId)), recent: recent.map(r => ({ ...r, type: 'booking' })) });
});

router.get('/connect/start', requireAuth, (req, res) => {
  try { res.json({ url: payments.connectUrl(req.userId) }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

router.get('/connect/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?payments=error');
  try {
    await payments.finishConnect(payments.verifyConnectState(state), String(code));
    res.redirect('/dashboard?payments=connected');
  } catch (e) {
    console.error('[payments connect]', e.message);
    res.redirect('/dashboard?payments=error');
  }
});

router.post('/keys', requireAuth, async (req, res) => {
  try { res.json(await payments.saveOwnKeys(req.userId, { secretKey: String(req.body?.secretKey || '').trim(), publishableKey: String(req.body?.publishableKey || '').trim() })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/', requireAuth, async (req, res) => {
  await payments.disconnect(req.userId);
  res.json({ ok: true });
});

/* ── Webhooks (raw body kept by express.json's verify hook) ─────── */

async function dispatch(event, userId, res) {
  try { await payments.handleEvent(event, userId); res.json({ received: true }); }
  catch (e) { console.error('[payments webhook]', e.message); res.status(500).json({ error: 'handler failed' }); }
}

/** Events from merchants connected via Stripe Connect (platform Connect webhook). */
router.post('/webhook/connect', (req, res) => {
  let event;
  try { event = payments.constructConnectEvent(req.rawBody, req.headers['stripe-signature']); }
  catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  const userId = event.account && payments.userForAccount(event.account);
  if (!userId) return res.json({ received: true, ignored: true });
  return dispatch(event, userId, res);
});

/** Events from a merchant's own Stripe account (endpoint created automatically with their keys). */
router.post('/webhook/u/:userId', (req, res) => {
  let event;
  try { event = payments.constructUserEvent(req.params.userId, req.rawBody, req.headers['stripe-signature']); }
  catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  return dispatch(event, req.params.userId, res);
});

module.exports = router;
