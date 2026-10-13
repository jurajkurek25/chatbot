'use strict';
/** Tabule (/api/boards): zoznam, vytvorenie, premenovanie, kôš; kreslí sa cez /yjs (Excalidraw). */
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const boards = require('../services/boards');
const drive = require('../services/drive');

const router = express.Router();
router.use(requireAuth, ws.middleware);

router.get('/', (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const rows = getDb().prepare(`SELECT b.* FROM boards b JOIN drive_items i ON i.id = b.drive_item_id
                                WHERE b.owner_id = ? AND i.trashed_at IS NULL AND (lower(b.title) LIKE ? OR lower(b.text) LIKE ?)
                                ORDER BY b.updated_at DESC LIMIT 200`).all(req.ownerId, q, q);
  res.json(rows.map(boards.boardView));
});

router.post('/', ws.writer, (req, res) => res.json(boards.boardView(boards.createBoard(req.ownerId, req.body || {}, req.userId))));

function own(req, res, next) {
  const b = boards.liveBoard(req.ownerId, req.params.id);
  if (!b) return res.status(404).json({ error: 'Tabuľa nenájdená.' });
  req.board = b;
  next();
}

router.get('/:id', own, (req, res) => {
  const me = getDb().prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  const item = drive.getItem(req.ownerId, req.board.drive_item_id);
  res.json({ ...boards.boardView(req.board), folderId: item?.parent_id || null, role: req.role, ownerId: req.ownerId, room: boards.boardName(req.ownerId, req.board.id), me: { id: req.userId, name: me?.name || '' } });
});

router.patch('/:id', ws.writer, own, (req, res) => res.json(boards.boardView(boards.rename(req.ownerId, req.board, req.body?.title))));

router.delete('/:id', ws.writer, own, (req, res) => {
  const item = drive.getItem(req.ownerId, req.board.drive_item_id);
  if (item) drive.trash(req.ownerId, item);
  res.json({ ok: true });
});

module.exports = router;
