'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { fetchPage, extractText, isPrivateHost } = require('../services/scraper');
const { analyzeProspect, batchAnalyzeSearchResults } = require('../services/claude');
const { searchGoogle, getNextQuery } = require('../services/google-search');
const { URL } = require('url');

const LOW_PROSPECT_THRESHOLD = 5; // auto-discover when uncontacted drops below this

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

// POST /api/prospects/discover — Google Search → AI batch analysis → save new prospects
router.post('/discover', async (req, res) => {
  const db = getDb();

  if (!process.env.SERPER_API_KEY) {
    return res.status(503).json({ error: 'SERPER_API_KEY nie je nakonfigurovaný na serveri.' });
  }

  const { query: customQuery } = req.body;
  let searchQuery;

  if (customQuery?.trim()) {
    searchQuery = customQuery.trim();
  } else {
    const { query } = getNextQuery(db);
    searchQuery = query;
  }

  try {
    // 1. Google search
    const searchData = await searchGoogle(searchQuery, 10);
    const organic = (searchData.organic || []).filter(r => r.link && r.title);

    if (organic.length === 0) {
      return res.json({ added: 0, query: searchQuery, message: 'Žiadne výsledky.' });
    }

    // 2. Skip already-known URLs
    const existing = new Set(
      db.prepare('SELECT url FROM prospects WHERE user_id = ? AND url IS NOT NULL').all(req.userId).map(r => r.url)
    );
    const fresh = organic.filter(r => !existing.has(r.link));

    if (fresh.length === 0) {
      return res.json({ added: 0, query: searchQuery, message: 'Všetky výsledky už máte uložené.' });
    }

    // 3. Batch AI analysis (title + snippet, no scraping)
    const analyses = await batchAnalyzeSearchResults(fresh);

    // 4. Save high-fit prospects (fit_score >= 4 and not skipped)
    let added = 0;
    const insert = db.prepare(`INSERT INTO prospects
      (id, user_id, url, company_name, industry, fit_score, opening_line, source)
      VALUES (?,?,?,?,?,?,?,?)`);

    for (const a of analyses) {
      if (a.skip || a.fit_score < 4) continue;
      const src = fresh[a.idx - 1];
      if (!src) continue;
      try {
        insert.run(
          uuidv4(), req.userId, src.link,
          a.company_name || src.title,
          a.industry || null,
          a.fit_score || null,
          a.opening_line || null,
          'auto'
        );
        added++;
      } catch { /* duplicate url — skip */ }
    }

    res.json({ added, query: searchQuery, total_searched: fresh.length });
  } catch (err) {
    console.error('[prospects/discover]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/stats — uncontacted count (used for auto-trigger)
router.get('/stats', (req, res) => {
  const db = getDb();
  const total      = db.prepare("SELECT COUNT(*) as n FROM prospects WHERE user_id = ?").get(req.userId).n;
  const uncontacted = db.prepare("SELECT COUNT(*) as n FROM prospects WHERE user_id = ? AND status = 'new'").get(req.userId).n;
  res.json({ total, uncontacted, threshold: LOW_PROSPECT_THRESHOLD });
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
