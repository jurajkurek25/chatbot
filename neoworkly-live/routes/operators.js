const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../db/database');
const { authClient, authOperator } = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '../public/uploads/operators');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 3 * 1024 * 1024 } });

// List operators for a client
router.get('/', authClient, (req, res) => {
  const db = getDB();
  const ops = db.prepare('SELECT id, email, nickname, full_name, photo_url, bio, is_online, is_busy, created_at FROM operators WHERE client_id = ?').all(req.clientId);
  res.json(ops);
});

// Public: get available operators by widget_key (for the chat widget)
router.get('/public/:widget_key', (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT id FROM clients WHERE widget_key = ?').get(req.params.widget_key);
  if (!client) return res.status(404).json({ error: 'Widget not found' });

  const ops = db.prepare(`
    SELECT id, nickname, full_name, photo_url, bio, is_online, is_busy
    FROM operators WHERE client_id = ? AND is_online = 1
  `).all(client.id);
  res.json(ops);
});

// Add operator (client only)
router.post('/', authClient, async (req, res) => {
  const { email, password, nickname, full_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const db = getDB();
    const existing = db.prepare('SELECT id FROM operators WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    db.prepare('INSERT INTO operators (id, client_id, email, password_hash, nickname, full_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.clientId, email, hash, nickname || '', full_name || '');
    res.json({ id, email, nickname, full_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create operator' });
  }
});

// Remove operator
router.delete('/:id', authClient, (req, res) => {
  const db = getDB();
  const op = db.prepare('SELECT id FROM operators WHERE id = ? AND client_id = ?').get(req.params.id, req.clientId);
  if (!op) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM operators WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Operator updates own profile
router.patch('/me', authOperator, upload.single('photo'), async (req, res) => {
  const { nickname, full_name, bio, password } = req.body;
  const db = getDB();
  const updates = [];
  const values = [];

  if (nickname !== undefined) { updates.push('nickname = ?'); values.push(nickname); }
  if (full_name !== undefined) { updates.push('full_name = ?'); values.push(full_name); }
  if (bio !== undefined) { updates.push('bio = ?'); values.push(bio); }
  if (req.file) { updates.push('photo_url = ?'); values.push(`/uploads/operators/${req.file.filename}`); }
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    updates.push('password_hash = ?');
    values.push(hash);
  }

  if (updates.length) {
    values.push(req.operatorId);
    db.prepare(`UPDATE operators SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const op = db.prepare('SELECT id, email, nickname, full_name, photo_url, bio FROM operators WHERE id = ?').get(req.operatorId);
  res.json(op);
});

// Operator get own profile
router.get('/me', authOperator, (req, res) => {
  const db = getDB();
  const op = db.prepare('SELECT id, email, nickname, full_name, photo_url, bio, is_online, is_busy FROM operators WHERE id = ?').get(req.operatorId);
  res.json(op);
});

module.exports = router;
