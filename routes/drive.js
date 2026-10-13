'use strict';
/**
 * Disk (/api/drive): súbory majiteľa a tímu, zdieľanie odkazom (/s/:token), priečinky klientov
 * v členskej sekcii a prenos súborov do digitálnych produktov, lead magnetov a znalostí chatbota.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const drive = require('../services/drive');
const shop = require('../services/shop');
const notifyMod = require('../services/bookingNotify');
const { parseFile } = require('../services/fileParser');
const { rateLimit } = require('../funnel/src/ratelimit');

const router = express.Router();
const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MINUTE = 60 * 1000;

fs.mkdirSync(drive.DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drive.DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 12)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 20 },
});
const unlinkAll = files => (files || []).forEach(f => fs.unlink(f.path, () => {}));

/** Uloží nahraté súbory do priečinka, ak sa zmestia do kvóty účtu; inak ich zmaže. */
function storeUploads(ownerId, parentId, files, createdBy) {
  if (!files?.length) return { error: 'Vyberte súbor.' };
  const total = files.reduce((n, f) => n + f.size, 0);
  if (drive.usage(ownerId) + total > drive.quotaBytes()) {
    unlinkAll(files);
    return { error: 'Na Disku nie je dosť miesta.', status: 413 };
  }
  return { items: files.map(f => drive.addFile(ownerId, parentId, f, createdBy)) };
}

const view = (item, extra = {}) => ({
  id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: item.size,
  updatedAt: item.updated_at, createdAt: item.created_at, system: item.system || null, ...extra,
});

/** E-mail majiteľovi, keď klient nahrá súbory (cez odkaz alebo členskú sekciu). */
function notifyOwner(ownerId, folderPath, names, who) {
  const owner = getDb().prepare('SELECT email, name FROM users WHERE id = ?').get(ownerId);
  if (!owner) return;
  notifyMod.sendMail({
    to: owner.email, business: 'Neoworkly Disk', subject: `Nové súbory na Disku (${names.length})`,
    html: notifyMod.layout({ color: '#5b4fff', business: 'Neoworkly Disk' }, {
      heading: 'Klient nahral súbory',
      intro: `${notifyMod.esc(who)} nahral/a do priečinka <b>${notifyMod.esc(folderPath)}</b>:<br>${names.map(n => '• ' + notifyMod.esc(n)).join('<br>')}`,
      buttons: [['Otvoriť Disk', `${appUrl()}/dashboard?view=drive`, true]],
    }),
  }).catch(() => {});
}

/* ════════════════════════════════════════════════════════════════
   PRIHLÁSENÝ POUŽÍVATEĽ (majiteľ alebo člen tímu, ?ws=<ownerId>)
   ════════════════════════════════════════════════════════════════ */

function workspace(req, res, next) {
  const ownerId = String(req.query.ws || req.body?.ws || req.userId);
  const role = drive.roleIn(req.userId, ownerId);
  if (!role) return res.status(404).json({ error: 'Disk nenájdený.' });
  req.ownerId = ownerId;
  req.role = role;
  next();
}
const writer = (req, res, next) => drive.canWrite(req.role) ? next() : res.status(403).json({ error: 'Máte prístup iba na čítanie.' });
const auth = [requireAuth, workspace];
const by = req => `user:${req.userId}`;

/** Položka v aktuálnom pracovnom priestore (nie v koši). */
function item(req, res, next) {
  const it = drive.liveItem(req.ownerId, req.params.id);
  if (!it) return res.status(404).json({ error: 'Položka nenájdená.' });
  req.item = it;
  next();
}
function folderParam(req) {
  const id = req.query.parentId || req.body?.parentId || null;
  if (!id) return { id: null };
  const f = drive.liveItem(req.ownerId, id);
  return f && f.kind === 'folder' ? { id: f.id } : { error: 'Priečinok neexistuje.' };
}

