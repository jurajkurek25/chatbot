'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const Anthropic = require('@anthropic-ai/sdk');

const TIMEOUT_MS     = 8000;
const MAX_BODY_BYTES = 300 * 1024;
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
        try { resolve(fetchHtml(new URL(res.headers.location, rawUrl).href, redirects + 1)); } catch { reject(new Error('Bad redirect')); }
        res.resume(); return;
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

  // Extract visible text for AI context
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 800);

  return { title, titleLength: title.length, metaDesc, metaDescLength: metaDesc.length,
           h1s, h2s, totalImages, imagesWithoutAlt, hasCanonical, hasOgTitle, hasOgDesc, hasViewport, text };
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

  return findings;
}

/* ── Score (0-100) ──────────────────────────────────────────── */
function calculateScore(allFindings) {
  const weights = { critical: 12, warning: 6, info: 2 };
  const penalty = allFindings.reduce((s, f) => s + (weights[f.severity] || 0), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

/* ── Claude Haiku: generate AI-optimized title + description ── */
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

/* ── Main audit ─────────────────────────────────────────────── */
async function runSeoAudit(startUrl, maxPages = 8) {
  const base = new URL(startUrl);
  const seed = (() => { const u = new URL(startUrl); u.hash = ''; u.search = ''; return u.href; })();
  const visited = new Set([seed]);
  const queue   = [seed];
  const pages   = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    try {
      const html = await fetchHtml(url);
      const meta = extractSeoMeta(html, url);
      const findings = generateFindings(meta, url);
      pages.push({ url, html, meta, findings });

      for (const link of extractLinks(html, url)) {
        if (!visited.has(link) && visited.size < maxPages * 3) {
          visited.add(link); queue.push(link);
        }
      }
    } catch { /* skip unreachable pages */ }

    if (queue.length > 0) await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
  }

  if (pages.length === 0) throw new Error('Nepodarilo sa načítať žiadnu stránku webu.');

  const aiFixes = await generateAiFixes(pages).catch(() => ({}));

  const result = {
    score: calculateScore(pages.flatMap(p => p.findings)),
    summary: {
      total_pages: pages.length,
      total_issues: pages.flatMap(p => p.findings).length,
      critical: pages.flatMap(p => p.findings).filter(f => f.severity === 'critical').length,
      warnings:  pages.flatMap(p => p.findings).filter(f => f.severity === 'warning').length,
      info:      pages.flatMap(p => p.findings).filter(f => f.severity === 'info').length,
    },
    pages: pages.map(p => ({
      url: p.url,
      title: p.meta.title,
      findings: p.findings,
      ai_fix: aiFixes[p.url] || null,
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
    if (!page.ai_fix) continue;
    try {
      const path = new URL(page.url).pathname;
      const t = (page.ai_fix.title || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const d = (page.ai_fix.description || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      lines.push(`  // ${page.url}`);
      lines.push(`  if ( rtrim( parse_url( $url, PHP_URL_PATH ), '/' ) === '${path.replace(/\/$/, '')}' ) {`);
      if (t) lines.push(`    echo '<title>${t}</title>\\n';`);
      if (d) lines.push(`    echo '<meta name="description" content="${d}">\\n';`);
      if (t) lines.push(`    echo '<meta property="og:title" content="${t}">\\n';`);
      if (d) lines.push(`    echo '<meta property="og:description" content="${d}">\\n';`);
      lines.push(`    echo '<link rel="canonical" href="' . esc_url( $url ) . '">\\n';`);
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
    const fix = page.ai_fix;
    if (!fix && page.findings.length === 0) continue;
    parts.push(`\n<!-- ===== ${page.url} ===== -->`);
    if (fix?.title)       parts.push(`<title>${fix.title}</title>`);
    if (fix?.description) parts.push(`<meta name="description" content="${fix.description}">`);
    if (fix?.title)       parts.push(`<meta property="og:title" content="${fix.title}">`);
    if (fix?.description) parts.push(`<meta property="og:description" content="${fix.description}">`);
    parts.push(`<meta property="og:url" content="${page.url}">`);
    parts.push(`<link rel="canonical" href="${page.url}">`);
    parts.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  }

  return parts.join('\n');
}

module.exports = { runSeoAudit, generateWordPressFix, generateHtmlFix };
