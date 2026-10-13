'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const payments = require('../services/payments');
const shop = require('../services/shop');

const router = express.Router();
const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const TYPES = ['file', 'course', 'membership'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

fs.mkdirSync(shop.FILES_DIR, { recursive: true });
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, shop.FILES_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '')}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});
const coverUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { const d = path.join(__dirname, '..', 'uploads', 'shop-covers'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '') || '.png'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});

/* ════════════════════════════════════════════════════════════════
   OWNER (dashboard)
   ════════════════════════════════════════════════════════════════ */

function ownedProduct(req, res, next) {
  const p = getDb().prepare('SELECT * FROM digital_products WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Produkt nenájdený.' });
  req.product = p;
  next();
}
const own = [requireAuth, ownedProduct];

/** Owner check for module / lesson / file ids (joined through the product). */
function ownedVia(table, idParam) {
  const sql = {
    module: 'SELECT m.* FROM course_modules m JOIN digital_products p ON p.id = m.product_id WHERE m.id = ? AND p.user_id = ?',
    lesson: 'SELECT l.* FROM course_lessons l JOIN digital_products p ON p.id = l.product_id WHERE l.id = ? AND p.user_id = ?',
    file:   'SELECT f.* FROM digital_files f JOIN digital_products p ON p.id = f.product_id WHERE f.id = ? AND p.user_id = ?',
  }[table];
  return [requireAuth, (req, res, next) => {
    const row = getDb().prepare(sql).get(req.params[idParam], req.userId);
    if (!row) return res.status(404).json({ error: 'Nenájdené.' });
    req.row = row;
    next();
  }];
}

router.get('/settings', requireAuth, (req, res) => {
  const s = getDb().prepare('SELECT * FROM shop_settings WHERE user_id = ?').get(req.userId) || {};
  res.json({ ...shop.storeOf(req.userId), storeName: s.store_name || '', membersUrl: `${appUrl()}/members/${req.userId}`, payments: payments.publicStatus(payments.getMerchant(req.userId)) });
});

router.put('/settings', requireAuth, (req, res) => {
  const b = req.body || {};
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO shop_settings (user_id) VALUES (?)').run(req.userId);
  db.prepare('UPDATE shop_settings SET store_name = ?, primary_color = ?, support_email = ?, custom_css = ? WHERE user_id = ?')
    .run(String(b.storeName || '').slice(0, 100), /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#5b4fff',
         EMAIL.test(b.supportEmail || '') ? b.supportEmail : '', String(b.customCss || '').replace(/<\/?style/gi, '').slice(0, 20000), req.userId);
  res.json({ ok: true });
});

router.get('/products', requireAuth, (req, res) => {
  res.json(getDb().prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM digital_files f WHERE f.product_id = p.id) AS file_count,
      (SELECT COUNT(*) FROM course_lessons l WHERE l.product_id = p.id) AS lesson_count,
      (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id AND o.status IN ('paid', 'free')) AS sales,
      (SELECT COALESCE(SUM(o.amount - o.amount_refunded), 0) FROM orders o WHERE o.product_id = p.id AND o.status IN ('paid', 'refunded')) AS revenue
    FROM digital_products p WHERE p.user_id = ? ORDER BY p.display_order, p.created_at DESC`).all(req.userId)
    .map(p => ({ ...p, url: `${appUrl()}/p/${p.id}` })));
});

function productFields(b, prev = {}) {
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 3650) : d; };
  return {
    type: TYPES.includes(b.type) ? b.type : (prev.type || 'file'),
    title: b.title !== undefined ? String(b.title).trim().slice(0, 150) : prev.title,
    subtitle: b.subtitle !== undefined ? String(b.subtitle).trim().slice(0, 250) : (prev.subtitle || ''),
    description: b.description !== undefined ? String(b.description).slice(0, 20000) : (prev.description || ''),
    price: b.price !== undefined ? (b.price === '' || b.price === null ? null : Math.max(0, parseFloat(b.price) || 0)) : (prev.price ?? null),
    currency: String(b.currency || prev.currency || 'EUR').toUpperCase().slice(0, 3),
    access_days: int(b.accessDays, prev.access_days || 0),
    thank_you: b.thankYou !== undefined ? String(b.thankYou).slice(0, 2000) : (prev.thank_you || ''),
    active: b.active !== undefined ? (b.active ? 1 : 0) : (prev.active ?? 1),
  };
}

router.post('/products', requireAuth, (req, res) => {
  const f = productFields(req.body || {});
  if (!f.title) return res.status(400).json({ error: 'Zadajte názov.' });
  const id = uuidv4();
  getDb().prepare(`INSERT INTO digital_products (id, user_id, type, title, subtitle, description, price, currency, access_days, thank_you, active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.userId, f.type, f.title, f.subtitle, f.description, f.price, f.currency, f.access_days, f.thank_you, f.active);
  res.json({ ok: true, id });
});

