'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { generateGdprText } = require('../services/claude');

const avatarStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '..', 'uploads', 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `avatar-${req.params.id}${ALLOWED_EXTS.has(ext) ? ext : '.jpg'}`);
  },
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
});

const router = express.Router();

// All widget routes require authentication
router.use(requireAuth);

// GET /api/widgets — list all widgets for current user
router.get('/', (req, res) => {
  const db = getDb();
  const widgets = db.prepare(`
    SELECT w.*,
      (SELECT COUNT(*) FROM knowledge_items WHERE widget_id = w.id) AS knowledge_count
    FROM widgets w
    WHERE w.user_id = ?
    ORDER BY w.created_at DESC
  `).all(req.userId);

  res.json(widgets.map(parseWidget));
});

// GET /api/widgets/leads/all — all leads across all user's widgets (single request, no race condition)
router.get('/leads/all', (req, res) => {
  const db = getDb();
  const leads = db.prepare(`
    SELECT l.id, l.name, l.email, l.phone, l.status, l.notes, l.chat_summary,
           l.gdpr_consent, l.created_at, l.widget_id, l.csat_rating,
           l.follow_up_sent_at, l.ab_variant,
           l.deal_value, l.converted_at, l.last_reactivation_at, l.reactivation_count,
           w.name AS widget_name, w.bot_name
    FROM leads l
    JOIN widgets w ON w.id = l.widget_id
    WHERE w.user_id = ?
    ORDER BY l.created_at DESC
  `).all(req.userId);

  res.json({ leads });
});

// GET /api/widgets/:id — get single widget
router.get('/:id', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  res.json(parseWidget(widget));
});

// POST /api/widgets — create widget
router.post('/', (req, res) => {
  const { name, bot_name, welcome_message, primary_color, goals, cta_type, cta_config, suggested_questions } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Názov widgetu je povinný.' });
  }

  const db = getDb();

  const user = db.prepare('SELECT subscription_plan, subscription_status, free_until, white_label_extra_slots FROM users WHERE id = ?').get(req.userId);

  // Block creation when subscription is not active
  const nowTs = Math.floor(Date.now() / 1000);
  const subActive = user?.subscription_status === 'active' || user?.subscription_status === 'past_due' ||
                    (user?.free_until && user.free_until > nowTs);
  if (!subActive) {
    return res.status(403).json({ error: 'Vytvorenie widgetu vyžaduje aktívne predplatné.' });
  }

  // Enforce widget limits per plan
  const widgetCount = db.prepare('SELECT COUNT(*) AS cnt FROM widgets WHERE user_id = ?').get(req.userId).cnt;
  const isWL = user?.subscription_plan === 'white_label';
  const limit = isWL ? (40 + (user.white_label_extra_slots || 0)) : 10;
  if (widgetCount >= limit) {
    return res.status(403).json({
      error: isWL
        ? `Dosiahli ste limit ${limit} klientov. Dokúpte ďalšie sloty (€15/klient).`
        : 'Dosiahli ste limit 10 widgetov na Pro pláne.',
      limit_reached: true,
      is_white_label: isWL,
      current: widgetCount,
      limit,
    });
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO widgets (id, user_id, name, bot_name, welcome_message, primary_color, goals, cta_type, cta_config, suggested_questions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.userId,
    name.trim(),
    (bot_name || 'Asistent').trim(),
    (welcome_message || 'Ahoj! Ako vám môžem pomôcť?').trim(),
    primary_color || '#2563eb',
    goals || '',
    validateCtaType(cta_type),
    JSON.stringify(cta_config || {}),
    JSON.stringify(suggested_questions || [])
  );

  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id);
  res.status(201).json(parseWidget(widget));
});

