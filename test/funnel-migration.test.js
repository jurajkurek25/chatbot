// Presun klientov zo samostatnej aplikácie Neoworkly Funnel: účty, heslá, 2FA, snippety, štatistiky.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');
const { startApp, request, newUser, getDb, funnelDb } = require('./helpers');
const { migrate } = require('../scripts/migrate-funnel');
const totp = require('../funnel/src/totp');
const { MIGRATIONS, EVENT_MIGRATIONS } = require('../funnel/src/db');

// Heslo ako ho ukladal funnel (scrypt)
function scrypt(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

// Databáza pôvodnej aplikácie (rovnaká schéma ako funnel/src/db-sqlite.js pred integráciou)
function oldDatabase(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE merchants (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      platform_customer_id TEXT NOT NULL, subscription_status TEXT NOT NULL DEFAULT 'none', stripe_account_id TEXT UNIQUE,
      charges_enabled INTEGER NOT NULL DEFAULT 0, funnel TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE events (id INTEGER PRIMARY KEY, merchant_id TEXT NOT NULL, step_id TEXT NOT NULL, type TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'live', created_at INTEGER NOT NULL);
  `);
  const added = ['neoworkly_user_id', 'stripe_webhook_id', 'stripe_webhook_secret'];
  for (const [c, type] of Object.entries(MIGRATIONS)) if (!added.includes(c)) db.exec(`ALTER TABLE merchants ADD COLUMN ${c} ${type}`);
  for (const [c, type] of Object.entries(EVENT_MIGRATIONS)) db.exec(`ALTER TABLE events ADD COLUMN ${c} ${type}`);
  return db;
}

const funnel = {
  products: { kniha: { name: 'E-kniha', type: 'one_time', amount: 1900, currency: 'eur', stripeAccountId: 'acct_stary' } },
  steps: { vstup: { kind: 'entry', productId: 'kniha', maxQuantity: 1, onAccept: '/dakujem' } },
};

describe('presun klientov z Neoworkly Funnel', () => {
  let ctx, file, dir, existing, totpSecret, recovery;
  const logs = [];
  const run = (opts = {}) => migrate(file, { log: (l) => logs.push(l), ...opts });
  const auth = (p, b) => request(ctx.authBase, 'POST', `/api/auth${p}`, b);

  before(async () => {
    ctx = await startApp();
    // Prihlásenie Neoworkly na tom istom serveri
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const authBase = `http://127.0.0.1:${server.address().port}`;
    const close = ctx.close;
    ctx.close = async () => { server.close(); await close(); };
    ctx.authBase = authBase;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-funnel-'));
    file = path.join(dir, 'neoworkly.db');
    const old = oldDatabase(file);
    totpSecret = totp.generateSecret();
    recovery = 'abcd-efgh-ijkl';
    existing = newUser(ctx, { email: 'spolu@example.sk' });
    const ins = old.prepare(`INSERT INTO merchants (id, email, password_hash, platform_customer_id, subscription_status, stripe_account_id,
      charges_enabled, funnel, created_at, totp_secret, recovery_codes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run('m_stary', 'Klient@Example.sk', scrypt('stareheslo1'), 'cus_legacy', 'active', 'acct_stary', 1, JSON.stringify(funnel),
      '2025-03-01T10:00:00.000Z', null, null);
    ins.run('m_2fa', 'dvojity@example.sk', scrypt('stareheslo2'), 'cus_2fa', 'canceled', null, 0, JSON.stringify({ products: {}, steps: {} }),
      '2025-04-01T10:00:00.000Z', totp.encrypt(totpSecret), JSON.stringify([totp.hashRecovery(recovery)]));
    ins.run('m_spolu', 'spolu@example.sk', scrypt('x'), 'cus_spolu', 'active', null, 0, JSON.stringify({ products: {}, steps: {} }),
      '2025-05-01T10:00:00.000Z', null, null);
    const ev = old.prepare('INSERT INTO events (merchant_id, step_id, type, amount, currency, variant, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    ev.run('m_stary', 'vstup', 'view', 0, 'eur', 'a', 'live', Date.now() - 1000);
    ev.run('m_stary', 'vstup', 'purchase', 1900, 'eur', 'a', 'live', Date.now() - 500);
    old.close();
  });
  after(async () => {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skúška (--dry-run) nič neuloží', () => {
    const report = run({ dryRun: true });
    assert.equal(report.migrated.length, 2);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM funnel_merchants WHERE id IN ('m_stary', 'm_2fa')").get().n, 0);
  });

  it('presunie obchodníkov s pôvodným ID, štatistikami a starým predplatným; existujúci účet iba ohlási', () => {
    const report = run();
    assert.deepEqual(report.migrated.map((m) => m.id), ['m_stary', 'm_2fa']);
    assert.deepEqual(report.conflicts.map((c) => c.id), ['m_spolu']);
    assert.equal(report.events, 2);
    const user = getDb().prepare('SELECT * FROM users WHERE email = ?').get('klient@example.sk');
    assert.match(user.password_hash, /^scrypt\$/);
    assert.equal(user.subscription_status, 'inactive');
    const m = funnelDb.getMerchantByUserSync(user.id);
    assert.deepEqual([m.id, m.platform_customer_id, m.subscription_status, m.stripe_account_id], ['m_stary', 'cus_legacy', 'active', 'acct_stary']);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE merchant_id = 'm_stary'").get().n, 2);
  });

  it('opakované spustenie nič nezdvojí; --link-existing prepojí účet s rovnakým e-mailom', async () => {
    await existing.api('GET', '/api/funnels/api/me'); // prázdny funnel z otvorenia sekcie Funnely
    const again = run({ linkExisting: true });
    assert.equal(again.migrated.length, 0);
    assert.deepEqual(again.linked.map((l) => [l.id, l.userId]), [['m_spolu', existing.id]]);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE merchant_id = 'm_stary'").get().n, 2);
    assert.equal(funnelDb.getMerchantByUserSync(existing.id).id, 'm_spolu');
  });

  it('snippet na webe klienta funguje ďalej s rovnakým ID obchodníka', async () => {
    ctx.stripe.accounts_.acct_stary = { id: 'acct_stary', charges_enabled: true };
    ctx.stripe.subscriptionStatus.cus_legacy = 'active';
    const view = await request(ctx.base, 'POST', '/api/f/m_stary/vstup/view', { count: true });
    assert.equal(view.status, 200);
    assert.equal(view.body.stripeAccount, 'acct_stary');
  });

  it('klient sa prihlási starým heslom (prevedie sa na bcrypt); so starým predplatným má Funnely', async () => {
    assert.equal((await auth('/login', { email: 'klient@example.sk', password: 'zle' })).status, 401);
    const res = await auth('/login', { email: 'klient@example.sk', password: 'stareheslo1' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.match(getDb().prepare('SELECT password_hash FROM users WHERE email = ?').get('klient@example.sk').password_hash, /^\$2/);
    assert.equal((await auth('/login', { email: 'klient@example.sk', password: 'stareheslo1' })).status, 200);
    const me = await request(ctx.base, 'GET', '/api/funnels/api/me', undefined, { authorization: `Bearer ${res.body.token}` });
    assert.equal(me.body.active, true);
  });

  it('klient so zapnutým 2FA potrebuje kód z aplikácie alebo záložný kód (každý iba raz)', async () => {
    const first = await auth('/login', { email: 'dvojity@example.sk', password: 'stareheslo2' });
    assert.deepEqual([first.body.twoFactor, first.body.token], [true, undefined]);
    assert.equal((await auth('/login/2fa', { challenge: first.body.challenge + 'x', code: '000000' })).body.expired, true);
    assert.equal((await auth('/login/2fa', { challenge: first.body.challenge, code: '000000' })).status, 401);
    const code = totp.hotp(totp.base32Decode(totpSecret), Math.floor(Date.now() / 30000));
    const ok = await auth('/login/2fa', { challenge: first.body.challenge, code });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal((await auth('/login/2fa', { challenge: first.body.challenge, code })).status, 401); // ten istý kód znova nie

    const second = await auth('/login', { email: 'dvojity@example.sk', password: 'stareheslo2' });
    assert.equal((await auth('/login/2fa', { challenge: second.body.challenge, code: recovery })).status, 200);
    assert.equal((await auth('/login/2fa', { challenge: second.body.challenge, code: recovery })).status, 401);
  });

  it('nedešifrovateľné tajomstvá (iný kľúč) zastavia presun', () => {
    const other = path.join(dir, 'other.db');
    const old = oldDatabase(other);
    old.prepare("INSERT INTO merchants (id, email, password_hash, platform_customer_id, funnel, totp_secret) VALUES ('m_x', 'x@example.sk', 'h', 'c', '{}', 'v2:zly:kluc:data')").run();
    old.close();
    assert.throws(() => migrate(other, { log: () => {} }), /Nedá sa dešifrovať totp_secret/);
  });
});

describe('hlavný Stripe webhook a staré predplatné funnela', () => {
  it('predplatné za 4 € (FUNNEL_SUBSCRIPTION_PRICE_ID) neaktivuje účet Neoworkly', async () => {
    process.env.FUNNEL_SUBSCRIPTION_PRICE_ID = 'price_funnel';
    process.env.STRIPE_SECRET_KEY = 'sk_test_main';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_main';
    const stripe = require('stripe')('sk_test_main');
    const app = express();
    app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
    app.use('/api/stripe', require('../routes/stripe'));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const id = crypto.randomUUID();
    getDb().prepare("INSERT INTO users (id, email, password_hash, name, subscription_status, stripe_customer_id) VALUES (?, ?, 'x', 'A', 'inactive', 'cus_main')").run(id, `${id}@example.sk`);
    const send = async (event) => {
      const payload = JSON.stringify(event);
      const headers = { 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_main' }) };
      return (await request(base, 'POST', '/api/stripe/webhook', payload, headers)).status;
    };
    try {
      const sub = (price) => ({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_main', status: 'active', items: { data: [{ price: { id: price } }] } } } });
      assert.equal(await send(sub('price_funnel')), 200);
      assert.equal(getDb().prepare('SELECT subscription_status FROM users WHERE id = ?').get(id).subscription_status, 'inactive');
      await send(sub('price_neoworkly'));
      assert.equal(getDb().prepare('SELECT subscription_status FROM users WHERE id = ?').get(id).subscription_status, 'active');
    } finally {
      server.close();
    }
  });
});
