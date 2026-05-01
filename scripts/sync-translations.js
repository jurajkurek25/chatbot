'use strict';
/**
 * sync-translations.js — Comprehensive translation sync for Neoworkly
 *
 * What it does:
 *   1. Scans all HTML files in /public for translatable text strings
 *   2. Finds strings NOT yet in sk.json → adds them
 *   3. For every non-SK language file: translates missing keys
 *   4. Creates language files that don't exist yet (translating all of sk.json)
 *
 * Usage:
 *   node scripts/sync-translations.js              — full sync (scan + update sk.json + translate)
 *   node scripts/sync-translations.js --scan-only  — just report missing strings, no changes
 *   node scripts/sync-translations.js --sk-only    — update sk.json only, skip translation
 *   node scripts/sync-translations.js de           — translate only one language
 *   node scripts/sync-translations.js --full       — rebuild ALL language files from scratch
 *
 * Requires: ANTHROPIC_API_KEY env var (for translation steps)
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const fs   = require('fs');
const path = require('path');

const PUBLIC  = path.join(__dirname, '..', 'public');
const LOCALES = path.join(PUBLIC, 'locales');
const SK_FILE = path.join(LOCALES, 'sk.json');

const LANG_NAMES = {
  en: 'English', de: 'German',  fr: 'French', es: 'Spanish',
  pl: 'Polish',  cs: 'Czech',   hu: 'Hungarian', ro: 'Romanian', hr: 'Croatian',
};

// HTML files to scan (relative to /public)
const HTML_FILES = [
  'index.html', 'dashboard.html', 'booking.html', 'onboarding.html',
  'demo.html',  'shopify.html',   'wordpress.html', '404.html', 'present.html',
];

// Strings to unconditionally skip (exact match or startsWith)
const SKIP_EXACT = new Set([
  '✕', '×', '+', '−', '→', '←', '↓', '↑', '•', '…',
  '/', '/mesiac', '€', '$', '%',
  '●', '⚡', '✓', '✗',
]);

// Patterns that indicate a string is NOT natural-language text
const SKIP_PATTERNS = [
  /^[\d\s.,€$%/\-:+×÷=()[\]{}]+$/, // pure numbers/symbols
  /^[A-Z_]{2,}$/,                    // ALL_CAPS constants
  /^https?:\/\//,                    // URLs
  /^[a-z-]+\.[a-z]{2,4}$/i,          // domain names / file extensions
  /^#[0-9a-f]{3,8}$/i,               // hex colours
  /^\d{1,2}:\d{2}$/,                 // times like 09:00
  /^\d{4}-\d{2}-\d{2}$/,             // ISO dates
  /^v\d/i,                            // version strings
  /^[A-Z][a-z]+[A-Z]/,               // camelCase (tech tokens)
  /^\s*$/,                            // whitespace only
];

// Brand/tech names that should NOT be translated (used as guard in prompt only)
const BRAND_NAMES = [
  'Neoworkly','Neoworkly','AI Coach','WooCommerce','GDPR','CTA','API',
  'Instagram','Stripe','WordPress','Shopify','Webflow','Wix','React',
  'Next.js','SQLite','JWT','OAuth','FTS5','WAL','ManyChat','Salesforce',
  'Intercom','CSV','PDF','TXT','MD','URL','DM','ROI',
];

// ── HTML entity decoder ──────────────────────────────────────────────────────
const ENTITIES = { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':'\u00a0','&mdash;':'—','&ndash;':'–','&rarr;':'→','&larr;':'←','&hellip;':'…' };
function decodeEntities(s) {
  return s.replace(/&[a-z]+;|&#\d+;/gi, m => ENTITIES[m] || m);
}

// ── Extract translatable strings from HTML content ───────────────────────────
function extractFromHTML(html) {
  const found = new Set();

  // Strip HTML comments
  let c = html.replace(/<!--[\s\S]*?-->/g, ' ');
  // Strip <script> blocks
  c = c.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  // Strip <style> blocks
  c = c.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // Strip SVG blocks
  c = c.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // Text nodes: content between > and <
  const textRe = />([^<]+)</g;
  let m;
  while ((m = textRe.exec(c)) !== null) {
    const raw = m[1];
    const s   = decodeEntities(raw).trim();
    if (isTranslatable(s)) found.add(s);
  }

  // placeholder="..."
  const phRe = /\bplaceholder\s*=\s*"([^"]+)"/g;
  while ((m = phRe.exec(c)) !== null) {
    const s = decodeEntities(m[1]).trim();
    if (isTranslatable(s)) found.add(s);
  }

  // title="..."
  const titleRe = /\btitle\s*=\s*"([^"]+)"/g;
  while ((m = titleRe.exec(c)) !== null) {
    const s = decodeEntities(m[1]).trim();
    if (isTranslatable(s)) found.add(s);
  }

  // alt="..."
  const altRe = /\balt\s*=\s*"([^"]+)"/g;
  while ((m = altRe.exec(c)) !== null) {
    const s = decodeEntities(m[1]).trim();
    if (isTranslatable(s)) found.add(s);
  }

  return found;
}

function isTranslatable(s) {
  if (!s || s.length < 3) return false;
  if (SKIP_EXACT.has(s)) return false;
  for (const re of SKIP_PATTERNS) if (re.test(s)) return false;
  // Must contain at least one letter
  if (!/[a-zA-ZÀ-žÁ-ž]/.test(s)) return false;
  return true;
}

// ── Scan all HTML files ──────────────────────────────────────────────────────
function scanAllFiles() {
  const allFound = new Map(); // string → Set of filenames
  for (const file of HTML_FILES) {
    const fp = path.join(PUBLIC, file);
    if (!fs.existsSync(fp)) continue;
    const html = fs.readFileSync(fp, 'utf8');
    for (const s of extractFromHTML(html)) {
      if (!allFound.has(s)) allFound.set(s, new Set());
      allFound.get(s).add(file);
    }
  }
  return allFound;
}

// ── Translation helpers ──────────────────────────────────────────────────────
const DQ = '__DQ__';
const sanitize   = s => s.replace(/"/g, DQ);
const desanitize = s => s.replace(/__DQ__/g, '"');

function sanitizeObj(obj) {
  const out = {}, keyMap = {};
  for (const [k, v] of Object.entries(obj)) {
    const sk = sanitize(k);
    out[sk]    = sanitize(v);
    keyMap[sk] = k;
  }
  return { sanitized: out, keyMap };
}

function restoreObj(translated, keyMap) {
  const out = {};
  for (const [sk, sv] of Object.entries(translated)) {
    const origKey = keyMap[sk] ?? desanitize(sk);
    out[origKey]  = desanitize(sv);
  }
  return out;
}

function chunk(obj, size) {
  const entries = Object.entries(obj);
  const parts = [];
  for (let i = 0; i < entries.length; i += size)
    parts.push(Object.fromEntries(entries.slice(i, i + size)));
  return parts;
}

let _client = null;
function getClient() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

async function translateChunk(skChunk, langName) {
  const { sanitized, keyMap } = sanitizeObj(skChunk);
  const prompt =
`Translate JSON values from Slovak to ${langName}.
Return ONLY a valid JSON object — no markdown, no explanation, no code fences.
Rules:
- Keep keys EXACTLY unchanged
- Keep brand names unchanged: ${BRAND_NAMES.slice(0,15).join(', ')}
- Keep {variable} and {placeholder} tokens unchanged
- Keep __DQ__ tokens unchanged
- Keep emojis unchanged

${JSON.stringify(sanitized)}`;

  const resp = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text  = resp.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in response');
  return restoreObj(JSON.parse(match[0]), keyMap);
}

async function translateLangFile(lang, langName, toTranslate, existing = {}) {
  const parts  = chunk(toTranslate, 40);
  const result = { ...existing };

  for (let i = 0; i < parts.length; i++) {
    process.stdout.write(`  chunk ${i + 1}/${parts.length}... `);
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        Object.assign(result, await translateChunk(parts[i], langName));
        process.stdout.write('✓\n');
        ok = true;
      } catch (err) {
        if (attempt < 4) {
          process.stdout.write(`retry${attempt}... `);
          await delay(1500 * attempt);
        } else {
          process.stdout.write(`✗ (${err.message})\n`);
          Object.assign(result, parts[i]); // SK fallback
        }
      }
    }
    if (i < parts.length - 1) await delay(350);
  }
  return result;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2);
  const scanOnly  = args.includes('--scan-only');
  const skOnly    = args.includes('--sk-only');
  const fullRebuild = args.includes('--full');
  const singleLang  = args.find(a => LANG_NAMES[a]);

  const targetLangs = singleLang
    ? [singleLang]
    : Object.keys(LANG_NAMES);

  // ── 1. Load sk.json ──────────────────────────────────────────────────────
  let sk = {};
  if (fs.existsSync(SK_FILE)) sk = JSON.parse(fs.readFileSync(SK_FILE, 'utf8'));
  console.log(`\nsk.json: ${Object.keys(sk).length} keys`);

  // ── 2. Scan HTML files ───────────────────────────────────────────────────
  console.log('\nScanning HTML files...');
  const allFound = scanAllFiles();
  console.log(`  Found ${allFound.size} unique strings across ${HTML_FILES.length} files`);

  const missing = [];
  for (const [s, files] of allFound) {
    if (!sk[s]) {
      missing.push(s);
      if (scanOnly) console.log(`  MISSING [${[...files].join(',')}]: ${s.slice(0, 80)}`);
    }
  }

  console.log(`  Missing from sk.json: ${missing.length}`);
  if (scanOnly) { console.log('\n(--scan-only: no changes made)'); return; }

  // ── 3. Update sk.json ────────────────────────────────────────────────────
  if (missing.length > 0) {
    const added = {};
    for (const s of missing) added[s] = s; // key = value for Slovak
    // Merge: new keys first (so they appear at end for easy review), then existing
    const updated = { ...sk, ...added };
    fs.writeFileSync(SK_FILE, JSON.stringify(updated, null, 2), 'utf8');
    console.log(`\n  ✓ sk.json updated: +${missing.length} new keys (total: ${Object.keys(updated).length})`);
    sk = updated;
  } else {
    console.log('  sk.json is up to date.');
  }

  if (skOnly) { console.log('\n(--sk-only: translation skipped)'); return; }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n⚠ ANTHROPIC_API_KEY not set — skipping translation.');
    console.log('  Set the key and re-run to generate/update language files.');
    return;
  }

  // ── 4. Translate ─────────────────────────────────────────────────────────
  console.log(`\nTranslating into ${targetLangs.length} language(s)...`);

  for (const lang of targetLangs) {
    const langName = LANG_NAMES[lang];
    const outFile  = path.join(LOCALES, `${lang}.json`);
    await delay(300);

    if (fullRebuild || !fs.existsSync(outFile)) {
      // ── Full build: translate entire sk.json ──
      console.log(`\n${lang} (${langName}): full build (${Object.keys(sk).length} keys)`);
      try {
        const translated = await translateLangFile(lang, langName, sk);
        fs.writeFileSync(outFile, JSON.stringify(translated, null, 2), 'utf8');
        console.log(`  ✓ saved ${lang}.json (${Object.keys(translated).length} keys)`);
      } catch (err) {
        console.error(`  ✗ ${lang}: ${err.message}`);
      }
    } else {
      // ── Patch: translate only keys missing from existing lang file ──
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const toTranslate = {};
      for (const key of Object.keys(sk)) {
        if (!existing[key]) toTranslate[key] = sk[key]; // SK value as source
      }
      if (Object.keys(toTranslate).length === 0) {
        console.log(`${lang}: up to date ✓`);
        continue;
      }
      console.log(`\n${lang} (${langName}): patching ${Object.keys(toTranslate).length} missing key(s)`);
      try {
        const patched = await translateLangFile(lang, langName, toTranslate, existing);
        fs.writeFileSync(outFile, JSON.stringify(patched, null, 2), 'utf8');
        console.log(`  ✓ ${lang}.json updated (total: ${Object.keys(patched).length} keys)`);
      } catch (err) {
        console.error(`  ✗ ${lang}: ${err.message}`);
      }
    }
    await delay(800);
  }

  console.log('\nDone! Commit with:');
  console.log('  git add public/locales/ && git commit -m "sync: update all translations"');
}

main().catch(console.error);
