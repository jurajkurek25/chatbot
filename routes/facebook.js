'use strict';

const express = require('express');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { getDb, searchKnowledge } = require('../db/database');
const { getChatResponseText } = require('../services/claude');

const router = express.Router();

const FB_GRAPH_VERSION = 'v17.0';
const FB_GRAPH_BASE    = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;

/* ── Helper: lightweight HTTPS GET/POST ─────────────────────────── */
function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options || {}, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ── Helper: send a Facebook Messenger message ──────────────────── */
async function sendFbMessage(recipientId, text, pageAccessToken) {
  const payload = JSON.stringify({
    recipient: { id: recipientId },
    message:   { text },
    access_token: pageAccessToken,
  });

  const url = new URL(`${FB_GRAPH_BASE}/me/messages`);
  const options = {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const result = await httpsRequest(url.toString(), options, payload);
  if (result.error) {
    throw new Error(`FB Send API error: ${JSON.stringify(result.error)}`);
  }
  return result;
}

/* ── Helper: validate token via Graph API /me ───────────────────── */
async function validatePageToken(token) {
  const url = `${FB_GRAPH_BASE}/me?access_token=${encodeURIComponent(token)}&fields=id,name`;
  const result = await httpsRequest(url, { method: 'GET' });
  if (result.error) throw new Error(result.error.message || 'Invalid token');
  return result; // { id, name }
}

/* ─────────────────────────────────────────────────────────────────
   1. GET /:widgetId/status
────────────────────────────────────────────────────────────────── */
router.get('/:widgetId/status', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget not found.' });

  const conn = db.prepare(`
    SELECT page_name, keyword_triggers, welcome_msg, connected_at
    FROM facebook_connections WHERE widget_id = ?
  `).get(req.params.widgetId);

  if (!conn) return res.json({ connected: false });

  res.json({
    connected:        true,
    page_name:        conn.page_name || '',
    keyword_triggers: JSON.parse(conn.keyword_triggers || '[]'),
    welcome_msg:      conn.welcome_msg || '',
    connected_at:     conn.connected_at,
  });
});

/* ─────────────────────────────────────────────────────────────────
   2. POST /:widgetId/connect
────────────────────────────────────────────────────────────────── */
router.post('/:widgetId/connect', requireAuth, async (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget not found.' });

  const { page_id, page_access_token, keyword_triggers, welcome_msg } = req.body;

  if (!page_id || !page_access_token) {
    return res.status(400).json({ error: 'page_id and page_access_token are required.' });
  }

  // Validate token via Graph API
  let pageInfo;
  try {
    pageInfo = await validatePageToken(page_access_token);
  } catch (err) {
    return res.status(400).json({ error: `Invalid page_access_token: ${err.message}` });
  }

  const keywords = Array.isArray(keyword_triggers) ? keyword_triggers : [];
  const cleanedKeywords = keywords
    .map(k => String(k).trim().toLowerCase().slice(0, 30))
    .filter(Boolean)
    .slice(0, 20);

  const existing = db.prepare('SELECT id FROM facebook_connections WHERE widget_id = ?')
    .get(req.params.widgetId);
  const connId = existing?.id || uuidv4();

  db.prepare(`
    INSERT INTO facebook_connections
      (id, widget_id, page_id, page_name, page_access_token, keyword_triggers, welcome_msg)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(widget_id) DO UPDATE SET
      page_id           = excluded.page_id,
      page_name         = excluded.page_name,
      page_access_token = excluded.page_access_token,
      keyword_triggers  = excluded.keyword_triggers,
      welcome_msg       = excluded.welcome_msg,
      connected_at      = unixepoch()
  `).run(
    connId,
    req.params.widgetId,
    page_id,
    pageInfo.name || null,
    page_access_token,
    JSON.stringify(cleanedKeywords),
    (welcome_msg || '').slice(0, 500) || '',
  );

  res.json({ ok: true, page_name: pageInfo.name || null });
});

