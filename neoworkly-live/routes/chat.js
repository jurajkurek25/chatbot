const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');
const { authClient, authOperator, authAny } = require('../middleware/auth');

// Get chat history (client or operator)
router.get('/:chatId/messages', authAny, (req, res) => {
  const db = getDB();
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  // Verify access
  if (req.user.role === 'client' && chat.client_id !== req.clientId) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'operator' && chat.operator_id !== req.operatorId) return res.status(403).json({ error: 'Forbidden' });

  const msgs = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(req.params.chatId);
  res.json({ chat, messages: msgs });
});

// List chats for client
router.get('/', authClient, (req, res) => {
  const db = getDB();
  const { status, limit = 50, offset = 0 } = req.query;
  let query = 'SELECT c.*, o.nickname as operator_nickname FROM chats c LEFT JOIN operators o ON c.operator_id = o.id WHERE c.client_id = ?';
  const params = [req.clientId];
  if (status) { query += ' AND c.status = ?'; params.push(status); }
  query += ' ORDER BY c.started_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  const chats = db.prepare(query).all(...params);
  res.json(chats);
});

// List chats for operator
router.get('/operator/mine', authOperator, (req, res) => {
  const db = getDB();
  const chats = db.prepare('SELECT * FROM chats WHERE operator_id = ? ORDER BY started_at DESC LIMIT 50').all(req.operatorId);
  res.json(chats);
});

// Active chat for operator
router.get('/operator/active', authOperator, (req, res) => {
  const db = getDB();
  const chat = db.prepare("SELECT * FROM chats WHERE operator_id = ? AND status = 'active'").get(req.operatorId);
  if (!chat) return res.json(null);
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(chat.id);
  res.json({ chat, messages });
});

// Queue status for client
router.get('/queue', authClient, (req, res) => {
  const db = getDB();
  const items = db.prepare('SELECT q.*, o.nickname as preferred_op_nickname FROM queue q LEFT JOIN operators o ON q.preferred_operator_id = o.id WHERE q.client_id = ? ORDER BY q.joined_at ASC').all(req.clientId);
  res.json(items);
});

module.exports = router;