// PUT /api/widgets/:id — update widget
router.put('/:id', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { name, bot_name, welcome_message, primary_color, goals, cta_type, cta_config, suggested_questions,
          suggested_questions_i18n, active,
          proactive_enabled, proactive_delay, proactive_message, proactive_sequence, gdpr_text,
          webhook_url, slack_webhook_url, hide_branding, csat_enabled,
          ab_test_enabled, welcome_message_b, auto_reply_enabled, auto_reply_message,
          offline_message, business_hours, demo_video_url } = req.body;

  const db = getDb();

  // Block manual reactivation when subscription is not active
  if (active === true || active === 1 || active === '1') {
    const subUser = db.prepare('SELECT subscription_status, free_until FROM users WHERE id = ?').get(req.userId);
    const nowSub = Math.floor(Date.now() / 1000);
    const subOk = subUser?.subscription_status === 'active' || subUser?.subscription_status === 'past_due' ||
                  (subUser?.free_until && subUser.free_until > nowSub);
    if (!subOk) {
      return res.status(403).json({ error: 'Aktivácia widgetu vyžaduje aktívne predplatné.' });
    }
  }

  // White-label is only available on the White Label plan
  if (hide_branding) {
    const user = db.prepare('SELECT subscription_plan FROM users WHERE id = ?').get(req.userId);
    if (user?.subscription_plan !== 'white_label') {
      return res.status(403).json({ error: 'white_label_required' });
    }
  }
  db.prepare(`
    UPDATE widgets SET
      name = ?,
      bot_name = ?,
      welcome_message = ?,
      primary_color = ?,
      goals = ?,
      cta_type = ?,
      cta_config = ?,
      suggested_questions = ?,
      suggested_questions_i18n = ?,
      active = ?,
      proactive_enabled = ?,
      proactive_delay = ?,
      proactive_message = ?,
      proactive_sequence = ?,
      gdpr_text = ?,
      webhook_url = ?,
      slack_webhook_url = ?,
      hide_branding = ?,
      csat_enabled = ?,
      ab_test_enabled = ?,
      welcome_message_b = ?,
      auto_reply_enabled = ?,
      auto_reply_message = ?,
      offline_message = ?,
      business_hours = ?,
      demo_video_url = ?
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : widget.name,
    bot_name !== undefined ? bot_name.trim() : widget.bot_name,
    welcome_message !== undefined ? welcome_message.trim() : widget.welcome_message,
    primary_color || widget.primary_color,
    goals !== undefined ? goals : widget.goals,
    cta_type ? validateCtaType(cta_type) : widget.cta_type,
    cta_config !== undefined ? JSON.stringify(cta_config) : widget.cta_config,
    suggested_questions !== undefined ? JSON.stringify(suggested_questions) : widget.suggested_questions,
    suggested_questions_i18n !== undefined ? JSON.stringify(suggested_questions_i18n) : (widget.suggested_questions_i18n || '{}'),
    active !== undefined ? (active ? 1 : 0) : widget.active,
    proactive_enabled !== undefined ? (proactive_enabled ? 1 : 0) : (widget.proactive_enabled || 0),
    proactive_delay !== undefined ? Math.max(1, Math.min(60, parseInt(proactive_delay) || 4)) : (widget.proactive_delay || 4),
    proactive_message !== undefined ? String(proactive_message).slice(0, 5000) : (widget.proactive_message || ''),
    proactive_sequence !== undefined ? JSON.stringify(Array.isArray(proactive_sequence) ? proactive_sequence.slice(0, 20) : []) : (widget.proactive_sequence || '[]'),
    gdpr_text !== undefined ? String(gdpr_text).slice(0, 5000) : (widget.gdpr_text || ''),
    webhook_url !== undefined ? (webhook_url ? String(webhook_url).slice(0, 512) : null) : (widget.webhook_url || null),
    slack_webhook_url !== undefined ? (slack_webhook_url ? String(slack_webhook_url).slice(0, 512) : null) : (widget.slack_webhook_url || null),
    hide_branding !== undefined ? (hide_branding ? 1 : 0) : (widget.hide_branding || 0),
    csat_enabled !== undefined ? (csat_enabled ? 1 : 0) : (widget.csat_enabled || 0),
    ab_test_enabled !== undefined ? (ab_test_enabled ? 1 : 0) : (widget.ab_test_enabled || 0),
    welcome_message_b !== undefined ? String(welcome_message_b || '').slice(0, 500) : (widget.welcome_message_b || ''),
    auto_reply_enabled !== undefined ? (auto_reply_enabled ? 1 : 0) : (widget.auto_reply_enabled || 0),
    auto_reply_message !== undefined ? String(auto_reply_message || '').slice(0, 2000) : (widget.auto_reply_message || ''),
    offline_message !== undefined ? String(offline_message || '').slice(0, 500) : (widget.offline_message || ''),
    business_hours !== undefined ? (typeof business_hours === 'string' ? business_hours : JSON.stringify(business_hours)) : (widget.business_hours || '{}'),
    demo_video_url !== undefined ? (demo_video_url ? String(demo_video_url).slice(0, 512) : null) : (widget.demo_video_url || null),
    widget.id
  );

  const updated = db.prepare('SELECT * FROM widgets WHERE id = ?').get(widget.id);
  res.json(parseWidget(updated));
});

// POST /api/widgets/:id/generate-gdpr — AI generates GDPR text from company info
router.post('/:id/generate-gdpr', async (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { companyName, companyAddress, companyId, email, purposes, retention } = req.body;
  if (!companyName?.trim()) return res.status(400).json({ error: 'Názov spoločnosti je povinný.' });

  try {
    const text = await generateGdprText({
      companyName: companyName.trim(),
      companyAddress: companyAddress?.trim() || '',
      companyId: companyId?.trim() || '',
      email: email?.trim() || '',
      purposes: purposes?.trim() || '',
      retention: retention?.trim() || '',
    });
    res.json({ gdpr_text: text });
  } catch (err) {
    console.error('generateGdpr error:', err.message);
    res.status(500).json({ error: 'Chyba pri generovaní GDPR textu.' });
  }
});

// DELETE /api/widgets/:id — delete widget
router.delete('/:id', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  db.prepare('DELETE FROM widgets WHERE id = ?').run(widget.id);
  res.json({ success: true });
});

// GET /api/widgets/:id/embed-code — get embed code snippet
router.get('/:id/embed-code', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const baseUrl = process.env.BASE_URL || 'https://neoworkly.com';
  const code = `<!-- Neoworkly Chat Widget -->
<script>
  window.NeoworklyConfig = { widgetId: '${widget.id}' };
</script>
<script src="${baseUrl}/widget.js" async></script>`;

  res.json({ code });
});

// POST /api/widgets/complete-onboarding — mark onboarding done
router.post('/complete-onboarding', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE users SET onboarding_done = 1 WHERE id = ?').run(req.userId);
  res.json({ success: true });
});

// POST /api/widgets/:id/avatar — upload bot avatar image
router.post('/:id/avatar', uploadAvatar.single('avatar'), (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  if (!req.file) return res.status(400).json({ error: 'Neplatný súbor.' });

  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  const db = getDb();
  db.prepare('UPDATE widgets SET avatar_url = ? WHERE id = ?').run(avatarUrl, widget.id);
  res.json({ avatar_url: avatarUrl });
});

// GET /api/widgets/:id/leads — list leads for a widget
router.get('/:id/leads', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  const leads = db.prepare(`
    SELECT id, name, email, phone, status, notes, chat_summary, gdpr_consent, created_at
    FROM leads WHERE widget_id = ?
    ORDER BY created_at DESC
  `).all(widget.id);

  res.json({ leads });
});

// PATCH /api/widgets/:id/leads/:leadId — update status and/or notes
router.patch('/:id/leads/:leadId', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND widget_id = ?').get(req.params.leadId, widget.id);
  if (!lead) return res.status(404).json({ error: 'Lead nenájdený.' });

  const { status, notes } = req.body;
  const allowed = ['new', 'contacted', 'closed'];

  if (status !== undefined && !allowed.includes(status)) {
    return res.status(400).json({ error: 'Neplatný stav.' });
  }

  const fields = [];
  const vals = [];
  if (status !== undefined) { fields.push('status = ?'); vals.push(status); }
  if (notes !== undefined) { fields.push('notes = ?'); vals.push(notes); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nič na aktualizáciu.' });

  vals.push(req.params.leadId);
  db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// POST /api/widgets/:id/leads/:leadId/followup — send manual follow-up email
router.post('/:id/leads/:leadId/followup', async (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND widget_id = ?').get(req.params.leadId, widget.id);
  if (!lead) return res.status(404).json({ error: 'Lead nenájdený.' });

  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Správa je povinná.' });

  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  try {
    const { sendFollowUp } = require('../services/email');
    await sendFollowUp({
      toEmail: lead.email,
      leadName: lead.name,
      ownerName: owner?.name || '',
      widgetName: widget.name || widget.bot_name,
      message: message.trim(),
    });
    db.prepare('UPDATE leads SET follow_up_sent_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), lead.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Odoslanie zlyhalo: ' + err.message });
  }
});

// DELETE /api/widgets/:id/leads/:leadId — delete a lead
router.delete('/:id/leads/:leadId', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  db.prepare('DELETE FROM leads WHERE id = ? AND widget_id = ?').run(req.params.leadId, widget.id);
  res.json({ ok: true });
});

// GET /api/widgets/:id/leads/export — CSV export
router.get('/:id/leads/export', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const db = getDb();
  const leads = db.prepare(`
    SELECT name, email, phone, status, notes, chat_summary, gdpr_consent, created_at
    FROM leads WHERE widget_id = ? ORDER BY created_at DESC
  `).all(widget.id);

  const header = ['Meno', 'Email', 'Telefón', 'Stav', 'Poznámky', 'AI zhrnutie', 'GDPR súhlas', 'Dátum'];
  const rows = leads.map(l => [
    l.name,
    l.email,
    l.phone || '',
    l.status,
    l.notes || '',
    (l.chat_summary || '').replace(/\n/g, ' '),
    l.gdpr_consent ? 'Áno' : 'Nie',
    new Date(l.created_at * 1000).toLocaleString('sk-SK'),
  ]);

  const csv = [header, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const filename = `kontakty-${widget.name || widget.id}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv);  // BOM for Excel UTF-8
});