router.get('/workspaces', requireAuth, (req, res) => {
  const me = getDb().prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  const teams = getDb().prepare(`SELECT t.owner_user_id AS ownerId, t.role, u.name FROM team_members t JOIN users u ON u.id = t.owner_user_id
                                 WHERE t.member_user_id = ? AND t.accepted = 1`).all(req.userId);
  res.json([{ ownerId: req.userId, role: 'owner', name: me?.name || 'Môj disk', mine: true }, ...teams]);
});

router.get('/items', ...auth, (req, res) => {
  const parent = req.query.parent ? drive.liveItem(req.ownerId, req.query.parent) : null;
  if (req.query.parent && (!parent || parent.kind !== 'folder')) return res.status(404).json({ error: 'Priečinok nenájdený.' });
  const db = getDb();
  const shareCount = db.prepare('SELECT COUNT(*) AS n FROM drive_shares WHERE item_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())');
  const memberOf = db.prepare('SELECT email, name FROM members WHERE id = ?');
  res.json({
    role: req.role, folder: parent ? view(parent, { memberUpload: !!parent.member_upload, member: parent.member_id ? memberOf.get(parent.member_id) : null }) : null,
    path: drive.pathOf(req.ownerId, parent?.id),
    items: drive.children(req.ownerId, parent?.id).map(i => view(i, {
      shares: shareCount.get(i.id).n, member: i.member_id ? memberOf.get(i.member_id) : null, memberUpload: !!i.member_upload,
    })),
    usage: drive.usage(req.ownerId), quota: drive.quotaBytes(),
  });
});

router.get('/search', ...auth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  res.json(drive.search(req.ownerId, q).map(i => view(i, { path: drive.pathOf(req.ownerId, i.parent_id).map(p => p.name).join(' / ') })));
});

router.post('/folders', ...auth, writer, (req, res) => {
  const parent = folderParam(req);
  if (parent.error) return res.status(400).json({ error: parent.error });
  res.json(view(drive.createFolder(req.ownerId, parent.id, req.body?.name, by(req))));
});

router.post('/files', ...auth, writer, upload.array('files', 20), (req, res) => {
  const parent = folderParam(req);
  if (parent.error) { unlinkAll(req.files); return res.status(400).json({ error: parent.error }); }
  const r = storeUploads(req.ownerId, parent.id, req.files, by(req));
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json(r.items.map(i => view(i)));
});

router.patch('/items/:id', ...auth, writer, item, (req, res) => {
  const { name, parentId, memberUpload } = req.body || {};
  if (req.item.system && parentId !== undefined) return res.status(400).json({ error: 'Systémový priečinok sa nedá presunúť.' });
  const r = drive.update(req.ownerId, req.item, { name, parentId });
  if (r.error) return res.status(400).json({ error: r.error });
  if (memberUpload !== undefined && req.item.member_id) {
    getDb().prepare('UPDATE drive_items SET member_upload = ? WHERE id = ?').run(memberUpload ? 1 : 0, req.item.id);
  }
  res.json(view(drive.getItem(req.ownerId, req.item.id)));
});

router.delete('/items/:id', ...auth, writer, item, (req, res) => {
  drive.trash(req.ownerId, req.item);
  res.json({ ok: true });
});

router.get('/trash', ...auth, (req, res) => res.json(drive.trashList(req.ownerId).map(i => view(i, { trashedAt: i.trashed_at }))));

router.post('/trash/:id/restore', ...auth, writer, (req, res) => {
  const it = drive.getItem(req.ownerId, req.params.id);
  if (!it || !it.trashed_at) return res.status(404).json({ error: 'Položka nie je v koši.' });
  drive.restore(req.ownerId, it);
  res.json({ ok: true });
});

router.delete('/trash/:id', ...auth, writer, (req, res) => {
  const it = drive.getItem(req.ownerId, req.params.id);
  if (!it || !it.trashed_at) return res.status(404).json({ error: 'Položka nie je v koši.' });
  drive.destroy(req.ownerId, it);
  res.json({ ok: true });
});

router.delete('/trash', ...auth, writer, (req, res) => {
  const items = drive.trashList(req.ownerId);
  items.forEach(i => drive.destroy(req.ownerId, i));
  res.json({ ok: true, deleted: items.length });
});

