'use strict';
/**
 * Merchant payments: each Neoworkly user collects money into their own Stripe account,
 * connected either with Stripe Connect (Standard, OAuth) or with their own API keys.
 * Neoworkly takes no commission (no application fee).
 *
 * Checkout sessions carry metadata { kind, ref } — fulfilment handlers are registered per
 * kind (bookings now, digital products later) and run from the webhook or, as a fallback,
 * when the customer returns from Stripe.
 */

const crypto = require('crypto');
const Stripe = require('stripe');
const { getDb } = require('../db/database');

const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'charge.refunded'];

/* ── Secret storage (AES-256-GCM) ─────────────────────────────── */

const encKey = () => crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'changeme').digest();
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, data] = blob.split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { return null; }
}

/* ── Merchant / client ────────────────────────────────────────── */

const platform = () => Stripe(process.env.STRIPE_SECRET_KEY);

function getMerchant(userId) {
  return getDb().prepare('SELECT * FROM merchant_payments WHERE user_id = ?').get(userId) || null;
}

function isReady(m) {
  return !!m && ((m.mode === 'connect' && !!m.stripe_account_id) || (m.mode === 'keys' && !!m.secret_key_enc));
}

/** { stripe, opts } — opts is passed as the request options of every call. */
function clientFor(m) {
  if (!isReady(m)) throw new Error('Platby nie sú nastavené.');
  if (m.mode === 'connect') return { stripe: platform(), opts: { stripeAccount: m.stripe_account_id } };
  return { stripe: Stripe(decrypt(m.secret_key_enc)), opts: {} };
}

function publicStatus(m) {
  return {
    ready: isReady(m), mode: m?.mode || null, accountName: m?.account_name || null,
    accountId: m?.mode === 'connect' ? m.stripe_account_id : null,
    publishableKey: m?.publishable_key || null, webhook: m?.mode === 'keys' ? !!m.webhook_secret_enc : null,
    currency: m?.currency || 'EUR', connectAvailable: !!(process.env.STRIPE_CONNECT_CLIENT_ID && process.env.STRIPE_SECRET_KEY),
  };
}

function upsert(userId, fields) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO merchant_payments (user_id) VALUES (?)').run(userId);
  const keys = Object.keys(fields);
  db.prepare(`UPDATE merchant_payments SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = unixepoch() WHERE user_id = ?`)
    .run(...keys.map(k => fields[k]), userId);
}

/* ── Connect (OAuth, Standard accounts) ───────────────────────── */

const sign = v => crypto.createHmac('sha256', encKey()).update(v).digest('base64url');
function connectUrl(userId) {
  if (!process.env.STRIPE_CONNECT_CLIENT_ID) throw new Error('Stripe Connect nie je nakonfigurovaný (STRIPE_CONNECT_CLIENT_ID).');
  const state = `${userId}.${Date.now()}`;
  const q = new URLSearchParams({ response_type: 'code', client_id: process.env.STRIPE_CONNECT_CLIENT_ID, scope: 'read_write',
    redirect_uri: `${appUrl()}/api/payments/connect/callback`, state: `${state}.${sign(state)}` });
  return `https://connect.stripe.com/oauth/authorize?${q}`;
}