function getOwnedWidget(widgetId, userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId);
}

function validateCtaType(type) {
  const allowed = ['call', 'contact', 'booking', 'custom', 'none'];
  return allowed.includes(type) ? type : 'contact';
}

function parseWidget(w) {
  return {
    ...w,
    active: Boolean(w.active),
    cta_config: safeParseJSON(w.cta_config, {}),
    suggested_questions: safeParseJSON(w.suggested_questions, []),
    suggested_questions_i18n: safeParseJSON(w.suggested_questions_i18n, {}),
    proactive_enabled: Boolean(w.proactive_enabled),
    proactive_delay: w.proactive_delay || 4,
    proactive_message: w.proactive_message || '',
    proactive_sequence: safeParseJSON(w.proactive_sequence, []),
    gdpr_text: w.gdpr_text || '',
    hide_branding: Boolean(w.hide_branding),
    csat_enabled: Boolean(w.csat_enabled),
    ab_test_enabled: Boolean(w.ab_test_enabled),
    welcome_message_b: w.welcome_message_b || '',
    auto_reply_enabled: Boolean(w.auto_reply_enabled),
    auto_reply_message: w.auto_reply_message || '',
    offline_message: w.offline_message || '',
    webhook_url: w.webhook_url || null,
    slack_webhook_url: w.slack_webhook_url || null,
    business_hours: safeParseJSON(w.business_hours, {}),
    demo_video_url: w.demo_video_url || null,
  };
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/* ── Auto-translate via Claude Haiku ─────────────────────────────── */

/**
 * POST /api/widgets/translate
 * Body: { text?: string, texts?: object, targetLanguages?: string[], context?: string }
 * Response: { translations: { langCode: string | object } }
 */
router.post('/translate', requireAuth, async (req, res) => {
  const { text, texts, context, targetLanguages } = req.body;
  if (!text && !texts) return res.status(400).json({ error: 'Chýba text alebo texts.' });

  const langs = Array.isArray(targetLanguages) && targetLanguages.length
    ? targetLanguages
    : ['cs', 'en', 'de', 'fr', 'es', 'pl', 'hu', 'ro', 'hr', 'it', 'nl', 'pt'];

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    let prompt;
    if (text) {
      prompt = `Translate the following text to these languages: ${langs.join(', ')}.
Context: ${context || 'welcome message for a chat assistant widget'}
Text to translate: "${text}"

Return ONLY valid JSON, no extra text:
{"cs":"...","en":"...","de":"...",...}`;
    } else {
      const pairs = Object.entries(texts)
        .map(([k, v]) => `  "${k}": "${String(v).replace(/"/g, '\\"')}"`)
        .join(',\n');
      prompt = `Translate these UI text strings to: ${langs.join(', ')}.
Context: ${context || 'booking page UI — labels, buttons, messages'}
Source object:
{
${pairs}
}

Return ONLY valid JSON where each key is a language code and value is an object with the same keys translated:
{"cs":{"bookingSubtitle":"...","confirmBtn":"..."},"en":{...},...}
No markdown, no explanation — only the JSON object.`;
    }

    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (resp.content[0]?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const result = JSON.parse(m ? m[0] : raw);
    res.json({ translations: result });
  } catch (err) {
    console.error('[translate]', err.message);
    res.status(500).json({ error: 'Preklad zlyhal: ' + err.message });
  }
});

/* ── Inbox / Conversations ─────────────────────────────────────── */

// GET /api/widgets/:id/conversations — list conversations with last message + lead info
router.get('/:id/conversations', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  const db = getDb();
  const convs = db.prepare(`
    SELECT c.id, c.session_id, c.live_agent, c.csat_rating,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count,
           (SELECT m2.content FROM messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC LIMIT 1) AS last_msg,
           (SELECT m3.created_at FROM messages m3 WHERE m3.conversation_id = c.id ORDER BY m3.created_at DESC LIMIT 1) AS last_msg_at,
           l.name AS lead_name, l.email AS lead_email
    FROM conversations c
    LEFT JOIN leads l ON l.session_id = c.session_id AND l.widget_id = c.widget_id
    WHERE c.widget_id = ?
    ORDER BY last_msg_at DESC NULLS LAST
    LIMIT 100
  `).all(widget.id);
  res.json(convs);
});

