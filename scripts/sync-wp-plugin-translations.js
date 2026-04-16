'use strict';
/**
 * sync-wp-plugin-translations.js — Translation sync for Neoworkly WordPress plugin
 *
 * What it does:
 *   1. Reads wordpress-plugin/neoworkly-chatbot/languages/sk.json as master
 *   2. For every non-SK language: translates missing keys using Claude Haiku
 *   3. Creates language files that don't exist yet (translating all of sk.json)
 *
 * Usage:
 *   node scripts/sync-wp-plugin-translations.js              — translate all languages
 *   node scripts/sync-wp-plugin-translations.js de           — translate one language only
 *   node scripts/sync-wp-plugin-translations.js --full       — rebuild ALL language files from scratch
 *
 * Requires: ANTHROPIC_API_KEY env var
 *
 * Output: wordpress-plugin/neoworkly-chatbot/languages/{lang}.json
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const fs   = require('fs');
const path = require('path');

const PLUGIN_DIR  = path.join(__dirname, '..', 'wordpress-plugin', 'neoworkly-chatbot');
const LANG_DIR    = path.join(PLUGIN_DIR, 'languages');
const SK_FILE     = path.join(LANG_DIR, 'sk.json');

const LANG_NAMES = {
  en: 'English', de: 'German',  fr: 'French', es: 'Spanish',
  pl: 'Polish',  cs: 'Czech',   hu: 'Hungarian', ro: 'Romanian', hr: 'Croatian',
};

// Brand/tech names that must NOT be translated
const BRAND_NAMES = [
  'Neoworkly', 'Neoworkly', 'WooCommerce', 'WordPress', 'CTA', 'API',
];

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
- Keep brand names unchanged: ${BRAND_NAMES.join(', ')}
- Keep {variable} and {placeholder} tokens unchanged (like {count}, {done}, {total}, {site}, %s)
- Keep HTML tags unchanged (<strong>, <a>, etc.) — translate only the text inside tags
- Keep __DQ__ tokens unchanged
- Keep emoji unchanged

${JSON.stringify(sanitized)}`;

  const resp = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text  = resp.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in response');
  return restoreObj(JSON.parse(match[0]), keyMap);
}

async function translateLangFile(lang, langName, toTranslate, existing = {}) {
  const parts  = chunk(toTranslate, 30);
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

// ── Colour helpers ───────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const col = (c, s) => `${c}${s}${C.reset}`;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args        = process.argv.slice(2);
  const fullRebuild = args.includes('--full');
  const singleLang  = args.find(a => LANG_NAMES[a]);

  const targetLangs = singleLang ? [singleLang] : Object.keys(LANG_NAMES);

  console.log('\n' + col(C.bold, '═'.repeat(60)));
  console.log(col(C.bold + C.cyan, '  Neoworkly WP Plugin — Translation Sync'));
  console.log(col(C.bold, '═'.repeat(60)));

  // ── 1. Load sk.json ────────────────────────────────────────────────────────
  if (!fs.existsSync(SK_FILE)) {
    console.error(col(C.red, `ERROR: sk.json not found at ${SK_FILE}`));
    process.exit(1);
  }
  const sk      = JSON.parse(fs.readFileSync(SK_FILE, 'utf8'));
  const skCount = Object.keys(sk).length;
  console.log(`\n  Master (sk.json): ${col(C.bold, skCount)} keys`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n' + col(C.yellow, '  ⚠  ANTHROPIC_API_KEY not set — cannot translate.'));
    console.log(col(C.gray,   '     Add ANTHROPIC_API_KEY=sk-ant-... to your .env and re-run.'));
    console.log(col(C.bold, '═'.repeat(60)) + '\n');
    return;
  }

  // ── 2. Translate each language ─────────────────────────────────────────────
  console.log(`\n  Translating into ${col(C.bold, targetLangs.length)} language(s)...\n`);

  for (const lang of targetLangs) {
    const langName = LANG_NAMES[lang];
    const outFile  = path.join(LANG_DIR, `${lang}.json`);
    await delay(300);

    if (fullRebuild || !fs.existsSync(outFile)) {
      console.log(`${lang.toUpperCase()} (${langName}): full build — ${skCount} keys`);
      try {
        const translated = await translateLangFile(lang, langName, sk);
        fs.writeFileSync(outFile, JSON.stringify(translated, null, 2), 'utf8');
        console.log(col(C.green, `  ✓ saved ${lang}.json (${Object.keys(translated).length} keys)\n`));
      } catch (err) {
        console.error(col(C.red, `  ✗ ${lang}: ${err.message}\n`));
      }
    } else {
      const existing    = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const toTranslate = {};
      for (const key of Object.keys(sk)) {
        if (!existing[key]) toTranslate[key] = sk[key];
      }
      if (Object.keys(toTranslate).length === 0) {
        console.log(`${lang.toUpperCase()}: up to date ✓`);
        continue;
      }
      console.log(`${lang.toUpperCase()} (${langName}): patching ${Object.keys(toTranslate).length} missing key(s)`);
      try {
        const patched = await translateLangFile(lang, langName, toTranslate, existing);
        fs.writeFileSync(outFile, JSON.stringify(patched, null, 2), 'utf8');
        console.log(col(C.green, `  ✓ ${lang}.json updated (total: ${Object.keys(patched).length} keys)\n`));
      } catch (err) {
        console.error(col(C.red, `  ✗ ${lang}: ${err.message}\n`));
      }
    }
    await delay(800);
  }

  console.log(col(C.bold, '═'.repeat(60)));
  console.log(col(C.green, '  Done! Commit with:'));
  console.log(col(C.gray,  '  git add wordpress-plugin/neoworkly-chatbot/languages/'));
  console.log(col(C.gray,  '  git commit -m "i18n: translate WP plugin into all languages"'));
  console.log(col(C.bold, '═'.repeat(60)) + '\n');
}

main().catch(console.error);
