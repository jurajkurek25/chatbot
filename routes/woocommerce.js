'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function ownsWidget(widgetId, userId) {
  return !!getDb().prepare('SELECT 1 FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId);
}

async function fetchWooProducts(storeUrl, key, secret) {
  const base = storeUrl.replace(/\/$/, '');
  const url = `${base}/wp-json/wc/v3/products?per_page=100&status=publish`;
  const creds = Buffer.from(`${key}:${secret}`).toString('base64');
  const resp = await fetch(url, { headers: { Authorization: `Basic ${creds}`, 'User-Agent': 'NeuraDeskApp/1.0' } });
  if (!resp.ok) throw new Error(`WooCommerce API returned ${resp.status}`);
  return resp.json();
}

// POST /api/woocommerce/:widgetId/connect — save credentials + scan
router.post('/:widgetId/connect', async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  const { store_url, consumer_key, consumer_secret } = req.body;
  if (!store_url || !consumer_key || !consumer_secret) return res.status(400).json({ error: 'Vyplňte všetky polia.' });

  // Validate by fetching
  let products;
  try { products = await fetchWooProducts(store_url, consumer_key, consumer_secret); }
  catch(e) { return res.status(400).json({ error: `Nepodarilo sa pripojiť: ${e.message}` }); }

  // Save credentials
  const db = getDb();
  db.prepare('UPDATE widgets SET woo_url = ?, woo_key = ?, woo_secret = ? WHERE id = ?')
    .run(store_url.trim(), consumer_key.trim(), consumer_secret.trim(), req.params.widgetId);

  // Import products
  let imported = 0;
  for (const p of products.slice(0, 100)) {
    if (!p.name) continue;
    const exists = db.prepare('SELECT id FROM products WHERE widget_id = ? AND name = ?').get(req.params.widgetId, p.name);
    if (exists) continue;
    const desc = [p.description, p.short_description].filter(Boolean).join(' ').replace(/<[^>]+>/g, '').slice(0, 1000);
    const price = parseFloat(p.price) || null;
    db.prepare(`INSERT INTO products (id, widget_id, name, type, description, price, currency, landing_url, active)
      VALUES (?,?,?,'digital',?,?,?,?,1)`).run(uuidv4(), req.params.widgetId, p.name, desc, price, 'EUR', p.permalink || '');
    imported++;
  }

  res.json({ ok: true, imported, total: products.length });
});

// DELETE /api/woocommerce/:widgetId/disconnect
router.delete('/:widgetId/disconnect', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  getDb().prepare('UPDATE widgets SET woo_url = NULL, woo_key = NULL, woo_secret = NULL WHERE id = ?').run(req.params.widgetId);
  res.json({ ok: true });
});

// GET /api/woocommerce/:widgetId/status
router.get('/:widgetId/status', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  const w = getDb().prepare('SELECT woo_url FROM widgets WHERE id = ?').get(req.params.widgetId);
  res.json({ connected: !!w?.woo_url, store_url: w?.woo_url || null });
});

module.exports = router;
