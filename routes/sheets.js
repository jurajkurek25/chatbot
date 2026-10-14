'use strict';
/** Tabuľky (/api/sheets): zoznam, vytvorenie, premenovanie, kôš; bunky sa upravujú cez /yjs. */
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const sheets = require('../services/sheets');
const drive = require('../services/drive');

const router = express.Router();
router.use(requireAuth, ws.middleware);

router.get('/', (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const rows = getDb().prepare(`SELECT b.* FROM sheets b JOIN drive_items i ON i.id = b.drive_item_id
                                WHERE b.owner_id = ? AND i.trashed_at IS NULL AND (lower(b.title) LIKE ? OR lower(b.text) LIKE ?)
                                ORDER BY b.updated_at DESC LIMIT 200`).all(req.ownerId, q, q);
  res.json(rows.map(sheets.sheetView));
});

router.post('/', ws.writer, (req, res) => res.json(sheets.sheetView(sheets.createSheet(req.ownerId, req.body || {}, req.userId))));

function own(req, res, next) {
  const b = sheets.liveSheet(req.ownerId, req.params.id);
  if (!b) return res.status(404).json({ error: 'Tabuľka nenájdená.' });
  req.sheet = b;
  next();
}

router.get('/:id', own, (req, res) => {
  const me = getDb().prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  const item = drive.getItem(req.ownerId, req.sheet.drive_item_id);
  res.json({ ...sheets.sheetView(req.sheet), folderId: item?.parent_id || null, role: req.role, ownerId: req.ownerId, room: sheets.sheetName(req.ownerId, req.sheet.id), me: { id: req.userId, name: me?.name || '' } });
});

router.patch('/:id', ws.writer, own, (req, res) => res.json(sheets.sheetView(sheets.rename(req.ownerId, req.sheet, req.body?.title))));

router.delete('/:id', ws.writer, own, (req, res) => {
  const item = drive.getItem(req.ownerId, req.sheet.drive_item_id);
  if (item) drive.trash(req.ownerId, item);
  res.json({ ok: true });
});

module.exports = router;
