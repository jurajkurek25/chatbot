'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { getDb, searchKnowledge } = require('../db/database');

function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET || process.env.FB_APP_SECRET;
  if (!secret || !req.rawBody) return true;
  const sig = req.headers['x-hub-signature-256'] || '';
  if (!sig.startsWith('sha256=')) return false;
  const hash = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash)); } catch { return false; }
}
const {
  exchangeCodeForToken,
  getLongLivedToken,
  getPages,
  getIgAccountDetails,
  subscribePageToWebhook,
  sendDM,
  graphRequestDirect,
} = require('../services/instagram');
const { getChatResponseText } = require('../services/claude');

const router = express.Router();

const META_SCOPES = [
  'instagram_manage_messages',
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
].join(',');

/* ── GET /api/instagram/auth-url/:widgetId ─────────────────────── */
router.get('/auth-url/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  if (!process.env.META_APP_ID) {
    return res.status(503).json({ error: 'META_APP_ID nie je nastavené.' });
  }

  const redirectUri = `${process.env.BASE_URL}/api/instagram/callback`;
  const state = Buffer.from(JSON.stringify({
    widgetId: req.params.widgetId,
    userId: req.userId,
  })).toString('base64url');

  const url = 'https://www.facebook.com/v21.0/dialog/oauth?' + new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: redirectUri,
    scope: META_SCOPES,
    state,
    response_type: 'code',
  }).toString();

  res.json({ url });
});

/* ── GET /api/instagram/callback ───────────────────────────────── */
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code || !state) {
    return res.redirect('/dashboard?ig_error=cancelled');
  }

  let widgetId, userId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
    widgetId = decoded.widgetId;
    userId = decoded.userId;
  } catch {
    return res.redirect('/dashboard?ig_error=state');
  }

  const redirectUri = `${process.env.BASE_URL}/api/instagram/callback`;

  try {
    // 1. Exchange code for short-lived token
    const shortData = await exchangeCodeForToken(code, redirectUri);
    const shortToken = shortData.access_token;

    console.log('[instagram] Short-lived token received, trying /me/accounts...');

    // 2. Get pages with short-lived token first (preserves all granted scopes)
    let pagesData = await getPages(shortToken);
    let pages = pagesData.data || [];

    console.log('[instagram] Pages with short token:', pages.length, JSON.stringify(pagesData).slice(0, 1000));

    // 3. Exchange for long-lived token
    const longData = await getLongLivedToken(shortToken);
    const userToken = longData.access_token;

    // 4. If short token gave no pages, try long-lived token as fallback
    if (pages.length === 0) {
      console.log('[instagram] No pages with short token, trying long-lived token...');
      pagesData = await getPages(userToken);
      pages = pagesData.data || [];
      console.log('[instagram] Pages with long token:', pages.length, JSON.stringify(pagesData).slice(0, 1000));
    }

    // 5. Also log direct /me info for debugging
    try {
      const meData = await graphRequestDirect(`/me?fields=id,name,instagram_business_account,connected_instagram_account`, shortToken);
      console.log('[instagram] /me direct:', JSON.stringify(meData));
    } catch(e) {
      console.log('[instagram] /me direct failed:', e.message);
    }

    // 3. Find a page that has an Instagram Business or Creator account
    let chosenPage = null;
    let igAccountId = null;

    for (const page of pages) {
      // Business account
      if (page.instagram_business_account?.id) {
        chosenPage = page;
        igAccountId = page.instagram_business_account.id;
        break;
      }
      // Creator account
      if (page.connected_instagram_account?.id) {
        chosenPage = page;
        igAccountId = page.connected_instagram_account.id;
        break;
      }
    }

    if (pages.length === 0) {
      console.error('[instagram] OAuth returned 0 pages. igFromUser:', JSON.stringify(igFromUser));
      return res.redirect('/dashboard?ig_error=no_pages');
    }

    if (!chosenPage || !igAccountId) {
      console.error('[instagram] Pages found but none linked to IG. Pages:', JSON.stringify(pages.map(p => ({
        id: p.id, name: p.name,
        has_business: !!p.instagram_business_account,
        has_creator: !!p.connected_instagram_account,
      }))));
      return res.redirect('/dashboard?ig_error=no_ig_account');
    }

    // 4. Get Instagram account details (username, etc.)
    const igDetails = await getIgAccountDetails(igAccountId, chosenPage.access_token);

    // 5. Subscribe page to Instagram webhooks
    await subscribePageToWebhook(chosenPage.id, chosenPage.access_token);

    // 6. Save / upsert connection
    const db = getDb();

    // Verify widget ownership at callback time (prevents TOCTOU with state manipulation)
    const ownedWidget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId);
    if (!ownedWidget) return res.redirect('/dashboard?ig_error=invalid_widget');

    const existing = db.prepare('SELECT id FROM instagram_connections WHERE widget_id = ?').get(widgetId);
    const connId = existing?.id || uuidv4();

    db.prepare(`
      INSERT INTO instagram_connections
        (id, widget_id, ig_user_id, ig_username, page_id, page_name, page_access_token)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(widget_id) DO UPDATE SET
        ig_user_id = excluded.ig_user_id,
        ig_username = excluded.ig_username,
        page_id = excluded.page_id,
        page_name = excluded.page_name,
        page_access_token = excluded.page_access_token,
        connected_at = unixepoch()
    `).run(connId, widgetId, igAccountId, igDetails.username || null,
           chosenPage.id, chosenPage.name, chosenPage.access_token);

    res.redirect('/dashboard?ig_connected=1');
  } catch (err) {
    console.error('[instagram] OAuth error:', err.message);
    res.redirect('/dashboard?ig_error=oauth');
  }
});

