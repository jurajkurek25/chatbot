'use strict';

const https   = require('https');
const express = require('express');
const { getDb }      = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ECOMAIL_HOST = 'api2.ecomailapp.cz';

function ownsWidget(widgetId, userId) {
  return getDb().prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, userId);
}

/* Low-level HTTPS call to Ecomail API */
function ecomailReq({ apiKey, method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { key: apiKey, 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request({ hostname: ECOMAIL_HOST, path, method, headers }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ── GET /:widgetId/status ─────────────────────────────────────── */
router.get('/:widgetId/status', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  const w = getDb().prepare(
    'SELECT ecomail_api_key, ecomail_list_id, ecomail_list_name FROM widgets WHERE id = ?'
  ).get(req.params.widgetId);
  res.json({
    connected:  Boolean(w.ecomail_api_key && w.ecomail_list_id),
    list_id:    w.ecomail_list_id   || null,
    list_name:  w.ecomail_list_name || null,
    // never send the API key to the frontend
  });
});

/* ── POST /:widgetId/lists — fetch available lists for given API key ── */
router.post('/:widgetId/lists', async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  const { apiKey } = req.body;
  if (!apiKey?.trim()) return res.status(400).json({ error: 'API kľúč je povinný.' });
  try {
    const result = await ecomailReq({ apiKey: apiKey.trim(), method: 'GET', path: '/lists' });
    if (result.status === 401 || result.status === 403) {
      return res.status(400).json({ error: 'Neplatný API kľúč. Skontrolujte ho a skúste znova.' });
    }
    if (result.status !== 200) {
      return res.status(400).json({ error: `Ecomail vrátil chybu (${result.status}). Skúste neskôr.` });
    }
    const lists = Array.isArray(result.body)
      ? result.body.map(l => ({ id: String(l.id), name: l.name }))
      : [];
    res.json({ lists });
  } catch (err) {
    console.error('[ecomail/lists]', err.message);
    res.status(500).json({ error: 'Nepodarilo sa spojiť s Ecomailom.' });
  }
});

/* ── POST /:widgetId/connect — save API key + list after validation ── */
router.post('/:widgetId/connect', async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  const { apiKey, listId, listName } = req.body;
  if (!apiKey?.trim() || !listId) return res.status(400).json({ error: 'API kľúč a zoznam sú povinné.' });
  try {
    // Quick validation — just check that the key works
    const result = await ecomailReq({ apiKey: apiKey.trim(), method: 'GET', path: '/lists' });
    if (result.status === 401 || result.status === 403) {
      return res.status(400).json({ error: 'Neplatný API kľúč. Skontrolujte ho a skúste znova.' });
    }
    if (result.status !== 200) {
      return res.status(400).json({ error: `Ecomail vrátil chybu (${result.status}).` });
    }
    getDb().prepare(
      'UPDATE widgets SET ecomail_api_key = ?, ecomail_list_id = ?, ecomail_list_name = ? WHERE id = ?'
    ).run(apiKey.trim(), String(listId), listName || '', req.params.widgetId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ecomail/connect]', err.message);
    res.status(500).json({ error: 'Nepodarilo sa spojiť s Ecomailom.' });
  }
});

/* ── DELETE /:widgetId/disconnect ─────────────────────────────── */
router.delete('/:widgetId/disconnect', (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  getDb().prepare(
    'UPDATE widgets SET ecomail_api_key = NULL, ecomail_list_id = NULL, ecomail_list_name = NULL WHERE id = ?'
  ).run(req.params.widgetId);
  res.json({ ok: true });
});

/* ── POST /:widgetId/test — subscribe a test email ─────────────── */
router.post('/:widgetId/test', async (req, res) => {
  if (!ownsWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  const w = getDb().prepare('SELECT ecomail_api_key, ecomail_list_id FROM widgets WHERE id = ?').get(req.params.widgetId);
  if (!w.ecomail_api_key || !w.ecomail_list_id) {
    return res.status(400).json({ error: 'Ecomail nie je prepojený.' });
  }
  const { testEmail } = req.body;
  if (!testEmail?.trim()) return res.status(400).json({ error: 'Zadajte testovací email.' });
  try {
    const result = await ecomailReq({
      apiKey: w.ecomail_api_key,
      method: 'POST',
      path: `/lists/${w.ecomail_list_id}/subscribe`,
      body: {
        subscriber_data: {
          email: testEmail.trim(),
          name: 'Test lead (NeuraDesk)',
          tags: ['neuradesk-test'],
        },
        trigger_autoresponders: false,
        update_existing: true,
      },
    });
    if (result.status >= 200 && result.status < 300) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: `Ecomail vrátil chybu ${result.status}. Skontrolujte List ID.` });
    }
  } catch (err) {
    console.error('[ecomail/test]', err.message);
    res.status(500).json({ error: 'Nepodarilo sa spojiť s Ecomailom.' });
  }
});

/* ── subscribeLeadToEcomail — used internally from chat.js ────── */
async function subscribeLeadToEcomail({ apiKey, listId, email, name, tags = [] }) {
  try {
    const allTags = ['neuradesk-lead', ...tags].filter(Boolean);
    await ecomailReq({
      apiKey,
      method: 'POST',
      path: `/lists/${listId}/subscribe`,
      body: {
        subscriber_data: { email, name, tags: allTags },
        trigger_autoresponders: true,
        update_existing: true,
      },
    });
  } catch (err) {
    console.error('[ecomail/subscribe]', err.message);
  }
}

module.exports = router;
module.exports.subscribeLeadToEcomail = subscribeLeadToEcomail;
