'use strict';

const express   = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDb }       = require('../db/database');
const { crawlSite }   = require('../services/scraper');
const { v4: uuidv4 }  = require('uuid');

const router = express.Router();
router.use(requireAuth);

// POST /api/scraper/scan
// Body: { url: "https://example.com", widget_id: "...", max_pages: 15 }
router.post('/scan', async (req, res) => {
  let { url, widget_id, max_pages } = req.body;

  // Validate URL
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL je povinná.' });
  }
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Neplatná URL adresa.' });
  }
  // SSRF protection: block private/loopback addresses
  const _scHost = new URL(url).hostname;
  if (
    _scHost === 'localhost' || _scHost === '::1' ||
    /^127\./.test(_scHost) || /^10\./.test(_scHost) ||
    /^192\.168\./.test(_scHost) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(_scHost) ||
    /^169\.254\./.test(_scHost)
  ) {
    return res.status(400).json({ error: 'Privátne IP adresy nie sú povolené.' });
  }

  // Validate widget ownership
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(widget_id, req.userId);
  if (!widget) {
    return res.status(403).json({ error: 'Widget nenájdený.' });
  }

  const limit = Math.min(Math.max(parseInt(max_pages) || 15, 1), 20);

  try {
    const pages = await crawlSite(url, limit);

    if (pages.length === 0) {
      return res.status(422).json({ error: 'Na tejto stránke sa nepodarilo nájsť žiadny obsah. Skúste inú URL.' });
    }

    // Import each page as a knowledge item
    const stmt = db.prepare(
      'INSERT INTO knowledge_items (id, widget_id, title, content, source_type) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMany = db.transaction((items) => {
      for (const item of items) {
        stmt.run(uuidv4(), widget_id, item.title, item.content, 'url');
      }
    });
    insertMany(pages);

    return res.json({
      imported: pages.length,
      pages: pages.map(p => ({ url: p.url, title: p.title, chars: p.content.length })),
    });
  } catch (err) {
    console.error('[scraper] error:', err.message);
    return res.status(500).json({ error: 'Chyba pri skenovaní stránky: ' + err.message });
  }
});

module.exports = router;
