'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

function requireAdminKey(req, res, next) {
  try {
    const raw = (process.env.ADMIN_KEYS || '').replace(/['"]/g, '');
    const keys = raw.split(',').map(k => k.trim()).filter(Boolean);

    if (!keys.length) {
      return res.status(503).json({ error: 'ADMIN_KEYS not configured on server.' });
    }

    const provided = (req.headers['x-admin-key'] || '').trim();
    if (!provided || !keys.includes(provided)) {
      return res.status(401).json({ error: 'Invalid admin key.' });
    }

    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth error', detail: err.message });
  }
}

// GET /api/admin/training-stats
router.get('/training-stats', requireAdminKey, (req, res) => {
  try {
    const db = getDb();

    // Ensure table exists before querying
    db.exec(`CREATE TABLE IF NOT EXISTS ai_training_samples (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      system_prompt TEXT,
      user_input TEXT NOT NULL,
      assistant_output TEXT NOT NULL,
      tool_calls TEXT,
      widget_id TEXT,
      quality INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`);

    const bySource = db.prepare(
      `SELECT source, quality, COUNT(*) as count FROM ai_training_samples GROUP BY source, quality ORDER BY source, quality`
    ).all();

    const total   = db.prepare(`SELECT COUNT(*) as count FROM ai_training_samples`).get();
    const oldest  = db.prepare(`SELECT MIN(created_at) as ts FROM ai_training_samples`).get();
    const newest  = db.prepare(`SELECT MAX(created_at) as ts FROM ai_training_samples`).get();

    res.json({
      total: total.count,
      oldest: oldest.ts ? new Date(oldest.ts * 1000).toISOString() : null,
      newest: newest.ts ? new Date(newest.ts * 1000).toISOString() : null,
      breakdown: bySource,
    });
  } catch (err) {
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

// GET /api/admin/training-data
// Query params: format=jsonl|json, source=chat|coach|demo, quality=0|1|-1, limit=N
router.get('/training-data', requireAdminKey, (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

module.exports = router;
