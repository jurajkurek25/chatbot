'use strict';
/**
 * sync-present-translations.js — Sync translations for present.html only
 *
 * Usage:
 *   node scripts/sync-present-translations.js           — scan + update sk.json + translate all langs
 *   node scripts/sync-present-translations.js --scan-only
 *   node scripts/sync-present-translations.js --sk-only
 *   node scripts/sync-present-translations.js de        — single language
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const fs   = require('fs');
const path = require('path');

const PUBLIC      = path.join(__dirname, '..', 'public');
const LOCALES     = path.join(PUBLIC, 'locales');
const SK_FILE     = path.join(LOCALES, 'sk.json');
const TARGET_FILE = path.join(PUBLIC, 'present.html');

const LANG_NAMES = {
  en: 'English', de: 'German',  fr: 'French', es: 'Spanish',
  pl: 'Polish',  cs: 'Czech',   hu: 'Hungarian', ro: 'Romanian', hr: 'Croatian',
};

const BRAND_NAMES = [
  'Neoworkly', 'AI', 'GDPR', 'CTA', 'API', 'Instagram', 'Stripe',
  'WordPress', 'Shopify', 'PDF', 'URL', 'DM', 'ROI', 'NEOW',
];

const SKIP_EXACT = new Set(['✕', '×', '+', '−', '→', '←', '↓', '↑', '•', '…', '/', '€', '$', '%']);

const SKIP_PATTERNS = [
  /^[\d\s.,€$%/\-:+×÷=()[\]{}]+$/,
  /^[A-Z_]{2,}$/,
  /^https?:\/\//,
  /^[a-z-]+\.[a-z]{2,4}$/i,
  /^#[0-9a-f]{3,8}$/i,
  /^\d{1,2}:\d{2}$/,
  /^v\d/i,
  /^[A-Z][a-z]+[A-Z]/,
  /^\s*$/,
];

const ENTITIES = { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' ','&mdash;':'—','&ndash;':'–','&rarr;':'→','&hellip;':'…' };
function decodeEntities(s) {
  return s.replace(/&[a-z]+;|&#\d+;/gi, m => ENTITIES[m] || m);
}

function isTranslatable(s) {
  if (!s || s.length < 3) return false;
  if (SKIP_EXACT.has(s)) return false;
  for (const re of SKIP_PATTERNS) if (re.test(s)) return false;
  if (!/[a-zA-ZÀ-žÁ-ž]/.test(s)) return false;
  return true;
}

function extractFromHTML(html) {
  const found = new Set();
  let c = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  const textRe = />([^<]+)</g;
  let m;
  while ((m = textRe.exec(c)) !== null) {
    const s = decodeEntities(m[1]).trim();
    if (isTranslatable(s)) found.add(s);
  }
  const attrRes = [/\bplaceholder\s*=\s*"([^"]+)"/g, /\btitle\s*=\s*"([^"]+)"/g, /\balt\s*=\s*"([^"]+)"/g];
  for (const re of attrRes) {
    while ((m = re.exec(c)) !== null) {
      const s = decodeEntities(m[1]).trim();
      if (isTranslatable(s)) found.add(s);
    }
  }
  return found;
}

const DQ          = '__DQ__';
const sanitize    = s => s.replace(/"/g, DQ);
const desanitize  = s => s.replace(/__DQ__/g, '"');

function sanitizeObj(obj) {
  const out = {}, keyMap = {};
  for (const [k, v] of Object.entries(obj)) {
    const sk = sanitize(k); out[sk] = sanitize(v); keyMap[sk] = k;
  }
  return { sanitized: out, keyMap };
}

function restoreObj(translated, keyMap) {
  const out = {};
  for (const [sk, sv] of Object.entries(translated)) {
    out[keyMap[sk] ?? desanitize(sk)] = desanitize(sv);
  }
  return out;
}

function chunk(obj, size) {
  const entries = Object.entries(obj), parts = [];
  for (let i = 0; i < entries.length; i += size)
    parts.push(Object.fromEntries(entries.slice(i, i + size)));
  return parts;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

let _client = null;
function getClient() {
  if (!_client) { const A = require('@anthropic-ai/sdk'); _client = new A({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  return _client;
}

async function translateChunk(skChunk, langName) {
  const { sanitized, keyMap } = sanitizeObj(skChunk);
  const prompt =
`Translate JSON values from Slovak to ${langName}.
Return ONLY a valid JSON object — no markdown, no explanation, no code fences.
Rules:
- Keep keys EXACTLY unchanged
- Keep brand names unchanged: ${BRAND_NAMES.join(', ')}
- Keep {variable} tokens unchanged
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

async function translateKeys(toTranslate, lang, langName, existing = {}) {
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
        if (attempt < 4) { process.stdout.write(`retry${attempt}... `); await delay(1500 * attempt); }
        else { process.stdout.write(`✗ (${err.message})\n`); Object.assign(result, parts[i]); }
      }
    }
    if (i < parts.length - 1) await delay(350);
  }
  return result;
}

async function main() {
  const args      = process.argv.slice(2);
  const scanOnly  = args.includes('--scan-only');
  const skOnly    = args.includes('--sk-only');
  const singleLang = args.find(a => LANG_NAMES[a]);
  const targetLangs = singleLang ? [singleLang] : Object.keys(LANG_NAMES);

  // 1. Load sk.json
  let sk = fs.existsSync(SK_FILE) ? JSON.parse(fs.readFileSync(SK_FILE, 'utf8')) : {};
  console.log(`\nsk.json: ${Object.keys(sk).length} total keys`);

  // 2. Scan present.html
  if (!fs.existsSync(TARGET_FILE)) { console.error('✗ present.html not found'); process.exit(1); }
  const html   = fs.readFileSync(TARGET_FILE, 'utf8');
  const found  = extractFromHTML(html);
  console.log(`present.html: ${found.size} translatable strings found`);

  const missing = [...found].filter(s => !sk[s]);
  console.log(`Missing from sk.json: ${missing.length}`);

  if (scanOnly) {
    missing.forEach(s => console.log(`  MISSING: ${s.slice(0, 90)}`));
    console.log('\n(--scan-only: no changes made)');
    return;
  }

  // 3. Update sk.json
  if (missing.length > 0) {
    for (const s of missing) sk[s] = s;
    fs.writeFileSync(SK_FILE, JSON.stringify(sk, null, 2), 'utf8');
    console.log(`✓ sk.json updated: +${missing.length} keys (total: ${Object.keys(sk).length})`);
  } else {
    console.log('sk.json is up to date.');
  }

  if (skOnly) { console.log('\n(--sk-only: translation skipped)'); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log('\n⚠ ANTHROPIC_API_KEY not set — skipping translation.'); return; }

  // 4. Translate only the keys from present.html that are missing in each lang file
  const presentKeys = [...found];
  console.log(`\nTranslating present.html keys into ${targetLangs.length} language(s)...`);

  for (const lang of targetLangs) {
    const langName = LANG_NAMES[lang];
    const outFile  = path.join(LOCALES, `${lang}.json`);
    await delay(300);

    const existing    = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
    const toTranslate = {};
    for (const key of presentKeys) {
      if (!existing[key]) toTranslate[key] = sk[key];
    }

    if (Object.keys(toTranslate).length === 0) {
      console.log(`${lang}: up to date ✓`);
      continue;
    }

    console.log(`\n${lang} (${langName}): translating ${Object.keys(toTranslate).length} key(s)`);
    try {
      const updated = await translateKeys(toTranslate, lang, langName, existing);
      fs.writeFileSync(outFile, JSON.stringify(updated, null, 2), 'utf8');
      console.log(`  ✓ ${lang}.json saved (total: ${Object.keys(updated).length} keys)`);
    } catch (err) {
      console.error(`  ✗ ${lang}: ${err.message}`);
    }
    await delay(600);
  }

  console.log('\nDone! Commit with:');
  console.log('  git add public/locales/ && git commit -m "sync: present.html translations"');
}

main().catch(console.error);
