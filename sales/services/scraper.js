'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 200 * 1024;

function isPrivateHost(hostname) {
  return (
    hostname === 'localhost' || hostname === '::1' ||
    /^127\./.test(hostname) || /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  );
}

function fetchPage(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only HTTP/HTTPS allowed'));
    if (isPrivateHost(parsed.hostname)) return reject(new Error('Private host blocked'));

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeoworklyBot/1.0)', Accept: 'text/html' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, rawUrl);
          if (isPrivateHost(next.hostname)) return reject(new Error('Redirect to private host'));
          res.resume();
          resolve(fetchPage(next.href, redirects + 1));
        } catch { reject(new Error('Bad redirect')); }
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('text/html')) { res.resume(); return reject(new Error('Not HTML')); }

      let body = '', total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_BYTES) { req.destroy(); return; }
        body += chunk;
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractText(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  const titleM = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const title = titleM ? titleM[1].trim() : '';

  const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})/i)
             || html.match(/<meta[^>]+content=["']([^"']{1,400})["'][^>]+name=["']description["']/i);
  const description = descM ? descM[1].trim() : '';

  const emailM = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  const phoneM = html.match(/(\+421|0)[0-9\s\-\/]{8,14}/g) || [];

  const text = cleaned
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ').trim()
    .slice(0, 5000);

  const emails = [...new Set(emailM)].filter(e => !e.includes('example') && !e.includes('domain')).slice(0, 3);
  const phones = [...new Set(phoneM)].slice(0, 2);

  return { title, description, text, emails, phones };
}

module.exports = { fetchPage, extractText, isPrivateHost };
