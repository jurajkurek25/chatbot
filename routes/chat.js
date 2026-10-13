'use strict';
/**
 * Tímový chat (/api/chat, podľa Zulipu): kanály s témami, súkromné kanály, priame správy,
 * @**zmienky**, reakcie, prílohy na Disk, správa → úloha a videohovor (Jitsi) priamo z konverzácie.
 * Písať môžu všetci členovia priestoru (aj „iba na čítanie“); kanály zakladá majiteľ alebo editor.
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const drive = require('../services/drive');
const links = require('../services/links');
const realtime = require('../services/realtime');
const notifications = require('../services/notifications');
const tasks = require('../services/tasks');
const meet = require('../services/meet');

const router = express.Router();
router.use(requireAuth, ws.middleware);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drive.DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 12)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 10 },
});
const EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏', '🔥'];
const MENTION = /@\*\*([^*\n]{1,80})\*\*/g;
const ALL = ['všetci', 'all'];
const db = () => getDb();

/* ── Kanály ─────────────────────────────────────────────────── */

const memberIds = streamId => db().prepare('SELECT user_id FROM chat_members WHERE stream_id = ?').all(streamId).map(r => r.user_id);
/** Kanál, ktorý používateľ vidí (verejný kanál priestoru alebo súkromný/DM, kde je členom). */
function visibleStream(ownerId, userId, id) {
  const s = db().prepare('SELECT * FROM chat_streams WHERE id = ? AND owner_id = ?').get(id, ownerId);
  if (!s) return null;
  if (s.kind === 'stream' && !s.private) return s;
  return memberIds(s.id).includes(userId) ? s : null;
}
/** Kto kanál vidí – komu posielať udalosti a koho môže @**všetci** upozorniť. */
const audience = s => (s.kind === 'stream' && !s.private ? ws.members(s.owner_id).map(m => m.id) : memberIds(s.id));

function deliver(s, event) {
  if (s.kind === 'stream' && !s.private) realtime.publish(s.owner_id, event);
  else memberIds(s.id).forEach(uid => realtime.publishUser(uid, event));
}

/** Pri prvom otvorení chatu vznikne kanál „všeobecné“. */
function ensureDefault(ownerId, userId) {
  if (db().prepare("SELECT 1 FROM chat_streams WHERE owner_id = ? AND kind = 'stream'").get(ownerId)) return;
  db().prepare("INSERT INTO chat_streams (id, owner_id, name, description, created_by) VALUES (?, ?, 'všeobecné', 'Spoločný kanál celého tímu', ?)").run(uuidv4(), ownerId, userId);
}

function unreadOf(userId, streamId) {
  return db().prepare(`SELECT COUNT(*) AS n FROM chat_messages m
    LEFT JOIN chat_reads r ON r.user_id = ? AND r.stream_id = m.stream_id AND r.topic = m.topic
    WHERE m.stream_id = ? AND m.user_id != ? AND m.id > COALESCE(r.last_id, 0)`).get(userId, streamId, userId).n;
}

const userName = id => db().prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || '';
function streamView(s, userId) {
  const v = { id: s.id, kind: s.kind, name: s.name, description: s.description, private: !!s.private, archived: !!s.archived, createdBy: s.created_by, unread: unreadOf(userId, s.id) };
  if (s.kind === 'dm' || s.private) v.members = memberIds(s.id);
  if (s.kind === 'dm') v.name = v.members.filter(id => id !== userId).map(userName).join(', ') || userName(userId);
  v.lastId = db().prepare('SELECT MAX(id) AS id FROM chat_messages WHERE stream_id = ?').get(s.id).id || 0;
  return v;
}

function visibleStreams(ownerId, userId) {
  return db().prepare(`SELECT s.* FROM chat_streams s WHERE s.owner_id = ? AND (
      (s.kind = 'stream' AND s.private = 0) OR EXISTS (SELECT 1 FROM chat_members m WHERE m.stream_id = s.id AND m.user_id = ?))`).all(ownerId, userId);
}

router.get('/streams', (req, res) => {
  ensureDefault(req.ownerId, req.userId);
  const list = visibleStreams(req.ownerId, req.userId).map(s => streamView(s, req.userId));
  list.sort((a, b) => (a.kind === b.kind ? (a.kind === 'dm' ? b.lastId - a.lastId : a.name.localeCompare(b.name, 'sk')) : a.kind === 'stream' ? -1 : 1));
  res.json(list);
});

