'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SUBSCRIPTION_COST_EUR = 29;

/* ── GET /api/money/stats ───────────────────────────────────────── */
router.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare(
      'SELECT ai_responses_this_month, usage_notified_100, extra_response_credits FROM users WHERE id = ?'
    ).get(req.userId);

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total_leads,
        COUNT(CASE WHEN converted_at IS NOT NULL THEN 1 END) AS total_conversions,
        COALESCE(SUM(CASE WHEN converted_at IS NOT NULL THEN deal_value ELSE 0 END), 0) AS total_revenue
      FROM leads
      WHERE widget_id IN (SELECT id FROM widgets WHERE user_id = ?)
    `).get(req.userId);

    const top_conversions = db.prepare(`
      SELECT l.id, l.name, l.email, l.deal_value, l.converted_at, l.chat_summary,
             w.name AS widget_name
      FROM leads l
      JOIN widgets w ON l.widget_id = w.id
      WHERE w.user_id = ? AND l.converted_at IS NOT NULL
      ORDER BY l.converted_at DESC
      LIMIT 5
    `).all(req.userId);

    const credits_used = user?.ai_responses_this_month ?? 0;
    const total_revenue = stats?.total_revenue ?? 0;
    const total_conversions = stats?.total_conversions ?? 0;
    const total_leads = stats?.total_leads ?? 0;
    const conversion_rate = total_leads > 0
      ? Math.round((total_conversions / total_leads) * 100)
      : 0;
    const revenue_per_credit = credits_used > 0 && total_revenue > 0
      ? parseFloat((total_revenue / credits_used).toFixed(2))
      : null;
    const roi_multiple = total_revenue > 0
      ? parseFloat((total_revenue / SUBSCRIPTION_COST_EUR).toFixed(1))
      : null;

    // Missed revenue: estimate if user hit monthly credit limit and has real conversion data
    let missed_revenue = null;
    if (user?.usage_notified_100 && total_conversions > 0 && total_leads > 0) {
      const avg_deal = total_revenue / total_conversions;
      const estimated_missed_chats = 25;
      missed_revenue = Math.round(estimated_missed_chats * (conversion_rate / 100) * avg_deal);
    }

    res.json({
      total_conversions,
      total_revenue,
      total_leads,
      conversion_rate,
      credits_used,
      roi_multiple,
      revenue_per_credit,
      missed_revenue,
      hit_limit: Boolean(user?.usage_notified_100),
      top_conversions,
    });
  } catch (err) {
    console.error('[money/stats]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── PATCH /api/money/:leadId/convert ───────────────────────────── */
router.patch('/:leadId/convert', (req, res) => {
  try {
    const { deal_value } = req.body;

    const db = getDb();
    const lead = db.prepare(`
      SELECT l.id FROM leads l
      JOIN widgets w ON l.widget_id = w.id
      WHERE l.id = ? AND w.user_id = ?
    `).get(req.params.leadId, req.userId);
    if (!lead) return res.status(404).json({ error: 'Lead nenájdený.' });

    if (deal_value === null || deal_value === undefined) {
      db.prepare('UPDATE leads SET deal_value = NULL, converted_at = NULL WHERE id = ?')
        .run(req.params.leadId);
    } else {
      const val = parseFloat(deal_value);
      if (isNaN(val) || val < 0) return res.status(400).json({ error: 'Neplatná hodnota.' });
      db.prepare(
        'UPDATE leads SET deal_value = ?, converted_at = COALESCE(converted_at, unixepoch()), status = "closed" WHERE id = ?'
      ).run(val, req.params.leadId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[money/convert]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

module.exports = router;
