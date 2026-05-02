'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

// Auth: ADMIN_KEYS env var — comma-separated list of long secret keys
// e.g. ADMIN_KEYS=abc123verylongkey1,xyz456verylongkey2
function requireAdminKey(req, res, next) {
  const raw = process.env.ADMIN_KEYS || '';
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);

  if (!keys.length) {
    return res.status(503).json({ error: 'ADMIN_KEYS not configured on server.' });
  }

  const provided = req.headers['x-admin-key'] || '';
  if (!provided || !keys.includes(provided)) {
    return res.status(401).json({ error: 'Invalid admin key.' });
  }

  next();
}

// GET /api/admin/training-data
// Query params:
//   format=jsonl (default) | json
//   source=chat|coach|demo (optional filter)
//   quality=0|1|-1 (optional filter)
//   limit=N (default 10000)
router.get('/training-data', requireAdminKey, (req, res) => {
  const { format = 'jsonl', source, quality, limit = 10000 } = req.query;

  const db = getDb();

  const conditions = [];
  const params = [];

  if (source) { conditions.push('source = ?'); params.push(source); }
  if (quality !== undefined && quality !== '') { conditions.push('quality = ?'); params.push(Number(quality)); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM ai_training_samples ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, Number(limit));

  if (format === 'json') {
    return res.json({ count: rows.length, samples: rows });
  }

  // JSONL — OpenAI fine-tuning format
  const lines = rows.map(row => {
    const messages = [];
    if (row.system_prompt) messages.push({ role: 'system', content: row.system_prompt });
    messages.push({ role: 'user', content: row.user_input });

    if (row.tool_calls) {
      try {
        messages.push({ role: 'assistant', content: row.assistant_output || '', tool_calls: JSON.parse(row.tool_calls) });
      } catch (_) {
        messages.push({ role: 'assistant', content: row.assistant_output });
      }
    } else {
      messages.push({ role: 'assistant', content: row.assistant_output });
    }

    return JSON.stringify({ messages, metadata: { source: row.source, quality: row.quality, widget_id: row.widget_id } });
  });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', `attachment; filename="training-data-${Date.now()}.jsonl"`);
  res.send(lines.join('\n'));
});

// GET /api/admin/training-stats
router.get('/training-stats', requireAdminKey, (req, res) => {
  const db = getDb();

  const bySource = db.prepare(
    `SELECT source, quality, COUNT(*) as count FROM ai_training_samples GROUP BY source, quality ORDER BY source, quality`
  ).all();

  const total = db.prepare(`SELECT COUNT(*) as count FROM ai_training_samples`).get();
  const oldest = db.prepare(`SELECT MIN(created_at) as ts FROM ai_training_samples`).get();
  const newest = db.prepare(`SELECT MAX(created_at) as ts FROM ai_training_samples`).get();

  res.json({
    total: total.count,
    oldest: oldest.ts ? new Date(oldest.ts * 1000).toISOString() : null,
    newest: newest.ts ? new Date(newest.ts * 1000).toISOString() : null,
    breakdown: bySource,
  });
});

module.exports = router;
