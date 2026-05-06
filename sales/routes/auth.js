'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth, SECRET } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.includes('@') || !password || password.length < 6)
    return res.status(400).json({ error: 'Vyplňte meno, platný email a heslo (min 6 znakov).' });

  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()))
    return res.status(409).json({ error: 'Email je už registrovaný.' });

  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?,?,?,?)')
    .run(id, name.trim(), email.trim().toLowerCase(), hash);

  const token = jwt.sign({ userId: id }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, name: name.trim(), email: email.trim().toLowerCase() } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Zadajte email a heslo.' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Nesprávny email alebo heslo.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Nesprávny email alebo heslo.' });

  const token = jwt.sign({ userId: user.id }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

router.get('/me', requireAuth, (req, res) => {
  const user = getDb().prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });
  res.json(user);
});

module.exports = router;
