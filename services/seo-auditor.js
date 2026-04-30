'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const Anthropic = require('@anthropic-ai/sdk');

const TIMEOUT_MS     = 8000;
const MAX_BODY_BYTES = 300 * 1024;

function isPrivateHost(hostname) {
  return (
    hostname === 'localhost' || hostname === '::1' ||
    /^127\./.test(hostname) || /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  );
}
const CRAWL_DELAY_MS = 200;
const SKIP_EXT = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|doc|docx|xls|css|js|xml|json|ico|woff|woff2|ttf|mp4|mp3)(\?|$)/i;

/* ── Fetch raw HTML ─────────────────────────────────────────── */
function fetchHtml(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, {
      headers: { 'User-Agent': 'NeoworklyBot/1.0 (seo-auditor)', Accept: 'text/html', 'Accept-Language': 'sk,cs,en' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const nextUrl = new URL(res.headers.location, rawUrl);
          if (isPrivateHost(nextUrl.hostname)) { res.resume(); return reject(new Error('Redirect to private host blocked')); }
          res.resume();
          resolve(fetchHtml(nextUrl.href, redirects + 1));
        } catch { reject(new Error('Bad redirect')); }
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('text/html')) { res.resume(); return reject(new Error('Not HTML')); }
      let body = '', total = 0;
      res.on('data', chunk => { total += chunk.length; if (total > MAX_BODY_BYTES) { req.destroy(); return; } body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ── Fetch plain text (for llms.txt check) ──────────────────── */
function fetchText(rawUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, { headers: { 'User-Agent': 'NeoworklyBot/1.0' }, timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ── Google PageSpeed Insights (mobile) ─────────────────────── */
function fetchPageSpeed(url) {
  const key = process.env.GOOGLE_PAGESPEED_API_KEY;
  if (!key) return Promise.resolve(null);
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${key}&strategy=mobile&category=performance`;
  return new Promise(resolve => {
    const req = https.get(apiUrl, { timeout: 20000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          const audits = d.lighthouseResult?.audits || {};
          const perf = d.lighthouseResult?.categories?.performance;
          if (!perf) return resolve(null);
          resolve({
            score:  Math.round((perf.score || 0) * 100),
            lcp:    audits['largest-contentful-paint']?.displayValue  || null,
            cls:    audits['cumulative-layout-shift']?.displayValue    || null,
            fcp:    audits['first-contentful-paint']?.displayValue     || null,
            tbt:    audits['total-blocking-time']?.displayValue        || null,
            si:     audits['speed-index']?.displayValue                || null,
            lcpMs:  audits['largest-contentful-paint']?.numericValue  || 0,
            clsVal: audits['cumulative-layout-shift']?.numericValue    || 0,
          });
        } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/* ── DataForSEO: domain rank + backlinks ─────────────────────── */
function fetchDataForSeo(origin) {
  const login    = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return Promise.resolve(null);

  const auth   = Buffer.from(`${login}:${password}`).toString('base64');
  const domain = origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const body   = JSON.stringify([{ target: domain, include_subdomains: true }]);

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.dataforseo.com',
      path:     '/v3/backlinks/summary/live',
      method:   'POST',
      headers:  { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  20000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const r = parsed.tasks?.[0]?.result?.[0];
          if (!r) return resolve(null);
          resolve({
            rank:              r.rank               || 0,
            backlinks:         r.backlinks          || 0,
            referring_domains: r.referring_domains  || 0,
            referring_ips:     r.referring_ips      || 0,
            broken_backlinks:  r.broken_backlinks   || 0,
          });
        } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/* ── Site-level checks: HTTPS, robots.txt, sitemap ──────────── */
async function analyzeSite(origin) {
  const findings = [];
  const base = new URL(origin);

  // HTTPS
  if (base.protocol !== 'https:') {
    findings.push({ type: 'https', severity: 'critical', issue: 'Web nepoužíva HTTPS', suggestion: 'Nainštalujte SSL certifikát a presmerujte HTTP → HTTPS. Google penalizuje HTTP weby.' });
  }

  // robots.txt
  try {
    const robots = await fetchText(`${origin}/robots.txt`);
    if (/Disallow:\s*\/\s*$|Disallow:\s*\/\s*\n/m.test(robots)) {
      findings.push({ type: 'robots', severity: 'critical', issue: 'robots.txt blokuje celý web (Disallow: /)', suggestion: 'Opravte robots.txt — blokujete indexovanie všetkých stránok Googlom.' });
    }
    if (!/Sitemap:/i.test(robots)) {
      findings.push({ type: 'robots', severity: 'info', issue: 'robots.txt neobsahuje odkaz na sitemap', suggestion: `Pridajte riadok: Sitemap: ${origin}/sitemap.xml` });
    }
  } catch {
    findings.push({ type: 'robots', severity: 'warning', issue: 'Chýba robots.txt', suggestion: `Vytvorte ${origin}/robots.txt — pomáha Googlu správne crawlovať váš web.` });
  }

  // sitemap.xml
  let sitemapFound = false;
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml']) {
    try { await fetchText(`${origin}${path}`); sitemapFound = true; break; } catch {}
  }
  if (!sitemapFound) {
    findings.push({ type: 'sitemap', severity: 'warning', issue: 'Chýba sitemap.xml', suggestion: `Vytvorte XML sitemap na ${origin}/sitemap.xml a nahláste ju v Google Search Console.` });
  }

  return findings;
}

/* ── Discover links ─────────────────────────────────────────── */
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
      abs.hash = ''; abs.search = '';
      links.add(abs.href);
    } catch {}
  }
  return [...links];
}

/* ── Extract existing Schema.org JSON-LD ────────────────────── */
function extractSchemaOrg(html) {
  const matches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  return matches.map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
}

/* ── Extract SEO metadata from raw HTML ─────────────────────── */
function extractSeoMeta(html, pageUrl) {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : '';

  const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
             || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const metaDesc = descM ? descM[1].trim() : '';

  const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
  const h1s = h1Matches.map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);

  const h2Matches = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  const h2s = h2Matches.map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);

  const imgMatches = [...html.matchAll(/<img([^>]*)>/gi)];
  const totalImages = imgMatches.length;
  const imagesWithoutAlt = imgMatches.filter(m => !/alt=["'][^"']+["']/i.test(m[1])).length;

  const hasCanonical = /<link[^>]+rel=["']canonical["'][^>]*>/i.test(html);
  const hasOgTitle   = /<meta[^>]+property=["']og:title["'][^>]*>/i.test(html);
  const hasOgDesc    = /<meta[^>]+property=["']og:description["'][^>]*>/i.test(html);
  const hasViewport  = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
  const hasJsonLd    = extractSchemaOrg(html).length > 0;
  const hasNoindex   = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html)
                    || /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]+name=["']robots["']/i.test(html);
  const h2Questions  = h2s.filter(h => h.includes('?'));

  const h3Matches = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)];
  const h3s = h3Matches.map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);

  const fullText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 1).length;
  const text = fullText.slice(0, 800);

  return { title, titleLength: title.length, metaDesc, metaDescLength: metaDesc.length,
           h1s, h2s, h3s, h2Questions, wordCount, totalImages, imagesWithoutAlt,
           hasCanonical, hasOgTitle, hasOgDesc, hasViewport, hasJsonLd, hasNoindex, text };
}

/* ── Generate findings per page ─────────────────────────────── */
function generateFindings(meta, pageUrl) {
  const findings = [];
  const path = (() => { try { return new URL(pageUrl).pathname; } catch { return pageUrl; } })();

  if (!meta.title) {
    findings.push({ type: 'title', severity: 'critical', issue: 'Chýba <title> tag', suggestion: `Pridajte popisný title tag (50–65 znakov) na stránku ${path}` });
  } else if (meta.titleLength < 30) {
    findings.push({ type: 'title', severity: 'warning', issue: `Title je príliš krátky (${meta.titleLength} znakov)`, suggestion: `Predĺžte title na 50–65 znakov. Teraz: "${meta.title}"` });
  } else if (meta.titleLength > 65) {
    findings.push({ type: 'title', severity: 'warning', issue: `Title je príliš dlhý (${meta.titleLength} znakov, max 65)`, suggestion: `Skráťte title. Teraz: "${meta.title.slice(0, 50)}…"` });
  }

  if (!meta.metaDesc) {
    findings.push({ type: 'description', severity: 'critical', issue: 'Chýba meta description', suggestion: 'Pridajte meta description (120–155 znakov) – zobrazuje sa vo výsledkoch Googlu' });
  } else if (meta.metaDescLength < 100) {
    findings.push({ type: 'description', severity: 'warning', issue: `Meta description je príliš krátky (${meta.metaDescLength} znakov)`, suggestion: 'Predĺžte description na 120–155 znakov' });
  } else if (meta.metaDescLength > 165) {
    findings.push({ type: 'description', severity: 'warning', issue: `Meta description je príliš dlhý (${meta.metaDescLength} znakov)`, suggestion: 'Skráťte description na max 155 znakov' });
  }

  if (meta.h1s.length === 0) {
    findings.push({ type: 'h1', severity: 'critical', issue: 'Chýba H1 nadpis', suggestion: 'Každá stránka musí mať práve jeden H1 nadpis s hlavným kľúčovým slovom' });
  } else if (meta.h1s.length > 1) {
    findings.push({ type: 'h1', severity: 'warning', issue: `Viacero H1 nadpisov (${meta.h1s.length}x)`, suggestion: 'Použite len jeden H1 – ďalšie zmeňte na H2/H3' });
  }

  if (meta.h2s.length === 0) {
    findings.push({ type: 'structure', severity: 'info', issue: 'Chýbajú H2 podnadpisy', suggestion: 'Pridajte H2 nadpisy pre lepšiu štruktúru a čitateľnosť obsahu' });
  }

  if (meta.imagesWithoutAlt > 0) {
    findings.push({ type: 'images', severity: 'warning', issue: `${meta.imagesWithoutAlt} z ${meta.totalImages} obrázkov nemá alt text`, suggestion: 'Pridajte popisný alt atribút ku každému obrázku' });
  }

  if (!meta.hasCanonical) {
    findings.push({ type: 'canonical', severity: 'info', issue: 'Chýba canonical URL tag', suggestion: `Pridajte <link rel="canonical" href="${pageUrl}"> do sekcie <head>` });
  }

  if (!meta.hasOgTitle || !meta.hasOgDesc) {
    findings.push({ type: 'og', severity: 'info', issue: 'Chýbajú Open Graph tagy (sociálne siete)', suggestion: 'Pridajte og:title a og:description pre zdieľanie na Facebooku/LinkedIn' });
  }

  if (!meta.hasViewport) {
    findings.push({ type: 'mobile', severity: 'warning', issue: 'Chýba viewport meta tag (mobilné zariadenia)', suggestion: 'Pridajte <meta name="viewport" content="width=device-width, initial-scale=1">' });
  }

  if (!meta.hasJsonLd) {
    findings.push({ type: 'schema', severity: 'info', issue: 'Chýba Schema.org JSON-LD (štruktúrované dáta)', suggestion: 'Pridajte JSON-LD – AI agenti (ChatGPT, Claude, Perplexity) a Google ho čítajú prednostne' });
  }

  if (meta.hasNoindex) {
    findings.push({ type: 'noindex', severity: 'warning', issue: 'Stránka má noindex – Google ju neindexuje', suggestion: 'Skontrolujte či je noindex zámerný. Ak nie, odstráňte meta robots noindex tag.' });
  }

  if (meta.wordCount < 300 && meta.wordCount > 0) {
    findings.push({ type: 'content', severity: 'info', issue: `Málo obsahu (${meta.wordCount} slov)`, suggestion: 'Stránky s menej ako 300 slovami Google považuje za "thin content". Rozšírte obsah.' });
  }

  if (meta.h3s.length > 0 && meta.h2s.length === 0) {
    findings.push({ type: 'structure', severity: 'info', issue: 'H3 nadpisy bez H2 (nesprávna hierarchia)', suggestion: 'Pridajte H2 nadpisy pred H3 – správna hierarchia je H1 → H2 → H3.' });
  }

  return findings;
}

/* ── Score (0-100) ──────────────────────────────────────────── */
function calculateScore(allFindings) {
  const weights = { critical: 12, warning: 6, info: 2 };
  const penalty = allFindings.reduce((s, f) => s + (weights[f.severity] || 0), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

/* ── Claude Haiku: AI-optimized title + description ─────────── */
async function generateAiFixes(pages) {
  const client = new Anthropic();
  const fixes = {};

  for (const page of pages.slice(0, 8)) {
    if (!page.html) continue;
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are an SEO expert. Create an optimized title (50-65 chars) and meta description (130-155 chars) for this webpage.

URL: ${page.url}
Current title: "${page.meta.title || '(missing)'}"
Current description: "${page.meta.metaDesc || '(missing)'}"
Page text: ${page.meta.text}

IMPORTANT: Respond in the SAME LANGUAGE as the page text.
Return ONLY valid JSON: {"title":"...","description":"..."}`
        }],
      });
      const text = msg.content[0]?.text || '';
      const m = text.match(/\{[\s\S]*?\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.title && parsed.description) fixes[page.url] = parsed;
      }
    } catch { /* skip */ }
  }
  return fixes;
}

