'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function ownsWidget(widgetId, userId) {
  return !!getDb().prepare('SELECT 1 FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId);
}

function periodStart(days) {
  if (!days || days <= 0) return 0;
  return Math.floor(Date.now() / 1000) - days * 86400;
}

/* GET /api/insights/:widgetId/overview — dashboard home: traffic, success rate, gaps, setup checklist */
router.get('/:widgetId/overview', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }
  const db = getDb();
  const wid = req.params.widgetId;
  const now = Math.floor(Date.now() / 1000);
  const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d / 1000); })();
  const since30 = now - 30 * 86400;

  const userMsgs = since => db.prepare(
    `SELECT COUNT(*) AS cnt FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.widget_id = ? AND m.role = 'user' AND m.created_at >= ?`
  ).get(wid, since).cnt;
  const unanswered = since => db.prepare(
    'SELECT COUNT(*) AS cnt FROM unanswered_questions WHERE widget_id = ? AND created_at >= ?'
  ).get(wid, since).cnt;

  const messagesToday = userMsgs(dayStart);
  const messages30 = userMsgs(since30);
  const unanswered30 = unanswered(since30);

  // Unanswered per day, last 30 days (oldest first, zero-filled)
  const perDay = {};
  for (const r of db.prepare('SELECT created_at FROM unanswered_questions WHERE widget_id = ? AND created_at >= ?').all(wid, since30)) {
    const key = new Date(r.created_at * 1000).toISOString().slice(0, 10);
    perDay[key] = (perDay[key] || 0) + 1;
  }
  const chart = [];
  for (let i = 29; i >= 0; i--) {
    const key = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10);
    chart.push({ date: key, count: perDay[key] || 0 });
  }

  const widget = db.prepare('SELECT allowed_domains FROM widgets WHERE id = ?').get(wid);
  const sources = db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_items WHERE widget_id = ?').get(wid).cnt;
  const anyConversation = !!db.prepare('SELECT 1 FROM conversations WHERE widget_id = ? LIMIT 1').get(wid);

  res.json({
    messages_today: messagesToday,
    messages_30d: messages30,
    unanswered_30d: unanswered30,
    success_rate: messages30 ? Math.max(0, Math.round((1 - unanswered30 / messages30) * 100)) : null,
    sources,
    chart,
    recent_unanswered: db.prepare(
      'SELECT id, question, created_at FROM unanswered_questions WHERE widget_id = ? ORDER BY created_at DESC LIMIT 5'
    ).all(wid),
    checklist: {
      created: true,
      source_added: sources > 0,
      domains_set: !!(widget?.allowed_domains || '').trim(),
      live: anyConversation,
    },
  });
});

/* GET /api/insights/:widgetId?days=30 */
router.get('/:widgetId', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  const days = parseInt(req.query.days, 10) || 30;
  const since = periodStart(days);
  const db = getDb();
  const wid = req.params.widgetId;

  // Base set of insights in period
  const insightRows = db.prepare(
    `SELECT id, topics, intent, objection, urgency, msg_count, created_at
     FROM conversation_insights
     WHERE widget_id = ? AND created_at >= ?
     ORDER BY created_at DESC`
  ).all(wid, since);

  const total = insightRows.length;

  // Leads in same period (for conversion rate)
  const leadsCount = db.prepare(
    'SELECT COUNT(*) AS cnt FROM leads WHERE widget_id = ? AND created_at >= ?'
  ).get(wid, since).cnt;

  // Average message count
  const avgMsgs = total ? (insightRows.reduce((s, r) => s + r.msg_count, 0) / total).toFixed(1) : 0;

  // Topics aggregation
  const topicMap = {};
  for (const row of insightRows) {
    try {
      const topics = JSON.parse(row.topics);
      for (const t of topics) {
        if (t) topicMap[t] = (topicMap[t] || 0) + 1;
      }
    } catch { /* skip */ }
  }
  const topics = Object.entries(topicMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([topic, count]) => ({ topic, count }));

  // Intent aggregation
  const intentMap = {};
  for (const row of insightRows) {
    if (row.intent) intentMap[row.intent] = (intentMap[row.intent] || 0) + 1;
  }
  const intents = Object.entries(intentMap)
    .sort((a, b) => b[1] - a[1])
    .map(([intent, count]) => ({ intent, count }));

  // Objection aggregation
  const objMap = {};
  for (const row of insightRows) {
    if (row.objection) objMap[row.objection] = (objMap[row.objection] || 0) + 1;
  }
  const objections = Object.entries(objMap)
    .sort((a, b) => b[1] - a[1])
    .map(([objection, count]) => ({ objection, count }));

  // Urgency aggregation
  const urgMap = {};
  for (const row of insightRows) {
    if (row.urgency) urgMap[row.urgency] = (urgMap[row.urgency] || 0) + 1;
  }
  const urgency = Object.entries(urgMap)
    .sort((a, b) => b[1] - a[1])
    .map(([urgency, count]) => ({ urgency, count }));

  // Daily trend (last days, grouped by day)
  const trendMap = {};
  for (const row of insightRows) {
    const d = new Date(row.created_at * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    trendMap[key] = (trendMap[key] || 0) + 1;
  }
  const trend = Object.entries(trendMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  // A/B test: count leads by ab_variant in same period
  const abRows = db.prepare(
    `SELECT ab_variant, COUNT(*) AS cnt FROM leads
     WHERE widget_id = ? AND created_at >= ? AND ab_variant IS NOT NULL
     GROUP BY ab_variant`
  ).all(wid, since);
  const abStats = {};
  for (const r of abRows) abStats[r.ab_variant || 'a'] = r.cnt;

  res.json({
    total,
    leads_count: leadsCount,
    conversion_rate: total > 0 ? Math.round((leadsCount / total) * 100) : 0,
    avg_msg_count: Number(avgMsgs),
    topics,
    intents,
    objections,
    urgency,
    trend,
    ab_stats: abStats,
  });
});

module.exports = router;
