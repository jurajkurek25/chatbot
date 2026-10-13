// Hlavná aplikácia Neoworkly v testoch: databáza v pamäti, falošný Stripe (platforma aj vlastné
// kľúče obchodníka), zachytené e-maily. Musí sa načítať pred modulmi aplikácie.
process.env.NODE_ENV = 'test';
process.env.NEOWORKLY_DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test-jwt';
process.env.COOKIE_SECRET = 'test-secret';
process.env.APP_URL = 'https://app.test';
process.env.PUBLIC_URL = 'https://app.test';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_platform';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
process.env.SMTP_HOST = 'smtp.test'; process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
process.env.SMTP_FROM = 'noreply@neoworkly.test';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mails = [];
nodemailer.createTransport = () => ({ sendMail: async (m) => { mails.push(m); } });

const { initDatabase, getDb } = require('../db/database');
initDatabase();
const FakeStripe = require('../funnel/test/helpers/fake-stripe');
const funnel = require('../funnel');
const { merchantKeys } = require('../funnel/src/merchants');
const funnelDb = require('../funnel/src/db');

// Vlastné kľúče obchodníka: každý kľúč = vlastný falošný Stripe účet
const keyClients = {};
merchantKeys.client = (key) => {
  if (!keyClients[key]) {
    const fake = new FakeStripe();
    const own = { id: `acct_own_${Object.keys(keyClients).length}`, charges_enabled: true };
    fake.accounts.retrieve = async () => own;
    keyClients[key] = fake;
  }
  return keyClients[key];
};

async function startApp() {
  const stripe = new FakeStripe();
  funnel.useStripe(stripe);
  const app = express();
  app.use(funnel.createApp({ stripe, stripeTest: null }));
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api/booking', require('../routes/booking'));
  app.use('/api/payments', require('../routes/payments'));
  app.use('/api/shop', require('../routes/shop'));
  app.use('/api/drive', require('../routes/drive'));
  app.use('/api/team', require('../routes/team'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, stripe, close: () => new Promise((r) => server.close(r)) };
}

async function request(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

/** Používateľ Neoworkly s predplatným; api(method, path, body) volá API s jeho prihlásením. */
function newUser(ctx, { email = `u${crypto.randomBytes(4).toString('hex')}@example.sk`, name = 'Ema' } = {}) {
  const id = crypto.randomUUID();
  getDb().prepare("INSERT INTO users (id, email, password_hash, name, subscription_status) VALUES (?, ?, 'x', ?, 'active')").run(id, email, name);
  const token = jwt.sign({ userId: id }, process.env.JWT_SECRET);
  return { id, email, api: (m, p, b) => request(ctx.base, m, p, b, { authorization: `Bearer ${token}` }) };
}

/** Prepojí Stripe cez Connect a povolí platby. */
async function connectStripe(ctx, user) {
  await user.api('GET', '/api/funnels/api/me');
  await user.api('POST', '/api/funnels/api/connect');
  const m = await funnelDb.getMerchantByUser(user.id);
  ctx.stripe.accounts_[m.stripe_account_id].charges_enabled = true;
  await user.api('GET', '/api/funnels/api/me');
  return m.stripe_account_id;
}

/** Podpísaná udalosť Stripe (skutočné overenie podpisu v aplikácii). */
function signedEvent(ctx, event, secret) {
  const payload = JSON.stringify(event);
  return { payload, headers: { 'stripe-signature': ctx.stripe.webhooks.generateTestHeaderString({ payload, secret }) } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startApp, request, newUser, connectStripe, signedEvent, mails, keyClients, getDb, funnelDb, wait };
