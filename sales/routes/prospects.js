'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { fetchPage, extractText, isPrivateHost } = require('../services/scraper');
const { analyzeProspect } = require('../services/claude');
const { URL } = require('url');

const router = express.Router();
router.use(requireAuth);

router.post('/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Zadajte URL.' });

  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    if (isPrivateHost(parsed.hostname)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Neplatná alebo nepovolená URL.' });
  }

  try {
    const html = await fetchPage(parsed.href);
    const pageContent = extractText(html);
    const analysis = await analyzeProspect(pageContent, parsed.href);
    res.json({ ok: true, url: parsed.href, ...analysis });
  } catch (err) {
    console.error('[prospects/analyze]', err.message);
    res.status(422).json({ error: `Nepodarilo sa analyzovať stránku: ${err.message}` });
  }
});

router.get('/', (req, res) => {
  const db = getDb();
  const prospects = db.prepare(
    'SELECT * FROM prospects WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.userId);
  res.json(prospects);
});

router.post('/', (req, res) => {
  const { url, company_name, industry, description, contact_email, contact_phone,
          fit_score, ai_summary, opening_line } = req.body;
  if (!company_name?.trim()) return res.status(400).json({ error: 'Názov firmy je povinný.' });

  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO prospects
    (id, user_id, url, company_name, industry, description, contact_email, contact_phone,
     fit_score, ai_summary, opening_line)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, req.userId, url || null, company_name.trim(), industry || null,
    description || null, contact_email || null, contact_phone || null,
    fit_score ? parseInt(fit_score) : null, ai_summary || null, opening_line || null);

  res.json(db.prepare('SELECT * FROM prospects WHERE id = ?').get(id));
});

router.patch('/:id', (req, res) => {
  const db = getDb();
  const prospect = db.prepare('SELECT id FROM prospects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!prospect) return res.status(404).json({ error: 'Prospekt nenájdený.' });

  const { status, notes } = req.body;
  const validStatuses = ['new', 'contacted', 'converted', 'rejected'];
  if (status && !validStatuses.includes(status))
    return res.status(400).json({ error: 'Neplatný status.' });

  db.prepare('UPDATE prospects SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?')
    .run(status || null, notes !== undefined ? notes : null, req.params.id);

  res.json(db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const prospect = db.prepare('SELECT id FROM prospects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!prospect) return res.status(404).json({ error: 'Prospekt nenájdený.' });
  db.prepare('DELETE FROM prospects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
