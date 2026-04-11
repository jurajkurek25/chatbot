'use strict';

// Repairs only the chunks that failed in the previous translate.js run.
// Run this AFTER translate.js has already created all lang files.
// It reads existing files, re-translates only the failed key ranges, and patches in-place.

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const locales = path.join(__dirname, '..', 'public', 'locales');
const sk      = JSON.parse(fs.readFileSync(path.join(locales, 'sk.json'), 'utf8'));
const skKeys  = Object.keys(sk);

// Which 1-based chunk numbers failed per language (chunk size = 50 keys)
const FAILED = {
  de: [3, 12, 16, 17],
  pl: [16],
  cs: [3, 16],
  hu: [3, 5, 16],
  ro: [16],
  hr: [16, 17],
};

const LANG_NAMES = {
  de: 'German', pl: 'Polish', cs: 'Czech',
  hu: 'Hungarian', ro: 'Romanian', hr: 'Croatian',
};

// Return the sk sub-object for a given 1-based chunk number (original chunk size 50)
function chunkKeys(chunkNum, chunkSize = 50) {
  const start = (chunkNum - 1) * chunkSize;
  return skKeys.slice(start, start + chunkSize);
}

// Split an object into sub-chunks of `size`
function splitObj(obj, size) {
  const entries = Object.entries(obj);
  const parts = [];
  for (let i = 0; i < entries.length; i += size) {
    parts.push(Object.fromEntries(entries.slice(i, i + size)));
  }
  return parts;
}

async function translateChunk(skChunk, langName) {
  const prompt = `Translate JSON values from Slovak to ${langName}. Return ONLY a valid JSON object, nothing else — no explanation, no markdown, no code blocks.
Rules: keep keys unchanged, keep brand names (NeuraDeskApp, NeuraDesk, AI Coach, WooCommerce, GDPR, CTA, API, Instagram), keep {variable} placeholders.

${JSON.stringify(skChunk)}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text  = response.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function repairLang(lang, failedChunks) {
  const langName = LANG_NAMES[lang];
  const outFile  = path.join(locales, `${lang}.json`);
  const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  let patched = 0;

  for (const chunkNum of failedChunks) {
    const keys    = chunkKeys(chunkNum);
    const skChunk = Object.fromEntries(keys.map(k => [k, sk[k]]));

    // Re-split into sub-chunks of 25 to keep well within token limits
    const parts = splitObj(skChunk, 25);
    console.log(`  chunk ${chunkNum} (${keys.length} keys → ${parts.length} sub-chunks):`);

    for (let i = 0; i < parts.length; i++) {
      process.stdout.write(`    sub ${i + 1}/${parts.length}... `);
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
            process.stdout.write(`✗ (${err.message}) — keeping SK fallback\n`);
          }
        }
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`  ✓ ${lang}.json patched (${patched} keys updated)\n`);
}

async function main() {
  const total = Object.values(FAILED).reduce((s, a) => s + a.length, 0);
  console.log(`Repairing ${total} failed chunks across ${Object.keys(FAILED).length} languages...\n`);

  for (const [lang, chunks] of Object.entries(FAILED)) {
    console.log(`${lang} (${LANG_NAMES[lang]}) — failed chunks: ${chunks.join(', ')}`);
    try {
      await repairLang(lang, chunks);
    } catch (err) {
      console.error(`  ✗ ${lang} error: ${err.message}\n`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('Done! Commit public/locales/ when satisfied.');
}

main().catch(console.error);
