'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const MAX_PAGES       = 20;
const TIMEOUT_MS      = 8000;

function isPrivateHost(hostname) {
  return (
    hostname === 'localhost' || hostname === '::1' ||
    /^127\./.test(hostname) || /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  );
}
const MAX_BODY_BYTES  = 300 * 1024; // 300 KB per page
const MAX_CONTENT_LEN = 6000;       // chars stored per page
const CRAWL_DELAY_MS  = 150;        // polite delay between requests

/* ── HTTP fetch ─────────────────────────────────────────────── */
function fetchPage(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, {
      headers: {
        'User-Agent': 'NeoworklyBot/1.0 (knowledge-scanner)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'sk,cs,en',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const nextUrl = new URL(res.headers.location, rawUrl);
          if (isPrivateHost(nextUrl.hostname)) return reject(new Error('Redirect to private host blocked'));
          res.resume();
          resolve(fetchPage(nextUrl.href, redirects + 1));
        } catch { reject(new Error('Bad redirect')); }
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('text/html')) { res.resume(); return reject(new Error('Not HTML')); }

      let body = '', total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) { req.destroy(); return; }
        body += chunk;
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

module.exports = { crawlSite };
