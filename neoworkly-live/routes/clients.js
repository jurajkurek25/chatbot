const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDB } = require('../db/database');
const { authClient } = require('../middleware/auth');

const LOGO_DIR = path.join(__dirname, '../public/uploads/logos');
if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGO_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
});
const uploadLogo = multer({ storage: logoStorage, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  cb(null, /^image\//.test(file.mimetype));
}});

// Get own profile + settings
router.get('/me', authClient, (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT id, email, company_name, widget_key, plan, ai_summary_enabled, language, logo_url, created_at FROM clients WHERE id = ?').get(req.clientId);
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

// Upload company logo
router.post('/logo', authClient, uploadLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const logoUrl = `/uploads/logos/${req.file.filename}`;
  const db = getDB();
  // Delete old logo file if exists
  const old = db.prepare('SELECT logo_url FROM clients WHERE id = ?').get(req.clientId);
  if (old?.logo_url) {
    const oldPath = path.join(__dirname, '../public', old.logo_url);
    try { fs.unlinkSync(oldPath); } catch {}
  }
  db.prepare('UPDATE clients SET logo_url = ? WHERE id = ?').run(logoUrl, req.clientId);
  res.json({ logo_url: logoUrl });
});

// Delete company logo
router.delete('/logo', authClient, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT logo_url FROM clients WHERE id = ?').get(req.clientId);
  if (row?.logo_url) {
    const filePath = path.join(__dirname, '../public', row.logo_url);
    try { fs.unlinkSync(filePath); } catch {}
  }
  db.prepare('UPDATE clients SET logo_url = NULL WHERE id = ?').run(req.clientId);
  res.json({ ok: true });
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
