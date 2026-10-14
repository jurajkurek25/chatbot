'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendPasswordReset } = require('../services/email');
const { TRIAL_DAYS } = require('../middleware/subscription');
const passwords = require('../services/passwords');
const twoFactor = require('../services/twoFactor');
const { rateLimit } = require('../funnel/src/ratelimit');

const router = express.Router();
const SALT_ROUNDS = 12;

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
  let referredById = null;
  if (referralCode) {
    const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode.toUpperCase().trim());
    if (referrer) {
      referredById = referrer.id;
    }
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = uuidv4();
    const myReferralCode = uniqueReferralCode(db, name);

    const trialUntil = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 86400;
    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, referral_code, referred_by, trial_until, ai_responses_reset_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, email.toLowerCase(), passwordHash, name.trim(), myReferralCode, referredById, trialUntil, trialUntil);

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
    const valid = await passwords.verify(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Nesprávny email alebo heslo.' });
    }
    // Heslo prenesené z Neoworkly Funnel (scrypt) => po úspešnom prihlásení bcrypt
    if (passwords.isLegacy(user.password_hash)) {
      user.password_hash = await passwords.hash(password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(user.password_hash, user.id);
    }
    // Účet z Neoworkly Funnel so zapnutým 2FA: najprv kód z aplikácie
    if (twoFactor.merchantWithTotp(user.id)) {
      return res.json({ twoFactor: true, challenge: twoFactor.issueChallenge(user) });
    }

    const token = signToken(user.id);
    return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Chyba servera.' });
  }
});

// POST /api/auth/login/2fa – druhý krok: kód z aplikácie alebo jednorazový záložný kód
router.post('/login/2fa',
  rateLimit({ name: 'auth-2fa-ip', max: 20, windowMs: 15 * 60 * 1000, key: req => req.ip }),
  (req, res, next) => {
    req.challengeUser = twoFactor.readChallenge(req.body.challenge);
    if (!req.challengeUser) return res.status(401).json({ error: 'Prihlásenie vypršalo. Zadajte znova email a heslo.', expired: true });
    next();
  },
  // 6-miestny kód => najviac 5 pokusov na účet za 15 minút
  rateLimit({ name: 'auth-2fa-user', max: 5, windowMs: 15 * 60 * 1000, key: req => req.challengeUser.id }),
  async (req, res) => {
    const user = req.challengeUser;
    const merchant = twoFactor.merchantWithTotp(user.id);
    if (merchant && !(await twoFactor.verify(merchant, req.body.code))) {
      return res.status(401).json({ error: 'Nesprávny kód.' });
    }
    return res.json({ token: signToken(user.id), user: { id: user.id, email: user.email, name: user.name } });
  });

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'changeme', { expiresIn: '30d' });
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
    const valid = await passwords.verify(currentPassword, user.password_hash);
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
    const valid = await passwords.verify(password, user.password_hash);
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