/* ── Claude Haiku: Schema.org JSON-LD per page ──────────────── */
async function generateSchemaFixes(pages) {
  const client = new Anthropic();
  const fixes = {};

  for (const page of pages.slice(0, 8)) {
    if (!page.html) continue;
    try {
      const hasFaqH2s = page.meta.h2Questions.length >= 2;
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `You are a Schema.org expert. Generate the most appropriate JSON-LD structured data for this webpage.

URL: ${page.url}
Title: "${page.meta.title || '(missing)'}"
H1: "${page.meta.h1s[0] || '(missing)'}"
H2 headings: ${JSON.stringify(page.meta.h2s.slice(0, 6))}
${hasFaqH2s ? 'NOTE: H2s look like FAQ questions — prefer FAQPage type.' : ''}
Page text: ${page.meta.text}

Rules:
- Choose the most specific @type: LocalBusiness, Organization, FAQPage, Product, Article, WebPage
- For FAQPage include mainEntity array with Question/Answer pairs from H2s
- Include @context "https://schema.org"
- Use the page language for all text values
- Only include fields you can confidently infer
Return ONLY valid JSON.`
        }],
      });
      const text = msg.content[0]?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const parsed = JSON.parse(m[0]);
          if (parsed['@type'] && parsed['@context']) fixes[page.url] = parsed;
        } catch {}
      }
    } catch { /* skip */ }
  }
  return fixes;
}

