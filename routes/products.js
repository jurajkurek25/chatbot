'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_TYPES = ['digital','physical','service','consultation','course','ticket','lead_magnet'];

// CSV upload — memory storage (files are small)
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = file.mimetype === 'text/csv'
      || file.mimetype === 'application/vnd.ms-excel'
      || file.originalname.endsWith('.csv');
    cb(ok ? null : new Error('Povolený je iba CSV súbor.'), ok);
  },
});

const CSV_COLUMNS = [
  'name','type','description','for_whom','benefits',
  'price','currency','stripe_link','cta_text','landing_url',
  'recommend_when','not_recommend_when','faq','tags','priority','active',
];

/** Robust CSV row parser — handles quoted fields containing commas/newlines */
function parseCSV(text) {
  const rows = [];
  // Normalise line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let i = 0;

  while (i < lines.length) {
    const row = [];
    // Skip blank lines
    if (lines[i] === '\n') { i++; continue; }

    while (i < lines.length && lines[i] !== '\n') {
      if (lines[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < lines.length) {
          if (lines[i] === '"' && lines[i + 1] === '"') {
            field += '"'; i += 2;
          } else if (lines[i] === '"') {
            i++; break; // closing quote
          } else {
            field += lines[i++];
          }
        }
        row.push(field);
        if (lines[i] === ',') i++;
      } else {
        // Unquoted field
        let field = '';
        while (i < lines.length && lines[i] !== ',' && lines[i] !== '\n') {
          field += lines[i++];
        }
        row.push(field.trim());
        if (lines[i] === ',') i++;
      }
    }
    if (lines[i] === '\n') i++;
    if (row.length) rows.push(row);
  }
  return rows;
}

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

// GET /api/products/:widgetId/template.csv — download CSV template
router.get('/:widgetId/template.csv', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const header = CSV_COLUMNS.join(',');
  const example = [
    '"Môj produkt"','service','"Popis produktu"','"Pre koho je vhodný"','"Hlavné benefity"',
    '99','EUR','"https://stripe.com/pay/xxx"','"Kúpiť teraz"','"https://myweb.com/produkt"',
    '"Keď zákazník hľadá X"','"Keď zákazník nechce Y"','"Otázka: odpoveď"','"tag1,tag2"','0','1',
  ].join(',');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="produkty-sablona.csv"');
  res.send('\uFEFF' + header + '\n' + example + '\n');
});

// POST /api/products/:widgetId/import-csv — bulk import from CSV
router.post('/:widgetId/import-csv', csvUpload.single('file'), (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Chýba CSV súbor.' });

  const text = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, ''); // strip BOM
  const rows = parseCSV(text);
  if (!rows.length) return res.status(400).json({ error: 'CSV je prázdne.' });

  // First row: detect if it's a header row
  const firstRow = rows[0].map(c => c.toLowerCase().trim());
  const isHeader = firstRow.includes('name') || firstRow.includes('nazov') || firstRow.includes('meno');
  const dataRows = isHeader ? rows.slice(1) : rows;

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO products (
      id, widget_id, name, type, description, for_whom, benefits,
      price, currency, stripe_link, cta_text, landing_url,
      recommend_when, not_recommend_when, faq, tags, priority, active
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let imported = 0;
  const errors = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const lineNum = (isHeader ? i + 2 : i + 1);

    // Map columns by position (same order as CSV_COLUMNS)
    const [
      name = '', type = 'service', description = '', for_whom = '', benefits = '',
      priceRaw = '', currency = 'EUR', stripe_link = '', cta_text = 'Zistiť viac', landing_url = '',
      recommend_when = '', not_recommend_when = '', faq = '', tags = '', priorityRaw = '0', activeRaw = '1',
    ] = row;

    if (!name.trim()) {
      errors.push(`Riadok ${lineNum}: chýba názov produktu`);
      continue;
    }

    const resolvedType = ALLOWED_TYPES.includes(type.trim()) ? type.trim() : 'service';
    const price = priceRaw.trim() !== '' ? parseFloat(priceRaw) : null;
    const priority = parseInt(priorityRaw, 10) || 0;
    const active = activeRaw.trim() === '0' ? 0 : 1;

    try {
      insert.run(
        uuidv4(), req.params.widgetId, name.trim(), resolvedType,
        description, for_whom, benefits,
        isNaN(price) ? null : price, currency.trim() || 'EUR',
        stripe_link.trim() || null, cta_text.trim() || 'Zistiť viac', landing_url.trim() || null,
        recommend_when, not_recommend_when, faq, tags, priority, active
      );
      imported++;
    } catch (err) {
      errors.push(`Riadok ${lineNum}: ${err.message}`);
    }
  }

  res.json({ imported, errors });
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