/* ── GET /api/instagram/webhook — Meta webhook verification ─────── */
router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('[instagram] Webhook verified by Meta.');
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

/* ── POST /api/instagram/webhook — incoming events ──────────────── */
router.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    const igUserId = entry.id;

    // Incoming DMs (messaging array)
    for (const msg of entry.messaging || []) {
      if (msg.message && !msg.message.is_echo) {
        handleIncomingDM(igUserId, msg).catch(e =>
          console.error('[instagram] DM handler error:', e.message)
        );
      }
    }

    // Comments (changes array)
    for (const change of entry.changes || []) {
      if (change.field === 'comments') {
        handleComment(igUserId, change.value).catch(e =>
          console.error('[instagram] Comment handler error:', e.message)
        );
      }
    }
  }
});

/* ── Comment keyword trigger ────────────────────────────────────── */
async function handleComment(igUserId, commentData) {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM instagram_connections WHERE ig_user_id = ?').get(igUserId);
  if (!conn) return;

  const keywords = JSON.parse(conn.keyword_triggers || '[]');
  if (!keywords.length) return;

  const commentText = (commentData.text || '').toLowerCase().trim();
  const matched = keywords.some(kw => commentText.includes(kw.toLowerCase().trim()));
  if (!matched) return;

  const senderId = commentData.from?.id;
  if (!senderId || senderId === igUserId) return; // ignore own comments

  // Only trigger once per user (check if session exists)
  const existingSession = db.prepare(
    'SELECT id FROM instagram_dm_sessions WHERE connection_id = ? AND igsid = ?'
  ).get(conn.id, senderId);
  if (existingSession) return;

  // Create session
  const sessionId = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO instagram_dm_sessions (id, connection_id, igsid, sender_username, history)
    VALUES (?, ?, ?, ?, '[]')
  `).run(sessionId, conn.id, senderId, commentData.from?.username || null);

  // Welcome DM
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(conn.widget_id);
  if (!widget) return;

  const welcomeMsg = conn.dm_welcome_msg ||
    `Ahoj! 👋 Videl som tvoj komentár. Som tu, ak máš nejaké otázky – napíš mi čo ťa zaujíma!`;

  await sendDM(igUserId, senderId, welcomeMsg, conn.page_access_token);

  // Save initial message to history
  db.prepare(`UPDATE instagram_dm_sessions SET history = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(JSON.stringify([{ role: 'assistant', content: welcomeMsg }]), sessionId);
}