// GET /api/widgets/:id/conversations/:convId/messages
router.get('/:id/conversations/:convId/messages', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  const db = getDb();
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND widget_id = ?').get(req.params.convId, widget.id);
  if (!conv) return res.status(404).json({ error: 'Konverzácia nenájdená.' });
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conv.id);
  res.json(msgs);
});

// PATCH /api/widgets/:id/conversations/:convId/takeover — toggle live_agent
router.patch('/:id/conversations/:convId/takeover', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  const db = getDb();
  const conv = db.prepare('SELECT id, live_agent FROM conversations WHERE id = ? AND widget_id = ?').get(req.params.convId, widget.id);
  if (!conv) return res.status(404).json({ error: 'Konverzácia nenájdená.' });
  const newVal = req.body.live !== undefined ? (req.body.live ? 1 : 0) : (conv.live_agent ? 0 : 1);
  db.prepare('UPDATE conversations SET live_agent = ? WHERE id = ?').run(newVal, conv.id);
  res.json({ ok: true, live_agent: Boolean(newVal) });
});

// POST /api/widgets/:id/conversations/:convId/agent-message — inject agent message
router.post('/:id/conversations/:convId/agent-message', (req, res) => {
  const widget = getOwnedWidget(req.params.id, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Správa je povinná.' });
  const db = getDb();
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND widget_id = ?').get(req.params.convId, widget.id);
  if (!conv) return res.status(404).json({ error: 'Konverzácia nenájdená.' });
  const { v4: uuidv4 } = require('uuid');
  db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
    uuidv4(), conv.id, 'assistant', message.trim().slice(0, 4000)
  );
  res.json({ ok: true });
});

module.exports = router;
