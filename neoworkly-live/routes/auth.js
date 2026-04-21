const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../db/database');

const JWT_SECRET = process.env.LIVE_JWT_SECRET || 'live_secret_change_me';
const SALT_ROUNDS = 10;

// Client registration
router.post('/register', async (req, res) => {
  const { email, password, company_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const db = getDB();
    const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = uuidv4();
    const widget_key = uuidv4().replace(/-/g, '');
    db.prepare(`INSERT INTO clients (id, email, password_hash, company_name, widget_key) VALUES (?, ?, ?, ?, ?)`)
      .run(id, email, hash, company_name || '', widget_key);

    const token = jwt.sign({ id, role: 'client' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, widget_key });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Client login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const db = getDB();
    const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
    if (!client) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, client.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: client.id, role: 'client' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, company_name: client.company_name, widget_key: client.widget_key, language: client.language });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Operator login
router.post('/operator/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const db = getDB();
    const op = db.prepare('SELECT * FROM operators WHERE email = ?').get(email);
    if (!op) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, op.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: op.id, role: 'operator', clientId: op.client_id }, JWT_SECRET, { expiresIn: '12h' });
    res.json({
      token,
      operator: {
        id: op.id,
        nickname: op.nickname,
        full_name: op.full_name,
        photo_url: op.photo_url,
        bio: op.bio
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