/* ── Ongoing DM conversation ────────────────────────────────────── */
async function handleIncomingDM(igUserId, msgData) {
  const db = getDb();
  const conn = db.prepare('SELECT * FROM instagram_connections WHERE ig_user_id = ?').get(igUserId);
  if (!conn) return;

  const senderId = msgData.sender?.id;
  const text = msgData.message?.text?.trim();
  if (!senderId || !text) return;

  // Get or create session
  let session = db.prepare(
    'SELECT * FROM instagram_dm_sessions WHERE connection_id = ? AND igsid = ?'
  ).get(conn.id, senderId);

  if (!session) {
    const sessionId = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO instagram_dm_sessions (id, connection_id, igsid, history)
      VALUES (?, ?, ?, '[]')
    `).run(sessionId, conn.id, senderId);
    session = db.prepare('SELECT * FROM instagram_dm_sessions WHERE id = ?').get(sessionId);
  }

  const history = JSON.parse(session.history || '[]');

  // Fetch widget + knowledge
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(conn.widget_id);
  if (!widget) return;

  const knowledgeItems = searchKnowledge(widget.id, text);

  // Generate response
  const response = await getChatResponseText(widget, knowledgeItems, history, text);

  // Send DM
  await sendDM(igUserId, senderId, response, conn.page_access_token);

  // Update history (keep last 20 messages)
  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: response });
  const trimmed = history.slice(-20);

  db.prepare(`
    UPDATE instagram_dm_sessions SET history = ?, updated_at = unixepoch() WHERE id = ?
  `).run(JSON.stringify(trimmed), session.id);
}

/* ── GET /api/instagram/status/:widgetId ───────────────────────── */
router.get('/status/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const conn = db.prepare(`
    SELECT ig_username, page_name, keyword_triggers, dm_welcome_msg, connected_at
    FROM instagram_connections WHERE widget_id = ?
  `).get(req.params.widgetId);

  if (!conn) return res.json({ connected: false });

  // Recent DM sessions stats
  const sessionCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM instagram_dm_sessions
    WHERE connection_id = (SELECT id FROM instagram_connections WHERE widget_id = ?)
  `).get(req.params.widgetId)?.cnt || 0;

  res.json({
    connected: true,
    ig_username: conn.ig_username,
    page_name: conn.page_name,
    keyword_triggers: JSON.parse(conn.keyword_triggers || '[]'),
    dm_welcome_msg: conn.dm_welcome_msg || '',
    connected_at: conn.connected_at,
    dm_sessions: sessionCount,
  });
});

/* ── PUT /api/instagram/settings/:widgetId ─────────────────────── */
router.put('/settings/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const conn = db.prepare('SELECT id FROM instagram_connections WHERE widget_id = ?').get(req.params.widgetId);
  if (!conn) return res.status(404).json({ error: 'Instagram nie je prepojený.' });

  const { keyword_triggers, dm_welcome_msg } = req.body;
  if (!Array.isArray(keyword_triggers)) {
    return res.status(400).json({ error: 'keyword_triggers musí byť pole.' });
  }

  // Sanitize keywords: lowercase, trim, max 20 chars each, max 20 keywords
  const cleaned = keyword_triggers
    .map(k => String(k).trim().toLowerCase().slice(0, 30))
    .filter(Boolean)
    .slice(0, 20);

  db.prepare(`
    UPDATE instagram_connections
    SET keyword_triggers = ?, dm_welcome_msg = ?
    WHERE widget_id = ?
  `).run(JSON.stringify(cleaned), (dm_welcome_msg || '').slice(0, 500) || null, req.params.widgetId);

  res.json({ ok: true });
});

/* ── DELETE /api/instagram/disconnect/:widgetId ────────────────── */
router.delete('/disconnect/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?')
    .get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  db.prepare('DELETE FROM instagram_connections WHERE widget_id = ?').run(req.params.widgetId);
  res.json({ ok: true });
});

module.exports = router;