/* ── Main audit ─────────────────────────────────────────────── */
async function runSeoAudit(startUrl, maxPages = 8) {
  const base = new URL(startUrl);
  const seed = (() => { const u = new URL(startUrl); u.hash = ''; u.search = ''; return u.href; })();
  const visited = new Set([seed]);
  const queue   = [seed];
  const pages   = [];

  const brokenLinks = new Set();

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    try {
      const t0 = Date.now();
      const html = await fetchHtml(url);
      const responseTime = Date.now() - t0;

      const meta = extractSeoMeta(html, url);
      const findings = generateFindings(meta, url);

      // Response time finding
      if (responseTime > 3000) {
        findings.push({ type: 'speed', severity: 'warning', issue: `Pomalé načítanie stránky (${(responseTime / 1000).toFixed(1)}s)`, suggestion: 'Načítanie nad 3s negatívne ovplyvňuje SEO. Zvážte CDN, caching, optimalizáciu obrázkov.' });
      } else if (responseTime > 1500) {
        findings.push({ type: 'speed', severity: 'info', issue: `Priemerné načítanie (${(responseTime / 1000).toFixed(1)}s)`, suggestion: 'Ideálny čas načítania je pod 1.5s. Optimalizujte server alebo použite caching.' });
      }

      pages.push({ url, html, meta, findings, responseTime });

      for (const link of extractLinks(html, url)) {
        if (!visited.has(link) && visited.size < maxPages * 3) {
          visited.add(link); queue.push(link);
        }
      }
    } catch (err) {
      if (err.message && err.message.startsWith('HTTP 4')) brokenLinks.add(url);
    }

    if (queue.length > 0) await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
  }

  if (pages.length === 0) throw new Error('Nepodarilo sa načítať žiadnu stránku webu.');

  // Duplicate title / description detection
  const titleCount = {}, descCount = {};
  pages.forEach(p => {
    if (p.meta.title)    titleCount[p.meta.title]    = (titleCount[p.meta.title]    || 0) + 1;
    if (p.meta.metaDesc) descCount[p.meta.metaDesc]  = (descCount[p.meta.metaDesc]  || 0) + 1;
  });
  pages.forEach(p => {
    if (p.meta.title    && titleCount[p.meta.title]    > 1)
      p.findings.push({ type: 'duplicate', severity: 'warning', issue: 'Duplicitný title tag (rovnaký na viacerých stránkach)', suggestion: `"${p.meta.title.slice(0, 40)}…" sa opakuje – každá stránka musí mať unikátny title.` });
    if (p.meta.metaDesc && descCount[p.meta.metaDesc]  > 1)
      p.findings.push({ type: 'duplicate', severity: 'warning', issue: 'Duplicitná meta description', suggestion: 'Každá stránka musí mať unikátnu meta description.' });
  });

  // Site-level checks (HTTPS, robots.txt, sitemap)
  const siteFindings = await analyzeSite(base.origin).catch(() => []);

  // Broken links site finding
  if (brokenLinks.size > 0) {
    siteFindings.push({ type: 'broken', severity: 'warning', issue: `${brokenLinks.size} nedostupných interných stránok (4xx)`, suggestion: `Opravte alebo odstráňte tieto URL: ${[...brokenLinks].slice(0, 3).join(', ')}` });
  }

  // llms.txt
  let hasLlmsTxt = false;
  try { await fetchText(`${base.origin}/llms.txt`); hasLlmsTxt = true; } catch {}
  if (!hasLlmsTxt) {
    siteFindings.push({ type: 'llms', severity: 'info', issue: 'Chýba llms.txt (AI agent indexing)', suggestion: `Nahrajte llms.txt na ${base.origin}/llms.txt – pomáha ChatGPT, Claude a Perplexity pochopiť váš web.` });
  }

  // PageSpeed per page (parallel, max 8 pages)
  const psResults = await Promise.all(
    pages.map(p => fetchPageSpeed(p.url).catch(() => null))
  );
  psResults.forEach((ps, i) => {
    if (!ps) return;
    pages[i].pagespeed = ps;
    const f = pages[i].findings;
    if (ps.score < 50)
      f.push({ type: 'speed', severity: 'critical', issue: `Veľmi nízke PageSpeed skóre (${ps.score}/100)`, suggestion: `LCP: ${ps.lcp || '?'}, CLS: ${ps.cls || '?'}. Optimalizujte obrázky, odstráňte blokovacie JS/CSS, použite CDN.` });
    else if (ps.score < 75)
      f.push({ type: 'speed', severity: 'warning', issue: `Nízke PageSpeed skóre (${ps.score}/100)`, suggestion: `LCP: ${ps.lcp || '?'}, CLS: ${ps.cls || '?'}. Zvážte optimalizáciu výkonu stránky.` });
    if (ps.lcpMs > 4000)
      f.push({ type: 'cwv', severity: 'warning', issue: `LCP príliš vysoký (${ps.lcp}) – Core Web Vital`, suggestion: 'Google penalizuje LCP > 4s. Optimalizujte najväčší element stránky (obrázok, hero banner).' });
    if (ps.clsVal > 0.25)
      f.push({ type: 'cwv', severity: 'warning', issue: `Vysoký CLS (${ps.cls}) – stránka "skáče" pri načítaní`, suggestion: 'CLS > 0.25 je zlý UX aj pre Google. Nastavte pevné rozmery obrázkov a reklamných blokov.' });
  });

  // DataForSEO domain metrics (once per domain)
  const domainMetrics = await fetchDataForSeo(base.origin).catch(() => null);
  if (domainMetrics) {
    if (domainMetrics.rank < 10 && domainMetrics.rank >= 0)
      siteFindings.push({ type: 'authority', severity: 'info', issue: `Nízka autorita domény (DataForSEO Rank: ${domainMetrics.rank}/100)`, suggestion: 'Získajte kvalitné spätné odkazy (backlinks) z relevantných webov vo vašom odvetví.' });
    if (domainMetrics.broken_backlinks > 50)
      siteFindings.push({ type: 'backlinks', severity: 'info', issue: `${domainMetrics.broken_backlinks} nefunkčných spätných odkazov`, suggestion: 'Opravte alebo presmerujte stránky s nefunkčnými backlinkami (stratená link equity).' });
  }

  const [aiFixes, schemaFixes] = await Promise.all([
    generateAiFixes(pages).catch(() => ({})),
    generateSchemaFixes(pages).catch(() => ({})),
  ]);

  const allFindings = [...siteFindings, ...pages.flatMap(p => p.findings)];

  const result = {
    score: calculateScore(allFindings),
    has_llms_txt: hasLlmsTxt,
    site_findings: siteFindings,
    summary: {
      total_pages: pages.length,
      total_issues: allFindings.length,
      critical: allFindings.filter(f => f.severity === 'critical').length,
      warnings:  allFindings.filter(f => f.severity === 'warning').length,
      info:      allFindings.filter(f => f.severity === 'info').length,
    },
    schema_fixes: schemaFixes,
    domain_metrics: domainMetrics,
    pages: pages.map(p => ({
      url: p.url,
      title: p.meta.title,
      meta: { metaDesc: p.meta.metaDesc, text: p.meta.text.slice(0, 200) },
      findings: p.findings,
      ai_fix: aiFixes[p.url] || null,
      pagespeed: p.pagespeed || null,
    })),
  };

  return result;
}

