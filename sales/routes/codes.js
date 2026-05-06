'use strict';
const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
router.use(requireAuth);

const MAIN_APP_URL = process.env.MAIN_APP_URL || 'https://neoworkly.com';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

function generateCode(name) {
  const prefix = (name || 'NEO').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(3, 'X');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}-${rand}`;
}

function postJson(urlStr, data, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const body = JSON.stringify(data);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = lib.request(opts, (res) => {
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// GET /api/codes — list user's promo codes
router.get('/', (req, res) => {
  const db = getDb();
  const codes = db.prepare('SELECT * FROM promo_codes WHERE created_by = ? ORDER BY created_at DESC').all(req.userId);
  res.json(codes);
});

// POST /api/codes/generate — generate new promo code
router.post('/generate', async (req, res) => {
  const { prospect_name, notes, value_days = 30, max_uses = 1 } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  const code = generateCode(user?.name);
  const id = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + 90 * 86400; // 90 days to use

  db.prepare(
    `INSERT INTO promo_codes (id, code, created_by, type, value_days, max_uses, prospect_name, notes, expires_at)
     VALUES (?, ?, ?, 'trial', ?, ?, ?, ?, ?)`
  ).run(id, code, req.userId, value_days, max_uses, prospect_name || null, notes || null, expiresAt);

  // Push to main app
  let synced = false;
  if (INTERNAL_SECRET) {
    try {
      const r = await postJson(
        `${MAIN_APP_URL}/api/promo-codes/register`,
        { code, type: 'trial', value_days, max_uses, salesperson_name: user?.name, notes, expires_at: expiresAt },
        { 'x-internal-secret': INTERNAL_SECRET }
      );
      if (r.ok) {
        synced = true;
        db.prepare('UPDATE promo_codes SET synced = 1 WHERE id = ?').run(id);
      }
    } catch (_) {}
  }

  res.json({ ok: true, code, synced, value_days, expires_at: expiresAt });
});

// GET /api/codes/referral — get or create referral link for current user
router.get('/referral', (req, res) => {
  const db = getDb();
  let ref = db.prepare('SELECT * FROM sales_refs WHERE user_id = ?').get(req.userId);
  if (!ref) {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
    const name = (user?.name || 'NEO').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
    const refCode = `S-${name}-${rand}`;
    const id = uuidv4();
    db.prepare('INSERT INTO sales_refs (id, user_id, ref_code) VALUES (?, ?, ?)').run(id, req.userId, refCode);
    ref = db.prepare('SELECT * FROM sales_refs WHERE id = ?').get(id);
  }
  res.json({
    ref_code: ref.ref_code,
    link: `${MAIN_APP_URL}?sales_ref=${ref.ref_code}`,
    clicks: ref.clicks,
  });
});

module.exports = router;