function fullProduct(p) {
  const db = getDb();
  const files = db.prepare('SELECT id, lesson_id, original_name, size, mime FROM digital_files WHERE product_id = ? ORDER BY created_at').all(p.id);
  const modules = db.prepare('SELECT * FROM course_modules WHERE product_id = ? ORDER BY position, rowid').all(p.id).map(m => ({
    ...m, lessons: db.prepare('SELECT * FROM course_lessons WHERE module_id = ? ORDER BY position, rowid').all(m.id)
      .map(l => ({ ...l, files: files.filter(f => f.lesson_id === l.id), embeddable: !!shop.videoEmbed(l.video_url) })),
  }));
  return {
    ...p, url: `${appUrl()}/p/${p.id}`, files: files.filter(f => !f.lesson_id), modules,
    includes: db.prepare('SELECT product_id FROM membership_includes WHERE membership_id = ?').all(p.id).map(r => r.product_id),
  };
}

router.get('/products/:id', own, (req, res) => res.json(fullProduct(req.product)));

router.put('/products/:id', own, (req, res) => {
  const f = productFields(req.body || {}, req.product);
  getDb().prepare(`UPDATE digital_products SET type = ?, title = ?, subtitle = ?, description = ?, price = ?, currency = ?, access_days = ?, thank_you = ?, active = ? WHERE id = ?`)
    .run(f.type, f.title || req.product.title, f.subtitle, f.description, f.price, f.currency, f.access_days, f.thank_you, f.active, req.product.id);
  if (Array.isArray(req.body?.includes) && f.type === 'membership') {
    const db = getDb();
    const mine = db.prepare("SELECT id FROM digital_products WHERE user_id = ? AND type != 'membership'").all(req.userId).map(r => r.id);
    db.prepare('DELETE FROM membership_includes WHERE membership_id = ?').run(req.product.id);
    for (const pid of req.body.includes) if (mine.includes(pid)) db.prepare('INSERT OR IGNORE INTO membership_includes (membership_id, product_id) VALUES (?, ?)').run(req.product.id, pid);
  }
  res.json(fullProduct(getDb().prepare('SELECT * FROM digital_products WHERE id = ?').get(req.product.id)));
});

router.delete('/products/:id', own, (req, res) => {
  const db = getDb();
  for (const f of db.prepare('SELECT stored_name FROM digital_files WHERE product_id = ?').all(req.product.id)) {
    fs.unlink(path.join(shop.FILES_DIR, f.stored_name), () => {});
  }
  db.prepare('DELETE FROM digital_products WHERE id = ?').run(req.product.id);
  res.json({ ok: true });
});

router.post('/products/:id/cover', requireAuth, coverUpload.single('cover'), ownedProduct, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nahrajte obrázok (JPG, PNG, WebP).' });
  const url = `/uploads/shop-covers/${req.file.filename}`;
  getDb().prepare('UPDATE digital_products SET cover_url = ? WHERE id = ?').run(url, req.product.id);
  res.json({ cover_url: url });
});

router.post('/products/:id/files', requireAuth, fileUpload.single('file'), ownedProduct, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Vyberte súbor.' });
  const db = getDb();
  const lessonId = req.body?.lessonId && db.prepare('SELECT id FROM course_lessons WHERE id = ? AND product_id = ?').get(req.body.lessonId, req.product.id)?.id;
  const id = uuidv4();
  // multer decodes the original name as latin1
  const original = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);
  db.prepare('INSERT INTO digital_files (id, product_id, lesson_id, stored_name, original_name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.product.id, lessonId || null, req.file.filename, original, req.file.mimetype || 'application/octet-stream', req.file.size);
  res.json({ id, original_name: original, size: req.file.size });
});

router.delete('/files/:fileId', ...ownedVia('file', 'fileId'), (req, res) => {
  fs.unlink(path.join(shop.FILES_DIR, req.row.stored_name), () => {});
  getDb().prepare('DELETE FROM digital_files WHERE id = ?').run(req.row.id);
  res.json({ ok: true });
});

