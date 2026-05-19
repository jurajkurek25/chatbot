'use strict';
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Internal auth middleware — used by sales app
function requireInternalSecret(req, res, next) {
  const secret = process.env.INTERNAL_SECRET || '';
  if (!secret || req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/promo-codes/register — called by sales app to create a code
router.post('/register', requireInternalSecret, (req, res) => {
  const { code, type = 'trial', value_days = 30, max_uses = 1, salesperson_name, notes, expires_at, sales_ref } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const db = getDb();
  const { v4: uuidv4 } = require('uuid');
  try {
    db.prepare(
      `INSERT INTO sales_promo_codes (id, code, type, value_days, max_uses, salesperson_name, notes, expires_at, sales_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), code.toUpperCase().trim(), type, value_days, max_uses, salesperson_name || null, notes || null, expires_at || null, sales_ref || null);
    res.json({ ok: true, code: code.toUpperCase().trim() });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/promo-codes/validate/:code — public, check if code is valid
router.get('/validate/:code', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT type, value_days, max_uses, uses, expires_at FROM sales_promo_codes WHERE code = ?')
    .get(req.params.code.toUpperCase().trim());
  if (!row) return res.json({ valid: false });
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at < now) return res.json({ valid: false, reason: 'expired' });
  if (row.uses >= row.max_uses) return res.json({ valid: false, reason: 'used' });
  res.json({ valid: true, type: row.type, value_days: row.value_days });
});

// POST /api/promo-codes/redeem — authenticated user redeems a code
router.post('/redeem', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const db = getDb();
  const user = db.prepare('SELECT id, sales_promo_used, free_until FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.sales_promo_used) return res.status(409).json({ error: 'Promo kód ste už použili.' });

  const row = db.prepare('SELECT * FROM sales_promo_codes WHERE code = ?').get(code.toUpperCase().trim());
  if (!row) return res.status(404).json({ error: 'Neplatný kód.' });
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at < now) return res.status(410).json({ error: 'Kód expiroval.' });
  if (row.uses >= row.max_uses) return res.status(410).json({ error: 'Kód bol už použitý.' });

  const base = Math.max(now, user.free_until || 0);
  const newFreeUntil = base + row.value_days * 86400;

  db.prepare('UPDATE users SET free_until = ?, sales_promo_used = ? WHERE id = ?').run(newFreeUntil, row.code, req.userId);
  db.prepare('UPDATE sales_promo_codes SET uses = uses + 1 WHERE id = ?').run(row.id);

  res.json({ ok: true, free_until: newFreeUntil, days: row.value_days, message: `Aktivovaných ${row.value_days} dní zadarmo!` });
});

// GET /api/promo-codes/wallet?ref_code=S-JOHN-ABC — earnings for a salesperson
router.get('/wallet', requireInternalSecret, (req, res) => {
  const { ref_code } = req.query;
  if (!ref_code) return res.status(400).json({ error: 'ref_code required' });

  const db = getDb();
  const commissions = db.prepare(
    'SELECT plan, amount, paid, created_at FROM sales_commissions WHERE sales_ref = ? ORDER BY created_at DESC'
  ).all(ref_code);

  const now = Math.floor(Date.now() / 1000);
  const d = new Date();
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);

  const total = commissions.reduce((s, c) => s + c.amount, 0);
  const monthCommissions = commissions.filter(c => c.created_at >= monthStart);
  const thisMonth = monthCommissions.reduce((s, c) => s + c.amount, 0);
  const thisMonthCount = monthCommissions.length;
  const pending = commissions.filter(c => !c.paid).reduce((s, c) => s + c.amount, 0);

  let bonus = 0;
  if (thisMonthCount >= 10) bonus = 100;
  else if (thisMonthCount >= 5) bonus = 30;

  res.json({
    total: Math.round((total + bonus) * 100) / 100,
    this_month: Math.round((thisMonth + bonus) * 100) / 100,
    this_month_conversions: thisMonthCount,
    bonus,
    bonus_next: thisMonthCount < 5 ? { target: 5, reward: 30, remaining: 5 - thisMonthCount }
      : thisMonthCount < 10 ? { target: 10, reward: 100, remaining: 10 - thisMonthCount }
      : null,
    pending: Math.round((pending + bonus) * 100) / 100,
    commissions: commissions.map(c => ({ plan: c.plan, amount: c.amount, paid: !!c.paid, date: c.created_at })),
  });
});

module.exports = router;
