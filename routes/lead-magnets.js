'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { parseFile } = require('../services/fileParser');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

// Persistent disk storage — PDFs stay on disk for download
const lmStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '..', 'uploads', 'lead-magnets');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage: lmStorage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.txt', '.md'].includes(ext)) { cb(null, true); }
    else { cb(new Error('Povolené typy: PDF, TXT, MD')); }
  },
});

/* ── helpers ─────────────────────────────────────────────────── */
function ownsWidget(widgetId, userId) {
  return !!getDb().prepare(
    'SELECT 1 FROM widgets WHERE id = ? AND user_id = ?'
  ).get(widgetId, userId);
}

function appOrigin() {
  return (process.env.APP_URL || 'https://neoworkly.com').replace(/\/$/, '');
}

const SUPPORTED_LANGS = ['sk','en','de','fr','es','pl','cs','hu','ro','hr'];

/* ── AI extraction ───────────────────────────────────────────── */
async function extractLeadMagnetInfo(content, fileName) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Si marketingový expert. Analyzuj obsah tohto lead magnetu a extrahuj kľúčové informácie pre predajného chatbota.

Súbor: ${fileName}

Obsah:
${content.slice(0, 12000)}

Vráť VÝHRADNE JSON (žiadny iný text):
{
  "when_to_recommend": "kedy má chatbot odporučiť tento lead magnet zákazníkovi",
  "target_audience": "pre koho je lead magnet určený",
  "summary": "čo lead magnet obsahuje a aký prínos dáva (2–3 vety)"
}`,
    }],
  });
  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { when_to_recommend: '', target_audience: '', summary: '' };
  try { return JSON.parse(match[0]); } catch { return { when_to_recommend: '', target_audience: '', summary: '' }; }
}

/* ══════════════════════════════════════════════════════════════
   PUBLIC ROUTE — widget email capture (no auth)
   POST /api/lead-magnets/:widgetId/leads/capture
══════════════════════════════════════════════════════════════ */
router.post('/:widgetId/leads/capture', (req, res) => {
  const { lmId, email, name, sessionId, lang } = req.body;
  if (!lmId || !email || !email.includes('@')) {
    return res.status(400).json({ error: 'Neplatné údaje.' });
  }

  const lm = getDb().prepare(
    'SELECT id, file_url FROM lead_magnets WHERE id = ? AND widget_id = ? AND active = 1'
  ).get(lmId, req.params.widgetId);
  if (!lm) return res.status(404).json({ error: 'Lead magnet nenájdený.' });

  // Resolve language-specific file: exact lang → fallback → default → main file_url
  let fileUrl = lm.file_url;
  if (lang) {
    const exact = getDb().prepare(
      'SELECT file_url FROM lead_magnet_files WHERE lead_magnet_id = ? AND lang = ?'
    ).get(lmId, lang);
    if (exact) {
      fileUrl = exact.file_url;
    } else {
      const def = getDb().prepare(
        "SELECT file_url FROM lead_magnet_files WHERE lead_magnet_id = ? AND lang = 'default'"
      ).get(lmId);
      if (def) fileUrl = def.file_url;
    }
  }

  // Upsert lead
  const existing = getDb().prepare(
    'SELECT id FROM lead_magnet_leads WHERE lead_magnet_id = ? AND email = ?'
  ).get(lmId, email);
  if (!existing) {
    getDb().prepare(`
      INSERT INTO lead_magnet_leads (id, lead_magnet_id, widget_id, email, name, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), lmId, req.params.widgetId, email.trim().toLowerCase(), (name || '').trim(), sessionId || null);
  }

  res.json({ ok: true, fileUrl });
});

/* ══════════════════════════════════════════════════════════════
   AUTHENTICATED ROUTES
══════════════════════════════════════════════════════════════ */
router.use(requireAuth);

