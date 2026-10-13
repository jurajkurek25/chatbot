'use strict';
/**
 * Digital products: downloadable files, courses (modules → lessons with video links)
 * and memberships (a member area that unlocks included products, optionally for N days).
 *
 * Buyers become "members" of the merchant's store. They log in with a magic link sent by
 * e-mail; files are delivered by e-mail as signed, expiring download links.
 */

const crypto = require('crypto');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const payments = require('./payments');
const notifyMod = require('./bookingNotify');

const FILES_DIR = path.join(__dirname, '..', 'data', 'digital');
const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const secret = () => process.env.JWT_SECRET || 'changeme';
const esc = notifyMod.esc;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

/* ── Store settings ───────────────────────────────────────────── */

function storeOf(userId) {
  const db = getDb();
  const s = db.prepare('SELECT * FROM shop_settings WHERE user_id = ?').get(userId) || {};
  const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId) || {};
  return {
    name: s.store_name || u.name || 'Obchod', color: /^#[0-9a-f]{6}$/i.test(s.primary_color || '') ? s.primary_color : '#5b4fff',
    supportEmail: s.support_email || u.email || '', customCss: s.custom_css || '',
  };
}

/* ── Video links → embeddable players ─────────────────────────── */

function videoEmbed(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  let m;
  if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
  if (/(^|\.)youtube\.com$/.test(host)) {
    if (u.searchParams.get('v')) return `https://www.youtube-nocookie.com/embed/${u.searchParams.get('v')}`;
    if ((m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/))) return `https://www.youtube-nocookie.com/embed/${m[2]}`;
  }
  if (host === 'vimeo.com' && (m = u.pathname.match(/^\/(\d+)(?:\/(\w+))?/))) return `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ''}`;
  if (host === 'player.vimeo.com') return url;
  if (host === 'loom.com' && (m = u.pathname.match(/^\/(?:share|embed)\/(\w+)/))) return `https://www.loom.com/embed/${m[1]}`;
  if (/wistia\.(com|net)$/.test(host) && (m = u.pathname.match(/\/(?:medias|iframe)\/(\w+)/))) return `https://fast.wistia.net/embed/iframe/${m[1]}`;
  if (host === 'iframe.mediadelivery.net' || host === 'player.mediadelivery.net') return url.replace('/play/', '/embed/');
  if (host === 'drive.google.com' && (m = u.pathname.match(/\/file\/d\/([\w-]+)/))) return `https://drive.google.com/file/d/${m[1]}/preview`;
  return null;
}

/* ── Members & login ──────────────────────────────────────────── */