/* ── Curriculum ────────────────────────────────────────────────── */

router.post('/products/:id/modules', own, (req, res) => {
  const db = getDb();
  const id = uuidv4();
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM course_modules WHERE product_id = ?').get(req.product.id).n;
  db.prepare('INSERT INTO course_modules (id, product_id, title, position) VALUES (?, ?, ?, ?)').run(id, req.product.id, String(req.body?.title || 'Nový modul').slice(0, 150), pos);
  res.json({ id });
});

router.put('/modules/:mid', ...ownedVia('module', 'mid'), (req, res) => {
  getDb().prepare('UPDATE course_modules SET title = ? WHERE id = ?').run(String(req.body?.title || req.row.title).slice(0, 150), req.row.id);
  res.json({ ok: true });
});

router.delete('/modules/:mid', ...ownedVia('module', 'mid'), (req, res) => {
  const db = getDb();
  for (const f of db.prepare('SELECT f.stored_name FROM digital_files f JOIN course_lessons l ON l.id = f.lesson_id WHERE l.module_id = ?').all(req.row.id)) {
    fs.unlink(path.join(shop.FILES_DIR, f.stored_name), () => {});
  }
  db.prepare('DELETE FROM course_modules WHERE id = ?').run(req.row.id);
  res.json({ ok: true });
});

router.post('/modules/:mid/lessons', ...ownedVia('module', 'mid'), (req, res) => {
  const db = getDb();
  const id = uuidv4();
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM course_lessons WHERE module_id = ?').get(req.row.id).n;
  db.prepare('INSERT INTO course_lessons (id, module_id, product_id, title, position) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.row.id, req.row.product_id, String(req.body?.title || 'Nová lekcia').slice(0, 150), pos);
  res.json({ id });
});

router.put('/lessons/:lid', ...ownedVia('lesson', 'lid'), (req, res) => {
  const b = req.body || {}, l = req.row;
  const video = b.videoUrl !== undefined ? String(b.videoUrl).trim().slice(0, 500) : l.video_url;
  if (video && !/^https:\/\//i.test(video)) return res.status(400).json({ error: 'Odkaz na video musí začínať https://' });
  getDb().prepare('UPDATE course_lessons SET title = ?, content = ?, video_url = ?, free_preview = ? WHERE id = ?')
    .run(b.title !== undefined ? String(b.title).trim().slice(0, 150) || l.title : l.title,
         b.content !== undefined ? String(b.content).slice(0, 50000) : l.content, video,
         b.freePreview !== undefined ? (b.freePreview ? 1 : 0) : l.free_preview, l.id);
  res.json({ ok: true, embeddable: !!shop.videoEmbed(video) });
});

router.delete('/lessons/:lid', ...ownedVia('lesson', 'lid'), (req, res) => {
  const db = getDb();
  for (const f of db.prepare('SELECT stored_name FROM digital_files WHERE lesson_id = ?').all(req.row.id)) fs.unlink(path.join(shop.FILES_DIR, f.stored_name), () => {});
  db.prepare('DELETE FROM course_lessons WHERE id = ?').run(req.row.id);
  res.json({ ok: true });
});

/** PUT /products/:id/curriculum { modules: [{ id, lessons: [lessonId…] }] } — reorder */
router.put('/products/:id/curriculum', own, (req, res) => {
  const db = getDb();
  const mods = Array.isArray(req.body?.modules) ? req.body.modules : [];
  db.transaction(() => mods.forEach((m, i) => {
    db.prepare('UPDATE course_modules SET position = ? WHERE id = ? AND product_id = ?').run(i, m.id, req.product.id);
    (Array.isArray(m.lessons) ? m.lessons : []).forEach((lid, j) =>
      db.prepare('UPDATE course_lessons SET position = ?, module_id = ? WHERE id = ? AND product_id = ?').run(j, m.id, lid, req.product.id));
  }))();
  res.json({ ok: true });
});

/* ── Orders & members ──────────────────────────────────────────── */

router.get('/orders', requireAuth, (req, res) => {
  res.json(getDb().prepare(`SELECT id, product_id, product_title, email, name, amount, amount_refunded, currency, status, created_at, paid_at
                            FROM orders WHERE user_id = ? AND status != 'pending' AND status != 'expired' ORDER BY created_at DESC LIMIT 200`).all(req.userId));
});

router.post('/orders/:orderId/refund', requireAuth, async (req, res) => {
  const db = getDb();
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.orderId, req.userId);
  if (!o) return res.status(404).json({ error: 'Objednávka nenájdená.' });
  const left = o.amount - o.amount_refunded;
  if (o.status !== 'paid' || left <= 0 || !o.stripe_payment_intent) return res.status(400).json({ error: 'Objednávku nie je možné vrátiť.' });
  try { await payments.refund(req.userId, o.stripe_payment_intent, left); }
  catch (e) { return res.status(502).json({ error: 'Stripe: ' + e.message }); }
  db.prepare("UPDATE orders SET amount_refunded = amount, status = 'refunded' WHERE id = ?").run(o.id);
  if (o.member_id) db.prepare('UPDATE product_access SET revoked = 1 WHERE member_id = ? AND product_id = ? AND order_id = ?').run(o.member_id, o.product_id, o.id);
  res.json({ ok: true });
});

router.get('/members', requireAuth, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM members WHERE user_id = ? ORDER BY created_at DESC LIMIT 500').all(req.userId).map(m => ({
    ...m, access: db.prepare(`SELECT a.product_id, a.expires_at, a.revoked, p.title FROM product_access a JOIN digital_products p ON p.id = a.product_id WHERE a.member_id = ?`).all(m.id),
  })));
});

