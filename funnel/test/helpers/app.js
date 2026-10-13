// Funnel ako súčasť Neoworkly: falošný Stripe, hlavná databáza v pamäti, zachytené e-maily.
// Musí sa načítať PRED modulmi funnela (tie čítajú premenné prostredia pri načítaní).
process.env.NODE_ENV = 'test';
process.env.NEOWORKLY_DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test-jwt';
process.env.COOKIE_SECRET = 'test-secret';
process.env.PUBLIC_URL = 'http://neoworkly.test';
process.env.APP_URL = 'http://neoworkly.test';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_platform';
process.env.STRIPE_TEST_PUBLISHABLE_KEY = 'pk_test_testmode';
process.env.FUNNEL_SUBSCRIPTION_PRICE_ID = 'price_saas';
process.env.FUNNEL_STRIPE_WEBHOOK_SECRET = 'whsec_platform';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
delete process.env.SMTP_HOST;

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { initDatabase, getDb } = require('../../../db/database');
initDatabase();
const FakeStripe = require('./fake-stripe');
const createFunnelApp = require('../../src/app');
const db = require('../../src/db');
const mailer = require('../../src/mailer');
const { resetRateLimits } = require('../../src/ratelimit');

const mails = [];
mailer.sendMail = async (mail) => {
  mails.push(mail);
};

// stripeTest = druhý falošný Stripe pre testovacie kľúče platformy (testovací režim obchodníkov)
async function startApp({ testMode = true } = {}) {
  const stripe = new FakeStripe();
  const stripeTest = testMode ? new FakeStripe() : null;
  const server = createFunnelApp(stripe, stripeTest).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await resetRateLimits();
  return { base, stripe, stripeTest, close: () => new Promise((resolve) => server.close(resolve)) };
}

// HTTP klient (jeden prehliadač); token = prihlásenie do Neoworkly (JWT)
function client(base, token = null) {
  const c = {
    token,
    async request(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json', ...(c.token && { authorization: `Bearer ${c.token}` }), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, body: json, headers: res.headers };
    },
    get: (path, headers) => c.request('GET', path, undefined, headers),
    post: (path, body = {}, headers) => c.request('POST', path, body, headers),
    put: (path, body = {}) => c.request('PUT', path, body),
    del: (path) => c.request('DELETE', path, {}),
  };
  return c;
}

const PASSWORD = 'heslo1234';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

// Používateľ Neoworkly (predvolene s aktívnym predplatným) a prihlásený prehliadač
function newUser(ctx, { email = `shop${crypto.randomBytes(4).toString('hex')}@example.sk`, status = 'active' } = {}) {
  const id = crypto.randomUUID();
  getDb().prepare('INSERT INTO users (id, email, password_hash, name, subscription_status) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, PASSWORD_HASH, 'Test', status);
  return { userId: id, email, browser: client(ctx.base, jwt.sign({ userId: id }, process.env.JWT_SECRET)) };
}

// Obchodník s prístupom k Neoworkly a Stripe účtom, ktorý prijíma platby
async function activeMerchant(ctx, email) {
  await resetRateLimits(); // testy vytvárajú veľa obchodníkov z jednej IP
  const user = newUser(ctx, { email });
  await user.browser.get('/api/funnels/api/me'); // funnel účet vznikne pri prvom otvorení
  const merchant = await db.getMerchantByUser(user.userId);
  await user.browser.post('/api/funnels/api/connect');
  const account = (await db.getMerchant(merchant.id)).stripe_account_id;
  ctx.stripe.accounts_[account].charges_enabled = true;
  const me = await user.browser.get('/api/funnels/api/me');
  return { ...user, id: merchant.id, account, me: me.body };
}

module.exports = { startApp, client, newUser, activeMerchant, mails, db, PASSWORD };
