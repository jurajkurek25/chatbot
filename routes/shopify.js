'use strict';

/**
 * Neoworkly – Shopify Integration
 *
 * Routes:
 *   GET  /shopify/install           — start OAuth (redirect to Shopify)
 *   GET  /shopify/callback          — OAuth callback (exchange code → token)
 *   GET  /shopify/setup             — setup UI page (served as HTML)
 *   GET  /api/shopify/status           — connection status for current shop
 *   GET  /api/shopify/widgets          — list user's Neoworkly widgets
 *   POST /api/shopify/link-account     — link Neoworkly account to shop
 *   POST /api/shopify/scan             — batch-scan shop content → knowledge base
 *   POST /api/shopify/inject           — inject/update ScriptTag on shop
 *   POST /api/shopify/toggle-embed     — enable/disable widget on shop
 *   DELETE /api/shopify/disconnect     — remove connection
 *   POST /api/shopify/webhook/uninstall — Shopify sends this when app removed
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const SHOPIFY_API_VERSION = '2024-01';

// ── Env vars (set in .env) ────────────────────────────────────────
function apiKey()    { return process.env.SHOPIFY_API_KEY    || ''; }
function apiSecret() { return process.env.SHOPIFY_API_SECRET || ''; }
function appUrl()    { return (process.env.APP_URL || 'https://neoworkly.com').replace(/\/$/, ''); }

// ── Shopify REST helper ───────────────────────────────────────────
function shopifyRequest(shop, token, method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: shop,
      path: `/admin/api/${SHOPIFY_API_VERSION}${endpoint}`,
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// paginate through all items, returns flat array
async function shopifyGetAll(shop, token, endpoint, listKey, limit = 50) {
  const items = [];
  let url = `${endpoint}?limit=${limit}`;

  while (url) {
    const res = await shopifyRequest(shop, token, 'GET', url);
    if (res.status !== 200 || !res.body[listKey]) break;
    items.push(...res.body[listKey]);

    // Cursor-based pagination (Link header not easily accessible with https.request;
    // fall back to offset for stores < 250 items, use page_info for large stores)
    const fetched = res.body[listKey].length;
    if (fetched < limit) break;

    // Simple offset pagination fallback (works for most stores)
    const lastId = items[items.length - 1]?.id;
    if (!lastId) break;
    url = `${endpoint}?limit=${limit}&since_id=${lastId}`;
  }

  return items;
}

// ── HMAC verification ────────────────────────────────────────────
function verifyHmac(query) {
  const secret = apiSecret();
  if (!secret) return true; // skip if not configured (dev mode)
  const { hmac, ...params } = query;
  if (!hmac) return false;
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const hash = crypto.createHmac('sha256', secret).update(message).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac)); }
  catch { return false; }
}

function verifyWebhookHmac(rawBody, signature) {
  const secret = apiSecret();
  if (!secret) return true;
  const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch { return false; }
}

// ── Sanitize shop domain ─────────────────────────────────────────
function sanitizeShop(shop) {
  if (!shop || typeof shop !== 'string') return null;
  const s = shop.trim().toLowerCase().replace(/^https?:\/\//, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(s)) return null;
  return s;
}

// ═══════════════════════════════════════════════════════════════
// STEP 1 – OAuth: Install redirect
// GET /shopify/install?shop=mystore.myshopify.com
// ═══════════════════════════════════════════════════════════════
router.get('/install', (req, res) => {
  const shop = sanitizeShop(req.query.shop);
  if (!shop) return res.status(400).send('Neplatná shop URL. Použite formát: mystore.myshopify.com');
  if (!apiKey()) return res.status(500).send('SHOPIFY_API_KEY nie je nastavené v .env');

  const nonce = crypto.randomBytes(16).toString('hex');
  const scopes = 'read_products,read_content,write_script_tags';
  const redirectUri = `${appUrl()}/shopify/callback`;

  // Save nonce to DB (overwrite if exists)
  const db = getDb();
  const existing = db.prepare('SELECT id FROM shopify_connections WHERE shop = ?').get(shop);
  if (existing) {
    db.prepare('UPDATE shopify_connections SET nonce = ? WHERE shop = ?').run(nonce, shop);
  } else {
    db.prepare('INSERT INTO shopify_connections (id, shop, access_token, nonce) VALUES (?,?,?,?)')
      .run(uuidv4(), shop, '', nonce);
  }

  const authUrl = `https://${shop}/admin/oauth/authorize`
    + `?client_id=${apiKey()}`
    + `&scope=${encodeURIComponent(scopes)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${nonce}`;

  res.redirect(authUrl);
});

// ═══════════════════════════════════════════════════════════════
// STEP 2 – OAuth: Callback
// GET /shopify/callback?shop=…&code=…&state=…&hmac=…
// ═══════════════════════════════════════════════════════════════
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const shop = sanitizeShop(req.query.shop);

  if (!shop) return res.status(400).send('Neplatná shop URL.');
  if (!verifyHmac(req.query)) return res.status(403).send('Neplatný HMAC podpis.');

  const db = getDb();
  const conn = db.prepare('SELECT id, nonce FROM shopify_connections WHERE shop = ?').get(shop);

  if (!conn || conn.nonce !== state) {
    return res.status(403).send('Neplatný state parameter. Skúste inštaláciu znova.');
  }

  // Exchange code for permanent access token
  const tokenRes = await shopifyRequest(shop, '', 'POST', '/oauth/access_token', {
    client_id: apiKey(),
    client_secret: apiSecret(),
    code,
  }).catch(() => null);

  if (!tokenRes || tokenRes.status !== 200 || !tokenRes.body?.access_token) {
    return res.status(500).send('Nepodarilo sa získať access token od Shopify.');
  }

  const accessToken = tokenRes.body.access_token;

  // Fetch shop info
  const shopInfo = await shopifyRequest(shop, accessToken, 'GET', '/shop.json').catch(() => null);
  const shopName  = shopInfo?.body?.shop?.name  || shop;
  const shopEmail = shopInfo?.body?.shop?.email || '';

  db.prepare(`
    UPDATE shopify_connections
    SET access_token = ?, shop_name = ?, shop_email = ?, nonce = NULL
    WHERE shop = ?
  `).run(accessToken, shopName, shopEmail, shop);

  res.redirect(`/shopify/setup?shop=${encodeURIComponent(shop)}`);
});

// ═══════════════════════════════════════════════════════════════
// STEP 3 – Setup page (HTML)
// GET /shopify/setup?shop=…
// ═══════════════════════════════════════════════════════════════
router.get('/setup', (req, res) => {
  const shop = sanitizeShop(req.query.shop);
  if (!shop) return res.status(400).send('Chýba shop parameter.');

  const db   = getDb();
  const conn = db.prepare('SELECT id FROM shopify_connections WHERE shop = ?').get(shop);
  if (!conn) return res.redirect(`/shopify/install?shop=${encodeURIComponent(shop)}`);

  res.sendFile(path.join(__dirname, '..', 'public', 'shopify.html'));
});

// ═══════════════════════════════════════════════════════════════
// API: GET /api/shopify/status?shop=…
// Returns connection + scan status for the shop
// ═══════════════════════════════════════════════════════════════
router.get('/status', (req, res) => {
  const shop = sanitizeShop(req.query.shop);
  if (!shop) return res.status(400).json({ error: 'Chýba shop.' });

  const db   = getDb();
  const conn = db.prepare('SELECT shop_name, shop_email, neoworkly_user_id, widget_id, scan_done, script_tag_id FROM shopify_connections WHERE shop = ?').get(shop);
  if (!conn) return res.status(404).json({ error: 'Shop nie je prepojený.' });

  let widgetName = null;
  if (conn.widget_id) {
    const w = db.prepare('SELECT name FROM widgets WHERE id = ?').get(conn.widget_id);
    widgetName = w?.name || null;
  }

  res.json({
    shop,
    shop_name:   conn.shop_name,
    shop_email:  conn.shop_email,
    linked:      Boolean(conn.neoworkly_user_id),
    widget_id:   conn.widget_id,
    widget_name: widgetName,
    scan_done:   Boolean(conn.scan_done),
    embed_active: Boolean(conn.script_tag_id),
  });
});

// ═══════════════════════════════════════════════════════════════
// API: POST /api/shopify/link-account
// Links a Neoworkly account to the Shopify shop
// Body: { shop, neoworkly_token, widget_id? }
// ═══════════════════════════════════════════════════════════════
router.post('/link-account', requireAuth, (req, res) => {
  const shop = sanitizeShop(req.body.shop);
  if (!shop) return res.status(400).json({ error: 'Chýba shop.' });

  const db   = getDb();
  const conn = db.prepare('SELECT id FROM shopify_connections WHERE shop = ?').get(shop);
  if (!conn) return res.status(404).json({ error: 'Shop nie je prepojený cez OAuth.' });

  let { widget_id, create_widget } = req.body;

  // Create new widget if requested
  if (create_widget || !widget_id) {
    const conn2 = db.prepare('SELECT shop_name FROM shopify_connections WHERE shop = ?').get(shop);
    const wName = conn2?.shop_name ? `${conn2.shop_name} – Shopify` : `${shop} – Shopify`;
    const newId = uuidv4();
    db.prepare(`
      INSERT INTO widgets (id, user_id, name, bot_name, welcome_message, goals, cta_type)
      VALUES (?, ?, ?, 'Asistent', 'Ahoj! Ako vám môžem pomôcť?', ?, 'contact')
    `).run(newId, req.userId, wName, `Chatbot pre Shopify obchod ${wName}.`);
    widget_id = newId;
  } else {
    // Verify ownership
    const w = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widget_id, req.userId);
    if (!w) return res.status(403).json({ error: 'Widget nenájdený.' });
  }

  db.prepare('UPDATE shopify_connections SET neoworkly_user_id = ?, widget_id = ? WHERE shop = ?')
    .run(req.userId, widget_id, shop);

  const widget = db.prepare('SELECT id, name FROM widgets WHERE id = ?').get(widget_id);
  res.json({ widget_id, widget_name: widget.name });
});

// ═══════════════════════════════════════════════════════════════
// API: GET /api/shopify/widgets?shop=…
// Returns user's widgets (for selection dropdown)
// ═══════════════════════════════════════════════════════════════
router.get('/widgets', requireAuth, (req, res) => {
  const db      = getDb();
  const widgets = db.prepare('SELECT id, name FROM widgets WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json(widgets);
});

// ═══════════════════════════════════════════════════════════════
// API: POST /api/shopify/scan
// Scans a batch of Shopify content → Neoworkly knowledge base
// Body: { shop, type: 'products'|'pages'|'blogs', offset }
// ═══════════════════════════════════════════════════════════════
router.post('/scan', requireAuth, async (req, res) => {
  const shop   = sanitizeShop(req.body.shop);
  const type   = req.body.type;
  const offset = Math.max(0, parseInt(req.body.offset) || 0);
  const BATCH  = 10;

  if (!shop) return res.status(400).json({ error: 'Chýba shop.' });

  const db   = getDb();
  const conn = db.prepare('SELECT access_token, widget_id FROM shopify_connections WHERE shop = ? AND neoworkly_user_id = ?').get(shop, req.userId);
  if (!conn || !conn.widget_id) return res.status(404).json({ error: 'Shop nie je prepojený.' });

  const { access_token: token, widget_id } = conn;

  // Helper: insert knowledge item
  const insertKnowledge = db.prepare(`
    INSERT OR IGNORE INTO knowledge_items (id, widget_id, title, content, source_type)
    VALUES (?, ?, ?, ?, 'url')
  `);

  // Helper: insert product card
  const insertProduct = db.prepare(`
    INSERT INTO products (id, widget_id, name, type, description, price, currency, landing_url, cta_text, tags, active)
    VALUES (?, ?, ?, 'physical', ?, ?, ?, ?, 'Zobraziť produkt', ?, 1)
  `);

  let imported = 0;
  let has_more = false;
  const errors = [];

  try {
    if (type === 'products') {
      const res2 = await shopifyRequest(shop, token, 'GET',
        `/products.json?limit=${BATCH}&fields=id,title,body_html,handle,product_type,variants,images,status${offset ? `&since_id=${offset}` : ''}`
      );
      const products = res2.body?.products || [];
      has_more = products.length === BATCH;

      for (const p of products) {
        if (p.status !== 'active') continue;
        const desc  = stripHtml(p.body_html || '');
        const price = p.variants?.[0]?.price ? parseFloat(p.variants[0].price) : null;
        const currency = 'EUR'; // Shopify stores use their own currency; we default to EUR
        const url   = `https://${shop}/products/${p.handle}`;
        const cats  = p.product_type || '';

        const knText = [p.title, desc, price ? `Cena: ${price} EUR` : '', cats ? `Typ: ${cats}` : '']
          .filter(Boolean).join('\n\n').slice(0, 10000);

        if (knText.length > 20) {
          try {
            insertKnowledge.run(uuidv4(), widget_id, p.title, knText);
            imported++;
          } catch { /* duplicate */ }
        }

        // Also add as product card
        try {
          insertProduct.run(uuidv4(), widget_id, p.title, desc.slice(0, 500), price, currency, url, cats);
        } catch { /* ignore */ }
      }

      // Return last product ID as next offset
      const lastId = products[products.length - 1]?.id || null;
      return res.json({ imported, has_more, next_offset: lastId, errors });
    }

    if (type === 'pages') {
      const res2 = await shopifyRequest(shop, token, 'GET',
        `/pages.json?limit=${BATCH}&fields=id,title,body_html${offset ? `&since_id=${offset}` : ''}`
      );
      const pages = res2.body?.pages || [];
      has_more = pages.length === BATCH;

      for (const pg of pages) {
        const content = stripHtml(pg.body_html || '');
        if (content.length < 30) continue;
        try {
          insertKnowledge.run(uuidv4(), widget_id, pg.title || 'Stránka', content.slice(0, 10000));
          imported++;
        } catch { /* duplicate */ }
      }

      const lastId = pages[pages.length - 1]?.id || null;
      return res.json({ imported, has_more, next_offset: lastId, errors });
    }

    if (type === 'blogs') {
      // First get all blogs
      const blogsRes = await shopifyRequest(shop, token, 'GET', '/blogs.json?fields=id,title');
      const blogs    = blogsRes.body?.blogs || [];

      let articleOffset = offset;
      let articlesImported = 0;
      let articlesHasMore  = false;
      let lastArticleId    = null;

      for (const blog of blogs) {
        const artRes = await shopifyRequest(shop, token, 'GET',
          `/blogs/${blog.id}/articles.json?limit=${BATCH}&fields=id,title,body_html,summary_html${articleOffset ? `&since_id=${articleOffset}` : ''}`
        );
        const articles = artRes.body?.articles || [];
        articlesHasMore = articles.length === BATCH;

        for (const art of articles) {
          const content = stripHtml(art.body_html || art.summary_html || '');
          if (content.length < 30) continue;
          try {
            insertKnowledge.run(uuidv4(), widget_id, art.title || 'Článok', content.slice(0, 10000));
            articlesImported++;
          } catch { /* duplicate */ }
        }

        if (articles.length) lastArticleId = articles[articles.length - 1]?.id;
        if (articlesHasMore) break; // process one blog per batch call
      }

      return res.json({ imported: articlesImported, has_more: articlesHasMore, next_offset: lastArticleId, errors });
    }

    res.status(400).json({ error: 'Neznámy typ skenovania.' });

  } catch (err) {
    console.error('Shopify scan error:', err);
    res.status(500).json({ error: 'Chyba pri skenovaní: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// API: POST /api/shopify/inject
// Creates a ScriptTag on the Shopify store (auto-injects widget)
// Body: { shop }
// ═══════════════════════════════════════════════════════════════
router.post('/inject', requireAuth, async (req, res) => {
  const shop = sanitizeShop(req.body.shop);
  if (!shop) return res.status(400).json({ error: 'Chýba shop.' });

  const db   = getDb();
  const conn = db.prepare('SELECT access_token, widget_id, script_tag_id FROM shopify_connections WHERE shop = ? AND neoworkly_user_id = ?').get(shop, req.userId);
  if (!conn?.widget_id) return res.status(404).json({ error: 'Shop nie je prepojený.' });

  const scriptSrc = `${appUrl()}/shopify-widget-loader.js?widget=${encodeURIComponent(conn.widget_id)}`;

  // Delete old script tag if exists
  if (conn.script_tag_id) {
    await shopifyRequest(shop, conn.access_token, 'DELETE', `/script_tags/${conn.script_tag_id}.json`).catch(() => {});
  }

  const tagRes = await shopifyRequest(shop, conn.access_token, 'POST', '/script_tags.json', {
    script_tag: {
      event: 'onload',
      src: scriptSrc,
      display_scope: 'online_store',
    },
  });

  if (tagRes.status !== 201 || !tagRes.body?.script_tag?.id) {
    return res.status(500).json({ error: 'Nepodarilo sa vložiť script tag.', detail: tagRes.body });
  }

  const tagId = tagRes.body.script_tag.id;
  db.prepare('UPDATE shopify_connections SET script_tag_id = ?, scan_done = 1 WHERE shop = ?').run(String(tagId), shop);

  res.json({ ok: true, script_tag_id: tagId });
});

// ═══════════════════════════════════════════════════════════════
// API: POST /api/shopify/toggle-embed
// Body: { shop, enabled: true/false }
// ═══════════════════════════════════════════════════════════════
router.post('/toggle-embed', requireAuth, async (req, res) => {
  const shop    = sanitizeShop(req.body.shop);
  const enabled = Boolean(req.body.enabled);
  if (!shop) return res.status(400).json({ error: 'Chýba shop.' });

  const db   = getDb();
  const conn = db.prepare('SELECT access_token, widget_id, script_tag_id FROM shopify_connections WHERE shop = ? AND neoworkly_user_id = ?').get(shop, req.userId);
  if (!conn) return res.status(404).json({ error: 'Shop nie je prepojený.' });

  if (!enabled && conn.script_tag_id) {
    await shopifyRequest(shop, conn.access_token, 'DELETE', `/script_tags/${conn.script_tag_id}.json`).catch(() => {});
    db.prepare('UPDATE shopify_connections SET script_tag_id = NULL WHERE shop = ?').run(shop);
    return res.json({ ok: true, embed_active: false });
  }

  if (enabled && !conn.script_tag_id) {
    // Re-inject
    return res.redirect(307, req.baseUrl + '/inject');
  }

  res.json({ ok: true, embed_active: Boolean(conn.script_tag_id) });
});

// ═══════════════════════════════════════════════════════════════
// API: DELETE /api/shopify/disconnect
// Body: { shop }
// ═══════════════════════════════════════════════════════════════
router.delete('/disconnect', requireAuth, async (req, res) => {
  const shop = sanitizeShop(req.body?.shop || req.query.shop);
  if (!shop) return res.status(400).json({ error: 'Chýba shop.' });

  const db   = getDb();
  const conn = db.prepare('SELECT access_token, script_tag_id FROM shopify_connections WHERE shop = ? AND neoworkly_user_id = ?').get(shop, req.userId);
  if (!conn) return res.status(404).json({ error: 'Pripojenie nenájdené.' });

  // Remove script tag from Shopify
  if (conn.script_tag_id) {
    await shopifyRequest(shop, conn.access_token, 'DELETE', `/script_tags/${conn.script_tag_id}.json`).catch(() => {});
  }

  db.prepare('DELETE FROM shopify_connections WHERE shop = ?').run(shop);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// Webhook: POST /api/shopify/webhook/uninstall
// Shopify calls this when merchant uninstalls the app
// ═══════════════════════════════════════════════════════════════
router.post('/webhook/uninstall', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-shopify-hmac-sha256'] || '';
  const shop      = req.headers['x-shopify-shop-domain'] || '';

  if (!verifyWebhookHmac(req.body, signature)) {
    return res.status(401).send('Unauthorized');
  }

  const db = getDb();
  db.prepare('DELETE FROM shopify_connections WHERE shop = ?').run(sanitizeShop(shop) || shop);
  res.status(200).send('OK');
});

// ═══════════════════════════════════════════════════════════════
// Widget loader script (served to Shopify storefronts)
// GET /shopify-widget-loader.js?widget=WIDGET_ID
// ═══════════════════════════════════════════════════════════════
router.get('/widget-loader.js', (req, res) => {
  const widgetId = req.query.widget || '';
  if (!widgetId) return res.status(400).send('// Missing widget ID');

  const origin = appUrl();
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`
(function(){
  if(window.__neoworklyLoaded) return;
  window.__neoworklyLoaded = true;
  window.NeoworklyConfig = { widgetId: ${JSON.stringify(widgetId)} };
  var s = document.createElement('script');
  s.src = ${JSON.stringify(origin + '/widget.js')};
  s.async = true;
  document.head.appendChild(s);
})();
`.trim());
});

// ── HTML strip helper ─────────────────────────────────────────
function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

module.exports = router;
