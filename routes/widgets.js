'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const avatarStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '..', 'uploads', 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `avatar-${req.params.id}${ext}`);
  },
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
});

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

  const { name, bot_name, welcome_message, primary_color, goals, cta_type, cta_config, suggested_questions, active,
          proactive_enabled, proactive_delay, proactive_message } = req.body;

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
      active = ?,
      proactive_enabled = ?,
      proactive_delay = ?,
      proactive_message = ?
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
    proactive_enabled !== undefined ? (proactive_enabled ? 1 : 0) : (widget.proactive_enabled || 0),
    proactive_delay !== undefined ? Math.max(1, Math.min(60, parseInt(proactive_delay) || 4)) : (widget.proactive_delay || 4),
    proactive_message !== undefined ? String(proactive_message).slice(0, 500) : (widget.proactive_message || ''),
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

// POST /api/widgets/:id/avatar — upload bot avatar image
router.post('/:id/avatar', uploadAvatar.single('avatar'), (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  if (!req.file) return res.status(400).json({ error: 'Neplatný súbor.' });

  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  const db = getDb();
  db.prepare('UPDATE widgets SET avatar_url = ? WHERE id = ?').run(avatarUrl, widget.id);
  res.json({ avatar_url: avatarUrl });
});

// GET /api/widgets/:id/leads — list leads for a widget
router.get('/:id/leads', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  const leads = db.prepare(`
    SELECT id, name, email, phone, status, notes, chat_summary, gdpr_consent, created_at
    FROM leads WHERE widget_id = ?
    ORDER BY created_at DESC
  `).all(widget.id);

  res.json({ leads });
});

// PATCH /api/widgets/:id/leads/:leadId — update status and/or notes
router.patch('/:id/leads/:leadId', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND widget_id = ?').get(req.params.leadId, widget.id);
  if (!lead) return res.status(404).json({ error: 'Lead nenájdený.' });

  const { status, notes } = req.body;
  const allowed = ['new', 'contacted', 'closed'];

  if (status !== undefined && !allowed.includes(status)) {
    return res.status(400).json({ error: 'Neplatný stav.' });
  }

  const fields = [];
  const vals = [];
  if (status !== undefined) { fields.push('status = ?'); vals.push(status); }
  if (notes !== undefined) { fields.push('notes = ?'); vals.push(notes); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nič na aktualizáciu.' });

  vals.push(req.params.leadId);
  db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// DELETE /api/widgets/:id/leads/:leadId — delete a lead
router.delete('/:id/leads/:leadId', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  db.prepare('DELETE FROM leads WHERE id = ? AND widget_id = ?').run(req.params.leadId, widget.id);
  res.json({ ok: true });
});

// GET /api/widgets/:id/leads/export — CSV export
router.get('/:id/leads/export', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  const leads = db.prepare(`
    SELECT name, email, phone, status, notes, chat_summary, gdpr_consent, created_at
    FROM leads WHERE widget_id = ? ORDER BY created_at DESC
  `).all(widget.id);

  const header = ['Meno', 'Email', 'Telefón', 'Stav', 'Poznámky', 'AI zhrnutie', 'GDPR súhlas', 'Dátum'];
  const rows = leads.map(l => [
    l.name,
    l.email,
    l.phone || '',
    l.status,
    l.notes || '',
    (l.chat_summary || '').replace(/\n/g, ' '),
    l.gdpr_consent ? 'Áno' : 'Nie',
    new Date(l.created_at * 1000).toLocaleString('sk-SK'),
  ]);

  const csv = [header, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const filename = `kontakty-${widget.name || widget.id}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv);  // BOM for Excel UTF-8
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
    proactive_enabled: Boolean(w.proactive_enabled),
    proactive_delay: w.proactive_delay || 4,
    proactive_message: w.proactive_message || '',
  };
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