/* ─────────────────────────────────────────────────────────────────
   3. DELETE /:widgetId/disconnect
────────────────────────────────────────────────────────────────── */
router.delete('/:widgetId/disconnect', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget not found.' });

  db.prepare('DELETE FROM facebook_connections WHERE widget_id = ?').run(req.params.widgetId);
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────
   4. PUT /:widgetId/settings
────────────────────────────────────────────────────────────────── */
router.put('/:widgetId/settings', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget not found.' });

  const conn = db.prepare('SELECT id FROM facebook_connections WHERE widget_id = ?')
    .get(req.params.widgetId);
  if (!conn) return res.status(404).json({ error: 'Facebook not connected.' });

  const { keyword_triggers, welcome_msg } = req.body;
  if (!Array.isArray(keyword_triggers)) {
    return res.status(400).json({ error: 'keyword_triggers must be an array.' });
  }

  const cleaned = keyword_triggers
    .map(k => String(k).trim().toLowerCase().slice(0, 30))
    .filter(Boolean)
    .slice(0, 20);

  db.prepare(`
    UPDATE facebook_connections
    SET keyword_triggers = ?, welcome_msg = ?
    WHERE widget_id = ?
  `).run(JSON.stringify(cleaned), (welcome_msg || '').slice(0, 500) || '', req.params.widgetId);

  res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────
   5. GET /:widgetId/webhook  — Facebook webhook verification
────────────────────────────────────────────────────────────────── */
router.get('/:widgetId/webhook', (req, res) => {
  const mode        = req.query['hub.mode'];
  const challenge   = req.query['hub.challenge'];
  const verifyToken = req.query['hub.verify_token'];

  const expected = process.env.FB_VERIFY_TOKEN || 'neuradesk_verify';

  if (mode === 'subscribe' && verifyToken === expected) {
    console.log('[facebook] Webhook verified.');
    return res.send(challenge);
  }
  res.sendStatus(403);
});

/* ─────────────────────────────────────────────────────────────────
   6. POST /:widgetId/webhook  — Facebook webhook event handler
────────────────────────────────────────────────────────────────── */
router.post('/:widgetId/webhook', (req, res) => {
  // Respond immediately — Facebook requires a fast 200 OK
  res.sendStatus(200);

  const body = req.body;
  if (!body || body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const messaging of entry.messaging || []) {
      const senderId = messaging.sender?.id;
      const pageId   = messaging.recipient?.id;

      // Only handle inbound text messages; skip echoes (sender === page)
      if (
        messaging.message &&
        messaging.message.text &&
        senderId &&
        pageId &&
        senderId !== pageId
      ) {
        handleFbDM(req.params.widgetId, senderId, pageId, messaging).catch(err =>
          console.error('[facebook] DM handler error:', err.message)
        );
      }
    }
  }
});

/* ── Incoming DM handler ────────────────────────────────────────── */
async function handleFbDM(widgetId, senderId, pageId, msgData) {
  const db = getDb();

  // Look up connection by widgetId
  const conn = db.prepare('SELECT * FROM facebook_connections WHERE widget_id = ?').get(widgetId);
  if (!conn) return;

  const text = (msgData.message?.text || '').trim();
  if (!text) return;

  // Get or create session
  let session = db.prepare(
    'SELECT * FROM facebook_dm_sessions WHERE connection_id = ? AND sender_id = ?'
  ).get(conn.id, senderId);

  if (!session) {
    const sessionId = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO facebook_dm_sessions (id, connection_id, sender_id, history)
      VALUES (?, ?, ?, '[]')
    `).run(sessionId, conn.id, senderId);
    session = db.prepare('SELECT * FROM facebook_dm_sessions WHERE id = ?').get(sessionId);
  }

  const history = JSON.parse(session.history || '[]');

  // If live agent mode is active, save message but skip Claude
  if (session.live_agent === 1) {
    history.push({ role: 'user', content: text });
    db.prepare(`
      UPDATE facebook_dm_sessions SET history = ?, updated_at = unixepoch() WHERE id = ?
    `).run(JSON.stringify(history.slice(-40)), session.id);
    return;
  }

  // Check keyword triggers — send welcome_msg once (only if history is empty)
  const keywords = JSON.parse(conn.keyword_triggers || '[]');
  if (keywords.length && history.length === 0 && conn.welcome_msg) {
    const lowerText = text.toLowerCase();
    const matched = keywords.some(kw => lowerText.includes(kw.toLowerCase().trim()));
    if (matched) {
      await sendFbMessage(senderId, conn.welcome_msg, conn.page_access_token);
      history.push({ role: 'assistant', content: conn.welcome_msg });
      db.prepare(`
        UPDATE facebook_dm_sessions SET history = ?, updated_at = unixepoch() WHERE id = ?
      `).run(JSON.stringify(history), session.id);
      // Continue to also generate a Claude reply below
    }
  }

  // Fetch widget + knowledge for Claude
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(conn.widget_id);
  if (!widget) return;

  const knowledgeItems = searchKnowledge(widget.id, text);

  // Generate response using non-streaming Claude call
  const response = await getChatResponseText(widget, knowledgeItems, history, text);

  // Send reply via Facebook Send API
  await sendFbMessage(senderId, response, conn.page_access_token);

  // Persist updated history (keep last 40 messages)
  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: response });
  const trimmed = history.slice(-40);

  db.prepare(`
    UPDATE facebook_dm_sessions SET history = ?, updated_at = unixepoch() WHERE id = ?
  `).run(JSON.stringify(trimmed), session.id);
}

/* ─────────────────────────────────────────────────────────────────
   7. GET /:widgetId/sessions  — list DM sessions with last message
────────────────────────────────────────────────────────────────── */
router.get('/:widgetId/sessions', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget not found.' });

  const conn = db.prepare('SELECT id FROM facebook_connections WHERE widget_id = ?')
    .get(req.params.widgetId);
  if (!conn) return res.json([]);

  const sessions = db.prepare(`
    SELECT id, sender_id, sender_name, history, live_agent, created_at, updated_at
    FROM facebook_dm_sessions
    WHERE connection_id = ?
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(conn.id);

  const result = sessions.map(s => {
    const history = JSON.parse(s.history || '[]');
    const lastMsg = history.length ? history[history.length - 1] : null;
    return {
      id:          s.id,
      sender_id:   s.sender_id,
      sender_name: s.sender_name || null,
      last_message: lastMsg ? lastMsg.content.slice(0, 200) : null,
      last_role:    lastMsg ? lastMsg.role : null,
      msg_count:    history.length,
      live_agent:   s.live_agent === 1,
      created_at:   s.created_at,
      updated_at:   s.updated_at,
    };
  });

  res.json(result);
});

/* ─────────────────────────────────────────────────────────────────
   8. PATCH /:widgetId/sessions/:sessionId/takeover  — toggle live_agent
────────────────────────────────────────────────────────────────── */
router.patch('/:widgetId/sessions/:sessionId/takeover', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget not found.' });

  const conn = db.prepare('SELECT id FROM facebook_connections WHERE widget_id = ?')
    .get(req.params.widgetId);
  if (!conn) return res.status(404).json({ error: 'Facebook not connected.' });

  const session = db.prepare(
    'SELECT id, live_agent FROM facebook_dm_sessions WHERE id = ? AND connection_id = ?'
  ).get(req.params.sessionId, conn.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const newValue = session.live_agent === 1 ? 0 : 1;
  db.prepare('UPDATE facebook_dm_sessions SET live_agent = ?, updated_at = unixepoch() WHERE id = ?')
    .run(newValue, session.id);

  res.json({ ok: true, live_agent: newValue === 1 });
});

module.exports = router;