/* ── Generate WordPress PHP snippet ────────────────────────── */
function generateWordPressFix(auditResult) {
  const date = new Date().toISOString().split('T')[0];
  const lines = [
`<?php
/**
 * Neoworkly Growth Boost – SEO Fix
 * Vygenerované: ${date}
 *
 * Pridajte tento kód na koniec functions.php vášho WordPress témy.
 * Prípadne ho uložte ako samostatný plugin (/wp-content/plugins/neoworkly-seo-fix.php)
 * s hlavičkou:  Plugin Name: Neoworkly SEO Fix
 */

add_action( 'wp_head', function () {
  $url = home_url( add_query_arg( null, null ) );
`,
  ];

  for (const page of auditResult.pages) {
    try {
      const path = new URL(page.url).pathname;
      const fix  = page.ai_fix;
      const schema = auditResult.schema_fixes?.[page.url];
      if (!fix && !schema) continue;
      lines.push(`  // ${page.url}`);
      lines.push(`  if ( rtrim( parse_url( $url, PHP_URL_PATH ), '/' ) === '${path.replace(/\/$/, '')}' ) {`);
      if (fix?.title) {
        const t = fix.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        lines.push(`    echo '<title>${t}</title>\\n';`);
        lines.push(`    echo '<meta property="og:title" content="${t}">\\n';`);
      }
      if (fix?.description) {
        const d = fix.description.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        lines.push(`    echo '<meta name="description" content="${d}">\\n';`);
        lines.push(`    echo '<meta property="og:description" content="${d}">\\n';`);
      }
      lines.push(`    echo '<link rel="canonical" href="' . esc_url( $url ) . '">\\n';`);
      if (schema) {
        const json = JSON.stringify(schema).replace(/'/g, "\\'");
        lines.push(`    echo '<script type="application/ld+json">${json}<\\/script>\\n';`);
      }
      lines.push(`  }\n`);
    } catch {}
  }

  lines.push(`}, 1 );\n`);
  return lines.join('\n');
}

/* ── Generate HTML head snippet ────────────────────────────── */
function generateHtmlFix(auditResult) {
  const date = new Date().toISOString().split('T')[0];
  const parts = [
    `<!-- Neoworkly Growth Boost – SEO Fix (${date}) -->`,
    `<!-- Vložte tieto tagy do sekcie <head> každej príslušnej stránky -->`,
    '',
  ];

  for (const page of auditResult.pages) {
    const fix    = page.ai_fix;
    const schema = auditResult.schema_fixes?.[page.url];
    if (!fix && !schema && page.findings.length === 0) continue;
    parts.push(`\n<!-- ===== ${page.url} ===== -->`);
    if (fix?.title)       parts.push(`<title>${fix.title}</title>`);
    if (fix?.description) parts.push(`<meta name="description" content="${fix.description}">`);
    if (fix?.title)       parts.push(`<meta property="og:title" content="${fix.title}">`);
    if (fix?.description) parts.push(`<meta property="og:description" content="${fix.description}">`);
    parts.push(`<meta property="og:url" content="${page.url}">`);
    parts.push(`<link rel="canonical" href="${page.url}">`);
    parts.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
    if (schema) {
      parts.push(`<script type="application/ld+json">`);
      parts.push(JSON.stringify(schema, null, 2));
      parts.push(`</script>`);
    }
  }

  return parts.join('\n');
}

/* ── Generate Schema.org JSON-LD snippet (standalone) ──────── */
function generateSchemaFix(auditResult) {
  const date = new Date().toISOString().split('T')[0];
  const parts = [
    `<!-- Neoworkly Growth Boost – Schema.org JSON-LD (${date}) -->`,
    `<!-- AEO/GEO optimalizácia pre AI agentov: ChatGPT, Claude, Perplexity, Google AI -->`,
    `<!-- Vložte do sekcie <head> každej príslušnej stránky -->`,
    '',
  ];

  const schemaFixes = auditResult.schema_fixes || {};
  for (const page of auditResult.pages) {
    const schema = schemaFixes[page.url];
    if (!schema) continue;
    parts.push(`\n<!-- ===== ${page.url} ===== -->`);
    parts.push(`<script type="application/ld+json">`);
    parts.push(JSON.stringify(schema, null, 2));
    parts.push(`</script>`);
  }

  return parts.join('\n');
}

/* ── Generate llms.txt ──────────────────────────────────────── */
function generateLlmsTxt(auditResult) {
  const pages = auditResult.pages || [];
  const firstPage = pages[0];
  const siteName = firstPage?.title || (firstPage?.url ? new URL(firstPage.url).hostname : 'Website');
  const siteDesc = firstPage?.meta?.metaDesc || firstPage?.ai_fix?.description || '';
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    `# ${siteName}`,
    ``,
    siteDesc ? `> ${siteDesc}` : `> AI-readable sitemap generated by Neoworkly Growth Boost`,
    ``,
    `## Pages`,
    ``,
  ];

  for (const page of pages) {
    const title = page.title || page.url;
    const desc  = page.meta?.metaDesc || page.ai_fix?.description || '';
    lines.push(`- [${title}](${page.url})${desc ? ': ' + desc : ''}`);
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(`- Generated: ${date}`);
  lines.push(`- Source: Neoworkly Growth Boost SEO Audit`);
  lines.push(`- This file follows the llms.txt standard (https://llmstxt.org)`);

  return lines.join('\n');
}

module.exports = { runSeoAudit, generateWordPressFix, generateHtmlFix, generateSchemaFix, generateLlmsTxt };
