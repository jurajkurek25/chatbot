'use strict';
/** Rýchle poznámky (/api/notes, podľa Memos): časová os, #štítky, pripnutie, archív, zmena na úlohu. */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const tasks = require('../services/tasks');
const links = require('../services/links');
const realtime = require('../services/realtime');

const router = express.Router();
router.use(requireAuth, ws.middleware);
const TAG = /(^|\s)#([\p{L}\p{N}_-]{1,40})/gu;
const tagsOf = text => [...new Set([...String(text).matchAll(TAG)].map(m => m[2].toLowerCase()))];

function view(n) {
  const u = getDb().prepare('SELECT name FROM users WHERE id = ?').get(n.user_id);
  return { id: n.id, content: n.content, visibility: n.visibility, pinned: !!n.pinned, archived: !!n.archived, tags: tagsOf(n.content),
    author: { id: n.user_id, name: u?.name || '' }, createdAt: n.created_at, updatedAt: n.updated_at,
    links: getDb().prepare("SELECT COUNT(*) AS n FROM item_links WHERE owner_id = ? AND ((a_type = 'note' AND a_id = ?) OR (b_type = 'note' AND b_id = ?))").get(n.owner_id, n.id, n.id).n };
}
// Viditeľné: poznámky priestoru + vlastné súkromné
const visible = (req, id) => getDb().prepare("SELECT * FROM notes WHERE id = ? AND owner_id = ? AND (visibility = 'workspace' OR user_id = ?)").get(id, req.ownerId, req.userId);

router.get('/', (req, res) => {
  const where = ["owner_id = ?", "(visibility = 'workspace' OR user_id = ?)", 'archived = ?'];
  const vals = [req.ownerId, req.userId, req.query.archived === '1' ? 1 : 0];
  if (req.query.q) { where.push('lower(content) LIKE ?'); vals.push(`%${String(req.query.q).toLowerCase()}%`); }
  if (req.query.before) { where.push('created_at < ?'); vals.push(Number(req.query.before) || 0); }
  if (req.query.mine === '1') { where.push('user_id = ?'); vals.push(req.userId); }
  let rows = getDb().prepare(`SELECT * FROM notes WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC LIMIT 300`).all(...vals);
  if (req.query.tag) rows = rows.filter(n => tagsOf(n.content).includes(String(req.query.tag).toLowerCase()));
  res.json(rows.slice(0, 100).map(view));
});

router.get('/tags', (req, res) => {
  const counts = {};
  getDb().prepare("SELECT content FROM notes WHERE owner_id = ? AND archived = 0 AND (visibility = 'workspace' OR user_id = ?)").all(req.ownerId, req.userId)
    .forEach(n => tagsOf(n.content).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  res.json(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })));
});

router.post('/', ws.writer, (req, res) => {
  const content = String(req.body?.content || '').trim().slice(0, 20000);
  if (!content) return res.status(400).json({ error: 'Poznámka je prázdna.' });
  const id = uuidv4();
  getDb().prepare('INSERT INTO notes (id, owner_id, user_id, content, visibility) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.ownerId, req.userId, content, req.body?.visibility === 'private' ? 'private' : 'workspace');
  const n = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (n.visibility === 'workspace') realtime.publish(req.ownerId, { type: 'note', id });
  res.json(view(n));
});

function own(req, res, next) {
  const n = visible(req, req.params.id);
  if (!n) return res.status(404).json({ error: 'Poznámka nenájdená.' });
  req.note = n;
  next();
}
// Upravovať smie autor; majiteľ priestoru môže poznámky tímu pripnúť, archivovať a mazať
const authorOrOwner = (req, res, next) => (req.note.user_id === req.userId || req.role === 'owner') ? next() : res.status(403).json({ error: 'Upraviť môže iba autor.' });

router.patch('/:id', ws.writer, own, authorOrOwner, (req, res) => {
  const b = req.body || {};
  const n = req.note;
  if (b.content !== undefined && n.user_id !== req.userId) return res.status(403).json({ error: 'Text môže upraviť iba autor.' });
  const content = b.content !== undefined ? String(b.content).trim().slice(0, 20000) : n.content;
  if (!content) return res.status(400).json({ error: 'Poznámka je prázdna.' });
  getDb().prepare('UPDATE notes SET content = ?, visibility = ?, pinned = ?, archived = ?, updated_at = unixepoch() WHERE id = ?').run(
    content, b.visibility !== undefined && n.user_id === req.userId ? (b.visibility === 'private' ? 'private' : 'workspace') : n.visibility,
    b.pinned !== undefined ? (b.pinned ? 1 : 0) : n.pinned, b.archived !== undefined ? (b.archived ? 1 : 0) : n.archived, n.id);
  realtime.publish(req.ownerId, { type: 'note', id: n.id });
  res.json(view(getDb().prepare('SELECT * FROM notes WHERE id = ?').get(n.id)));
});

router.delete('/:id', ws.writer, own, authorOrOwner, (req, res) => {
  links.forget(req.ownerId, 'note', req.note.id);
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(req.note.id);
  realtime.publish(req.ownerId, { type: 'note', id: req.note.id });
  res.json({ ok: true });
});

/** Z poznámky úloha: prvý riadok = názov, zvyšok = popis; obe sa prepoja. */
router.post('/:id/to-task', ws.writer, own, (req, res) => {
  const [first, ...rest] = req.note.content.replace(TAG, '$1$2').trim().split('\n');
  const r = tasks.createTask(req.ownerId, { projectId: req.body?.projectId, title: first.replace(/^[-*#\s[\]x]+/i, '').slice(0, 300) || 'Úloha z poznámky', description: rest.join('\n').trim() }, req.userId);
  if (r.error) return res.status(400).json(r);
  links.link(req.ownerId, { type: 'note', id: req.note.id }, { type: 'task', id: r.task.id }, req.userId);
  res.json(r.task);
});

links.registerType('note', {
  label: 'Poznámka', icon: '🗒',
  resolve(ownerId, id) {
    const n = getDb().prepare("SELECT * FROM notes WHERE id = ? AND owner_id = ? AND visibility = 'workspace'").get(id, ownerId);
    return n ? { title: n.content.split('\n')[0].slice(0, 120), url: `/dashboard?view=notes&note=${id}&ws=${ownerId}` } : null;
  },
});

module.exports = router;
