'use strict';
/** Lístok na WebSocket (/ws, /yjs), ľudia v priestore a prepojenia medzi položkami modulov. */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const realtime = require('../services/realtime');
const workspace = require('../services/workspace');
const links = require('../services/links');

const router = express.Router();
router.use(requireAuth);

router.post('/ticket', (req, res) => res.json({ ticket: realtime.ticket(req.userId) }));

router.get('/workspaces', (req, res) => res.json(workspace.list(req.userId)));
router.get('/members', workspace.middleware, (req, res) => res.json(workspace.members(req.ownerId)));
router.get('/presence', workspace.middleware, (req, res) => res.json(realtime.presence(req.ownerId)));

const ref = (o) => ({ type: String(o?.type || ''), id: String(o?.id || '') });
router.get('/links', workspace.middleware, (req, res) => res.json(links.related(req.ownerId, String(req.query.type), String(req.query.id))));
router.post('/links', workspace.middleware, workspace.writer, (req, res) => {
  const r = links.link(req.ownerId, ref(req.body.a), ref(req.body.b), req.userId);
  if (r.error) return res.status(400).json(r);
  realtime.publish(req.ownerId, { type: 'links', items: [ref(req.body.a), ref(req.body.b)] });
  res.json(r);
});
router.delete('/links', workspace.middleware, workspace.writer, (req, res) => {
  links.unlink(req.ownerId, ref(req.body.a), ref(req.body.b));
  realtime.publish(req.ownerId, { type: 'links', items: [ref(req.body.a), ref(req.body.b)] });
  res.json({ ok: true });
});

/** Hľadanie položiek naprieč modulmi (na prepájanie a rýchle otvorenie). */
router.get('/search', workspace.middleware, (req, res) => {
  const { getDb } = require('../db/database');
  const db = getDb();
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const out = [];
  const add = (type, rows, title) => rows.forEach(r => { const info = links.types.get(type)?.resolve(req.ownerId, r.id); if (info) out.push({ type, id: r.id, icon: links.types.get(type).icon, label: links.types.get(type).label, ...info, title: info.title || title(r) }); });
  const has = t => links.known(t);
  if (has('task')) add('task', db.prepare('SELECT id FROM tasks WHERE owner_id = ? AND lower(title) LIKE ? ORDER BY updated_at DESC LIMIT 8').all(req.ownerId, like));
  if (has('note')) add('note', db.prepare("SELECT id FROM notes WHERE owner_id = ? AND visibility = 'workspace' AND lower(content) LIKE ? ORDER BY updated_at DESC LIMIT 8").all(req.ownerId, like));
  if (has('doc')) add('doc', db.prepare('SELECT id FROM docs WHERE owner_id = ? AND (lower(title) LIKE ? OR lower(text) LIKE ?) ORDER BY updated_at DESC LIMIT 8').all(req.ownerId, like, like));
  if (has('board')) add('board', db.prepare('SELECT id FROM boards WHERE owner_id = ? AND (lower(title) LIKE ? OR lower(text) LIKE ?) ORDER BY updated_at DESC LIMIT 8').all(req.ownerId, like, like));
  if (has('form')) add('form', db.prepare('SELECT id FROM forms WHERE owner_id = ? AND lower(title) LIKE ? ORDER BY updated_at DESC LIMIT 8').all(req.ownerId, like));
  if (has('event')) add('event', db.prepare('SELECT id FROM calendar_events WHERE owner_id = ? AND lower(title) LIKE ? ORDER BY start_at DESC LIMIT 8').all(req.ownerId, like));
  if (has('file')) add('file', db.prepare('SELECT id FROM drive_items WHERE owner_id = ? AND trashed_at IS NULL AND ref IS NULL AND lower(name) LIKE ? ORDER BY updated_at DESC LIMIT 8').all(req.ownerId, like));
  if (has('message')) add('message', db.prepare(`SELECT m.id FROM chat_messages m JOIN chat_streams s ON s.id = m.stream_id
    WHERE m.owner_id = ? AND s.kind = 'stream' AND s.private = 0 AND lower(m.content) LIKE ? ORDER BY m.id DESC LIMIT 8`).all(req.ownerId, like));
  res.json(out);
});

// Upozornenia (zvonček)
const notifications = require('../services/notifications');
router.get('/notifications', (req, res) => res.json({ items: notifications.list(req.userId), unread: notifications.unread(req.userId) }));
router.post('/notifications/read', (req, res) => { notifications.markRead(req.userId, req.body?.id); res.json({ unread: notifications.unread(req.userId) }); });

module.exports = router;