/* GET /api/lead-magnets/:widgetId — list with language files */
router.get('/:widgetId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const db = getDb();
  const items = db.prepare(
    `SELECT id, name, description, file_url, when_to_recommend, target_audience, ai_content, active, created_at
     FROM lead_magnets WHERE widget_id = ? ORDER BY created_at DESC`
  ).all(req.params.widgetId);

  // Attach language files to each lead magnet
  for (const item of items) {
    item.files = db.prepare(
      'SELECT id, lang, file_url, created_at FROM lead_magnet_files WHERE lead_magnet_id = ? ORDER BY lang'
    ).all(item.id);
  }
  res.json(items);
});

/* POST /api/lead-magnets/:widgetId — create (optionally with file) */
router.post('/:widgetId', upload.single('file'), async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const { name, description, lang } = req.body;
  if (!name?.trim()) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Názov je povinný.' });
  }

  let filePath = null, fileUrl = null;
  let aiInfo = { when_to_recommend: '', target_audience: '', summary: '' };

  if (req.file) {
    filePath = req.file.path;
    fileUrl = `${appOrigin()}/uploads/lead-magnets/${req.file.filename}`;
    try {
      const content = await parseFile(req.file.path, req.file.mimetype, req.file.originalname);
      aiInfo = await extractLeadMagnetInfo(content, req.file.originalname);
    } catch (err) { console.error('LM AI extraction:', err.message); }
  }

  const id = uuidv4();
  const db = getDb();
  db.prepare(`
    INSERT INTO lead_magnets (id, widget_id, name, description, file_path, file_url, ai_content, when_to_recommend, target_audience, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, req.params.widgetId, name.trim(), (description || '').trim(),
    filePath, fileUrl, aiInfo.summary || '', aiInfo.when_to_recommend || '', aiInfo.target_audience || '');

  // If a lang was specified with the file, also insert into lead_magnet_files
  if (req.file && lang && SUPPORTED_LANGS.includes(lang)) {
    db.prepare(
      'INSERT OR REPLACE INTO lead_magnet_files (id, lead_magnet_id, lang, file_path, file_url) VALUES (?,?,?,?,?)'
    ).run(uuidv4(), id, lang, filePath, fileUrl);
  }

  const item = db.prepare('SELECT * FROM lead_magnets WHERE id = ?').get(id);
  item.files = db.prepare(
    'SELECT id, lang, file_url, created_at FROM lead_magnet_files WHERE lead_magnet_id = ? ORDER BY lang'
  ).all(id);
  res.json(item);
});

/* POST /api/lead-magnets/:widgetId/:lmId/files — add/replace language file */
router.post('/:widgetId/:lmId/files', upload.single('file'), async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const { lang } = req.body;
  if (!lang || (!SUPPORTED_LANGS.includes(lang) && lang !== 'default')) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Neplatný jazyk.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Súbor je povinný.' });

  const lm = getDb().prepare(
    'SELECT id FROM lead_magnets WHERE id = ? AND widget_id = ?'
  ).get(req.params.lmId, req.params.widgetId);
  if (!lm) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Lead magnet nenájdený.' }); }

  // Delete old file if replacing
  const old = getDb().prepare(
    'SELECT id, file_path FROM lead_magnet_files WHERE lead_magnet_id = ? AND lang = ?'
  ).get(req.params.lmId, lang);
  if (old?.file_path) fs.unlink(old.file_path, () => {});

  const fileUrl = `${appOrigin()}/uploads/lead-magnets/${req.file.filename}`;
  getDb().prepare(
    'INSERT OR REPLACE INTO lead_magnet_files (id, lead_magnet_id, lang, file_path, file_url) VALUES (?,?,?,?,?)'
  ).run(uuidv4(), req.params.lmId, lang, req.file.path, fileUrl);

  const files = getDb().prepare(
    'SELECT id, lang, file_url, created_at FROM lead_magnet_files WHERE lead_magnet_id = ? ORDER BY lang'
  ).all(req.params.lmId);
  res.json({ ok: true, files });
});

/* DELETE /api/lead-magnets/:widgetId/:lmId/files/:fileId */
router.delete('/:widgetId/:lmId/files/:fileId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const f = getDb().prepare(
    'SELECT f.id, f.file_path FROM lead_magnet_files f JOIN lead_magnets m ON m.id = f.lead_magnet_id WHERE f.id = ? AND m.widget_id = ?'
  ).get(req.params.fileId, req.params.widgetId);
  if (!f) return res.status(404).json({ error: 'Súbor nenájdený.' });

  getDb().prepare('DELETE FROM lead_magnet_files WHERE id = ?').run(req.params.fileId);
  if (f.file_path) fs.unlink(f.file_path, () => {});
  res.json({ ok: true });
});

/* PATCH /api/lead-magnets/:widgetId/:lmId */
router.patch('/:widgetId/:lmId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const lm = getDb().prepare('SELECT id FROM lead_magnets WHERE id = ? AND widget_id = ?').get(req.params.lmId, req.params.widgetId);
  if (!lm) return res.status(404).json({ error: 'Lead magnet nenájdený.' });

  const allowed = ['active', 'name', 'description', 'when_to_recommend', 'target_audience'];
  const sets = [], vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { sets.push(`${key} = ?`); vals.push(req.body[key]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Žiadne zmeny.' });
  vals.push(req.params.lmId);
  getDb().prepare(`UPDATE lead_magnets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const updated = getDb().prepare('SELECT * FROM lead_magnets WHERE id = ?').get(req.params.lmId);
  res.json(updated);
});