function upsertMember(userId, email, name) {
  const db = getDb();
  const e = String(email).trim().toLowerCase();
  let m = db.prepare('SELECT * FROM members WHERE user_id = ? AND email = ?').get(userId, e);
  if (!m) {
    db.prepare('INSERT INTO members (id, user_id, email, name) VALUES (?, ?, ?, ?)').run(uuidv4(), userId, e, String(name || '').trim().slice(0, 120));
    m = db.prepare('SELECT * FROM members WHERE user_id = ? AND email = ?').get(userId, e);
  } else if (name && !m.name) {
    db.prepare('UPDATE members SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 120), m.id);
  }
  return m;
}

/** One-time login link, valid 7 days (also used in purchase e-mails). */
function loginLink(member) {
  const token = crypto.randomBytes(24).toString('base64url');
  getDb().prepare('INSERT INTO member_login_tokens (token_hash, member_id, expires_at) VALUES (?, ?, ?)').run(sha(token), member.id, now() + 7 * 86400);
  return `${appUrl()}/members/${member.user_id}?login=${token}`;
}

/** Exchanges a login token for a 30-day member session (JWT). */
function redeemLogin(userId, token) {
  const db = getDb();
  const row = db.prepare(`SELECT t.*, m.user_id FROM member_login_tokens t JOIN members m ON m.id = t.member_id WHERE t.token_hash = ?`).get(sha(String(token || '')));
  if (!row || row.user_id !== userId || row.expires_at < now()) return null;
  // Links may be opened twice (mail scanners, second device): allow reuse within 7 days
  db.prepare('UPDATE member_login_tokens SET used_at = COALESCE(used_at, unixepoch()) WHERE token_hash = ?').run(row.token_hash);
  return sessionFor({ id: row.member_id, user_id: userId });
}

function sessionFor(member) {
  getDb().prepare('UPDATE members SET last_login_at = unixepoch() WHERE id = ?').run(member.id);
  return jwt.sign({ mid: member.id, store: member.user_id, typ: 'member' }, secret(), { expiresIn: '30d' });
}

function memberFromToken(userId, token) {
  try {
    const p = jwt.verify(String(token || ''), secret());
    if (p.typ !== 'member' || p.store !== userId) return null;
    return getDb().prepare('SELECT * FROM members WHERE id = ? AND user_id = ?').get(p.mid, userId) || null;
  } catch { return null; }
}

/* ── Access ───────────────────────────────────────────────────── */

/** Product ids the member can open right now (direct purchases + products inside active memberships). */
function accessibleProductIds(memberId) {
  const db = getDb();
  const direct = db.prepare(`SELECT product_id FROM product_access WHERE member_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > unixepoch())`)
    .all(memberId).map(r => r.product_id);
  const viaMembership = direct.length ? db.prepare(`SELECT product_id FROM membership_includes WHERE membership_id IN (${direct.map(() => '?').join(',')})`)
    .all(...direct).map(r => r.product_id) : [];
  return [...new Set([...direct, ...viaMembership])];
}
const hasAccess = (memberId, productId) => accessibleProductIds(memberId).includes(productId);

function grantAccess(member, product, orderId) {
  const expires = product.access_days > 0 ? now() + product.access_days * 86400 : null;
  getDb().prepare(`INSERT INTO product_access (member_id, product_id, order_id, expires_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(member_id, product_id) DO UPDATE SET order_id = excluded.order_id, revoked = 0, granted_at = unixepoch(),
                   expires_at = CASE WHEN excluded.expires_at IS NULL THEN NULL
                                     ELSE MAX(COALESCE(product_access.expires_at, 0), unixepoch()) + ? END`)
    .run(member.id, product.id, orderId || null, expires, product.access_days * 86400);
}

/* ── Signed download links ────────────────────────────────────── */

function downloadToken(fileId, orderId, days = 7) {
  const exp = now() + days * 86400;
  const body = `${fileId}.${orderId}.${exp}`;
  return `${body}.${crypto.createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

function verifyDownloadToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const [fileId, orderId, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', secret()).update(`${fileId}.${orderId}.${exp}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < now()) return { expired: true };
  return { fileId, orderId };
}

/* ── Orders ───────────────────────────────────────────────────── */