/** Grants a product manually (gift, bank transfer…) and e-mails access. */
router.post('/members', requireAuth, async (req, res) => {
  const { email, name, productId } = req.body || {};
  if (!EMAIL.test(email || '')) return res.status(400).json({ error: 'Neplatný e-mail.' });
  const product = getDb().prepare('SELECT * FROM digital_products WHERE id = ? AND user_id = ?').get(productId, req.userId);
  if (!product) return res.status(404).json({ error: 'Produkt nenájdený.' });
  const order = shop.createOrder({ userId: req.userId, product, email, name, amount: 0 });
  await shop.fulfilOrder(order.id);
  res.json({ ok: true });
});

router.delete('/members/:memberId/access/:productId', requireAuth, (req, res) => {
  getDb().prepare(`UPDATE product_access SET revoked = 1 WHERE member_id = ? AND product_id = ?
                   AND member_id IN (SELECT id FROM members WHERE user_id = ?)`).run(req.params.memberId, req.params.productId, req.userId);
  res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════
   PUBLIC: product page, checkout, downloads
   ════════════════════════════════════════════════════════════════ */

function curriculumOutline(productId) {
  const db = getDb();
  return db.prepare('SELECT id, title FROM course_modules WHERE product_id = ? ORDER BY position, rowid').all(productId).map(m => ({
    title: m.title,
    lessons: db.prepare('SELECT id, title, free_preview, video_url, content FROM course_lessons WHERE module_id = ? ORDER BY position, rowid').all(m.id)
      .map(l => ({ id: l.id, title: l.title, preview: !!l.free_preview, hasVideo: !!l.video_url,
        ...(l.free_preview ? { content: l.content, embed: shop.videoEmbed(l.video_url), videoUrl: shop.videoEmbed(l.video_url) ? null : l.video_url } : {}) })),
  }));
}

router.get('/public/:productId', (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM digital_products WHERE id = ? AND active = 1').get(req.params.productId);
  if (!p) return res.status(404).json({ error: 'Produkt nie je dostupný.' });
  const merchantReady = payments.isReady(payments.getMerchant(p.user_id));
  res.json({
    id: p.id, type: p.type, title: p.title, subtitle: p.subtitle, description: p.description, coverUrl: p.cover_url,
    price: p.price, currency: p.currency, accessDays: p.access_days, free: !(p.price > 0),
    purchasable: !(p.price > 0) || merchantReady, store: shop.storeOf(p.user_id), storeId: p.user_id,
    files: db.prepare('SELECT original_name, size FROM digital_files WHERE product_id = ? AND lesson_id IS NULL').all(p.id),
    curriculum: p.type !== 'file' ? curriculumOutline(p.id) : [],
    includes: p.type === 'membership' ? db.prepare(`SELECT p.title, p.type FROM membership_includes i JOIN digital_products p ON p.id = i.product_id WHERE i.membership_id = ? AND p.active = 1`).all(p.id) : [],
  });
});

router.post('/public/:productId/checkout', async (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM digital_products WHERE id = ? AND active = 1').get(req.params.productId);
  if (!p) return res.status(404).json({ error: 'Produkt nie je dostupný.' });
  const { email, name, consent } = req.body || {};
  if (!EMAIL.test(email || '')) return res.status(400).json({ error: 'Zadajte platný e-mail.' });
  if (!consent) return res.status(400).json({ error: 'Potvrďte súhlas s podmienkami.' });
  const amount = p.price > 0 ? payments.toCents(p.price) : 0;
  if (amount && !payments.isReady(payments.getMerchant(p.user_id))) return res.status(503).json({ error: 'Predajca zatiaľ neprijíma platby online.' });
  const order = shop.createOrder({ userId: p.user_id, product: p, email, name, amount });
  if (!amount) {
    await shop.fulfilOrder(order.id);
    return res.json({ free: true });
  }
  try {
    const session = await payments.createCheckout(p.user_id, {
      kind: 'order', ref: order.id, amount, currency: p.currency, name: p.title, description: p.subtitle || undefined,
      customerEmail: order.email,
      successUrl: `${appUrl()}/members/${p.user_id}?order={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl()}/p/${p.id}?payment=cancelled`,
    });
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, order.id);
    res.json({ checkoutUrl: session.url });
  } catch (e) {
    console.error('[shop checkout]', e.message);
    res.status(502).json({ error: 'Platbu sa nepodarilo spustiť. Skúste to znova.' });
  }
});

/**
 * GET /download/:token — signed link from the purchase e-mail (order-bound) or from the
 * member area (member-bound, "m<memberId>"). Access is re-checked on every download.
 */
router.get('/download/:token', (req, res) => {
  const t = shop.verifyDownloadToken(req.params.token);
  if (!t) return res.status(404).send('Neplatný odkaz.');
  if (t.expired) return res.status(410).send('Platnosť odkazu vypršala. Súbor nájdete v členskej sekcii.');
  const db = getDb();
  const f = db.prepare('SELECT * FROM digital_files WHERE id = ?').get(t.fileId);
  if (!f) return res.status(404).send('Súbor už neexistuje.');
  let allowed = false;
  if (t.orderId.startsWith('m')) allowed = shop.hasAccess(t.orderId.slice(1), f.product_id);
  else {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(t.orderId);
    allowed = !!o && ['paid', 'free'].includes(o.status) && (o.product_id === f.product_id
      || !!db.prepare('SELECT 1 FROM membership_includes WHERE membership_id = ? AND product_id = ?').get(o.product_id, f.product_id));
  }
  if (!allowed) return res.status(403).send('K tomuto súboru nemáte prístup.');
  const file = path.join(shop.FILES_DIR, f.stored_name);
  if (!fs.existsSync(file)) return res.status(404).send('Súbor nenájdený.');
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  fs.createReadStream(file).pipe(res);
});

/* ════════════════════════════════════════════════════════════════
   MEMBER AREA (magic-link login, session JWT in X-Member-Token)
   ════════════════════════════════════════════════════════════════ */

function memberAuth(req, res, next) {
  const m = shop.memberFromToken(req.params.storeId, req.headers['x-member-token']);
  if (!m) return res.status(401).json({ error: 'Prihláste sa.' });
  req.member = m;
  next();
}

router.get('/m/:storeId', (req, res) => {
  if (!getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(req.params.storeId)) return res.status(404).json({ error: 'Obchod nenájdený.' });
  res.json({ store: shop.storeOf(req.params.storeId) });
});

router.post('/m/:storeId/login-request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const m = EMAIL.test(email) && getDb().prepare('SELECT * FROM members WHERE user_id = ? AND email = ?').get(req.params.storeId, email);
  if (m) await shop.sendLoginEmail(m).catch(err => console.error('[shop login mail]', err.message));
  res.json({ ok: true }); // same answer either way: no e-mail enumeration
});

