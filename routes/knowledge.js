'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { parseFile, cleanupFile } = require('../services/fileParser');

const router = express.Router();

// Multer config — store uploads in /uploads, max 20MB
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = ['.pdf', '.txt', '.md', '.csv'];
    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Nepodporovaný typ súboru. Povolené: PDF, TXT, MD, CSV'));
    }
  },
});

router.use(requireAuth);

// GET /api/knowledge/:widgetId — list knowledge items
router.get('/:widgetId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const db = getDb();
  const items = db.prepare(`
    SELECT id, title, source_type,
      CASE WHEN length(content) > 200 THEN substr(content, 1, 200) || '...' ELSE content END AS preview,
      length(content) AS char_count,
      created_at
    FROM knowledge_items
    WHERE widget_id = ?
    ORDER BY created_at DESC
  `).all(req.params.widgetId);

  res.json(items);
});

// POST /api/knowledge/:widgetId/text — add text knowledge item
router.post('/:widgetId/text', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const { title, content } = req.body;
  if (!title || !content || !title.trim() || !content.trim()) {
    return res.status(400).json({ error: 'Názov a obsah sú povinné.' });
  }
  if (content.length > 200000) {
    return res.status(400).json({ error: 'Obsah je príliš dlhý (max 200 000 znakov).' });
  }

  const item = insertKnowledgeItem(req.params.widgetId, title.trim(), content.trim(), 'text');
  res.status(201).json(item);
});

// POST /api/knowledge/:widgetId/upload — upload file
router.post('/:widgetId/upload', upload.single('file'), async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    cleanupFile(req.file?.path);
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Súbor je povinný.' });
  }

  try {
    const content = await parseFile(req.file.path, req.file.mimetype);
    const title = (req.body.title || req.file.originalname).trim();
    const item = insertKnowledgeItem(req.params.widgetId, title, content, 'pdf');
    cleanupFile(req.file.path);
    res.status(201).json(item);
  } catch (err) {
    cleanupFile(req.file?.path);
    res.status(422).json({ error: err.message });
  }
});

// DELETE /api/knowledge/:widgetId/:itemId — delete knowledge item
router.delete('/:widgetId/:itemId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const db = getDb();
  const item = db.prepare('SELECT id FROM knowledge_items WHERE id = ? AND widget_id = ?').get(
    req.params.itemId, req.params.widgetId
  );
  if (!item) return res.status(404).json({ error: 'Položka nenájdená.' });

  db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(item.id);
  res.json({ success: true });
});

function insertKnowledgeItem(widgetId, title, content, sourceType) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO knowledge_items (id, widget_id, title, content, source_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, widgetId, title, content, sourceType);
  return { id, widget_id: widgetId, title, content, source_type: sourceType };
}

function ownsWidget(widgetId, userId) {
  const db = getDb();
  return Boolean(db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId));
}

module.exports = router;