function createOrder({ userId, product, email, name, amount }) {
  const id = uuidv4();
  getDb().prepare(`INSERT INTO orders (id, user_id, product_id, product_title, email, name, amount, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, product.id, product.title, String(email).trim().toLowerCase(), String(name || '').trim().slice(0, 120), amount, product.currency || 'EUR', amount ? 'pending' : 'free');
  return getDb().prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

/** Grants access and e-mails the buyer (idempotent: runs once per order). */
async function fulfilOrder(orderId, session) {
  const db = getDb();
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.paid_at) return o;
  const pi = session && (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id);
  const claimed = db.prepare(`UPDATE orders SET status = CASE WHEN amount > 0 THEN 'paid' ELSE 'free' END, paid_at = unixepoch(),
                              stripe_payment_intent = COALESCE(?, stripe_payment_intent), amount = COALESCE(?, amount)
                              WHERE id = ? AND paid_at IS NULL`).run(pi || null, session?.amount_total ?? null, o.id);
  if (!claimed.changes) return o;
  const product = db.prepare('SELECT * FROM digital_products WHERE id = ?').get(o.product_id);
  const member = upsertMember(o.user_id, o.email, o.name);
  db.prepare('UPDATE orders SET member_id = ? WHERE id = ?').run(member.id, o.id);
  if (product) grantAccess(member, product, o.id);
  await sendPurchaseEmail(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id), product, member)
    .catch(err => console.error('[shop mail]', err.message));
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
}

const money = (cents, cur) => `${(cents / 100).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur || 'EUR'}`;
const TYPE_LABEL = { file: 'Súbor na stiahnutie', course: 'Online kurz', membership: 'Členstvo' };

async function sendPurchaseEmail(order, product, member) {
  const store = storeOf(order.user_id);
  const files = product ? getDb().prepare('SELECT * FROM digital_files WHERE product_id = ? AND lesson_id IS NULL ORDER BY created_at').all(product.id) : [];
  const fileButtons = files.map(f => [`⬇ ${f.original_name}`, `${appUrl()}/api/shop/download/${downloadToken(f.id, order.id)}`]);
  const ctx = { color: store.color, business: store.name };
  return notifyMod.sendMail({
    to: order.email, business: store.name, replyTo: store.supportEmail || undefined,
    subject: `${order.amount ? 'Ďakujeme za nákup' : 'Váš prístup'}: ${order.product_title}`,
    html: notifyMod.layout(ctx, {
      heading: order.amount ? 'Ďakujeme za nákup ✓' : 'Váš prístup je pripravený ✓',
      intro: `Dobrý deň${order.name ? ' ' + esc(order.name) : ''}, ${files.length ? 'súbory si stiahnete tlačidlami nižšie' : 'obsah nájdete vo svojej členskej sekcii'}.${product?.thank_you ? '<br><br>' + esc(product.thank_you).replace(/\n/g, '<br>') : ''}`,
      rows: [
        ['Produkt', esc(order.product_title)],
        product && ['Typ', TYPE_LABEL[product.type] || ''],
        order.amount && ['Zaplatené', esc(money(order.amount, order.currency))],
        product?.access_days > 0 && ['Prístup', `${product.access_days} dní`],
      ],
      buttons: [...fileButtons, ['Otvoriť členskú sekciu', loginLink(member), true]],
      note: files.length ? 'Odkazy na stiahnutie platia 7 dní. Súbory máte kedykoľvek k dispozícii aj v členskej sekcii.' : 'Odkaz na prihlásenie platí 7 dní. Nový si kedykoľvek vyžiadate zadaním e-mailu v členskej sekcii.',
    }),
  });
}

async function sendLoginEmail(member) {
  const store = storeOf(member.user_id);
  return notifyMod.sendMail({
    to: member.email, business: store.name, subject: `Prihlásenie – ${store.name}`,
    html: notifyMod.layout({ color: store.color, business: store.name }, {
      heading: 'Prihlásenie do členskej sekcie', intro: 'Kliknite na tlačidlo a budete prihlásený/á. Heslo nepotrebujete.',
      buttons: [['Prihlásiť sa', loginLink(member), true]], note: 'Odkaz platí 7 dní. Ak ste o prihlásenie nežiadali, e-mail ignorujte.' }),
  });
}

/* ── Stripe fulfilment ────────────────────────────────────────── */

payments.register('order', {
  paid: session => fulfilOrder(session.metadata.ref, session),
  expired: session => getDb().prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(session.metadata.ref),
  refunded: charge => {
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!pi) return;
    const o = getDb().prepare('SELECT * FROM orders WHERE stripe_payment_intent = ?').get(pi);
    if (!o) return;
    getDb().prepare(`UPDATE orders SET amount_refunded = ?, status = CASE WHEN ? >= amount THEN 'refunded' ELSE status END WHERE id = ?`)
      .run(charge.amount_refunded, charge.amount_refunded, o.id);
    if (charge.amount_refunded >= o.amount && o.member_id) {
      getDb().prepare('UPDATE product_access SET revoked = 1 WHERE member_id = ? AND product_id = ? AND order_id = ?').run(o.member_id, o.product_id, o.id);
    }
  },
});

module.exports = {
  FILES_DIR, storeOf, videoEmbed, upsertMember, loginLink, redeemLogin, sessionFor, memberFromToken,
  accessibleProductIds, hasAccess, grantAccess, downloadToken, verifyDownloadToken,
  createOrder, fulfilOrder, sendPurchaseEmail, sendLoginEmail, money,
};
