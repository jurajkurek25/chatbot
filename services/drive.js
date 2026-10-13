'use strict';
/**
 * Disk: priečinky a súbory účtu (majiteľ + tím podľa roly), odkazy na zdieľanie (heslo, platnosť,
 * nahrávanie) a priečinky pre klientov v členskej sekcii. Súbory ležia na disku servera (data/drive).
 * Zmazanie ide najprv do koša (30 dní), celý podstrom naraz (rovnaký trashed_at).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const DIR = path.join(__dirname, '..', 'data', 'drive');
const TRASH_DAYS = 30;
const quotaBytes = () => (Number(process.env.DRIVE_QUOTA_MB) || 5120) * 1024 * 1024;
const secret = () => process.env.JWT_SECRET || 'changeme';
const now = () => Math.floor(Date.now() / 1000);

/* ── Prístup: majiteľ alebo člen tímu (readonly / editor) ───────── */

const { roleIn, canWrite } = require('./workspace');

/* ── Položky a strom ────────────────────────────────────────────── */

const getItem = (ownerId, id) => getDb().prepare('SELECT * FROM drive_items WHERE id = ? AND owner_id = ?').get(id, ownerId);
const liveItem = (ownerId, id) => getDb().prepare('SELECT * FROM drive_items WHERE id = ? AND owner_id = ? AND trashed_at IS NULL').get(id, ownerId);

function children(ownerId, parentId) {
  return getDb().prepare(`SELECT * FROM drive_items WHERE owner_id = ? AND parent_id IS ? AND trashed_at IS NULL
                          ORDER BY kind DESC, name COLLATE NOCASE`).all(ownerId, parentId || null);
}

/** Cesta od koreňa (bez koreňa) – pre drobčekovú navigáciu. */
function pathOf(ownerId, id) {
  const out = [];
  let cur = id ? getItem(ownerId, id) : null;
  for (let guard = 0; cur && guard < 100; guard++) {
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? getItem(ownerId, cur.parent_id) : null;
  }
  return out;
}

/** Je `id` v podstrome `rootId` (vrátane neho samého)? */
function isWithin(ownerId, id, rootId) {
  let cur = id ? getItem(ownerId, id) : null;
  for (let guard = 0; cur && guard < 100; guard++) {
    if (cur.id === rootId) return true;
    cur = cur.parent_id ? getItem(ownerId, cur.parent_id) : null;
  }
  return false;
}

