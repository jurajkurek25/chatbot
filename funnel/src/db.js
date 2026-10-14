// Databáza: klienti Neoworkly (obchodníci) a ich funnely (SQLite alebo Postgres, rovnaké async API).
// Produkty a kroky funnela sú JSON v stĺpci `funnel` – upravuje ich iba vlastník cez dashboard.
const crypto = require('crypto');

// Stĺpce merchants: id, email, password_hash, platform_customer_id (zákazník na Stripe účte Neoworkly,
// platí 4 €), subscription_status, stripe_account_id (pripojený Stripe účet klienta acct_...),
// charges_enabled, funnel ({ products, steps, ... } ako JSON), created_at + stĺpce nižšie.
// Stĺpce pridané neskôr – existujúca databáza sa pri štarte doplní
const MIGRATIONS = {
  email_verified: 'INTEGER NOT NULL DEFAULT 0',
  verify_token_hash: 'TEXT',
  reset_token_hash: 'TEXT',
  reset_expires: 'BIGINT', // ms od epochy
  session_version: 'INTEGER NOT NULL DEFAULT 0', // zvýši sa pri zmene hesla => staré relácie neplatia
  funnel_version: 'INTEGER NOT NULL DEFAULT 0', // ochrana pred prepísaním súbežnou úpravou
  blocked: 'INTEGER NOT NULL DEFAULT 0', // zablokovaný adminom Neoworkly
  terms_accepted_at: 'TEXT', // kedy súhlasil s obchodnými podmienkami (ISO čas)
  test_account_id: 'TEXT', // testovací Stripe účet obchodníka (testovacie kľúče platformy)
  test_key: 'TEXT', // tajný kľúč, ktorým obchodník zapne testovací režim vo svojich snippetoch
  totp_secret: 'TEXT', // 2FA: zašifrované tajomstvo TOTP (zapnuté)
  totp_pending: 'TEXT', // 2FA: zašifrované tajomstvo počas nastavovania (ešte nepotvrdené kódom)
  totp_last_step: 'INTEGER NOT NULL DEFAULT -1', // posledný použitý krok TOTP (kód nejde použiť dvakrát)
  recovery_codes: 'TEXT', // 2FA: JSON pole hashov nepoužitých záložných kódov
  stripe_api_key: 'TEXT', // prepojenie vlastnými kľúčmi namiesto Connect: zašifrovaný tajný kľúč obchodníka
  stripe_publishable_key: 'TEXT', // ... a jeho verejný kľúč (pre Stripe.js v snippetoch)
  neoworkly_user_id: 'TEXT', // účet Neoworkly, ktorému funnel patrí
  stripe_webhook_id: 'TEXT', // vlastné kľúče: webhook pre platby rezervácií a produktov (vytvorený automaticky)
  stripe_webhook_secret: 'TEXT', // ... a jeho zašifrované tajomstvo
};

// Udalosti funnela pre štatistiky – bez osobných údajov (žiadna IP, e-mail ani ID zákazníka):
// merchant_id, step_id, type (view | purchase | decline), amount (pri nákupe v centoch),
// mode (live | test), created_at (ms od epochy) + stĺpce nižšie
const EVENT_MIGRATIONS = {
  currency: "TEXT NOT NULL DEFAULT 'eur'", // mena tržby pri nákupe
  variant: "TEXT NOT NULL DEFAULT 'a'", // variant A/B testu
};

// Tabuľky funnela sú v hlavnej databáze Neoworkly (better-sqlite3). Rovnaké asynchrónne rozhranie
// ako pôvodný ovládač (all/get/run), aby zvyšok kódu funnela ostal nezmenený.
const { getDb } = require('../../db/database');

