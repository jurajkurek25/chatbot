'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { runSeoAudit, generateWordPressFix, generateHtmlFix, generateSchemaFix, generateLlmsTxt } = require('../services/seo-auditor');

const router = express.Router();
router.use(requireAuth);

/* ── POST /api/seo/start ──────────────────────────────────────── */
router.post('/start', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL je povinná.' });

    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Neplatná URL.' }); }
    if (!parsed.protocol.startsWith('http')) return res.status(400).json({ error: 'Len HTTP/HTTPS URL.' });

    const db = getDb();
    const user = db.prepare('SELECT growth_boost_paid FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

    const auditId = uuidv4();
    const cleanUrl = (() => { const u = new URL(url); u.hash = ''; u.search = ''; return u.href; })();

    db.prepare(`
      INSERT INTO seo_audits (id, user_id, url, status, findings_json)
      VALUES (?, ?, ?, 'running', '{}')
    `).run(auditId, req.userId, cleanUrl);

    runSeoAudit(cleanUrl, 8).then(result => {
      db.prepare(`
        UPDATE seo_audits
        SET status = 'done', score = ?, findings_json = ?, completed_at = unixepoch()
        WHERE id = ?
      `).run(result.score, JSON.stringify(result), auditId);
    }).catch(err => {
      db.prepare(`UPDATE seo_audits SET status = 'error', findings_json = ? WHERE id = ?`)
        .run(JSON.stringify({ error: err.message }), auditId);
    });

    res.json({ audit_id: auditId, status: 'running' });
  } catch (err) {
    console.error('[seo/start]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── GET /api/seo/status/:auditId ────────────────────────────── */
router.get('/status/:auditId', (req, res) => {
  try {
    const db = getDb();
    const audit = db.prepare('SELECT * FROM seo_audits WHERE id = ? AND user_id = ?')
      .get(req.params.auditId, req.userId);
    if (!audit) return res.status(404).json({ error: 'Audit nenájdený.' });

    let findings = {};
    try { findings = JSON.parse(audit.findings_json); } catch {}

    res.json({ id: audit.id, url: audit.url, status: audit.status, score: audit.score, findings, created_at: audit.created_at, completed_at: audit.completed_at });
  } catch (err) {
    console.error('[seo/status]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── GET /api/seo/latest ─────────────────────────────────────── */
router.get('/latest', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT growth_boost_paid FROM users WHERE id = ?').get(req.userId);
    const audit = db.prepare(`
      SELECT * FROM seo_audits WHERE user_id = ? AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1
    `).get(req.userId);

    if (!audit) return res.json({ audit: null, has_boost: Boolean(user?.growth_boost_paid) });

    let findings = {};
    try { findings = JSON.parse(audit.findings_json); } catch {}

    res.json({
      audit: { id: audit.id, url: audit.url, status: audit.status, score: audit.score, findings, created_at: audit.created_at, completed_at: audit.completed_at },
      has_boost: Boolean(user?.growth_boost_paid),
    });
  } catch (err) {
    console.error('[seo/latest]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── GET /api/seo/fix/wordpress ──────────────────────────────── */
router.get('/fix/wordpress', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT growth_boost_paid FROM users WHERE id = ?').get(req.userId);
    if (!user?.growth_boost_paid) return res.status(403).json({ error: 'Táto funkcia vyžaduje Growth Boost.' });

    const audit = db.prepare(`
      SELECT findings_json FROM seo_audits WHERE user_id = ? AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1
    `).get(req.userId);
    if (!audit) return res.status(404).json({ error: 'Žiadny dokončený audit.' });

    let result = {};
    try { result = JSON.parse(audit.findings_json); } catch {}

    const php = generateWordPressFix(result);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="neoworkly-seo-fix.php"');
    res.send(php);
  } catch (err) {
    console.error('[seo/fix/wordpress]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── GET /api/seo/fix/html ───────────────────────────────────── */
router.get('/fix/html', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT growth_boost_paid FROM users WHERE id = ?').get(req.userId);
    if (!user?.growth_boost_paid) return res.status(403).json({ error: 'Táto funkcia vyžaduje Growth Boost.' });

    const audit = db.prepare(`
      SELECT findings_json FROM seo_audits WHERE user_id = ? AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1
    `).get(req.userId);
    if (!audit) return res.status(404).json({ error: 'Žiadny dokončený audit.' });

    let result = {};
    try { result = JSON.parse(audit.findings_json); } catch {}

    const html = generateHtmlFix(result);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="neoworkly-seo-fix.html"');
    res.send(html);
  } catch (err) {
    console.error('[seo/fix/html]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── GET /api/seo/fix/schema ─────────────────────────────────── */
router.get('/fix/schema', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT growth_boost_paid FROM users WHERE id = ?').get(req.userId);
    if (!user?.growth_boost_paid) return res.status(403).json({ error: 'Táto funkcia vyžaduje Growth Boost.' });

    const audit = db.prepare(`
      SELECT findings_json FROM seo_audits WHERE user_id = ? AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1
    `).get(req.userId);
    if (!audit) return res.status(404).json({ error: 'Žiadny dokončený audit.' });

    let result = {};
    try { result = JSON.parse(audit.findings_json); } catch {}

    const html = generateSchemaFix(result);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="neoworkly-schema.html"');
    res.send(html);
  } catch (err) {
    console.error('[seo/fix/schema]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── GET /api/seo/fix/llms ───────────────────────────────────── */
router.get('/fix/llms', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT growth_boost_paid FROM users WHERE id = ?').get(req.userId);
    if (!user?.growth_boost_paid) return res.status(403).json({ error: 'Táto funkcia vyžaduje Growth Boost.' });

    const audit = db.prepare(`
      SELECT findings_json FROM seo_audits WHERE user_id = ? AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1
    `).get(req.userId);
    if (!audit) return res.status(404).json({ error: 'Žiadny dokončený audit.' });

    let result = {};
    try { result = JSON.parse(audit.findings_json); } catch {}

    const txt = generateLlmsTxt(result);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="llms.txt"');
    res.send(txt);
  } catch (err) {
    console.error('[seo/fix/llms]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── GET /api/seo/preview ────────────────────────────────────── */
router.get('/preview', (req, res) => {
  try {
    const db = getDb();
    const audit = db.prepare(`
      SELECT findings_json, score, url FROM seo_audits WHERE user_id = ? AND status IN ('done','running')
      ORDER BY created_at DESC LIMIT 1
    `).get(req.userId);

    if (!audit) return res.json({ audit: null });

    let findings = {};
    try { findings = JSON.parse(audit.findings_json); } catch {}

    const teaser = findings.pages
      ? findings.pages.flatMap(p => p.findings).slice(0, 3)
      : [];

    res.json({ score: audit.score, url: audit.url, teaser, total_issues: findings.summary?.total_issues ?? 0 });
  } catch (err) {
    console.error('[seo/preview]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

module.exports = router;
