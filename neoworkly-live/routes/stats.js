const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');
const { authClient } = require('../middleware/auth');
const { generateSummary } = require('../services/claude');

// Overview stats
router.get('/', authClient, (req, res) => {
  const db = getDB();
  const clientId = req.clientId;

  const totalChats = db.prepare("SELECT COUNT(*) as n FROM chats WHERE client_id = ?").get(clientId).n;
  const activeChats = db.prepare("SELECT COUNT(*) as n FROM chats WHERE client_id = ? AND status = 'active'").get(clientId).n;
  const endedChats = db.prepare("SELECT COUNT(*) as n FROM chats WHERE client_id = ? AND status = 'ended'").get(clientId).n;
  const queueCount = db.prepare("SELECT COUNT(*) as n FROM queue WHERE client_id = ?").get(clientId).n;
  const totalOperators = db.prepare("SELECT COUNT(*) as n FROM operators WHERE client_id = ?").get(clientId).n;
  const onlineOperators = db.prepare("SELECT COUNT(*) as n FROM operators WHERE client_id = ? AND is_online = 1").get(clientId).n;
  const avgDuration = db.prepare(`
    SELECT AVG((JULIANDAY(ended_at) - JULIANDAY(started_at)) * 86400) as avg_sec
    FROM chats WHERE client_id = ? AND status = 'ended' AND ended_at IS NOT NULL
  `).get(clientId).avg_sec;

  const chatsPerDay = db.prepare(`
    SELECT DATE(started_at) as day, COUNT(*) as n
    FROM chats WHERE client_id = ?
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all(clientId);

  const busyOps = db.prepare(`
    SELECT o.nickname, o.full_name, COUNT(c.id) as chat_count
    FROM operators o LEFT JOIN chats c ON c.operator_id = o.id
    WHERE o.client_id = ?
    GROUP BY o.id ORDER BY chat_count DESC
  `).all(clientId);

  res.json({
    totalChats, activeChats, endedChats, queueCount,
    totalOperators, onlineOperators,
    avgDurationSeconds: Math.round(avgDuration || 0),
    chatsPerDay,
    operatorStats: busyOps
  });
});

// AI summary of recent chats
router.get('/ai-summary', authClient, async (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT ai_summary_enabled FROM clients WHERE id = ?').get(req.clientId);
  if (!client.ai_summary_enabled) return res.status(403).json({ error: 'AI summary is disabled' });

  const recentChats = db.prepare(`
    SELECT c.id, c.visitor_name, c.started_at, c.ended_at,
      (SELECT GROUP_CONCAT(m.content, ' | ') FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at) as transcript
    FROM chats c
    WHERE c.client_id = ? AND c.status = 'ended'
    ORDER BY c.started_at DESC LIMIT 50
  `).all(req.clientId);

  if (recentChats.length === 0) return res.json({ summary: null });

  try {
    const summary = await generateSummary(recentChats);
    res.json({ summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

module.exports = router;
