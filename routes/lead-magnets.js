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

// Persistent disk storage so PDF files remain accessible for download
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
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
  fileFilter(req, file, cb) {
    const allowed = ['application/pdf', 'text/plain', 'text/markdown'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = ['.pdf', '.txt', '.md'];
    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Povolené typy: PDF, TXT, MD'));
    }
  },
});

/* ── helpers ─────────────────────────────────────────────────── */
function ownsWidget(widgetId, userId) {
  return !!getDb().prepare(
    'SELECT 1 FROM widgets WHERE id = ? AND user_id = ?'
  ).get(widgetId, userId);
}

function origin() {
  return (process.env.APP_URL || 'https://neuradesk.online').replace(/\/$/, '');
}

/* ── AI extraction ───────────────────────────────────────────── */
async function extractLeadMagnetInfo(content, fileName) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const truncated = content.slice(0, 12000);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Si marketingový expert. Analyzuj obsah tohto lead magnetu (e-book / PDF / sprievodca) a extrahuj kľúčové informácie pre predajného chatbota.

Súbor: ${fileName}

Obsah:
${truncated}

Vráť VÝHRADNE JSON (žiadny iný text):
{
  "when_to_recommend": "Stručný popis – kedy má chatbot odporučiť tento lead magnet zákazníkovi (situácia, potreby, otázky zákazníka)",
  "target_audience": "Pre koho je lead magnet určený – typ zákazníka, jeho problémy, štádium nákupného rozhodnutia",
  "summary": "Čo lead magnet obsahuje a aký prínos dáva čitateľovi (2–3 vety)"
}`,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { when_to_recommend: '', target_audience: '', summary: '' };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { when_to_recommend: '', target_audience: '', summary: '' };
  }
}

/* ══════════════════════════════════════════════════════════════
   PUBLIC ROUTE (no auth) — widget email capture
   POST /api/lead-magnets/:widgetId/leads/capture
══════════════════════════════════════════════════════════════ */
router.post('/:widgetId/leads/capture', (req, res) => {
  const { lmId, email, name, sessionId } = req.body;

  if (!lmId || !email || !email.includes('@')) {
    return res.status(400).json({ error: 'Neplatné údaje.' });
  }

  // Verify lead magnet belongs to widget and is active
  const lm = getDb().prepare(
    'SELECT id, file_url FROM lead_magnets WHERE id = ? AND widget_id = ? AND active = 1'
  ).get(lmId, req.params.widgetId);
  if (!lm) return res.status(404).json({ error: 'Lead magnet nenájdený.' });

  // Upsert — same email + lmId just updates timestamp
  const existing = getDb().prepare(
    'SELECT id FROM lead_magnet_leads WHERE lead_magnet_id = ? AND email = ?'
  ).get(lmId, email);

  if (!existing) {
    getDb().prepare(`
      INSERT INTO lead_magnet_leads (id, lead_magnet_id, widget_id, email, name, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), lmId, req.params.widgetId, email.trim().toLowerCase(), (name || '').trim(), sessionId || null);
  }

  res.json({ ok: true, fileUrl: lm.file_url });
});

/* ══════════════════════════════════════════════════════════════
   AUTHENTICATED ROUTES
══════════════════════════════════════════════════════════════ */
router.use(requireAuth);

/* GET /api/lead-magnets/:widgetId — list lead magnets */
router.get('/:widgetId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const items = getDb().prepare(
    `SELECT id, name, description, file_url, when_to_recommend, target_audience, ai_content, active, created_at
     FROM lead_magnets WHERE widget_id = ? ORDER BY created_at DESC`
  ).all(req.params.widgetId);
  res.json(items);
});

