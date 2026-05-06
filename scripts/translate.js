'use strict';

/**
 * Translation script — uses Claude Haiku to translate sk.json into other languages.
 *
 * USAGE:
 *   node scripts/translate.js                  # update all langs (add missing keys only)
 *   node scripts/translate.js --full           # retranslate everything (overwrite existing)
 *   node scripts/translate.js --lang en,de     # update specific languages only
 *   node scripts/translate.js --lang en --full # full retranslate for one language
 *   node scripts/translate.js --dry-run        # show what would be translated, don't write
 *
 * Requires: ANTHROPIC_API_KEY in env or .env file
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const locales = path.join(__dirname, '..', 'public', 'locales');

const ALL_LANGS = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pl: 'Polish',
  cs: 'Czech',
  hu: 'Hungarian',
  ro: 'Romanian',
  hr: 'Croatian',
};

// ── CLI args ──────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const isFull  = args.includes('--full');
const isDry   = args.includes('--dry-run');
const langArg = args.find(a => a.startsWith('--lang=') || a.startsWith('--lang '));
const langVal = langArg ? (langArg.split(/[= ]/)[1] || args[args.indexOf(langArg) + 1]) : null;

const LANGS = langVal
  ? Object.fromEntries(
      langVal.split(',')
        .map(l => l.trim())
        .filter(l => ALL_LANGS[l])
        .map(l => [l, ALL_LANGS[l]])
    )
  : ALL_LANGS;

if (Object.keys(LANGS).length === 0) {
  console.error('No valid languages specified. Available:', Object.keys(ALL_LANGS).join(', '));
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function chunk(obj, size) {
  const keys   = Object.keys(obj);
  const chunks = [];
  for (let i = 0; i < keys.length; i += size) {
    const c = {};
    keys.slice(i, i + size).forEach(k => { c[k] = obj[k]; });
    chunks.push(c);
  }
  return chunks;
}

async function translateChunk(skChunk, langName, attempt = 1) {
  const prompt = `Translate the JSON values from Slovak to ${langName}.
Return ONLY a valid JSON object — no explanation, no markdown, no code fences.
Rules:
- Keys stay unchanged (they are Slovak source strings)
- Keep brand names unchanged: Neoworkly, AI Coach, WooCommerce, GDPR, CTA, API, Instagram, Facebook, Stripe, DataForSEO, Schema.org, llms.txt, Growth Boost, Boost token
- Keep {variable} and {placeholder} patterns unchanged
- Keep emoji unchanged
- Keep HTML entities (e.g. &lt;, &#10;) unchanged

${JSON.stringify(skChunk, null, 2)}`;

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = response.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in response');
  return JSON.parse(match[0]);
}

async function translateKeys(keysToTranslate, langName) {
  const chunks = chunk(keysToTranslate, 50);
  const result = {};

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`    chunk ${i + 1}/${chunks.length}... `);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const translated = await translateChunk(chunks[i], langName, attempt);
        Object.assign(result, translated);
        process.stdout.write('✓\n');
        break;
      } catch (err) {
        if (attempt < 3) {
          process.stdout.write(`retry ${attempt}... `);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          process.stdout.write(`✗ (${err.message}) — using Slovak fallback\n`);
          Object.assign(result, chunks[i]);
        }
      }
    }

    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sk = loadJson(path.join(locales, 'sk.json'));
  const skKeys = Object.keys(sk);

  if (skKeys.length === 0) {
    console.error('sk.json is empty or missing!');
    process.exit(1);
  }

  console.log(`\nSource: sk.json — ${skKeys.length} keys`);
  console.log(`Mode:   ${isFull ? 'FULL (retranslate everything)' : 'UPDATE (missing keys only)'}`);
  console.log(`Langs:  ${Object.keys(LANGS).join(', ')}`);
  if (isDry) console.log('DRY RUN — nothing will be written\n');
  console.log('');

  for (const [lang, langName] of Object.entries(LANGS)) {
    const outFile  = path.join(locales, `${lang}.json`);
    const existing = loadJson(outFile);

    // Find missing keys
    const missingKeys = isFull
      ? sk   // full mode: retranslate all
      : Object.fromEntries(
          skKeys
            .filter(k => existing[k] === undefined)
            .map(k => [k, sk[k]])
        );

    const missingCount = Object.keys(missingKeys).length;

    if (missingCount === 0) {
      console.log(`${lang} (${langName}): ✓ up to date (${skKeys.length} keys)`);
      continue;
    }

    console.log(`${lang} (${langName}): ${missingCount} key${missingCount > 1 ? 's' : ''} to translate${isFull ? ' (full)' : ' (new)'}`);

    if (isDry) {
      const preview = Object.keys(missingKeys).slice(0, 5);
      preview.forEach(k => console.log(`    "${k}"`));
      if (missingCount > 5) console.log(`    ... and ${missingCount - 5} more`);
      console.log('');
      continue;
    }

    try {
      const translated = await translateKeys(missingKeys, langName);

      let finalResult;
      if (isFull) {
        // Full mode: replace entirely but keep key order from sk.json
        finalResult = {};
        for (const k of skKeys) {
          finalResult[k] = translated[k] ?? sk[k];
        }
      } else {
        // Update mode: merge new translations into existing file
        // Preserve existing translations, add new ones at the end
        finalResult = { ...existing };
        for (const k of skKeys) {
          if (!(k in finalResult)) {
            finalResult[k] = translated[k] ?? sk[k];
          }
        }
        // Remove keys that no longer exist in sk.json (cleanup)
        const skKeySet = new Set(skKeys);
        for (const k of Object.keys(finalResult)) {
          if (!skKeySet.has(k)) delete finalResult[k];
        }
      }

      fs.writeFileSync(outFile, JSON.stringify(finalResult, null, 2), 'utf8');
      const added = Object.keys(finalResult).length - Object.keys(existing).length;
      console.log(`  ✓ saved ${path.basename(outFile)} (+${Math.max(0, added)} added, ${Object.keys(finalResult).length} total)\n`);
    } catch (err) {
      console.error(`  ✗ failed: ${err.message}\n`);
    }

    // Pause between languages to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