/** Krátkodobý odkaz na stiahnutie / náhľad (prehliadač nevie poslať hlavičku Authorization). */
router.get('/items/:id/url', ...auth, item, (req, res) => {
  if (req.item.kind !== 'file') return res.status(400).json({ error: 'Priečinok sa nedá stiahnuť.' });
  res.json({ url: `/api/drive/f/${drive.fileToken(req.item.id, 'u')}${req.query.inline ? '?inline=1' : ''}` });
});

/* ── Zdieľanie odkazom ───────────────────────────────────────────── */

const shareView = s => ({
  id: s.id, url: drive.shareUrl(s.token), allowUpload: !!s.allow_upload, hasPassword: !!s.password_hash,
  expiresAt: s.expires_at, createdAt: s.created_at, downloads: s.downloads,
});

router.get('/items/:id/shares', ...auth, item, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM drive_shares WHERE item_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(req.item.id).map(shareView));
});

router.post('/items/:id/shares', ...auth, writer, item, async (req, res) => {
  const { allowUpload, password, expiresDays } = req.body || {};
  if (allowUpload && req.item.kind !== 'folder') return res.status(400).json({ error: 'Nahrávať sa dá iba do zdieľaného priečinka.' });
  if (password && String(password).length < 4) return res.status(400).json({ error: 'Heslo musí mať aspoň 4 znaky.' });
  const days = parseInt(expiresDays, 10);
  const id = uuidv4();
  getDb().prepare(`INSERT INTO drive_shares (id, owner_id, item_id, token, allow_upload, password_hash, expires_at, created_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.ownerId, req.item.id, crypto.randomBytes(18).toString('base64url'), allowUpload ? 1 : 0,
      password ? await bcrypt.hash(String(password), 10) : null, days > 0 ? Math.floor(Date.now() / 1000) + Math.min(days, 3650) * 86400 : null, by(req));
  res.json(shareView(getDb().prepare('SELECT * FROM drive_shares WHERE id = ?').get(id)));
});

router.delete('/shares/:shareId', ...auth, writer, (req, res) => {
  getDb().prepare('UPDATE drive_shares SET revoked_at = unixepoch() WHERE id = ? AND owner_id = ?').run(req.params.shareId, req.ownerId);
  res.json({ ok: true });
});

/* ── Priečinky klientov (členská sekcia) ─────────────────────────── */

async function sendClientMail(ownerId, member, folderName) {
  const store = shop.storeOf(ownerId);
  return notifyMod.sendMail({
    to: member.email, business: store.name, replyTo: store.supportEmail || undefined, subject: `Máte nové dokumenty – ${store.name}`,
    html: notifyMod.layout({ color: store.color, business: store.name }, {
      heading: 'Máte nové dokumenty', intro: `V priečinku <b>${notifyMod.esc(folderName)}</b> na vás čakajú dokumenty. Nájdete ich v členskej sekcii – heslo nepotrebujete.`,
      buttons: [['Otvoriť dokumenty', shop.loginLink(member), true]], note: 'Odkaz platí 7 dní. Nový si vyžiadate zadaním e-mailu v členskej sekcii.',
    }),
  });
}

router.post('/client-folders', ...auth, writer, async (req, res) => {
  const { email, name, memberUpload, notify } = req.body || {};
  if (!EMAIL.test(email || '')) return res.status(400).json({ error: 'Zadajte e-mail klienta.' });
  const member = shop.upsertMember(req.ownerId, email, name);
  const root = drive.clientsRoot(req.ownerId);
  const folder = drive.createFolder(req.ownerId, root.id, name ? `${name} (${member.email})` : member.email, by(req), { memberId: member.id, memberUpload });
  if (notify) await sendClientMail(req.ownerId, member, folder.name).catch(() => {});
  res.json(view(folder));
});

router.post('/items/:id/notify-client', ...auth, writer, item, async (req, res) => {
  const root = req.item.member_id ? req.item : null;
  const member = root && getDb().prepare('SELECT * FROM members WHERE id = ?').get(root.member_id);
  if (!member) return res.status(400).json({ error: 'Priečinok nepatrí klientovi.' });
  const sent = await sendClientMail(req.ownerId, member, root.name).catch(() => false);
  res.json({ ok: true, sent });
});

/* ── Prepojenie s modulmi: kópia súboru z Disku ─────────────────── */

router.get('/targets', ...auth, (req, res) => {
  const db = getDb();
  res.json({
    products: db.prepare('SELECT id, title, type FROM digital_products WHERE user_id = ? ORDER BY created_at DESC').all(req.ownerId).map(p => ({
      ...p, lessons: db.prepare('SELECT id, title FROM course_lessons WHERE product_id = ? ORDER BY position, rowid').all(p.id),
    })),
    leadMagnets: db.prepare('SELECT lm.id, lm.name, w.name AS widget FROM lead_magnets lm JOIN widgets w ON w.id = lm.widget_id WHERE w.user_id = ? ORDER BY lm.created_at DESC').all(req.ownerId),
    widgets: db.prepare('SELECT id, name FROM widgets WHERE user_id = ? ORDER BY created_at').all(req.ownerId),
  });
});

function fileItem(req, res, next) {
  if (req.item.kind !== 'file') return res.status(400).json({ error: 'Vyberte súbor, nie priečinok.' });
  next();
}

router.post('/items/:id/to-product', ...auth, writer, item, fileItem, (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM digital_products WHERE id = ? AND user_id = ?').get(req.body?.productId, req.ownerId);
  if (!p) return res.status(404).json({ error: 'Produkt nenájdený.' });
  const lessonId = req.body?.lessonId ? db.prepare('SELECT id FROM course_lessons WHERE id = ? AND product_id = ?').get(req.body.lessonId, p.id)?.id : null;
  if (req.body?.lessonId && !lessonId) return res.status(404).json({ error: 'Lekcia nenájdená.' });
  const stored = drive.copyOut(req.item, shop.FILES_DIR);
  db.prepare('INSERT INTO digital_files (id, product_id, lesson_id, stored_name, original_name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), p.id, lessonId, stored, req.item.name, req.item.mime, req.item.size);
  res.json({ ok: true });
});

router.post('/items/:id/to-lead-magnet', ...auth, writer, item, fileItem, (req, res) => {
  const db = getDb();
  const lm = db.prepare('SELECT lm.* FROM lead_magnets lm JOIN widgets w ON w.id = lm.widget_id WHERE lm.id = ? AND w.user_id = ?').get(req.body?.leadMagnetId, req.ownerId);
  if (!lm) return res.status(404).json({ error: 'Lead magnet nenájdený.' });
  const dir = path.join(__dirname, '..', 'uploads', 'lead-magnets');
  const stored = drive.copyOut(req.item, dir);
  if (lm.file_path) fs.unlink(lm.file_path, () => {});
  db.prepare('UPDATE lead_magnets SET file_path = ?, file_url = ? WHERE id = ?').run(path.join(dir, stored), `${appUrl()}/uploads/lead-magnets/${stored}`, lm.id);
  res.json({ ok: true });
});

router.post('/items/:id/to-knowledge', ...auth, writer, item, fileItem, async (req, res) => {
  const db = getDb();
  const w = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.body?.widgetId, req.ownerId);
  if (!w) return res.status(404).json({ error: 'Widget nenájdený.' });
  try {
    const content = await parseFile(path.join(drive.DIR, req.item.stored_name), req.item.mime, req.item.name);
    db.prepare("INSERT INTO knowledge_items (id, widget_id, title, content, source_type) VALUES (?, ?, ?, ?, 'pdf')").run(uuidv4(), w.id, req.item.name, content);
    res.json({ ok: true, chars: content.length });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   STIAHNUTIE podľa podpísaného odkazu (všetky spôsoby prístupu)
   ════════════════════════════════════════════════════════════════ */

router.get('/f/:token', (req, res) => {
  const t = drive.readFileToken(req.params.token);
  if (!t) return res.status(410).send('Platnosť odkazu vypršala. Otvorte súbor znova.');
  const it = getDb().prepare("SELECT * FROM drive_items WHERE id = ? AND kind = 'file' AND trashed_at IS NULL").get(t.i);
  if (!it) return res.status(404).send('Súbor nenájdený.');
  // Odkaz zo zdieľania / členskej sekcie: prístup sa overí znova (zrušené zdieľanie, presunutý súbor)
  if (t.s.startsWith('s:')) {
    const s = getDb().prepare('SELECT * FROM drive_shares WHERE id = ? AND revoked_at IS NULL').get(t.s.slice(2));
    if (!s || (s.expires_at && s.expires_at < Date.now() / 1000) || !drive.isWithin(s.owner_id, it.id, s.item_id)) return res.status(403).send('Odkaz už neplatí.');
    getDb().prepare('UPDATE drive_shares SET downloads = downloads + 1 WHERE id = ?').run(s.id);
  } else if (t.s.startsWith('m:')) {
    if (!drive.memberRootOf(it.owner_id, t.s.slice(2), it.id)) return res.status(403).send('K súboru už nemáte prístup.');
  } else if (t.s !== 'u') return res.status(403).send('Neplatný odkaz.');
  drive.send(res, it, req.query.inline === '1');
});

/* ════════════════════════════════════════════════════════════════
   VEREJNÉ ZDIEĽANIE (/s/:token)
   ════════════════════════════════════════════════════════════════ */

const publicLimit = rateLimit({ name: 'drive-public-ip', max: 300, windowMs: 15 * MINUTE, key: req => req.ip });

function share(req, res, next) {
  const found = drive.shareByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'Odkaz neexistuje alebo už neplatí.' });
  req.share = found.share;
  req.root = found.item;
  req.unlocked = drive.unlocked(found.share, req.headers['x-share-key']);
  next();
}
const unlockedOnly = (req, res, next) => req.unlocked ? next() : res.status(401).json({ error: 'Zadajte heslo.', locked: true });
/** Priečinok v rámci zdieľaného podstromu (predvolene jeho koreň). */
function shareFolder(req) {
  const id = req.query.parent || req.root.id;
  const f = drive.liveItem(req.share.owner_id, id);
  return f && f.kind === 'folder' && drive.isWithin(req.share.owner_id, f.id, req.root.id) ? f : null;
}
const relPath = (req, id) => {
  const full = drive.pathOf(req.share.owner_id, id);
  return full.slice(full.findIndex(p => p.id === req.root.id));
};

router.get('/public/:token', publicLimit, share, (req, res) => {
  const owner = shop.storeOf(req.share.owner_id);
  res.json({
    name: req.root.name, kind: req.root.kind, owner: { name: owner.name, color: owner.color },
    locked: !req.unlocked, allowUpload: !!req.share.allow_upload, expiresAt: req.share.expires_at,
    file: req.unlocked && req.root.kind === 'file' ? view(req.root) : null,
  });
});

const unlockLimit = rateLimit({ name: 'drive-unlock', max: 10, windowMs: 15 * MINUTE, key: req => `${req.ip}:${req.params.token}` });
router.post('/public/:token/unlock', unlockLimit, share, async (req, res) => {
  if (!req.share.password_hash) return res.json({ key: null });
  if (!(await bcrypt.compare(String(req.body?.password || ''), req.share.password_hash))) return res.status(401).json({ error: 'Nesprávne heslo.' });
  res.json({ key: drive.unlockKey(req.share) });
});

router.get('/public/:token/items', publicLimit, share, unlockedOnly, (req, res) => {
  if (req.root.kind !== 'folder') return res.status(400).json({ error: 'Zdieľaný je jeden súbor.' });
  const folder = shareFolder(req);
  if (!folder) return res.status(404).json({ error: 'Priečinok nenájdený.' });
  res.json({ folder: view(folder), path: relPath(req, folder.id), items: drive.children(req.share.owner_id, folder.id).map(i => view(i)) });
});

router.get('/public/:token/file/:itemId', publicLimit, share, unlockedOnly, (req, res) => {
  const it = drive.liveItem(req.share.owner_id, req.params.itemId);
  if (!it || it.kind !== 'file' || !drive.isWithin(req.share.owner_id, it.id, req.root.id)) return res.status(404).json({ error: 'Súbor nenájdený.' });
  res.json({ url: `/api/drive/f/${drive.fileToken(it.id, `s:${req.share.id}`)}${req.query.inline ? '?inline=1' : ''}` });
});

const uploadLimit = rateLimit({ name: 'drive-upload-ip', max: 30, windowMs: 15 * MINUTE, key: req => req.ip });
const shareUploadAllowed = (req, res, next) => req.share.allow_upload && req.root.kind === 'folder' ? next() : res.status(403).json({ error: 'Do tohto priečinka sa nedá nahrávať.' });
router.post('/public/:token/upload', uploadLimit, share, unlockedOnly, shareUploadAllowed, upload.array('files', 20), (req, res) => {
  const folder = shareFolder(req);
  if (!folder) { unlinkAll(req.files); return res.status(404).json({ error: 'Priečinok nenájdený.' }); }
  const r = storeUploads(req.share.owner_id, folder.id, req.files, `share:${req.share.id}`);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  notifyOwner(req.share.owner_id, drive.pathOf(req.share.owner_id, folder.id).map(p => p.name).join(' / '), r.items.map(i => i.name), 'Návštevník zdieľaného odkazu');
  res.json(r.items.map(i => view(i)));
});

/* ════════════════════════════════════════════════════════════════
   ČLENSKÁ SEKCIA: priečinky klienta (/api/drive/m/:storeId, X-Member-Token)
   ════════════════════════════════════════════════════════════════ */

function member(req, res, next) {
  const m = shop.memberFromToken(req.params.storeId, req.headers['x-member-token']);
  if (!m) return res.status(401).json({ error: 'Prihláste sa.' });
  req.member = m;
  next();
}
/** Priečinok klienta (koreň alebo podpriečinok) → { folder, root } */
function memberFolder(req, id) {
  const f = id && drive.liveItem(req.params.storeId, id);
  if (!f || f.kind !== 'folder') return null;
  const root = drive.memberRootOf(req.params.storeId, req.member.id, f.id);
  return root ? { folder: f, root } : null;
}

router.get('/m/:storeId/folders', member, (req, res) => {
  res.json(drive.memberFolders(req.params.storeId, req.member.id).map(f => view(f, { canUpload: !!f.member_upload })));
});

router.get('/m/:storeId/items', member, (req, res) => {
  const r = memberFolder(req, req.query.parent);
  if (!r) return res.status(404).json({ error: 'Priečinok nenájdený.' });
  const full = drive.pathOf(req.params.storeId, r.folder.id);
  res.json({
    folder: view(r.folder), canUpload: !!r.root.member_upload, path: full.slice(full.findIndex(p => p.id === r.root.id)),
    items: drive.children(req.params.storeId, r.folder.id).map(i => view(i)),
  });
});

router.get('/m/:storeId/file/:itemId', member, (req, res) => {
  const it = drive.liveItem(req.params.storeId, req.params.itemId);
  if (!it || it.kind !== 'file' || !drive.memberRootOf(req.params.storeId, req.member.id, it.id)) return res.status(404).json({ error: 'Súbor nenájdený.' });
  res.json({ url: `/api/drive/f/${drive.fileToken(it.id, `m:${req.member.id}`)}${req.query.inline ? '?inline=1' : ''}` });
});

router.post('/m/:storeId/upload', uploadLimit, member, upload.array('files', 20), (req, res) => {
  const r = memberFolder(req, req.query.parent);
  if (!r || !r.root.member_upload) { unlinkAll(req.files); return res.status(403).json({ error: 'Do tohto priečinka sa nedá nahrávať.' }); }
  const stored = storeUploads(req.params.storeId, r.folder.id, req.files, `member:${req.member.id}`);
  if (stored.error) return res.status(stored.status || 400).json({ error: stored.error });
  notifyOwner(req.params.storeId, drive.pathOf(req.params.storeId, r.folder.id).map(p => p.name).join(' / '), stored.items.map(i => i.name), req.member.email);
  res.json(stored.items.map(i => view(i)));
});

module.exports = router;
