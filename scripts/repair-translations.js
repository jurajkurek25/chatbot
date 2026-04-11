'use strict';

// v2: Repairs failed translation chunks using a quote-placeholder technique.
// Keys/values containing " are sanitized before sending to Claude (replaced with __DQ__),
// then restored after — this prevents Claude from producing unescaped quotes in JSON output.

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const locales = path.join(__dirname, '..', 'public', 'locales');
const sk      = JSON.parse(fs.readFileSync(path.join(locales, 'sk.json'), 'utf8'));
const skKeys  = Object.keys(sk);

const LANG_NAMES = {
  de: 'German', en: 'English', fr: 'French', es: 'Spanish',
  pl: 'Polish', cs: 'Czech', hu: 'Hungarian', ro: 'Romanian', hr: 'Croatian',
};

// ─── Quote placeholder helpers ────────────────────────────────────────────────
const DQ = '__DQ__';
const sanitize   = s => s.replace(/"/g, DQ);
const desanitize = s => s.replace(/__DQ__/g, '"');

// Sanitize an object's keys AND values; return { sanitized, keyMap }
function sanitizeObj(obj) {
  const sanitized = {};
  const keyMap    = {}; // sanitizedKey → originalKey
  for (const [k, v] of Object.entries(obj)) {
    const sk2 = sanitize(k);
    sanitized[sk2] = sanitize(v);
    keyMap[sk2]    = k;
  }
  return { sanitized, keyMap };
}

// Restore original keys and desanitize values
function restoreObj(translated, keyMap) {
  const out = {};
  for (const [sk2, sv] of Object.entries(translated)) {
    const origKey  = keyMap[sk2] ?? desanitize(sk2);
    out[origKey]   = desanitize(sv);
  }
  return out;
}

// ─── API call ─────────────────────────────────────────────────────────────────
async function translateChunk(skChunk, langName) {
  const { sanitized, keyMap } = sanitizeObj(skChunk);

  const prompt = `Translate JSON values from Slovak to ${langName}. Return ONLY a valid JSON object — no explanation, no markdown, no code blocks.
Rules: keep keys EXACTLY unchanged, keep brand names (NeuraDeskApp, NeuraDesk, AI Coach, WooCommerce, GDPR, CTA, API, Instagram), keep {variable} placeholders, keep __DQ__ tokens as-is.

${JSON.stringify(sanitized)}`;

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = response.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  const raw = JSON.parse(match[0]);
  return restoreObj(raw, keyMap);
}

// ─── Detect which keys still need translation ─────────────────────────────────
// A key is "untranslated" if value === sk[key] AND key has Slovak letters OR length > 15
const SK_CHARS = /[áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ]/;
function needsTranslation(key, value) {
  if (value !== sk[key]) return false;          // already translated
  if (key.length <= 3) return false;            // too short to matter
  // If value has Slovak chars or is long → likely untranslated
  return SK_CHARS.test(value) || value.length > 20;
}

// Split object entries into sub-arrays of `size`
function splitObj(obj, size) {
  const entries = Object.entries(obj);
  const parts   = [];
  for (let i = 0; i < entries.length; i += size) {
    parts.push(Object.fromEntries(entries.slice(i, i + size)));
  }
  return parts;
}

// ─── Repair one language file ─────────────────────────────────────────────────
async function repairLang(lang) {
  const langName = LANG_NAMES[lang];
  const outFile  = path.join(locales, `${lang}.json`);
  const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  // Find keys that are still in Slovak
  const todo = {};
  for (const key of skKeys) {
    if (needsTranslation(key, existing[key])) todo[key] = sk[key];
  }

  const todoCount = Object.keys(todo).length;
  if (todoCount === 0) {
    console.log(`  ${lang}: nothing to repair ✓\n`);
    return;
  }
  console.log(`  ${lang}: ${todoCount} keys still in Slovak — translating in chunks of 15`);

  const parts   = splitObj(todo, 15);
  let patched   = 0;

  for (let i = 0; i < parts.length; i++) {
    process.stdout.write(`    chunk ${i + 1}/${parts.length}... `);
    let ok = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const translated = await translateChunk(parts[i], langName);
        Object.assign(existing, translated);
        patched += Object.keys(parts[i]).length;
        process.stdout.write('✓\n');
        ok = true;
        break;
      } catch (err) {
        if (attempt < 4) {
          process.stdout.write(`retry${attempt}... `);
          await new Promise(r => setTimeout(r, 1500 * attempt));
        } else {
          process.stdout.write(`✗ (${err.message}) — keeping SK\n`);
        }
      }
    }
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  fs.writeFileSync(outFile, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`  ✓ ${lang}.json: patched ${patched} keys\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const langs = Object.keys(LANG_NAMES).filter(l => l !== 'sk');
  console.log(`Scanning ${langs.length} language files for untranslated keys...\n`);

  for (const lang of langs) {
    const outFile = path.join(locales, `${lang}.json`);
    if (!fs.existsSync(outFile)) {
      console.log(`  ${lang}: file missing, skipping\n`);
      continue;
    }
    console.log(`${lang} (${LANG_NAMES[lang]}):`);
    try {
      await repairLang(lang);
    } catch (err) {
      console.error(`  ✗ ${lang}: ${err.message}\n`);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log('Done! Run: git add public/locales/ && git commit -m "patch translations"');
}

main().catch(console.error);
