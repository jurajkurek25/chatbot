'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, searchKnowledge } = require('../db/database');
const { streamChatResponse } = require('../services/claude');

const router = express.Router();

// Simple in-memory rate limiter: max 30 messages per IP per 10 minutes
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_MAX;
}

// GET /api/widget/:widgetId/config — public endpoint for widget configuration
router.get('/:widgetId/config', (req, res) => {
  const db = getDb();
  const widget = db.prepare(`
    SELECT id, bot_name, welcome_message, primary_color, cta_type, cta_config, suggested_questions, active
    FROM widgets WHERE id = ?
  `).get(req.params.widgetId);

  if (!widget || !widget.active) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  res.json({
    id: widget.id,
    bot_name: widget.bot_name,
    welcome_message: widget.welcome_message,
    primary_color: widget.primary_color,
    cta_type: widget.cta_type,
    cta_config: safeParseJSON(widget.cta_config, {}),
    suggested_questions: safeParseJSON(widget.suggested_questions, []),
  });
});

// POST /api/widget/:widgetId/chat — chat endpoint (SSE streaming)
router.post('/:widgetId/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Príliš veľa správ. Skúste to neskôr.' });
  }

  const db = getDb();
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ? AND active = 1').get(req.params.widgetId);
  if (!widget) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const { message, sessionId, history = [] } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Správa je povinná.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Správa je príliš dlhá.' });
  }
  if (!Array.isArray(history) || history.length > 40) {
    return res.status(400).json({ error: 'Neplatná história konverzácie.' });
  }

  // Validate history shape
  const cleanHistory = history
    .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  // Find relevant knowledge items via FTS
  const knowledgeItems = searchKnowledge(widget.id, message.trim());

  // Get or create conversation record
  const sid = (sessionId && typeof sessionId === 'string') ? sessionId.slice(0, 64) : uuidv4();
  let conversation = db.prepare('SELECT id FROM conversations WHERE session_id = ? AND widget_id = ?').get(sid, widget.id);
  if (!conversation) {
    const convId = uuidv4();
    db.prepare('INSERT INTO conversations (id, widget_id, session_id) VALUES (?, ?, ?)').run(convId, widget.id, sid);
    conversation = { id: convId };
  }

  // Save user message
  db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
    uuidv4(), conversation.id, 'user', message.trim()
  );

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const fullText = await streamChatResponse(widget, knowledgeItems, cleanHistory, message.trim(), res);

    // Save assistant response
    if (fullText) {
      db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
        uuidv4(), conversation.id, 'assistant', fullText
      );
    }
  } catch (err) {
    console.error('Chat error:', err);
    try {
      res.write(`data: ${JSON.stringify({ error: 'Chyba pri generovaní odpovede.' })}\n\n`);
      res.end();
    } catch { /* connection already closed */ }
  }
});

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
