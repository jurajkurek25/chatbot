'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendFollowUp } = require('../services/email');

const router = express.Router();
router.use(requireAuth);

/* ── GET /api/reactivation/cold-leads ──────────────────────────── */
router.get('/cold-leads', (req, res) => {
  try {
    const hours = Math.max(1, parseInt(req.query.hours || '24', 10));
    const cutoffAge = Math.floor(Date.now() / 1000) - hours * 3600;

    const db = getDb();
    const leads = db.prepare(`
      SELECT l.id, l.name, l.email, l.chat_summary, l.status,
             l.created_at, l.last_reactivation_at, l.reactivation_count,
             w.name AS widget_name, w.bot_name
      FROM leads l
      JOIN widgets w ON l.widget_id = w.id
      WHERE w.user_id = ?
        AND l.email IS NOT NULL AND l.email != ''
        AND l.converted_at IS NULL
        AND l.status != 'closed'
        AND l.created_at <= ?
        AND (l.last_reactivation_at IS NULL OR l.last_reactivation_at <= ?)
      ORDER BY l.created_at DESC
      LIMIT 50
    `).all(req.userId, cutoffAge, cutoffAge);

    const now = Math.floor(Date.now() / 1000);
    res.json({
      leads: leads.map(l => ({
        ...l,
        hours_cold: Math.round((now - l.created_at) / 3600),
      })),
    });
  } catch (err) {
    console.error('[reactivation/cold-leads]', err.message);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

/* ── POST /api/reactivation/preview/:leadId ─────────────────────── */
router.post('/preview/:leadId', async (req, res) => {
  try {
    const db = getDb();
    const lead = db.prepare(`
      SELECT l.*, w.name AS widget_name, w.bot_name, w.goals
      FROM leads l JOIN widgets w ON l.widget_id = w.id
      WHERE l.id = ? AND w.user_id = ?
    `).get(req.params.leadId, req.userId);
    if (!lead) return res.status(404).json({ error: 'Lead nenájdený.' });

    const context = [
      lead.chat_summary
        ? `Zhrnutie konverzácie: ${lead.chat_summary}`
        : 'Zákazník zanechal kontakt bez ďalších podrobností.',
      lead.widget_name ? `Business/widget: ${lead.widget_name}` : '',
      lead.goals ? `Ciele biznisu: ${lead.goals}` : '',
    ].filter(Boolean).join('\n');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: `Napíš krátku, osobnú re-engagement správu pre zákazníka menom ${lead.name}.

Kontext:
${context}

Pravidlá:
- Maximálne 3–4 vety
- Oslovi ho menom
- Zmiň konkrétne, čo riešil (z kontextu vyššie)
- Ponúkni konkrétnu pomoc alebo insight — nie generické "ozývam sa"
- Tón: priateľský, ale profesionálny
- Jazyk: slovenčina
- Napíš IBA text správy, bez predmetu emailu, bez hlavičky, bez podpisu`,
      }],
    });

    res.json({ message: response.content[0].text.trim() });
  } catch (err) {
    console.error('[reactivation/preview]', err.message);
    res.status(500).json({ error: 'Nepodarilo sa vygenerovať správu.' });
  }
});

/* ── POST /api/reactivation/send/:leadId ────────────────────────── */
router.post('/send/:leadId', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Správa je povinná.' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: 'Správa je príliš dlhá (max 5000 znakov).' });
    }

    const db = getDb();
    const userData = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.userId);
    const lead = db.prepare(`
      SELECT l.*, w.name AS widget_name, w.bot_name
      FROM leads l JOIN widgets w ON l.widget_id = w.id
      WHERE l.id = ? AND w.user_id = ?
    `).get(req.params.leadId, req.userId);
    if (!lead) return res.status(404).json({ error: 'Lead nenájdený.' });

    await sendFollowUp({
      toEmail: lead.email,
      leadName: lead.name,
      ownerName: userData?.name || 'Team',
      widgetName: lead.widget_name || lead.bot_name || 'Chatbot',
      message: message.trim(),
    });

    db.prepare(
      'UPDATE leads SET last_reactivation_at = unixepoch(), reactivation_count = reactivation_count + 1, status = "contacted" WHERE id = ?'
    ).run(lead.id);

    res.json({ success: true });
  } catch (err) {
    console.error('[reactivation/send]', err.message);
    res.status(500).json({ error: 'Nepodarilo sa odoslať správu.' });
  }
});

module.exports = router;