router.get('/unread', (req, res) => {
  res.json({ unread: visibleStreams(req.ownerId, req.userId).filter(s => !s.archived).reduce((n, s) => n + unreadOf(req.userId, s.id), 0) });
});

const cleanMembers = (ownerId, ids) => [...new Set([].concat(ids || []).map(String))].filter(id => ws.isMember(ownerId, id));

router.post('/streams', ws.writer, (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/^#/, '').slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Zadajte názov kanála.' });
  if (db().prepare("SELECT 1 FROM chat_streams WHERE owner_id = ? AND kind = 'stream' AND lower(name) = lower(?)").get(req.ownerId, name)) return res.status(400).json({ error: 'Kanál s týmto názvom už existuje.' });
  const id = uuidv4();
  const priv = req.body?.private ? 1 : 0;
  db().prepare('INSERT INTO chat_streams (id, owner_id, name, description, private, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.ownerId, name, String(req.body?.description || '').slice(0, 300), priv, req.userId);
  if (priv) cleanMembers(req.ownerId, [req.userId, ...(req.body?.members || [])]).forEach(uid => db().prepare('INSERT INTO chat_members (stream_id, user_id) VALUES (?, ?)').run(id, uid));
  const s = db().prepare('SELECT * FROM chat_streams WHERE id = ?').get(id);
  deliver(s, { type: 'chat', op: 'streams' });
  res.json(streamView(s, req.userId));
});

function stream(req, res, next) {
  const s = visibleStream(req.ownerId, req.userId, req.params.id);
  if (!s) return res.status(404).json({ error: 'Kanál nenájdený.' });
  req.stream = s;
  next();
}

router.patch('/streams/:id', ws.writer, stream, (req, res) => {
  const s = req.stream, b = req.body || {};
  if (s.kind !== 'stream') return res.status(400).json({ error: 'Priame správy sa neupravujú.' });
  if (s.created_by !== req.userId && req.role !== 'owner') return res.status(403).json({ error: 'Kanál môže upraviť iba ten, kto ho založil, alebo majiteľ.' });
  const name = b.name !== undefined ? String(b.name).trim().replace(/^#/, '').slice(0, 60) || s.name : s.name;
  db().prepare('UPDATE chat_streams SET name = ?, description = ?, archived = ? WHERE id = ?')
    .run(name, b.description !== undefined ? String(b.description).slice(0, 300) : s.description, b.archived !== undefined ? (b.archived ? 1 : 0) : s.archived, s.id);
  if (s.private && Array.isArray(b.members)) {
    const before = memberIds(s.id);
    db().prepare('DELETE FROM chat_members WHERE stream_id = ?').run(s.id);
    cleanMembers(req.ownerId, [req.userId, ...b.members]).forEach(uid => db().prepare('INSERT INTO chat_members (stream_id, user_id) VALUES (?, ?)').run(s.id, uid));
    before.filter(uid => !memberIds(s.id).includes(uid)).forEach(uid => realtime.publishUser(uid, { type: 'chat', op: 'streams' }));
  }
  const fresh = db().prepare('SELECT * FROM chat_streams WHERE id = ?').get(s.id);
  deliver(fresh, { type: 'chat', op: 'streams' });
  res.json(streamView(fresh, req.userId));
});

router.delete('/streams/:id', ws.writer, stream, (req, res) => {
  if (req.stream.kind !== 'stream') return res.status(400).json({ error: 'Priame správy sa nemažú.' });
  if (req.role !== 'owner') return res.status(403).json({ error: 'Kanál môže zmazať iba majiteľ.' });
  const ids = db().prepare('SELECT id FROM chat_messages WHERE stream_id = ?').all(req.stream.id);
  ids.forEach(m => links.forget(req.ownerId, 'message', String(m.id)));
  deliver(req.stream, { type: 'chat', op: 'streams' });
  db().prepare('DELETE FROM chat_streams WHERE id = ?').run(req.stream.id);
  res.json({ ok: true });
});

/** Priama správa (1:1 alebo skupinka) – nájde existujúcu alebo založí novú. */
router.post('/dm', (req, res) => {
  const asked = [].concat(req.body?.userIds || []).map(String);
  const people = cleanMembers(req.ownerId, [req.userId, ...asked]).sort();
  if (!asked.length || asked.some(id => !people.includes(id))) return res.status(400).json({ error: 'Vyberte kolegu z tímu.' });
  const key = people.join(',');
  let s = db().prepare("SELECT * FROM chat_streams WHERE owner_id = ? AND dm_key = ?").get(req.ownerId, key);
  if (!s) {
    const id = uuidv4();
    db().prepare("INSERT INTO chat_streams (id, owner_id, kind, dm_key, created_by) VALUES (?, ?, 'dm', ?, ?)").run(id, req.ownerId, key, req.userId);
    people.forEach(uid => db().prepare('INSERT INTO chat_members (stream_id, user_id) VALUES (?, ?)').run(id, uid));
    s = db().prepare('SELECT * FROM chat_streams WHERE id = ?').get(id);
  }
  res.json(streamView(s, req.userId));
});

/* ── Témy a správy ──────────────────────────────────────────── */

router.get('/streams/:id/topics', stream, (req, res) => {
  const rows = db().prepare(`SELECT m.topic, MAX(m.id) AS lastId, MAX(m.created_at) AS lastAt, COUNT(*) AS count,
      SUM(CASE WHEN m.user_id != ? AND m.id > COALESCE(r.last_id, 0) THEN 1 ELSE 0 END) AS unread
    FROM chat_messages m LEFT JOIN chat_reads r ON r.user_id = ? AND r.stream_id = m.stream_id AND r.topic = m.topic
    WHERE m.stream_id = ? GROUP BY m.topic ORDER BY lastId DESC LIMIT 200`).all(req.userId, req.userId, req.stream.id);
  res.json(rows);
});

function fileList(ownerId, json) {
  let ids = [];
  try { ids = JSON.parse(json || '[]'); } catch { /* prázdne */ }
  return ids.map(id => db().prepare('SELECT id, name, size, mime FROM drive_items WHERE id = ? AND owner_id = ? AND trashed_at IS NULL').get(id, ownerId)).filter(Boolean);
}

function messageView(m) {
  const reactions = {};
  db().prepare('SELECT emoji, user_id FROM chat_reactions WHERE message_id = ? ORDER BY rowid').all(m.id)
    .forEach(r => { (reactions[r.emoji] = reactions[r.emoji] || []).push(r.user_id); });
  return {
    id: m.id, streamId: m.stream_id, topic: m.topic, content: m.content, files: fileList(m.owner_id, m.files),
    meeting: m.meeting_room || null, author: { id: m.user_id, name: userName(m.user_id) }, reactions,
    createdAt: m.created_at, editedAt: m.edited_at,
    links: db().prepare("SELECT COUNT(*) AS n FROM item_links WHERE owner_id = ? AND ((a_type = 'message' AND a_id = ?) OR (b_type = 'message' AND b_id = ?))").get(m.owner_id, String(m.id), String(m.id)).n,
  };
}

router.get('/streams/:id/messages', stream, (req, res) => {
  const where = ['stream_id = ?'];
  const vals = [req.stream.id];
  if (req.query.topic !== undefined && req.stream.kind === 'stream') { where.push('topic = ?'); vals.push(String(req.query.topic)); }
  if (req.query.before) { where.push('id < ?'); vals.push(Number(req.query.before) || 0); }
  const limit = Math.min(200, Number(req.query.limit) || 60);
  const rows = db().prepare(`SELECT * FROM chat_messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...vals, limit + 1);
  res.json({ messages: rows.slice(0, limit).reverse().map(messageView), more: rows.length > limit });
});

/** @**Meno** → ID členov priestoru, ktorí kanál vidia; @**všetci** = celý kanál. */
function mentionsIn(s, content) {
  const people = ws.members(s.owner_id);
  const can = new Set(audience(s));
  const out = new Set();
  for (const [, raw] of content.matchAll(MENTION)) {
    const name = raw.trim().toLowerCase();
    if (ALL.includes(name)) can.forEach(id => out.add(id));
    people.filter(p => (p.name || '').toLowerCase() === name && can.has(p.id)).forEach(p => out.add(p.id));
  }
  return [...out];
}

const chatUrl = (s, topic, id) => `/dashboard?view=chat&stream=${s.id}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}${id ? `&msg=${id}` : ''}&ws=${s.owner_id}`;
const where = (s, topic) => (s.kind === 'dm' ? 'v priamej správe' : `v #${s.name}${topic ? ` › ${topic}` : ''}`);

function post(s, userId, { topic, content, files, meetingRoom }) {
  const t = s.kind === 'dm' ? '' : String(topic || '').trim().slice(0, 60) || 'bez témy';
  const r = db().prepare('INSERT INTO chat_messages (owner_id, stream_id, topic, user_id, content, files, meeting_room) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(s.owner_id, s.id, t, userId, content, JSON.stringify(files || []), meetingRoom || null);
  const m = db().prepare('SELECT * FROM chat_messages WHERE id = ?').get(r.lastInsertRowid);
  markRead(userId, s.id, t, m.id);
  const view = messageView(m);
  deliver(s, { type: 'chat', op: 'new', message: view });
  // Upozornenia: zmienky vždy, priame správy keď adresát práve nie je pripojený (inak ho upozorní odznak chatu)
  const actor = userName(userId);
  const preview = content.replace(MENTION, '@$1').slice(0, 300);
  const mentioned = mentionsIn(s, content);
  notifications.notify(mentioned, { ownerId: s.owner_id, type: 'chat.mention', title: `${actor} vás spomenul/a ${where(s, t)}`, body: preview, url: chatUrl(s, t, m.id), email: true }, userId);
  if (s.kind === 'dm') {
    const away = memberIds(s.id).filter(uid => !mentioned.includes(uid) && !realtime.isOnline(uid));
    notifications.notify(away, { ownerId: s.owner_id, type: 'chat.dm', title: `Nová správa od ${actor}`, body: preview, url: chatUrl(s, '', m.id), email: true }, userId);
  }
  return view;
}

router.post('/streams/:id/messages', stream, (req, res) => {
  const s = req.stream;
  if (s.archived) return res.status(400).json({ error: 'Kanál je archivovaný.' });
  const content = String(req.body?.content || '').trim().slice(0, 10000);
  const files = [].concat(req.body?.files || []).map(String)
    .filter(id => db().prepare("SELECT 1 FROM drive_items WHERE id = ? AND owner_id = ? AND kind = 'file' AND trashed_at IS NULL").get(id, req.ownerId)).slice(0, 10);
  if (!content && !files.length) return res.status(400).json({ error: 'Správa je prázdna.' });
  res.json(post(s, req.userId, { topic: req.body?.topic, content, files }));
});

/** Prílohy: uložia sa na Disk do priečinka „Chat“ a správa na ne odkáže. */
router.post('/streams/:id/files', stream, upload.array('files', 10), (req, res) => {
  const folder = drive.systemFolder(req.ownerId, 'chat-files', 'Chat');
  const r = drive.storeFiles(req.ownerId, folder.id, req.files, `user:${req.userId}`);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json(r.items.map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })));
});

/** Videohovor z konverzácie: založí miestnosť a pošle do témy správu s pozvánkou. */
router.post('/streams/:id/meet', stream, (req, res) => {
  const s = req.stream;
  const topic = s.kind === 'dm' ? '' : String(req.body?.topic || '').trim() || 'videohovor';
  const room = meet.create(req.ownerId, s.kind === 'dm' ? 'Videohovor' : `#${s.name} › ${topic}`, req.userId);
  res.json(post(s, req.userId, { topic, content: String(req.body?.content || '').trim() || '🎥 Začal/a som videohovor – pridajte sa.', meetingRoom: room }));
});

function message(req, res, next) {
  const m = db().prepare('SELECT * FROM chat_messages WHERE id = ? AND owner_id = ?').get(Number(req.params.id) || 0, req.ownerId);
  const s = m && visibleStream(req.ownerId, req.userId, m.stream_id);
  if (!s) return res.status(404).json({ error: 'Správa nenájdená.' });
  req.msg = m;
  req.stream = s;
  next();
}

router.patch('/messages/:id', message, (req, res) => {
  const m = req.msg;
  if (m.user_id !== req.userId) return res.status(403).json({ error: 'Upraviť môže iba autor.' });
  const content = req.body?.content !== undefined ? String(req.body.content).trim().slice(0, 10000) : m.content;
  if (!content && fileList(m.owner_id, m.files).length === 0) return res.status(400).json({ error: 'Správa je prázdna.' });
  const topic = req.body?.topic !== undefined && req.stream.kind === 'stream' ? String(req.body.topic).trim().slice(0, 60) || m.topic : m.topic;
  db().prepare('UPDATE chat_messages SET content = ?, topic = ?, edited_at = unixepoch() WHERE id = ?').run(content, topic, m.id);
  const view = messageView(db().prepare('SELECT * FROM chat_messages WHERE id = ?').get(m.id));
  deliver(req.stream, { type: 'chat', op: 'edit', message: view, oldTopic: m.topic });
  res.json(view);
});

router.delete('/messages/:id', message, (req, res) => {
  if (req.msg.user_id !== req.userId && req.role !== 'owner') return res.status(403).json({ error: 'Zmazať môže iba autor alebo majiteľ.' });
  links.forget(req.ownerId, 'message', String(req.msg.id));
  db().prepare('DELETE FROM chat_messages WHERE id = ?').run(req.msg.id);
  deliver(req.stream, { type: 'chat', op: 'delete', id: req.msg.id, streamId: req.stream.id, topic: req.msg.topic });
  res.json({ ok: true });
});

router.post('/messages/:id/react', message, (req, res) => {
  const emoji = String(req.body?.emoji || '');
  if (!EMOJI.includes(emoji)) return res.status(400).json({ error: 'Neznáma reakcia.' });
  const had = db().prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(req.msg.id, req.userId, emoji).changes;
  if (!had) db().prepare('INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(req.msg.id, req.userId, emoji);
  const view = messageView(req.msg);
  deliver(req.stream, { type: 'chat', op: 'edit', message: view });
  res.json(view);
});

/** Zo správy úloha (prepojená so správou; riešitelia = spomenutí ľudia). */
router.post('/messages/:id/to-task', ws.writer, message, (req, res) => {
  const m = req.msg;
  const text = m.content.replace(MENTION, '@$1').trim();
  const title = String(req.body?.title || text.split('\n')[0] || 'Úloha z chatu').slice(0, 300);
  const r = tasks.createTask(req.ownerId, {
    projectId: req.body?.projectId, title, assignees: mentionsIn(req.stream, m.content).filter(id => ws.canWrite(ws.roleIn(id, req.ownerId))),
    description: `${text}\n\n— ${userName(m.user_id)}, ${where(req.stream, m.topic)}`,
  }, req.userId);
  if (r.error) return res.status(400).json(r);
  links.link(req.ownerId, { type: 'message', id: String(m.id) }, { type: 'task', id: r.task.id }, req.userId);
  deliver(req.stream, { type: 'chat', op: 'edit', message: messageView(m) });
  res.json(r.task);
});

/* ── Prečítané, hľadanie ────────────────────────────────────── */

function markRead(userId, streamId, topic, upTo) {
  db().prepare(`INSERT INTO chat_reads (user_id, stream_id, topic, last_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, stream_id, topic) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`).run(userId, streamId, topic, upTo);
}

router.post('/streams/:id/read', stream, (req, res) => {
  const topics = req.body?.topic !== undefined && req.stream.kind === 'stream' ? [String(req.body.topic)]
    : db().prepare('SELECT DISTINCT topic FROM chat_messages WHERE stream_id = ?').all(req.stream.id).map(r => r.topic);
  const upTo = Number(req.body?.upTo) || Number.MAX_SAFE_INTEGER;
  topics.forEach(t => {
    const last = db().prepare('SELECT MAX(id) AS id FROM chat_messages WHERE stream_id = ? AND topic = ? AND id <= ?').get(req.stream.id, t, upTo).id;
    if (last) markRead(req.userId, req.stream.id, t, last);
  });
  realtime.publishUser(req.userId, { type: 'chat', op: 'read', streamId: req.stream.id });
  res.json({ unread: unreadOf(req.userId, req.stream.id) });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const ids = visibleStreams(req.ownerId, req.userId).map(s => s.id);
  if (!ids.length) return res.json([]);
  const rows = db().prepare(`SELECT * FROM chat_messages WHERE stream_id IN (${ids.map(() => '?').join(',')}) AND (lower(content) LIKE ? OR lower(topic) LIKE ?) ORDER BY id DESC LIMIT 50`)
    .all(...ids, `%${q}%`, `%${q}%`);
  res.json(rows.map(messageView));
});

router.get('/emoji', (req, res) => res.json(EMOJI));

// Odkaz na správu z iných modulov (úloha ↔ správa). Obsah súkromných konverzácií sa nezobrazí.
links.registerType('message', {
  label: 'Správa v chate', icon: '💬',
  resolve(ownerId, id) {
    const m = db().prepare('SELECT * FROM chat_messages WHERE id = ? AND owner_id = ?').get(Number(id) || 0, ownerId);
    const s = m && db().prepare('SELECT * FROM chat_streams WHERE id = ?').get(m.stream_id);
    if (!s) return null;
    const open = s.kind === 'stream' && !s.private;
    return { title: open ? `#${s.name} › ${m.topic}: ${m.content.replace(MENTION, '@$1').slice(0, 80)}` : 'Súkromná správa', url: chatUrl(s, m.topic, m.id) };
  },
});

module.exports = router;
