'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All widget routes require authentication
router.use(requireAuth);

// GET /api/widgets — list all widgets for current user
router.get('/', (req, res) => {
  const db = getDb();
  const widgets = db.prepare(`
    SELECT w.*,
      (SELECT COUNT(*) FROM knowledge_items WHERE widget_id = w.id) AS knowledge_count
    FROM widgets w
    WHERE w.user_id = ?
    ORDER BY w.created_at DESC
  `).all(req.userId);

  res.json(widgets.map(parseWidget));
});

// GET /api/widgets/:id — get single widget
router.get('/:id', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  res.json(parseWidget(widget));
});

// POST /api/widgets — create widget
router.post('/', (req, res) => {
  const { name, bot_name, welcome_message, primary_color, goals, cta_type, cta_config, suggested_questions } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Názov widgetu je povinný.' });
  }

  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO widgets (id, user_id, name, bot_name, welcome_message, primary_color, goals, cta_type, cta_config, suggested_questions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.userId,
    name.trim(),
    (bot_name || 'Asistent').trim(),
    (welcome_message || 'Ahoj! Ako vám môžem pomôcť?').trim(),
    primary_color || '#2563eb',
    goals || '',
    validateCtaType(cta_type),
    JSON.stringify(cta_config || {}),
    JSON.stringify(suggested_questions || [])
  );

  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id);
  res.status(201).json(parseWidget(widget));
});

// PUT /api/widgets/:id — update widget
router.put('/:id', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { name, bot_name, welcome_message, primary_color, goals, cta_type, cta_config, suggested_questions, active } = req.body;

  const db = getDb();
  db.prepare(`
    UPDATE widgets SET
      name = ?,
      bot_name = ?,
      welcome_message = ?,
      primary_color = ?,
      goals = ?,
      cta_type = ?,
      cta_config = ?,
      suggested_questions = ?,
      active = ?
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : widget.name,
    bot_name !== undefined ? bot_name.trim() : widget.bot_name,
    welcome_message !== undefined ? welcome_message.trim() : widget.welcome_message,
    primary_color || widget.primary_color,
    goals !== undefined ? goals : widget.goals,
    cta_type ? validateCtaType(cta_type) : widget.cta_type,
    cta_config !== undefined ? JSON.stringify(cta_config) : widget.cta_config,
    suggested_questions !== undefined ? JSON.stringify(suggested_questions) : widget.suggested_questions,
    active !== undefined ? (active ? 1 : 0) : widget.active,
    widget.id
  );

  const updated = db.prepare('SELECT * FROM widgets WHERE id = ?').get(widget.id);
  res.json(parseWidget(updated));
});

// DELETE /api/widgets/:id — delete widget
router.delete('/:id', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  db.prepare('DELETE FROM widgets WHERE id = ?').run(widget.id);
  res.json({ success: true });
});

// GET /api/widgets/:id/embed-code — get embed code snippet
router.get('/:id/embed-code', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const baseUrl = process.env.BASE_URL || 'https://neuradesk.online';
  const code = `<!-- NeuraDeskApp Chat Widget -->
<script>
  window.NeuraDeskConfig = { widgetId: '${widget.id}' };
</script>
<script src="${baseUrl}/widget.js" async></script>`;

  res.json({ code });
});

// POST /api/widgets/complete-onboarding — mark onboarding done
router.post('/complete-onboarding', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE users SET onboarding_done = 1 WHERE id = ?').run(req.userId);
  res.json({ success: true });
});

function getOwnedWidget(widgetId, userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId);
}

function validateCtaType(type) {
  const allowed = ['call', 'contact', 'custom', 'none'];
  return allowed.includes(type) ? type : 'contact';
}

function parseWidget(w) {
  return {
    ...w,
    active: Boolean(w.active),
    cta_config: safeParseJSON(w.cta_config, {}),
    suggested_questions: safeParseJSON(w.suggested_questions, []),
  };
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
