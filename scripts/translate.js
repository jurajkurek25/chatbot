'use strict';

// Load .env if present (so you can run this script directly on the server)
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const locales   = path.join(__dirname, '..', 'public', 'locales');
const sk        = JSON.parse(fs.readFileSync(path.join(locales, 'sk.json'), 'utf8'));

const LANGS = {
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

// Split into chunks of 50 keys — smaller = safer JSON output, fewer token issues
function chunk(obj, size) {
  const keys = Object.keys(obj);
  const chunks = [];
  for (let i = 0; i < keys.length; i += size) {
    const c = {};
    keys.slice(i, i + size).forEach(k => { c[k] = obj[k]; });
    chunks.push(c);
  }
  return chunks;
}

async function translateChunk(skChunk, lang, langName, attempt = 1) {
  const prompt = `Translate JSON values from Slovak to ${langName}. Return ONLY a valid JSON object, nothing else — no explanation, no markdown, no code blocks.
Rules: keep keys unchanged, keep brand names (NeuraDeskApp, NeuraDesk, AI Coach, WooCommerce, GDPR, CTA, API, Instagram), keep {variable} placeholders.

${JSON.stringify(skChunk)}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  // Strip markdown code fences if present
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function translateLang(lang, langName) {
  const chunks = chunk(sk, 50);
  const result = {};

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  chunk ${i + 1}/${chunks.length}... `);
    let success = false;
    // Retry up to 3 times on failure
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const translated = await translateChunk(chunks[i], lang, langName, attempt);
        Object.assign(result, translated);
        process.stdout.write('✓\n');
        success = true;
        break;
      } catch (err) {
        if (attempt < 3) {
          process.stdout.write(`retry${attempt}... `);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          process.stdout.write(`✗ (${err.message})\n`);
          // SK fallback for this chunk
          Object.assign(result, chunks[i]);
        }
      }
    }
    // Delay between chunks to avoid rate limits
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  return result;
}

async function main() {
  console.log(`Translating ${Object.keys(sk).length} strings into ${Object.keys(LANGS).length} languages...\n`);

  for (const [lang, name] of Object.entries(LANGS)) {
    const outFile = path.join(locales, `${lang}.json`);
    if (fs.existsSync(outFile)) {
      console.log(`${lang}: already exists, skipping`);
      continue;
    }
    console.log(`${lang} (${name}):`);
    try {
      const translated = await translateLang(lang, name);
      fs.writeFileSync(outFile, JSON.stringify(translated, null, 2), 'utf8');
      console.log(`  ✓ saved ${path.basename(outFile)} (${Object.keys(translated).length} keys)\n`);
    } catch (err) {
      console.error(`  ✗ failed: ${err.message}\n`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Done!');
}

main().catch(console.error);
