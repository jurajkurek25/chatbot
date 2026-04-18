'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { getDb, searchKnowledge } = require('../db/database');
const { getChatResponseText } = require('../services/claude');
const { sendTextMessage, markAsRead } = require('../services/whatsapp');

const router = express.Router();

/* ── GET /api/whatsapp/status/:widgetId ────────────────────────── */
router.get('/status/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const conn = db.prepare(`
    SELECT phone_number_id, phone_display, verify_token, created_at
    FROM whatsapp_connections WHERE widget_id = ?
  `).get(req.params.widgetId);

  if (!conn) return res.json({ connected: false });

  res.json({
    connected: true,
    phone_number_id: conn.phone_number_id,
    phone_display: conn.phone_display || '',
    verify_token: conn.verify_token,
    created_at: conn.created_at,
  });
});

/* ── POST /api/whatsapp/connect/:widgetId ──────────────────────── */
router.post('/connect/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { phone_number_id, access_token, phone_display, verify_token } = req.body;

  if (!phone_number_id || !access_token || !verify_token) {
    return res.status(400).json({ error: 'phone_number_id, access_token a verify_token sú povinné.' });
  }

  const existing = db.prepare('SELECT id FROM whatsapp_connections WHERE widget_id = ?')
    .get(req.params.widgetId);
  const connId = existing?.id || uuidv4();

  db.prepare(`
    INSERT INTO whatsapp_connections
      (id, widget_id, user_id, phone_number_id, access_token, phone_display, verify_token)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(widget_id) DO UPDATE SET
      phone_number_id = excluded.phone_number_id,
      access_token    = excluded.access_token,
      phone_display   = excluded.phone_display,
      verify_token    = excluded.verify_token,
      created_at      = unixepoch()
  `).run(connId, req.params.widgetId, req.userId, phone_number_id, access_token,
         phone_display || null, verify_token);

  res.json({ ok: true });
});

/* ── DELETE /api/whatsapp/disconnect/:widgetId ─────────────────── */
router.delete('/disconnect/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  db.prepare('DELETE FROM whatsapp_connections WHERE widget_id = ?').run(req.params.widgetId);
  res.json({ ok: true });
});

/* ── GET /api/whatsapp/webhook — Meta webhook verification ─────── */
router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode !== 'subscribe' || !token) return res.sendStatus(403);

  const db = getDb();
  const conn = db.prepare('SELECT id FROM whatsapp_connections WHERE verify_token = ?').get(token);
  if (!conn) return res.sendStatus(403);

  console.log('[whatsapp] Webhook verified by Meta.');
  res.send(challenge);
});

/* ── POST /api/whatsapp/webhook — receive incoming messages ─────── */
router.post('/webhook', async (req, res) => {
  // Respond immediately so Meta doesn't retry
  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      const message = value?.messages?.[0];
      if (!message || message.type !== 'text') continue;

      const from = message.from; // phone number of sender
      const text = message.text?.body;
      const phoneNumberId = value?.metadata?.phone_number_id;
      const messageId = message.id;
      const contactName = value?.contacts?.[0]?.profile?.name || null;

      if (!from || !text || !phoneNumberId) continue;

      handleIncomingMessage(phoneNumberId, from, text, messageId, contactName).catch(e =>
        console.error('[whatsapp] Message handler error:', e.message)
      );
    }
  }
});

/* ── Incoming message handler ───────────────────────────────────── */
async function handleIncomingMessage(phoneNumberId, from, text, messageId, contactName) {
  const db = getDb();

  // Find the connection by phone_number_id
  const conn = db.prepare('SELECT * FROM whatsapp_connections WHERE phone_number_id = ?').get(phoneNumberId);
  if (!conn) return;

  // Get the widget
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(conn.widget_id);
  if (!widget) return;

  // Upsert conversation
  let conversation = db.prepare(
    'SELECT * FROM whatsapp_conversations WHERE connection_id = ? AND wa_contact_id = ?'
  ).get(conn.id, from);

  if (!conversation) {
    const convId = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO whatsapp_conversations (id, connection_id, wa_contact_id, contact_name, last_message_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `).run(convId, conn.id, from, contactName);
    conversation = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(convId);
  } else {
    // Update contact name if we now have it
    if (contactName && !conversation.contact_name) {
      db.prepare('UPDATE whatsapp_conversations SET contact_name = ?, last_message_at = unixepoch() WHERE id = ?')
        .run(contactName, conversation.id);
    } else {
      db.prepare('UPDATE whatsapp_conversations SET last_message_at = unixepoch() WHERE id = ?')
        .run(conversation.id);
    }
  }

  // Load message history for this conversation
  const historyRows = db.prepare(
    'SELECT role, content FROM whatsapp_messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversation.id);
  const history = historyRows.map(r => ({ role: r.role, content: r.content }));

  // Get knowledge base
  const knowledgeItems = searchKnowledge(widget.id, text);

  // Generate AI response
  const response = await getChatResponseText(widget, knowledgeItems, history, text);

  // Send reply
  await sendTextMessage(phoneNumberId, from, response, conn.access_token);

  // Mark original message as read
  await markAsRead(phoneNumberId, messageId, conn.access_token).catch(() => {});

  // Persist messages (keep last 40)
  const userMsgId = uuidv4();
  const assistantMsgId = uuidv4();
  db.prepare(`
    INSERT INTO whatsapp_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)
  `).run(userMsgId, conversation.id, text);
  db.prepare(`
    INSERT INTO whatsapp_messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)
  `).run(assistantMsgId, conversation.id, response);

  // Prune old messages beyond 40
  const allMsgIds = db.prepare(
    'SELECT id FROM whatsapp_messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversation.id);
  if (allMsgIds.length > 40) {
    const toDelete = allMsgIds.slice(0, allMsgIds.length - 40);
    const placeholders = toDelete.map(() => '?').join(',');
    db.prepare(`DELETE FROM whatsapp_messages WHERE id IN (${placeholders})`)
      .run(...toDelete.map(r => r.id));
  }
}

module.exports = router;