function open({ merchantColumns, eventColumns }) {
  const sql = getDb();
  sql.exec(`
    CREATE TABLE IF NOT EXISTS funnel_merchants (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      platform_customer_id TEXT NOT NULL DEFAULT '',
      subscription_status TEXT NOT NULL DEFAULT 'none',
      stripe_account_id TEXT UNIQUE,
      charges_enabled INTEGER NOT NULL DEFAULT 0,
      funnel TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS funnel_events (
      id INTEGER PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'live',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS funnel_events_merchant_time ON funnel_events (merchant_id, created_at);
  `);
  for (const [table, columns] of [['funnel_merchants', merchantColumns], ['funnel_events', eventColumns]]) {
    const existing = sql.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [column, type] of Object.entries(columns)) {
      if (!existing.includes(column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS funnel_merchants_user ON funnel_merchants (neoworkly_user_id)');
  const statements = new Map();
  const prepare = (q) => {
    if (!statements.has(q)) statements.set(q, sql.prepare(q));
    return statements.get(q);
  };
  return {
    all: async (q, params = []) => prepare(q).all(...params),
    get: async (q, params = []) => prepare(q).get(...params) ?? null,
    run: async (q, params = []) => prepare(q).run(...params).changes,
    getSync: (q, params = []) => prepare(q).get(...params) ?? null,
    close: async () => {},
  };
}

// Otvorí sa až pri prvom použití (hlavná aplikácia najprv pripraví databázu v initDatabase)
let conn = null;
const connection = () => (conn ||= open({ merchantColumns: MIGRATIONS, eventColumns: EVENT_MIGRATIONS }));
const db = {
  all: (...a) => connection().all(...a),
  get: (...a) => connection().get(...a),
  run: (...a) => connection().run(...a),
  getSync: (...a) => connection().getSync(...a),
  close: async () => {},
};

async function addEvent({ merchantId, stepId, type, amount = 0, currency = 'eur', variant = 'a', mode = 'live', at = Date.now() }) {
  await db.run(
    'INSERT INTO funnel_events (merchant_id, step_id, type, amount, currency, variant, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [merchantId, stepId, type, amount, currency, variant, mode, at],
  );
}

const count = (type) => `SUM(CASE WHEN type = '${type}' THEN 1 ELSE 0 END)`;

// Výsledky A/B testu kroku po variantoch od jeho spustenia
async function variantStats(merchantId, stepId, since, mode = 'live') {
  const rows = await db.all(
    // Pri kroku „Zadarmo za kontakt“ je konverziou získaný kontakt
    `SELECT variant, ${count('view')} AS views, SUM(CASE WHEN type IN ('purchase', 'lead') THEN 1 ELSE 0 END) AS purchases,
            SUM(CASE WHEN type = 'purchase' THEN amount ELSE 0 END) AS revenue
       FROM funnel_events WHERE merchant_id = ? AND step_id = ? AND mode = ? AND created_at >= ?
      GROUP BY variant`,
    [merchantId, stepId, mode, since],
  );
  const find = (v) => {
    const r = rows.find((x) => x.variant === v) || {};
    return { views: Number(r.views || 0), purchases: Number(r.purchases || 0), revenue: Number(r.revenue || 0) };
  };
  return { a: find('a'), b: find('b') };
}

// Súčty po krokoch od daného času (iba ostré udalosti, pokiaľ nie je povedané inak).
// Tržby sú po menách: { eur: 1900, czk: 25000 } – rôzne meny sa nesčítavajú.
async function stepStats(merchantId, since, mode = 'live') {
  const counts = await db.all(
    `SELECT step_id AS "stepId", ${count('view')} AS views, ${count('purchase')} AS purchases,
            ${count('decline')} AS declines, ${count('lead')} AS leads
       FROM funnel_events WHERE merchant_id = ? AND mode = ? AND created_at >= ?
      GROUP BY step_id`,
    [merchantId, mode, since],
  );
  const revenue = await db.all(
    `SELECT step_id AS "stepId", currency, SUM(amount) AS amount
       FROM funnel_events WHERE merchant_id = ? AND mode = ? AND created_at >= ? AND type = 'purchase'
      GROUP BY step_id, currency`,
    [merchantId, mode, since],
  );
  return counts.map((r) => ({
    stepId: r.stepId,
    views: Number(r.views),
    purchases: Number(r.purchases),
    declines: Number(r.declines),
    leads: Number(r.leads || 0),
    revenue: Object.fromEntries(revenue.filter((x) => x.stepId === r.stepId).map((x) => [x.currency, Number(x.amount)])),
  }));
}

function toMerchant(row) {
  if (!row) return null;
  return {
    ...row,
    charges_enabled: Boolean(row.charges_enabled),
    email_verified: Boolean(row.email_verified),
    blocked: Boolean(row.blocked),
    funnel: JSON.parse(row.funnel),
  };
}

// Stĺpec je vždy konštanta z kódu (nie vstup od používateľa)
const by = (column) => async (value) => toMerchant(await db.get(`SELECT * FROM funnel_merchants WHERE ${column} = ?`, [value]));

const getMerchant = by('id');
const getMerchantByEmail = by('email');
const getMerchantByPlatformCustomer = by('platform_customer_id');
const getMerchantByAccount = by('stripe_account_id');
const getMerchantByResetHash = by('reset_token_hash');
const getMerchantByVerifyHash = by('verify_token_hash');
const getMerchantByUser = by('neoworkly_user_id');

// Funnel účet pre používateľa Neoworkly (vznikne pri prvom otvorení sekcie Funnely)
async function createMerchantForUser({ userId, email }) {
  const id = `m_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO funnel_merchants (id, email, password_hash, platform_customer_id, funnel, terms_accepted_at, created_at, email_verified, neoworkly_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [id, email, '', '', JSON.stringify({ products: {}, steps: {} }), now, now, userId],
  );
  return getMerchant(id);
}

/** Synchrónne pre hlavnú aplikáciu (platby rezervácií a produktov). */
const getMerchantByUserSync = (userId) => toMerchant(db.getSync('SELECT * FROM funnel_merchants WHERE neoworkly_user_id = ?', [userId]));

// Nový e-mail treba znova overiť
async function changeEmail(id, email) {
  await db.run(
    'UPDATE funnel_merchants SET email = ?, email_verified = 0, verify_token_hash = NULL, reset_token_hash = NULL WHERE id = ?',
    [email, id],
  );
}

async function deleteMerchant(id) {
  await db.run('DELETE FROM funnel_events WHERE merchant_id = ?', [id]);
  await db.run('DELETE FROM funnel_merchants WHERE id = ?', [id]);
}

const UPDATABLE = [
  'subscription_status',
  'stripe_account_id',
  'charges_enabled',
  'email_verified',
  'verify_token_hash',
  'reset_token_hash',
  'reset_expires',
  'blocked',
  'test_account_id',
  'test_key',
  'totp_secret',
  'totp_pending',
  'totp_last_step',
  'recovery_codes',
  'stripe_api_key',
  'stripe_publishable_key',
  'email',
  'stripe_webhook_id',
  'stripe_webhook_secret',
];

async function updateMerchant(id, fields) {
  const columns = Object.keys(fields);
  for (const column of columns) {
    if (!UPDATABLE.includes(column)) throw new Error(`Nepovolený stĺpec ${column}`);
  }
  if (!columns.length) return;
  const values = Object.values(fields).map((v) => (typeof v === 'boolean' ? Number(v) : v));
  await db.run(`UPDATE funnel_merchants SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
}

// Zmaže udalosti štatistík staršie ako daný čas (ms); vráti ich počet
async function pruneEvents(before) {
  return db.run('DELETE FROM funnel_events WHERE created_at < ?', [before]);
}

// Pre /health: overí, že databáza odpovedá
const ping = async () => Number((await db.get('SELECT 1 AS ok')).ok) === 1;

async function listMerchants() {
  return (await db.all('SELECT * FROM funnel_merchants ORDER BY created_at DESC, id')).map(toMerchant);
}

// Nové heslo zneplatní odkaz na obnovu aj všetky existujúce relácie
async function setPassword(id, passwordHash) {
  await db.run(
    `UPDATE funnel_merchants SET password_hash = ?, session_version = session_version + 1,
       reset_token_hash = NULL, reset_expires = NULL WHERE id = ?`,
    [passwordHash, id],
  );
}

// Odhlási všetky existujúce relácie (napr. po zapnutí/vypnutí 2FA)
async function bumpSession(id) {
  await db.run('UPDATE funnel_merchants SET session_version = session_version + 1 WHERE id = ?', [id]);
}

// Uloží funnel iba ak ho medzitým nezmenila iná požiadavka (ani na inom serveri); vráti false pri konflikte
async function saveFunnel(id, funnel, version) {
  const changes = await db.run(
    'UPDATE funnel_merchants SET funnel = ?, funnel_version = funnel_version + 1 WHERE id = ? AND funnel_version = ?',
    [JSON.stringify(funnel), id, version],
  );
  return changes === 1;
}

// 2FA: zapíše použitý krok TOTP iba ak je novší ako posledný => ten istý kód neprejde dvakrát,
// ani pri súbežných požiadavkách na rôznych serveroch
async function useTotpStep(id, step) {
  return (await db.run('UPDATE funnel_merchants SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', [step, id, step])) === 1;
}

// 2FA: nahradí zoznam záložných kódov iba ak sa medzitým nezmenil (kód sa spotrebuje práve raz)
async function replaceRecoveryCodes(id, before, after) {
  return (await db.run('UPDATE funnel_merchants SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?', [after, id, before])) === 1;
}

// Stav predplatného iba ak je stále pôvodný => zmenu (a e-mail o nej) spracuje práve jedna požiadavka
async function changeSubscriptionStatus(id, from, to) {
  return (await db.run('UPDATE funnel_merchants SET subscription_status = ? WHERE id = ? AND subscription_status = ?', [to, id, from])) === 1;
}

// Pri vypínaní servera
const close = () => db.close();

module.exports = {
  getMerchant,
  getMerchantByEmail,
  getMerchantByPlatformCustomer,
  getMerchantByAccount,
  getMerchantByResetHash,
  getMerchantByVerifyHash,
  getMerchantByUser,
  getMerchantByUserSync,
  createMerchantForUser,
  listMerchants,
  addEvent,
  pruneEvents,
  stepStats,
  variantStats,
  ping,
  changeEmail,
  deleteMerchant,
  updateMerchant,
  setPassword,
  bumpSession,
  saveFunnel,
  useTotpStep,
  replaceRecoveryCodes,
  changeSubscriptionStatus,
  close,
  MIGRATIONS,
  EVENT_MIGRATIONS,
};