router.post('/m/:storeId/login', (req, res) => {
  const session = shop.redeemLogin(req.params.storeId, req.body?.token);
  if (!session) return res.status(401).json({ error: 'Odkaz je neplatný alebo vypršal. Vyžiadajte si nový.' });
  res.json({ session });
});

/** Return from Stripe Checkout: confirms the order and signs in first-time buyers. */
router.post('/m/:storeId/order', async (req, res) => {
  const db = getDb();
  const o = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ? AND user_id = ?').get(String(req.body?.sessionId || ''), req.params.storeId);
  if (!o) return res.status(404).json({ error: 'Objednávka nenájdená.' });
  let order = o;
  if (!o.paid_at) {
    try {
      const s = await payments.retrieveSession(o.user_id, o.stripe_session_id);
      if (s.payment_status === 'paid') order = await shop.fulfilOrder(o.id, s);
    } catch (e) { console.warn('[shop order sync]', e.message); }
  }
  if (!order.paid_at) return res.json({ status: 'pending' });
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(order.member_id);
  // Only an account created by this very order is signed in automatically — an existing
  // account (someone else's e-mail?) must use the link sent to that inbox.
  const fresh = member && !db.prepare('SELECT 1 FROM orders WHERE member_id = ? AND id != ? AND paid_at IS NOT NULL').get(member.id, order.id);
  res.json({ status: 'paid', email: order.email, session: fresh ? shop.sessionFor(member) : null });
});