function descendants(ownerId, id) {
  return getDb().prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT d.id FROM drive_items d JOIN t ON d.parent_id = t.id WHERE d.owner_id = ?)
                          SELECT d.* FROM drive_items d JOIN t ON t.id = d.id`).all(id, ownerId);
}

const usage = ownerId => getDb().prepare("SELECT COALESCE(SUM(size), 0) AS n FROM drive_items WHERE owner_id = ? AND kind = 'file'").get(ownerId).n;

function cleanName(name) {
  const n = String(name || '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return n === '.' || n === '..' ? '' : n;
}

function createFolder(ownerId, parentId, name, createdBy, extra = {}) {
  const id = uuidv4();
  getDb().prepare(`INSERT INTO drive_items (id, owner_id, parent_id, kind, name, created_by, member_id, member_upload)
                   VALUES (?, ?, ?, 'folder', ?, ?, ?, ?)`)
    .run(id, ownerId, parentId || null, cleanName(name) || 'Nový priečinok', createdBy, extra.memberId || null, extra.memberUpload ? 1 : 0);
  return getItem(ownerId, id);
}

/** Zaeviduje súbor nahraný multerom do DIR (premenuje sa na stored_name). */
function addFile(ownerId, parentId, file, createdBy) {
  const id = uuidv4();
  const original = Buffer.from(file.originalname, 'latin1').toString('utf8'); // multer dekóduje názov ako latin1
  getDb().prepare(`INSERT INTO drive_items (id, owner_id, parent_id, kind, name, stored_name, mime, size, created_by)
                   VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?)`)
    .run(id, ownerId, parentId || null, cleanName(original) || 'súbor', file.filename, file.mimetype || 'application/octet-stream', file.size, createdBy);
  return getItem(ownerId, id);
}

/** Presun / premenovanie; priečinok nejde presunúť do vlastného podstromu. */
function update(ownerId, item, { name, parentId }) {
  const db = getDb();
  if (name !== undefined) {
    const n = cleanName(name);
    if (!n) return { error: 'Zadajte názov.' };
    db.prepare('UPDATE drive_items SET name = ?, updated_at = unixepoch() WHERE id = ?').run(n, item.id);
  }
  if (parentId !== undefined) {
    const target = parentId || null;
    if (target) {
      const folder = liveItem(ownerId, target);
      if (!folder || folder.kind !== 'folder') return { error: 'Cieľový priečinok neexistuje.' };
      if (isWithin(ownerId, target, item.id)) return { error: 'Priečinok sa nedá presunúť do seba samého.' };
    }
    db.prepare('UPDATE drive_items SET parent_id = ?, updated_at = unixepoch() WHERE id = ?').run(target, item.id);
  }
  return { item: getItem(ownerId, item.id) };
}

function trash(ownerId, item) {
  const t = now();
  const ids = descendants(ownerId, item.id).filter(d => !d.trashed_at).map(d => d.id);
  const stmt = getDb().prepare('UPDATE drive_items SET trashed_at = ? WHERE id = ?');
  getDb().transaction(() => ids.forEach(id => stmt.run(t, id)))();
}

/** Obnoví položku s podstromom zmazaným spolu s ňou; ak rodič už neexistuje, ide do koreňa. */
function restore(ownerId, item) {
  const db = getDb();
  const ids = descendants(ownerId, item.id).filter(d => d.trashed_at === item.trashed_at).map(d => d.id);
  const parent = item.parent_id && liveItem(ownerId, item.parent_id);
  db.transaction(() => {
    ids.forEach(id => db.prepare('UPDATE drive_items SET trashed_at = NULL WHERE id = ?').run(id));
    if (!parent) db.prepare('UPDATE drive_items SET parent_id = NULL WHERE id = ?').run(item.id);
  })();
}

/** Položky v koši: iba „vrcholy“ (nie deti zmazané spolu s rodičom). */
function trashList(ownerId) {
  return getDb().prepare(`SELECT d.* FROM drive_items d LEFT JOIN drive_items p ON p.id = d.parent_id
                          WHERE d.owner_id = ? AND d.trashed_at IS NOT NULL AND (p.id IS NULL OR p.trashed_at IS NOT d.trashed_at)
                          ORDER BY d.trashed_at DESC`).all(ownerId);
}

function destroy(ownerId, item) {
  const db = getDb();
  const all = descendants(ownerId, item.id);
  for (const d of all) if (d.stored_name) fs.unlink(path.join(DIR, d.stored_name), () => {});
  db.transaction(() => {
    for (const d of all) db.prepare('DELETE FROM drive_shares WHERE item_id = ?').run(d.id);
    for (const d of all.reverse()) db.prepare('DELETE FROM drive_items WHERE id = ?').run(d.id);
  })();
}

/** Kôš starší ako 30 dní sa zmaže natrvalo (plánovač v server.js). */
function purgeTrash() {
  const old = getDb().prepare('SELECT * FROM drive_items WHERE trashed_at IS NOT NULL AND trashed_at < ?').all(now() - TRASH_DAYS * 86400);
  for (const item of old) if (getItem(item.owner_id, item.id)) destroy(item.owner_id, item);
  return old.length;
}

function search(ownerId, q) {
  const like = `%${String(q).replace(/[%_\\]/g, c => '\\' + c)}%`;
  return getDb().prepare(`SELECT * FROM drive_items WHERE owner_id = ? AND trashed_at IS NULL AND name LIKE ? ESCAPE '\\'
                          ORDER BY kind DESC, name COLLATE NOCASE LIMIT 100`).all(ownerId, like);
}

/* ── Podpísané odkazy na stiahnutie / náhľad ────────────────────── */
// scope: 'u' (prihlásený používateľ / člen), alebo 's:<shareId>' (verejný odkaz)

const sign = body => crypto.createHmac('sha256', secret()).update(`drive.${body}`).digest('base64url');

function fileToken(itemId, scope, ttlSec = 600) {
  const body = Buffer.from(JSON.stringify({ i: itemId, s: scope, e: now() + ttlSec })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readFileToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  if (expected.length !== Buffer.byteLength(sig) || !crypto.timingSafeEqual(expected, Buffer.from(sig))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  return data.e >= now() ? data : null;
}

// Náhľad v prehliadači iba pre bezpečné typy (HTML/SVG by spustili skript na našej doméne)
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav|webm)|text\/plain)$/;

function send(res, item, inline) {
  const file = path.join(DIR, item.stored_name);
  if (!fs.existsSync(file)) return res.status(404).send('Súbor nenájdený.');
  const show = inline && INLINE.test(item.mime);
  res.setHeader('Content-Type', show ? item.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Content-Disposition', `${show ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`);
  res.setHeader('Content-Length', item.size);
  fs.createReadStream(file).pipe(res);
}

/* ── Zdieľanie odkazom ───────────────────────────────────────────── */

const shareUrl = token => `${(process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '')}/s/${token}`;

/** Platný odkaz + jeho položka (položka nesmie byť v koši). */
function shareByToken(token) {
  const s = getDb().prepare('SELECT * FROM drive_shares WHERE token = ? AND revoked_at IS NULL').get(String(token || ''));
  if (!s || (s.expires_at && s.expires_at < now())) return null;
  const item = liveItem(s.owner_id, s.item_id);
  return item ? { share: s, item } : null;
}

/** Kľúč po zadaní hesla (12 h), viazaný na odkaz a jeho heslo (zmena hesla starý kľúč zneplatní). */
const passwordTag = s => crypto.createHash('sha256').update(String(s.password_hash)).digest('base64url').slice(0, 10);
const unlockKey = s => fileToken(s.id, `k:${passwordTag(s)}`, 12 * 3600);
function unlocked(s, key) {
  if (!s.password_hash) return true;
  const t = readFileToken(key);
  return !!t && t.i === s.id && t.s === `k:${passwordTag(s)}`;
}

/* ── Priečinky klientov (členská sekcia) ─────────────────────────── */

function clientsRoot(ownerId) {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM drive_items WHERE owner_id = ? AND parent_id IS NULL AND kind = 'folder' AND system = 'clients' AND trashed_at IS NULL").get(ownerId);
  if (existing) return existing;
  const f = createFolder(ownerId, null, 'Klienti', 'system');
  db.prepare("UPDATE drive_items SET system = 'clients' WHERE id = ?").run(f.id);
  return getItem(ownerId, f.id);
}

/** Priečinky prepojené s členom (vrátane podpriečinkov ich obsahu nie). */
const memberFolders = (ownerId, memberId) => getDb().prepare(`SELECT * FROM drive_items WHERE owner_id = ? AND member_id = ? AND kind = 'folder' AND trashed_at IS NULL ORDER BY name COLLATE NOCASE`).all(ownerId, memberId);

/** Koreňový klientsky priečinok, pod ktorým leží položka (alebo null). */
function memberRootOf(ownerId, memberId, itemId) {
  return memberFolders(ownerId, memberId).find(f => isWithin(ownerId, itemId, f.id)) || null;
}

/** Kópia súboru z Disku na iné miesto (digitálny produkt, lead magnet…). */
function copyOut(item, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const name = `${uuidv4()}${path.extname(item.name).toLowerCase().replace(/[^.\w]/g, '')}`;
  fs.copyFileSync(path.join(DIR, item.stored_name), path.join(destDir, name));
  return name;
}

module.exports = {
  DIR, quotaBytes, roleIn, canWrite, getItem, liveItem, children, pathOf, isWithin, descendants, usage,
  createFolder, addFile, update, trash, restore, trashList, destroy, purgeTrash, search, cleanName,
  fileToken, readFileToken, send, shareUrl, shareByToken, unlockKey, unlocked,
  clientsRoot, memberFolders, memberRootOf, copyOut,
};

// Súbory a priečinky Disku sa dajú prepájať s úlohami, poznámkami, udalosťami…
require('./links').registerType('file', {
  label: 'Súbor', icon: '📎',
  resolve(ownerId, id) {
    const it = liveItem(ownerId, id);
    return it ? { title: it.name, url: `/dashboard?view=drive&item=${encodeURIComponent(id)}`, kind: it.kind } : null;
  },
});
