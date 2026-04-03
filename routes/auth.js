'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

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
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'changeme', { expiresIn: '30d' });
}

module.exports = router;