router.get('/m/:storeId/me', memberAuth, (req, res) => {
  const db = getDb();
  const ids = shop.accessibleProductIds(req.member.id);
  const products = ids.length ? db.prepare(`SELECT id, type, title, subtitle, cover_url FROM digital_products WHERE id IN (${ids.map(() => '?').join(',')}) AND user_id = ?`).all(...ids, req.params.storeId) : [];
  const access = db.prepare('SELECT product_id, expires_at FROM product_access WHERE member_id = ? AND revoked = 0').all(req.member.id);
  res.json({
    member: { email: req.member.email, name: req.member.name }, store: shop.storeOf(req.params.storeId),
    products: products.map(p => {
      const total = db.prepare('SELECT COUNT(*) AS n FROM course_lessons WHERE product_id = ?').get(p.id).n;
      const done = db.prepare('SELECT COUNT(*) AS n FROM lesson_progress lp JOIN course_lessons l ON l.id = lp.lesson_id WHERE lp.member_id = ? AND l.product_id = ?').get(req.member.id, p.id).n;
      return { ...p, lessons: total, completed: done, expiresAt: access.find(a => a.product_id === p.id)?.expires_at || null };
    }),
  });
});

router.get('/m/:storeId/products/:productId', memberAuth, (req, res) => {
  const db = getDb();
  if (!shop.hasAccess(req.member.id, req.params.productId)) return res.status(403).json({ error: 'K tomuto produktu nemáte prístup.' });
  const p = db.prepare('SELECT * FROM digital_products WHERE id = ? AND user_id = ?').get(req.params.productId, req.params.storeId);
  if (!p) return res.status(404).json({ error: 'Produkt nenájdený.' });
  const done = new Set(db.prepare('SELECT lesson_id FROM lesson_progress WHERE member_id = ?').all(req.member.id).map(r => r.lesson_id));
  const link = f => ({ name: f.original_name, size: f.size, url: `${appUrl()}/api/shop/download/${shop.downloadToken(f.id, 'm' + req.member.id, 1)}` });
  const files = db.prepare('SELECT * FROM digital_files WHERE product_id = ? ORDER BY created_at').all(p.id);
  res.json({
    id: p.id, type: p.type, title: p.title, subtitle: p.subtitle, description: p.description, coverUrl: p.cover_url,
    files: files.filter(f => !f.lesson_id).map(link),
    modules: db.prepare('SELECT * FROM course_modules WHERE product_id = ? ORDER BY position, rowid').all(p.id).map(m => ({
      id: m.id, title: m.title,
      lessons: db.prepare('SELECT * FROM course_lessons WHERE module_id = ? ORDER BY position, rowid').all(m.id).map(l => ({
        id: l.id, title: l.title, content: l.content, embed: shop.videoEmbed(l.video_url), videoUrl: shop.videoEmbed(l.video_url) ? null : (l.video_url || null),
        completed: done.has(l.id), files: files.filter(f => f.lesson_id === l.id).map(link),
      })),
    })),
    includes: p.type === 'membership' ? db.prepare(`SELECT p.id, p.title, p.type FROM membership_includes i JOIN digital_products p ON p.id = i.product_id WHERE i.membership_id = ?`).all(p.id) : [],
  });
});

router.post('/m/:storeId/lessons/:lessonId/progress', memberAuth, (req, res) => {
  const db = getDb();
  const l = db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(req.params.lessonId);
  if (!l || !shop.hasAccess(req.member.id, l.product_id)) return res.status(403).json({ error: 'Bez prístupu.' });
  if (req.body?.completed === false) db.prepare('DELETE FROM lesson_progress WHERE member_id = ? AND lesson_id = ?').run(req.member.id, l.id);
  else db.prepare('INSERT OR IGNORE INTO lesson_progress (member_id, lesson_id) VALUES (?, ?)').run(req.member.id, l.id);
  res.json({ ok: true });
});

module.exports = router;