/* POST /api/lead-magnets/:widgetId — upload new lead magnet */
router.post('/:widgetId', upload.single('file'), async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const { name, description } = req.body;
  if (!name?.trim()) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Názov je povinný.' });
  }

  let filePath = null;
  let fileUrl = null;
  let aiInfo = { when_to_recommend: '', target_audience: '', summary: '' };

  if (req.file) {
    filePath = req.file.path;
    fileUrl = `${origin()}/uploads/lead-magnets/${req.file.filename}`;

    try {
      const content = await parseFile(req.file.path, req.file.mimetype, req.file.originalname);
      aiInfo = await extractLeadMagnetInfo(content, req.file.originalname);
    } catch (err) {
      console.error('Lead magnet AI extraction error:', err.message);
    }
  }

  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO lead_magnets (id, widget_id, name, description, file_path, file_url, ai_content, when_to_recommend, target_audience, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    req.params.widgetId,
    name.trim(),
    (description || '').trim(),
    filePath,
    fileUrl,
    aiInfo.summary || '',
    aiInfo.when_to_recommend || '',
    aiInfo.target_audience || '',
  );

  const item = getDb().prepare('SELECT * FROM lead_magnets WHERE id = ?').get(id);
  res.json(item);
});

/* PATCH /api/lead-magnets/:widgetId/:lmId — toggle active or update fields */
router.patch('/:widgetId/:lmId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const lm = getDb().prepare(
    'SELECT id FROM lead_magnets WHERE id = ? AND widget_id = ?'
  ).get(req.params.lmId, req.params.widgetId);
  if (!lm) return res.status(404).json({ error: 'Lead magnet nenájdený.' });

  const allowed = ['active', 'name', 'description', 'when_to_recommend', 'target_audience'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(req.body[key]);
    }
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

  const lm = getDb().prepare(
    'SELECT id, file_path FROM lead_magnets WHERE id = ? AND widget_id = ?'
  ).get(req.params.lmId, req.params.widgetId);
  if (!lm) return res.status(404).json({ error: 'Lead magnet nenájdený.' });

  getDb().prepare('DELETE FROM lead_magnets WHERE id = ?').run(req.params.lmId);

  // Clean up file
  if (lm.file_path) {
    fs.unlink(lm.file_path, () => {});
  }

  res.json({ ok: true });
});

/* ── Leads ─────────────────────────────────────────────────── */

/* GET /api/lead-magnets/:widgetId/leads — list email leads */
router.get('/:widgetId/leads', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const lmId = req.query.lmId || null;
  const leads = lmId
    ? getDb().prepare(`
        SELECT l.*, m.name AS lm_name
        FROM lead_magnet_leads l
        JOIN lead_magnets m ON m.id = l.lead_magnet_id
        WHERE l.widget_id = ? AND l.lead_magnet_id = ?
        ORDER BY l.created_at DESC
      `).all(req.params.widgetId, lmId)
    : getDb().prepare(`
        SELECT l.*, m.name AS lm_name
        FROM lead_magnet_leads l
        JOIN lead_magnets m ON m.id = l.lead_magnet_id
        WHERE l.widget_id = ?
        ORDER BY l.created_at DESC
      `).all(req.params.widgetId);

  res.json(leads);
});

/* GET /api/lead-magnets/:widgetId/leads/export.csv */
router.get('/:widgetId/leads/export.csv', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const lmId = req.query.lmId || null;
  const leads = lmId
    ? getDb().prepare(`
        SELECT l.*, m.name AS lm_name
        FROM lead_magnet_leads l
        JOIN lead_magnets m ON m.id = l.lead_magnet_id
        WHERE l.widget_id = ? AND l.lead_magnet_id = ?
        ORDER BY l.created_at DESC
      `).all(req.params.widgetId, lmId)
    : getDb().prepare(`
        SELECT l.*, m.name AS lm_name
        FROM lead_magnet_leads l
        JOIN lead_magnets m ON m.id = l.lead_magnet_id
        WHERE l.widget_id = ?
        ORDER BY l.created_at DESC
      `).all(req.params.widgetId);

  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const rows = [
    ['Lead Magnet', 'Meno', 'Email', 'Dátum'].map(esc).join(','),
    ...leads.map(l => [
      l.lm_name,
      l.name || '',
      l.email,
      new Date(l.created_at * 1000).toLocaleString('sk-SK'),
    ].map(esc).join(',')),
  ];

  // UTF-8 BOM for Excel
  const csv = '\uFEFF' + rows.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lead-magnet-leads.csv"`);
  res.send(csv);
});

module.exports = router;
