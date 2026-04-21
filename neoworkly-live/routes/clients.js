const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');
const { authClient } = require('../middleware/auth');

// Get own profile + settings
router.get('/me', authClient, (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT id, email, company_name, widget_key, plan, ai_summary_enabled, language, created_at FROM clients WHERE id = ?').get(req.clientId);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json(client);
});

// Update settings
router.patch('/me', authClient, (req, res) => {
  const { company_name, ai_summary_enabled, language } = req.body;
  const db = getDB();
  db.prepare('UPDATE clients SET company_name = COALESCE(?, company_name), ai_summary_enabled = COALESCE(?, ai_summary_enabled), language = COALESCE(?, language) WHERE id = ?')
    .run(company_name ?? null, ai_summary_enabled ?? null, language ?? null, req.clientId);
  res.json({ ok: true });
});

// Get widget embed code info
router.get('/widget-key', authClient, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT widget_key FROM clients WHERE id = ?').get(req.clientId);
  res.json({ widget_key: row.widget_key });
});

// Save widget visual config
router.patch('/widget-config', authClient, (req, res) => {
  const allowed = ['primaryColor','secondaryColor','bgColor','textColor','mutedColor','userBubbleColor','opBubbleColor','borderRadius','buttonShape','font','position'];
  const incoming = req.body || {};
  const safe = {};
  allowed.forEach(k => { if (incoming[k] !== undefined) safe[k] = incoming[k]; });
  const db = getDB();
  const existing = db.prepare('SELECT widget_config FROM clients WHERE id = ?').get(req.clientId);
  let current = {};
  try { current = JSON.parse(existing.widget_config || '{}'); } catch {}
  db.prepare('UPDATE clients SET widget_config = ? WHERE id = ?')
    .run(JSON.stringify({ ...current, ...safe }), req.clientId);
  res.json({ ok: true });
});

// Get widget config (for dashboard)
router.get('/widget-config', authClient, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT widget_config FROM clients WHERE id = ?').get(req.clientId);
  let config = {};
  try { config = JSON.parse(row.widget_config || '{}'); } catch {}
  res.json(config);
});

module.exports = router;
