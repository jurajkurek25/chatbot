'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const MAX_PAGES       = 20;
const TIMEOUT_MS      = 8000;
const MAX_BODY_BYTES  = 300 * 1024; // 300 KB per page
const MAX_CONTENT_LEN = 6000;       // chars stored per page
const CRAWL_DELAY_MS  = 150;        // polite delay between requests

/* ── HTTP fetch ─────────────────────────────────────────────── */
// opts.xml accepts XML responses (sitemaps, product feeds); opts.maxBytes caps the body
function fetchPage(rawUrl, redirects = 0, opts = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, {
      headers: {
        'User-Agent': 'NeoworklyBot/1.0 (knowledge-scanner)',
        'Accept': opts.xml ? 'application/xml,text/xml,*/*' : 'text/html,application/xhtml+xml',
        'Accept-Language': 'sk,cs,en',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, rawUrl).href;
          res.resume();
          resolve(fetchPage(next, redirects + 1, opts));
        } catch { reject(new Error('Bad redirect')); }
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const ct = res.headers['content-type'] || '';
      if (!(opts.xml ? /xml|text\/plain/.test(ct) : ct.includes('text/html'))) { res.resume(); return reject(new Error(opts.xml ? 'Not XML' : 'Not HTML')); }

      const maxBytes = opts.maxBytes || MAX_BODY_BYTES;
      let body = '', total = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        total += Buffer.byteLength(chunk);
        body += chunk;
        // Oversized: keep what we have (destroying alone would leave the promise pending)
        if (total > maxBytes) { resolve(body); req.destroy(); }
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ── HTML → text ────────────────────────────────────────────── */
function extractContent(html, pageUrl) {
  // Remove noisy blocks
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Title
  const titleM = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  let title = titleM ? titleM[1].trim() : '';
  if (!title) {
    const h1m = cleaned.match(/<h1[^>]*>([^<]{1,200})<\/h1>/i);
    title = h1m ? h1m[1].replace(/<[^>]+>/g, '').trim() : new URL(pageUrl).pathname;
  }

  // Meta description
  const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})/i)
              || html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
  const desc = descM ? descM[1].trim() : '';

  // Plain text
  const text = cleaned
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const content = [desc, text].filter(Boolean).join('\n\n').slice(0, MAX_CONTENT_LEN);
  return { title: title.slice(0, 200), content };
}

/* ── Extract same-domain links ──────────────────────────────── */
const SKIP_EXT = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|doc|docx|xls|xlsx|ppt|pptx|css|js|xml|json|ico|woff|woff2|ttf|eot|mp4|mp3|avi|mov)(\?|$)/i;

function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.hostname !== base.hostname) continue;
      if (!abs.protocol.startsWith('http')) continue;
      if (SKIP_EXT.test(abs.pathname)) continue;
      abs.hash = '';
      abs.search = '';
      links.add(abs.href);
    } catch {}
  }
  return [...links];
}

/* ── Main crawl function ────────────────────────────────────── */
async function crawlSite(startUrl, maxPages = MAX_PAGES) {
  const base = new URL(startUrl);
  // Normalise start URL
  const seed = (() => { const u = new URL(startUrl); u.hash = ''; u.search = ''; return u.href; })();

  const visited  = new Set([seed]);
  const queue    = [seed];
  const results  = []; // {title, content, url}

  while (queue.length > 0 && results.length < maxPages) {
    const url = queue.shift();

    try {
      const html = await fetchPage(url);
      const { title, content } = extractContent(html, url);

      if (content.trim().length > 100) {
        results.push({ url, title, content });
      }

      // Add discovered links to queue
      const links = extractLinks(html, url);
      for (const link of links) {
        if (!visited.has(link) && visited.size < maxPages * 3) {
          visited.add(link);
          queue.push(link);
        }
      }
    } catch (err) {
      // Skip pages that fail silently
    }

    if (queue.length > 0 && CRAWL_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
    }
  }

  return results;
}

/* ── Sitemap import ─────────────────────────────────────────── */
function xmlText(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s{2,}/g, ' ').trim();
}

async function importSitemap(sitemapUrl, maxPages = MAX_PAGES) {
  let xml = await fetchPage(sitemapUrl, 0, { xml: true, maxBytes: 5 * 1024 * 1024 });
  let locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => xmlText(m[1]));
  // Sitemap index → follow the first child sitemap
  if (/<sitemapindex/i.test(xml) && locs.length) {
    xml = await fetchPage(locs[0], 0, { xml: true, maxBytes: 5 * 1024 * 1024 });
    locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => xmlText(m[1]));
  }
  const results = [];
  for (const url of locs.filter(u => !SKIP_EXT.test(u))) {
    if (results.length >= maxPages) break;
    try {
      const { title, content } = extractContent(await fetchPage(url), url);
      if (content.trim().length > 100) results.push({ url, title, content });
    } catch { /* skip */ }
    if (CRAWL_DELAY_MS > 0) await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
  }
  return results;
}

/* ── Product / XML feed import (Heureka, Google Shopping, RSS, Atom) ── */
const FEED_ITEM = /<(SHOPITEM|item|entry|product|offer)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const FEED_TITLE = ['PRODUCTNAME', 'PRODUCT', 'g:title', 'title', 'name'];

async function importFeed(feedUrl, maxItems = 500) {
  const xml = await fetchPage(feedUrl, 0, { xml: true, maxBytes: 20 * 1024 * 1024 });
  const items = [];
  for (const m of xml.matchAll(FEED_ITEM)) {
    if (items.length >= maxItems) break;
    const fields = {};
    // CDATA may contain HTML — flatten it to escaped text so its element stays a leaf
    const body = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) =>
      xmlText(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    // Heureka <PARAM><PARAM_NAME>Farba</PARAM_NAME><VAL>čierna</VAL></PARAM> → "Farba: čierna"
    const params = [...body.matchAll(/<PARAM>[\s\S]*?<PARAM_NAME>([\s\S]*?)<\/PARAM_NAME>[\s\S]*?<VAL>([\s\S]*?)<\/VAL>[\s\S]*?<\/PARAM>/g)]
      .map(p => `${xmlText(p[1])}: ${xmlText(p[2])}`);
    // leaf elements only: <TAG>value</TAG> without nested tags
    for (const f of body.replace(/<PARAM>[\s\S]*?<\/PARAM>/g, '').matchAll(/<([\w:.-]+)[^>]*>((?:(?!<[\w:.-]+[\s>])[\s\S])*?)<\/\1>/g)) {
      const v = xmlText(f[2]);
      if (v && !fields[f[1]]) fields[f[1]] = v.slice(0, 800);
    }
    const titleKey = FEED_TITLE.find(k => fields[k]);
    if (!titleKey) continue;
    const content = Object.entries(fields)
      .filter(([k]) => !/IMG|image|PARAM_NAME/i.test(k))
      .map(([k, v]) => `${k.replace(/^g:/, '')}: ${v}`).concat(params).join('\n').slice(0, 2000);
    items.push({ title: fields[titleKey].slice(0, 200), content });
  }
  return items;
}

module.exports = { crawlSite, importSitemap, importFeed };
