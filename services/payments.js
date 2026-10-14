'use strict';
/**
 * Merchant payments: each Neoworkly user collects money into their own Stripe account,
 * connected in the Payments section either with Stripe Connect (account created by the
 * platform, Standard-like controller, onboarding via Account Links) or with their own API keys.
 * The connection is stored on the user's funnel account (one Stripe account for funnels,
 * bookings and digital products). Neoworkly takes no commission (no application fee).
 *
 * Checkout sessions carry metadata { kind, ref } — fulfilment handlers are registered per
 * kind (bookings, digital products) and run from the webhook or, as a fallback, when the
 * customer returns from Stripe.
 */

const funnelDb = require('../funnel/src/db');
const totp = require('../funnel/src/totp');
const { merchantKeys } = require('../funnel/src/merchants');
const { stripePlatform } = require('../funnel');

/* ── Merchant / client ────────────────────────────────────────── */

/** The user's Stripe connection (their funnel account), or null. */
const getMerchant = userId => (userId ? funnelDb.getMerchantByUserSync(userId) : null);

const isReady = m => !!m && !!m.stripe_account_id && !!m.charges_enabled && !m.blocked;

// Same Stripe client per secret key as the funnel (tests replace merchantKeys.client)
const keyClient = secretKey => merchantKeys.client(secretKey);

/** { stripe, opts } — opts is passed as the request options of every call. */
function clientFor(m) {
  if (!isReady(m)) throw new Error('Platby nie sú nastavené.');
  // stripeAccount: undefined, not {} — stripe-node rejects an empty options object ("Unknown arguments")
  if (m.stripe_api_key) return { stripe: keyClient(totp.decrypt(m.stripe_api_key)), opts: { stripeAccount: undefined } };
  return { stripe: stripePlatform(), opts: { stripeAccount: m.stripe_account_id } };
}

function publicStatus(m) {
  return {
    ready: isReady(m), connected: !!m?.stripe_account_id, mode: m?.stripe_account_id ? (m.stripe_api_key ? 'keys' : 'connect') : null,
    accountId: m?.stripe_account_id || null, chargesEnabled: !!m?.charges_enabled,
    webhook: m?.stripe_api_key ? !!m.stripe_webhook_id : null,
  };
}

/* ── Checkout / refunds ───────────────────────────────────────── */

const toCents = amount => Math.round(Number(amount) * 100);

/** Creates a Checkout Session; metadata.kind + metadata.ref identify what is being paid. */
async function createCheckout(userId, { kind, ref, amount, currency, name, description, customerEmail, successUrl, cancelUrl, expiresInMin = 30 }) {
  const { stripe, opts } = clientFor(getMerchant(userId));
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: String(currency || 'EUR').toLowerCase(), unit_amount: amount,
      product_data: { name: String(name).slice(0, 250), ...(description ? { description: String(description).slice(0, 500) } : {}) } } }],
    customer_email: customerEmail || undefined,
    metadata: { kind, ref, neoworkly_user: userId },
    payment_intent_data: { metadata: { kind, ref } },
    success_url: successUrl, cancel_url: cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + Math.max(30, expiresInMin) * 60,
  }, opts);
}

async function retrieveSession(userId, sessionId) {
  const { stripe, opts } = clientFor(getMerchant(userId));
  return stripe.checkout.sessions.retrieve(sessionId, {}, opts);
}

async function refund(userId, paymentIntent, amount) {
  const { stripe, opts } = clientFor(getMerchant(userId));
  return stripe.refunds.create({ payment_intent: paymentIntent, ...(amount ? { amount } : {}) }, opts);
}

/* ── Fulfilment ───────────────────────────────────────────────── */

const handlers = {};
/** register('booking', { paid(session, userId), expired(session, userId), refunded(charge, userId) }) */
function register(kind, h) { handlers[kind] = h; }

async function handleSession(session, userId, type) {
  const h = handlers[session?.metadata?.kind];
  if (!h) return;
  if (type === 'expired') return h.expired?.(session, userId);
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return h.paid?.(session, userId);
}

async function handleEvent(event, userId) {
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') return handleSession(obj, userId, 'completed');
  if (event.type === 'checkout.session.expired') return handleSession(obj, userId, 'expired');
  if (event.type === 'charge.refunded') {
    // Refunds made in the Stripe dashboard: handlers match the charge by its payment intent
    for (const h of Object.values(handlers)) await h.refunded?.(obj, userId);
  }
}

/** Raw-body webhook verification for a merchant connected with their own keys. */
function constructUserEvent(userId, rawBody, signature) {
  const m = getMerchant(userId);
  const secret = m?.stripe_api_key && m.stripe_webhook_secret && totp.decrypt(m.stripe_webhook_secret);
  if (!secret) throw new Error('No webhook secret');
  return keyClient(totp.decrypt(m.stripe_api_key)).webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  getMerchant, isReady, publicStatus, clientFor,
  toCents, createCheckout, retrieveSession, refund, register, handleSession, handleEvent, constructUserEvent,
};
