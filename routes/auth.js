'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendPasswordReset } = require('../services/email');

const router = express.Router();
const SALT_ROUNDS = 12;

// In-memory rate limiter (matches chat.js pattern)
const _rl = new Map();
function rateLimit(key, maxHits, windowMs) {
  const now = Date.now();
  let e = _rl.get(key);
  if (!e || now > e.resetAt) e = { hits: 0, resetAt: now + windowMs };
  e.hits++;
  _rl.set(key, e);
  return e.hits > maxHits;
}
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

function generateReferralCode(name) {
  const base = name.replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'USR';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${rand}`;
}

function uniqueReferralCode(db, name) {
  let code, attempts = 0;
  do {
    code = generateReferralCode(name);
    attempts++;
  } while (db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code) && attempts < 10);
  return code;
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  if (rateLimit('reg:' + clientIp(req), 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Príliš veľa pokusov. Skúste neskôr.' });
  }

  const { email, password, name, referralCode } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, heslo a meno sú povinné.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Neplatný email.' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Tento email je už zaregistrovaný.' });
  }

  // Validate referral code if provided
  // Self-referral prevention: reject if referrer has same non-generic email domain
  const GENERIC_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','protonmail.com','seznam.cz','centrum.cz','azet.sk','post.sk','me.com','live.com','msn.com','googlemail.com']);
  let referredById = null;
  if (referralCode) {
    const referrer = db.prepare('SELECT id, email FROM users WHERE referral_code = ?').get(referralCode.toUpperCase().trim());
    if (referrer) {
      const newDomain = email.toLowerCase().split('@')[1] || '';
      const refDomain = referrer.email.toLowerCase().split('@')[1] || '';
      const isSameDomain = newDomain === refDomain && !GENERIC_DOMAINS.has(newDomain);
      if (!isSameDomain) {
        referredById = referrer.id;
      }
    }
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = uuidv4();
    const myReferralCode = uniqueReferralCode(db, name);

    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, email.toLowerCase(), passwordHash, name.trim(), myReferralCode, referredById);

    const token = signToken(id);
    return res.status(201).json({
      token,
      user: { id, email: email.toLowerCase(), name: name.trim() },
      hasReferral: !!referredById,
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Chyba servera.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  if (rateLimit('login:' + clientIp(req), 10, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Príliš veľa pokusov. Skúste neskôr.' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email a heslo sú povinné.' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, email, password_hash, name FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Nesprávny email alebo heslo.' });
  }

  try {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Nesprávny email alebo heslo.' });
    }

    const token = signToken(user.id);
    return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Chyba servera.' });
  }
});

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'changeme', { algorithm: 'HS256', expiresIn: '30d' });
}

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Aktuálne a nové heslo sú povinné.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Nové heslo musí mať aspoň 8 znakov.' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  try {
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Aktuálne heslo je nesprávne.' });

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ error: 'Chyba servera.' });
  }
});

// POST /api/auth/change-email
router.post('/change-email', requireAuth, async (req, res) => {
  const { password, newEmail } = req.body;
  if (!password || !newEmail) {
    return res.status(400).json({ error: 'Heslo a nový email sú povinné.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).json({ error: 'Neplatný email.' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  try {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Heslo je nesprávne.' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail.toLowerCase(), req.userId);
    if (existing) return res.status(409).json({ error: 'Tento email už používa iný účet.' });

    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail.toLowerCase(), req.userId);
    return res.json({ ok: true, email: newEmail.toLowerCase() });
  } catch (err) {
    console.error('Change email error:', err);
    return res.status(500).json({ error: 'Chyba servera.' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  if (rateLimit('fp:' + clientIp(req), 3, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Príliš veľa pokusov. Skúste neskôr.' });
  }

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email je povinný.' });

  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());

  // Always return success to prevent email enumeration
  if (!user) return res.json({ ok: true });

  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    db.prepare('UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?').run(token, expires, user.id);

    const baseUrl = process.env.BASE_URL || 'https://neoworkly.com';
    const resetUrl = `${baseUrl}/?reset=${token}`;
    await sendPasswordReset({ toEmail: email.toLowerCase(), resetUrl });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Chyba servera.' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token a nové heslo sú povinné.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov.' });
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const user = db.prepare(
    'SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires > ?'
  ).get(token, now);

  if (!user) return res.status(400).json({ error: 'Odkaz je neplatný alebo vypršal.' });

  try {
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    db.prepare(
      'UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?'
    ).run(newHash, user.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Chyba servera.' });
  }
});

module.exports = router;
