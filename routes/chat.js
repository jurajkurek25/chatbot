'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, searchKnowledge } = require('../db/database');
const { streamChatResponse, summarizeConversation, analyzeConversationTrends } = require('../services/claude');
const { sendLeadNotification, sendUsageNotification } = require('../services/email');
const { BASE_RESPONSES, nextMonthReset, maybeResetUsage } = require('./credits');

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
    SELECT id, bot_name, welcome_message, primary_color, cta_type, cta_config, suggested_questions,
           active, avatar_url, proactive_enabled, proactive_delay, proactive_message, gdpr_text,
           hide_branding, business_hours, offline_message, csat_enabled, welcome_message_b
    FROM widgets WHERE id = ?
  `).get(req.params.widgetId);

  if (!widget || !widget.active) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  // hide_branding is only active on the White Label plan
  const owner = db.prepare('SELECT subscription_plan FROM users WHERE id = ?').get(widget.user_id);
  const isWhiteLabel = owner?.subscription_plan === 'white_label';

  res.json({
    id: widget.id,
    bot_name: widget.bot_name,
    welcome_message: widget.welcome_message,
    primary_color: widget.primary_color,
    cta_type: widget.cta_type,
    cta_config: safeParseJSON(widget.cta_config, {}),
    suggested_questions: safeParseJSON(widget.suggested_questions, []),
    avatar_url: widget.avatar_url || null,
    proactive_enabled: Boolean(widget.proactive_enabled),
    proactive_delay: widget.proactive_delay || 4,
    proactive_message: widget.proactive_message || '',
    gdpr_text: widget.gdpr_text || '',
    hide_branding: Boolean(widget.hide_branding) && isWhiteLabel,
    business_hours: widget.business_hours ? JSON.parse(widget.business_hours || '{}') : {},
    offline_message: widget.offline_message || '',
    csat_enabled: Boolean(widget.csat_enabled),
    ab_variant: Math.random() < 0.5 ? 'a' : 'b',
    welcome_message_b: widget.welcome_message_b || '',
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

  // If live agent has taken over this session, skip Claude
  if (widget) {
    const liveConv = db.prepare('SELECT live_agent FROM conversations WHERE session_id = ? AND widget_id = ?').get(
      (req.body.sessionId || '').slice(0, 64), widget.id
    );
    if (liveConv && liveConv.live_agent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      // Save the user message but don't respond — agent will reply from dashboard
      if (req.body.message?.trim()) {
        const sid = (req.body.sessionId || '').slice(0, 64);
        let conv = db.prepare('SELECT id FROM conversations WHERE session_id = ? AND widget_id = ?').get(sid, widget.id);
        if (conv) {
          db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
            require('uuid').v4(), conv.id, 'user', req.body.message.trim()
          );
        }
      }
      res.write(`data: ${JSON.stringify({ done: true, fullText: '' })}\n\n`);
      res.end();
      return;
    }
  }

  if (!widget) {
    return res.status(404).json({ error: 'Widget nenájdený.' });
  }

  // Check monthly usage limit
  const owner = db.prepare(
    'SELECT id, email, name, ai_responses_this_month, ai_responses_reset_at, extra_response_credits, usage_notified_80, usage_notified_100 FROM users WHERE id = ?'
  ).get(widget.user_id);

  if (owner) {
    const thisMonth = maybeResetUsage(db, owner.id, owner);
    const extra = owner.extra_response_credits || 0;

    if (thisMonth >= BASE_RESPONSES && extra <= 0) {
      return res.status(402).json({
        error: 'Mesačný limit AI odpovedí bol vyčerpaný. Vlastník chatbota si musí dobiť kredity.',
        code: 'LIMIT_REACHED',
      });
    }
  }

  const { message, sessionId, history = [], pageContext } = req.body;
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
    // Sanitize pageContext
    const safePageCtx = (pageContext && typeof pageContext.url === 'string')
      ? { url: pageContext.url.slice(0, 512), title: String(pageContext.title || '').slice(0, 200) }
      : null;

    const fullText = await streamChatResponse(widget, knowledgeItems, cleanHistory, message.trim(), res, safePageCtx);

    // Save assistant response + track usage
    if (fullText && owner) {
      db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
        uuidv4(), conversation.id, 'assistant', fullText
      );

      // Increment usage (base first, then extra)
      const freshOwner = db.prepare(
        'SELECT ai_responses_this_month, extra_response_credits, usage_notified_80, usage_notified_100 FROM users WHERE id = ?'
      ).get(owner.id);
      const currentMonth = freshOwner.ai_responses_this_month || 0;
      const currentExtra = freshOwner.extra_response_credits || 0;

      if (currentMonth < BASE_RESPONSES) {
        db.prepare('UPDATE users SET ai_responses_this_month = ai_responses_this_month + 1 WHERE id = ?').run(owner.id);
      } else if (currentExtra > 0) {
        db.prepare('UPDATE users SET extra_response_credits = extra_response_credits - 1 WHERE id = ?').run(owner.id);
      }

      // Usage notifications (async)
      const newCount = currentMonth + 1;
      setImmediate(() => {
        try {
          if (newCount >= BASE_RESPONSES && !freshOwner.usage_notified_100) {
            db.prepare('UPDATE users SET usage_notified_100 = 1 WHERE id = ?').run(owner.id);
            sendUsageNotification({ toEmail: owner.email, ownerName: owner.name, pct: 100, extra: currentExtra }).catch(() => {});
          } else if (newCount >= BASE_RESPONSES * 0.8 && !freshOwner.usage_notified_80) {
            db.prepare('UPDATE users SET usage_notified_80 = 1 WHERE id = ?').run(owner.id);
            sendUsageNotification({ toEmail: owner.email, ownerName: owner.name, pct: 80, extra: currentExtra }).catch(() => {});
          }
        } catch { /* ignore */ }
      });

      // Anonymous trend insight — trigger once per conversation after 3 full exchanges (6 msgs)
      setImmediate(async () => {
        try {
          const msgCount = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?').get(conversation.id).cnt;
          if (msgCount >= 6) {
            const conv = db.prepare('SELECT insight_done FROM conversations WHERE id = ?').get(conversation.id);
            if (conv && !conv.insight_done) {
              db.prepare('UPDATE conversations SET insight_done = 1 WHERE id = ?').run(conversation.id);
              const allMsgs = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation.id);
              const insight = await analyzeConversationTrends(allMsgs, msgCount);
              if (insight) {
                db.prepare(`INSERT INTO conversation_insights (id, widget_id, topics, intent, objection, urgency, msg_count) VALUES (?,?,?,?,?,?,?)`)
                  .run(uuidv4(), widget.id, JSON.stringify(insight.topics), insight.intent, insight.objection, insight.urgency, msgCount);
              }
            }
          }
        } catch (err) { console.error('Insight error:', err.message); }
      });
    } else if (fullText) {
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

// POST /api/widget/:widgetId/leads — save contact form submission + AI summary + email
router.post('/:widgetId/leads', async (req, res) => {
  const db = getDb();

  // Load widget + owner info for email notification
  const widgetRow = db.prepare(`
    SELECT w.id, w.name, w.bot_name, w.active, u.email AS owner_email, u.name AS owner_name
    FROM widgets w
    JOIN users u ON u.id = w.user_id
    WHERE w.id = ? AND w.active = 1
  `).get(req.params.widgetId);
  if (!widgetRow) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { name, email, phone, sessionId, gdprConsent } = req.body;
  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Meno a email sú povinné.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Neplatný email.' });
  }

  const leadId = uuidv4();
  db.prepare(
    'INSERT INTO leads (id, widget_id, name, email, phone, session_id, gdpr_consent) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(leadId, widgetRow.id, name.trim(), email.trim(), phone?.trim() || null, sessionId || null, gdprConsent ? 1 : 0);

  res.json({ ok: true, leadId });

  // Async: generate AI summary, then send email notification
  setImmediate(async () => {
    const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(widgetRow.id);
    let summary = null;

    if (sessionId) {
      try {
        const conv = db.prepare(
          'SELECT id FROM conversations WHERE session_id = ? AND widget_id = ?'
        ).get(sessionId, widgetRow.id);

        if (conv) {
          const messages = db.prepare(
            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
          ).all(conv.id);
          summary = await summarizeConversation(messages);
          if (summary) {
            db.prepare('UPDATE leads SET chat_summary = ? WHERE id = ?').run(summary, leadId);
          }
        }
      } catch (err) {
        console.error('Lead summary error:', err.message);
      }
    }

    // Auto-reply to lead
    if (widget.auto_reply_enabled && widget.auto_reply_message) {
      try {
        const { sendLeadAutoReply } = require('../services/email');
        await sendLeadAutoReply({
          toEmail: email.trim(),
          leadName: name.trim(),
          widgetName: widgetRow.name || widgetRow.bot_name,
          botName: widgetRow.bot_name,
          customMessage: widget.auto_reply_message,
        });
      } catch(e) { console.error('Auto-reply error:', e.message); }
    }

    // Ecomail: subscribe lead with AI-based tags
    if (widget.ecomail_api_key && widget.ecomail_list_id) {
      try {
        const { subscribeLeadToEcomail } = require('./ecomail');
        const tags = [];
        // Pull latest insight for this widget to get intent/urgency tags
        const insight = db.prepare(
          `SELECT ci.intent, ci.urgency
           FROM conversation_insights ci
           JOIN conversations c ON c.widget_id = ci.widget_id
           WHERE ci.widget_id = ? AND c.session_id = ?
           ORDER BY ci.created_at DESC LIMIT 1`
        ).get(widgetRow.id, sessionId || '');
        if (insight?.intent && insight.intent !== 'just_browsing') tags.push(`intent-${insight.intent}`);
        if (insight?.urgency && insight.urgency !== 'just_browsing') tags.push(`urgency-${insight.urgency}`);
        await subscribeLeadToEcomail({
          apiKey:  widget.ecomail_api_key,
          listId:  widget.ecomail_list_id,
          email:   email.trim(),
          name:    name.trim(),
          tags,
        });
      } catch(e) { console.error('Ecomail error:', e.message); }
    }

    // Webhook (Zapier/n8n/Make)
    if (widget.webhook_url) {
      try {
        const https = require('https');
        const http = require('http');
        const wUrl = new URL(widget.webhook_url);
        const payload = JSON.stringify({ event: 'new_lead', widget_id: widgetRow.id, name: name.trim(), email: email.trim(), phone: phone?.trim()||null, created_at: new Date().toISOString() });
        const mod = wUrl.protocol === 'https:' ? https : http;
        const hReq = mod.request({ hostname: wUrl.hostname, path: wUrl.pathname + wUrl.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, () => {});
        hReq.on('error', () => {});
        hReq.write(payload);
        hReq.end();
      } catch(e) { console.error('Webhook error:', e.message); }
    }

    // Slack notification
    if (widget.slack_webhook_url) {
      try {
        const https = require('https');
        const http = require('http');
        const sUrl = new URL(widget.slack_webhook_url);
        const text = `🔔 Nový lead: *${name.trim()}* (${email.trim()})${phone ? ` | ${phone.trim()}` : ''} – widget *${widgetRow.name || widgetRow.bot_name}*`;
        const payload = JSON.stringify({ text });
        const mod = sUrl.protocol === 'https:' ? https : http;
        const hReq = mod.request({ hostname: sUrl.hostname, path: sUrl.pathname + sUrl.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, () => {});
        hReq.on('error', () => {});
        hReq.write(payload);
        hReq.end();
      } catch(e) { console.error('Slack webhook error:', e.message); }
    }

    // Send email notification to widget owner
    try {
      await sendLeadNotification({
        toEmail: widgetRow.owner_email,
        ownerName: widgetRow.owner_name,
        widgetName: widgetRow.name || widgetRow.bot_name,
        lead: {
          name: name.trim(),
          email: email.trim(),
          phone: phone?.trim() || null,
          chat_summary: summary,
        },
      });
    } catch (err) {
      console.error('Lead email error:', err.message);
    }
  });
});

// POST /api/widget/:widgetId/csat — save CSAT rating (1-5)
router.post('/:widgetId/csat', (req, res) => {
  const db = getDb();
  const { sessionId, rating } = req.body;
  const r = parseInt(rating);
  if (!sessionId || !r || r < 1 || r > 5) {
    return res.status(400).json({ error: 'Invalid.' });
  }
  const sid = String(sessionId).slice(0, 64);
  const conv = db.prepare('SELECT id FROM conversations WHERE session_id = ? AND widget_id = ?').get(sid, req.params.widgetId);
  if (!conv) return res.status(404).json({ error: 'Not found.' });
  db.prepare('UPDATE conversations SET csat_rating = ? WHERE id = ?').run(r, conv.id);
  // Also update lead for this session if exists
  db.prepare('UPDATE leads SET csat_rating = ? WHERE session_id = ? AND widget_id = ?').run(r, sid, req.params.widgetId);
  res.json({ ok: true });
});

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
