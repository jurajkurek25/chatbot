'use strict';
/** Dokumenty (/api/docs): zoznam, vytvorenie, premenovanie, kôš; obsah sa upravuje cez /yjs (BlockNote). */
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const docs = require('../services/docs');
const drive = require('../services/drive');
const links = require('../services/links');

const router = express.Router();
router.use(requireAuth, ws.middleware);

router.get('/', (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const rows = getDb().prepare(`SELECT d.* FROM docs d JOIN drive_items i ON i.id = d.drive_item_id
                                WHERE d.owner_id = ? AND i.trashed_at IS NULL AND (lower(d.title) LIKE ? OR lower(d.text) LIKE ?)
                                ORDER BY d.updated_at DESC LIMIT 200`).all(req.ownerId, q, q);
  res.json(rows.map(docs.docView));
});

router.post('/', ws.writer, (req, res) => {
  const d = docs.createDoc(req.ownerId, req.body || {}, req.userId);
  res.json(docs.docView(d));
});

function own(req, res, next) {
  const d = docs.liveDoc(req.ownerId, req.params.id);
  if (!d) return res.status(404).json({ error: 'Dokument nenájdený.' });
  req.doc = d;
  next();
}

router.get('/:id', own, (req, res) => {
  const me = getDb().prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  const item = drive.getItem(req.ownerId, req.doc.drive_item_id);
  res.json({ ...docs.docView(req.doc), folderId: item?.parent_id || null, role: req.role, ownerId: req.ownerId, room: docs.docName(req.ownerId, req.doc.id), me: { id: req.userId, name: me?.name || '' },
    related: links.related(req.ownerId, 'doc', req.doc.id) });
});

router.patch('/:id', ws.writer, own, (req, res) => res.json(docs.docView(docs.rename(req.ownerId, req.doc, req.body || {}))));

router.delete('/:id', ws.writer, own, (req, res) => {
  const item = drive.getItem(req.ownerId, req.doc.drive_item_id);
  if (item) drive.trash(req.ownerId, item);
  res.json({ ok: true });
});

module.exports = router;