/* DELETE /api/lead-magnets/:widgetId/:lmId */
router.delete('/:widgetId/:lmId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const lm = getDb().prepare('SELECT id, file_path FROM lead_magnets WHERE id = ? AND widget_id = ?').get(req.params.lmId, req.params.widgetId);
  if (!lm) return res.status(404).json({ error: 'Lead magnet nenájdený.' });

  // Clean up all language files first
  const langFiles = getDb().prepare('SELECT file_path FROM lead_magnet_files WHERE lead_magnet_id = ?').all(req.params.lmId);
  for (const f of langFiles) { if (f.file_path) fs.unlink(f.file_path, () => {}); }

  getDb().prepare('DELETE FROM lead_magnets WHERE id = ?').run(req.params.lmId);
  if (lm.file_path) fs.unlink(lm.file_path, () => {});
  res.json({ ok: true });
});

/* ── Leads ─────────────────────────────────────────────────── */

router.get('/:widgetId/leads', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const lmId = req.query.lmId || null;
  const sql = lmId
    ? `SELECT l.*, m.name AS lm_name FROM lead_magnet_leads l JOIN lead_magnets m ON m.id = l.lead_magnet_id WHERE l.widget_id = ? AND l.lead_magnet_id = ? ORDER BY l.created_at DESC`
    : `SELECT l.*, m.name AS lm_name FROM lead_magnet_leads l JOIN lead_magnets m ON m.id = l.lead_magnet_id WHERE l.widget_id = ? ORDER BY l.created_at DESC`;
  const leads = lmId ? getDb().prepare(sql).all(req.params.widgetId, lmId) : getDb().prepare(sql).all(req.params.widgetId);
  res.json(leads);
});

router.get('/:widgetId/leads/export.csv', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const lmId = req.query.lmId || null;
  const sql = lmId
    ? `SELECT l.*, m.name AS lm_name FROM lead_magnet_leads l JOIN lead_magnets m ON m.id = l.lead_magnet_id WHERE l.widget_id = ? AND l.lead_magnet_id = ? ORDER BY l.created_at DESC`
    : `SELECT l.*, m.name AS lm_name FROM lead_magnet_leads l JOIN lead_magnets m ON m.id = l.lead_magnet_id WHERE l.widget_id = ? ORDER BY l.created_at DESC`;
  const leads = lmId ? getDb().prepare(sql).all(req.params.widgetId, lmId) : getDb().prepare(sql).all(req.params.widgetId);

  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const csv = '\uFEFF' + [
    ['Lead Magnet', 'Meno', 'Email', 'Dátum'].map(esc).join(','),
    ...leads.map(l => [l.lm_name, l.name || '', l.email, new Date(l.created_at * 1000).toLocaleString('sk-SK')].map(esc).join(',')),
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lead-magnet-leads.csv"');
  res.send(csv);
});

module.exports = router;
