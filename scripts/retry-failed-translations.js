'use strict';
/**
 * retry-failed-translations.js — Retry only chunks that fell back to Slovak
 *
 * Detects keys where lang[key] === sk[key] (failed translation fallback),
 * groups them into chunks of 40, retries each chunk up to 10 times.
 *
 * Usage:
 *   node scripts/retry-failed-translations.js           — all languages
 *   node scripts/retry-failed-translations.js de        — single language
 *   node scripts/retry-failed-translations.js de fr pl  — multiple languages
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const fs   = require('fs');
const path = require('path');

const LOCALES = path.join(__dirname, '..', 'public', 'locales');
const SK_FILE = path.join(LOCALES, 'sk.json');

const LANG_NAMES = {
  en: 'English', de: 'German',  fr: 'French', es: 'Spanish',
  pl: 'Polish',  cs: 'Czech',   hu: 'Hungarian', ro: 'Romanian', hr: 'Croatian',
};

const BRAND_NAMES = [
  'Neoworkly','AI Coach','WooCommerce','GDPR','CTA','API',
  'Instagram','Stripe','WordPress','Shopify','Webflow','Wix',
  'ManyChat','Salesforce','Intercom','CSV','PDF','TXT','URL','DM','ROI',
];

const MAX_RETRIES  = 10;
const CHUNK_SIZE   = 40;

const DQ          = '__DQ__';
const sanitize    = s => s.replace(/"/g, DQ);
const desanitize  = s => s.replace(/__DQ__/g, '"');

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
  const parts   = [];
  for (let i = 0; i < entries.length; i += size)
    parts.push(Object.fromEntries(entries.slice(i, i + size)));
  return parts;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// A key is "failed" if the translated value equals the Slovak source value,
// but only for keys that look like natural language (not brand names, URLs, etc.)
function isLikelyFailed(key, langValue, skValue) {
  if (langValue !== skValue) return false;         // already translated
  if (skValue.length < 4) return false;            // too short to care
  if (/^https?:\/\//.test(skValue)) return false; // URL — identity is correct
  if (/^[A-Z_]{2,}$/.test(skValue)) return false; // ALL_CAPS constant
  if (BRAND_NAMES.some(b => skValue === b)) return false; // exact brand match
  if (!/[a-zA-ZÀ-žÁ-ž]/.test(skValue)) return false; // no letters
  return true;
}

async function retryLanguage(lang, langName, sk) {
  const outFile = path.join(LOCALES, `${lang}.json`);
  if (!fs.existsSync(outFile)) {
    console.log(`  ${lang}: file not found, skipping`);
    return;
  }

  const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  // Find keys that failed (fell back to Slovak value)
  const failed = {};
  for (const key of Object.keys(sk)) {
    const skVal   = sk[key];
    const langVal = existing[key];
    if (langVal === undefined || isLikelyFailed(key, langVal, skVal)) {
      failed[key] = skVal;
    }
  }

  const failedCount = Object.keys(failed).length;
  if (failedCount === 0) {
    console.log(`  ${lang} (${langName}): no failed keys detected ✓`);
    return;
  }

  console.log(`\n  ${lang} (${langName}): ${failedCount} failed key(s) to retry`);

  const parts   = chunk(failed, CHUNK_SIZE);
  const updated = { ...existing };
  let   fixed   = 0;

  for (let i = 0; i < parts.length; i++) {
    const chunkKeys = Object.keys(parts[i]);
    process.stdout.write(`    chunk ${i + 1}/${parts.length} (${chunkKeys.length} keys)... `);

    let ok = false;
    for (let attempt = 1; attempt <= MAX_RETRIES && !ok; attempt++) {
      try {
        const result = await translateChunk(parts[i], langName);

        // Validate: at least some values actually changed from SK
        const changed = Object.entries(result).filter(([k, v]) => v !== parts[i][k]).length;
        if (changed === 0 && chunkKeys.length > 3) {
          throw new Error(`All ${chunkKeys.length} values unchanged — likely bad response`);
        }

        Object.assign(updated, result);
        fixed += chunkKeys.length;
        process.stdout.write(`✓ (attempt ${attempt})\n`);
        ok = true;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const wait = Math.min(1000 * attempt, 8000);
          process.stdout.write(`retry ${attempt}/${MAX_RETRIES}... `);
          await delay(wait);
        } else {
          process.stdout.write(`✗ gave up after ${MAX_RETRIES} attempts: ${err.message}\n`);
        }
      }
    }

    if (i < parts.length - 1) await delay(400);
  }

  fs.writeFileSync(outFile, JSON.stringify(updated, null, 2), 'utf8');
  console.log(`    ✓ ${lang}.json saved — fixed ${fixed}/${failedCount} keys`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('✗ ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const args = process.argv.slice(2).filter(a => LANG_NAMES[a]);
  const targetLangs = args.length > 0 ? args : Object.keys(LANG_NAMES);

  const sk = JSON.parse(fs.readFileSync(SK_FILE, 'utf8'));
  console.log(`sk.json: ${Object.keys(sk).length} keys`);
  console.log(`Retrying failed translations for: ${targetLangs.join(', ')}`);
  console.log(`Max retries per chunk: ${MAX_RETRIES}\n`);

  let totalFixed = 0;

  for (const lang of targetLangs) {
    await retryLanguage(lang, LANG_NAMES[lang], sk);
    await delay(600);
  }

  console.log('\nDone. Commit with:');
  console.log('  git add public/locales/ && git commit -m "fix: retry failed translations"');
}

main().catch(console.error);