function verifyConnectState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) throw new Error('Neplatný stav.');
  const [userId, ts, sig] = parts;
  const expected = sign(`${userId}.${ts}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('Neplatný podpis.');
  if (Date.now() - Number(ts) > 3600 * 1000) throw new Error('Platnosť vypršala.');
  return userId;
}

async function finishConnect(userId, code) {
  const stripe = platform();
  const token = await stripe.oauth.token({ grant_type: 'authorization_code', code });
  const prev = getMerchant(userId);
  if (prev?.mode === 'keys' && prev.webhook_id) { try { await Stripe(decrypt(prev.secret_key_enc)).webhookEndpoints.del(prev.webhook_id); } catch {} }
  let name = null;
  try {
    const acct = await stripe.accounts.retrieve(token.stripe_user_id);
    name = acct.settings?.dashboard?.display_name || acct.business_profile?.name || acct.email || null;
  } catch {}
  upsert(userId, { mode: 'connect', stripe_account_id: token.stripe_user_id, account_name: name,
    secret_key_enc: null, publishable_key: token.stripe_publishable_key || null, webhook_id: null, webhook_secret_enc: null });
}

/* ── Own API keys ─────────────────────────────────────────────── */

async function saveOwnKeys(userId, { secretKey, publishableKey }) {
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(secretKey || '')) throw new Error('Neplatný tajný kľúč (sk_live_… alebo sk_test_…).');
  if (publishableKey && !/^pk_(live|test)_[A-Za-z0-9]{10,}$/.test(publishableKey)) throw new Error('Neplatný verejný kľúč (pk_…).');
  const stripe = Stripe(secretKey);
  let acct;
  try { acct = await stripe.accounts.retrieve(); }
  catch (e) { throw new Error('Stripe kľúč nefunguje: ' + e.message); }
  const prev = getMerchant(userId);
  // Remove the webhook we created for a previous key on the same account, then create a fresh one
  if (prev?.mode === 'keys' && prev.webhook_id) { try { await Stripe(decrypt(prev.secret_key_enc)).webhookEndpoints.del(prev.webhook_id); } catch {} }
  let webhookId = null, webhookSecret = null;
  try {
    const wh = await stripe.webhookEndpoints.create({ url: `${appUrl()}/api/payments/webhook/u/${userId}`, enabled_events: EVENTS,
      description: 'Neoworkly – rezervácie a digitálne produkty' });
    webhookId = wh.id; webhookSecret = wh.secret;
  } catch (e) { console.warn('[payments] webhook not created:', e.message); }
  upsert(userId, { mode: 'keys', stripe_account_id: acct.id, account_name: acct.settings?.dashboard?.display_name || acct.business_profile?.name || acct.email || null,
    secret_key_enc: encrypt(secretKey), publishable_key: publishableKey || null, webhook_id: webhookId, webhook_secret_enc: encrypt(webhookSecret) });
  return publicStatus(getMerchant(userId));
}

async function disconnect(userId) {
  const m = getMerchant(userId);
  if (!m) return;
  try {
    if (m.mode === 'keys' && m.webhook_id) await Stripe(decrypt(m.secret_key_enc)).webhookEndpoints.del(m.webhook_id);
    if (m.mode === 'connect' && process.env.STRIPE_CONNECT_CLIENT_ID) {
      await platform().oauth.deauthorize({ client_id: process.env.STRIPE_CONNECT_CLIENT_ID, stripe_user_id: m.stripe_account_id });
    }
  } catch (e) { console.warn('[payments] disconnect:', e.message); }
  upsert(userId, { mode: null, stripe_account_id: null, account_name: null, secret_key_enc: null, publishable_key: null, webhook_id: null, webhook_secret_enc: null });
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
  return stripe.checkout.sessions.retrieve(sessionId, opts);
}

async function refund(userId, paymentIntent, amount) {
  const { stripe, opts } = clientFor(getMerchant(userId));
  return stripe.refunds.create({ payment_intent: paymentIntent, ...(amount ? { amount } : {}) }, opts);
}

/* ── Fulfilment ───────────────────────────────────────────────── */

const handlers = {};
/** register('booking', { paid(session, userId), expired(session, userId) }) */
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

/** Raw-body webhook verification for a user's own Stripe account. */
function constructUserEvent(userId, rawBody, signature) {
  const m = getMerchant(userId);
  const secret = m?.mode === 'keys' && decrypt(m.webhook_secret_enc);
  if (!secret) throw new Error('No webhook secret');
  return Stripe(decrypt(m.secret_key_enc)).webhooks.constructEvent(rawBody, signature, secret);
}

function constructConnectEvent(rawBody, signature) {
  if (!process.env.STRIPE_CONNECT_WEBHOOK_SECRET) throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET not set');
  return platform().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
}

function userForAccount(accountId) {
  return getDb().prepare("SELECT user_id FROM merchant_payments WHERE mode = 'connect' AND stripe_account_id = ?").get(accountId)?.user_id || null;
}

module.exports = {
  encrypt, decrypt, getMerchant, isReady, publicStatus, connectUrl, verifyConnectState, finishConnect, saveOwnKeys, disconnect,
  toCents, createCheckout, retrieveSession, refund, register, handleSession, handleEvent, constructUserEvent, constructConnectEvent, userForAccount,
};
