'use strict';

const GRAPH = 'https://graph.facebook.com/v21.0';

/* ── Meta Graph API helper ─────────────────────────────────────── */
async function graphRequest(path, method = 'GET', params = {}, token = null) {
  const url = new URL(`${GRAPH}${path}`);

  let opts;
  if (method === 'GET') {
    if (token) params.access_token = token;
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    opts = { method };
  } else {
    if (token) params.access_token = token;
    opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    };
  }

  const r = await fetch(url.toString(), opts);
  const data = await r.json();
  if (data.error) {
    throw new Error(`Meta API: ${data.error.message} (code ${data.error.code})`);
  }
  return data;
}

/* ── OAuth token exchange ──────────────────────────────────────── */
async function exchangeCodeForToken(code, redirectUri) {
  return graphRequest('/oauth/access_token', 'GET', {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });
}

async function getLongLivedToken(shortToken) {
  return graphRequest('/oauth/access_token', 'GET', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: shortToken,
  });
}

/* ── Pages & Instagram accounts ───────────────────────────────── */
async function getPages(userToken) {
  return graphRequest('/me/accounts', 'GET', {
    fields: 'id,name,access_token,instagram_business_account',
  }, userToken);
}

async function getIgAccountDetails(igAccountId, pageToken) {
  return graphRequest(`/${igAccountId}`, 'GET', {
    fields: 'id,username,name,profile_picture_url,followers_count',
  }, pageToken);
}

/* ── Webhook subscription ──────────────────────────────────────── */
async function subscribePageToWebhook(pageId, pageToken) {
  return graphRequest(`/${pageId}/subscribed_apps`, 'POST', {
    subscribed_fields: 'messages,comments',
  }, pageToken);
}

/* ── Send Instagram DM ─────────────────────────────────────────── */
async function sendDM(igUserId, recipientIgsid, text, pageToken) {
  // Instagram DM limit: 1000 chars per message
  const chunks = splitText(text, 1000);
  for (const chunk of chunks) {
    await graphRequest(`/${igUserId}/messages`, 'POST', {
      recipient: { id: recipientIgsid },
      message: { text: chunk },
    }, pageToken);
  }
}

/* ── Helpers ───────────────────────────────────────────────────── */
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.slice(0, maxLen);
    // Try to cut at sentence boundary
    const lastDot = cut.lastIndexOf('. ');
    if (lastDot > maxLen * 0.6) cut = remaining.slice(0, lastDot + 1);
    parts.push(cut.trim());
    remaining = remaining.slice(cut.length).trim();
  }
  return parts;
}

module.exports = {
  exchangeCodeForToken,
  getLongLivedToken,
  getPages,
  getIgAccountDetails,
  subscribePageToWebhook,
  sendDM,
};
