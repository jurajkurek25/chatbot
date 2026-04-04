'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_TYPES = ['digital','physical','service','consultation','course','ticket','lead_magnet'];

function ownsWidget(widgetId, userId) {
  const db = getDb();
  return Boolean(db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId));
}

// GET /api/products/:widgetId — list all products for widget
router.get('/:widgetId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const db = getDb();
  const products = db.prepare(`
    SELECT * FROM products WHERE widget_id = ? ORDER BY priority DESC, created_at DESC
  `).all(req.params.widgetId);
  res.json(products);
});

// POST /api/products/:widgetId — create product
router.post('/:widgetId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const {
    name, type = 'service', description = '', for_whom = '', benefits = '',
    price, currency = 'EUR', stripe_link, cta_text = 'Zistiť viac',
    landing_url, recommend_when = '', not_recommend_when = '',
    faq = '', tags = '', priority = 0, active = 1,
  } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Názov produktu je povinný.' });
  if (!ALLOWED_TYPES.includes(type)) return res.status(400).json({ error: 'Neplatný typ produktu.' });

  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO products (
      id, widget_id, name, type, description, for_whom, benefits,
      price, currency, stripe_link, cta_text, landing_url,
      recommend_when, not_recommend_when, faq, tags, priority, active
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, req.params.widgetId, name.trim(), type, description, for_whom, benefits,
    price ?? null, currency, stripe_link || null, cta_text, landing_url || null,
    recommend_when, not_recommend_when, faq, tags, priority, active ? 1 : 0
  );

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  res.status(201).json(product);
});

// PUT /api/products/:widgetId/:productId — update product
router.put('/:widgetId/:productId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const db = getDb();
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND widget_id = ?').get(
    req.params.productId, req.params.widgetId
  );
  if (!product) return res.status(404).json({ error: 'Produkt nenájdený.' });

  const {
    name, type, description, for_whom, benefits,
    price, currency, stripe_link, cta_text, landing_url,
    recommend_when, not_recommend_when, faq, tags, priority, active,
  } = req.body;

  if (type && !ALLOWED_TYPES.includes(type)) return res.status(400).json({ error: 'Neplatný typ produktu.' });

  db.prepare(`
    UPDATE products SET
      name = COALESCE(?, name),
      type = COALESCE(?, type),
      description = COALESCE(?, description),
      for_whom = COALESCE(?, for_whom),
      benefits = COALESCE(?, benefits),
      price = ?,
      currency = COALESCE(?, currency),
      stripe_link = ?,
      cta_text = COALESCE(?, cta_text),
      landing_url = ?,
      recommend_when = COALESCE(?, recommend_when),
      not_recommend_when = COALESCE(?, not_recommend_when),
      faq = COALESCE(?, faq),
      tags = COALESCE(?, tags),
      priority = COALESCE(?, priority),
      active = COALESCE(?, active)
    WHERE id = ?
  `).run(
    name?.trim() || null, type || null, description ?? null, for_whom ?? null, benefits ?? null,
    price !== undefined ? (price ?? null) : undefined === price ? undefined : price,
    currency || null, stripe_link !== undefined ? (stripe_link || null) : null,
    cta_text || null, landing_url !== undefined ? (landing_url || null) : null,
    recommend_when ?? null, not_recommend_when ?? null, faq ?? null, tags ?? null,
    priority !== undefined ? priority : null,
    active !== undefined ? (active ? 1 : 0) : null,
    req.params.productId
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.productId);
  res.json(updated);
});

// DELETE /api/products/:widgetId/:productId — delete product
router.delete('/:widgetId/:productId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const db = getDb();
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND widget_id = ?').get(
    req.params.productId, req.params.widgetId
  );
  if (!product) return res.status(404).json({ error: 'Produkt nenájdený.' });
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.productId);
  res.json({ ok: true });
});

module.exports = router;
