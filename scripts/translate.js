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

// Split into chunks of 150 keys to stay within token limits
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

async function translateChunk(skChunk, lang, langName) {
  const prompt = `You are a professional translator specialising in SaaS and business software UI.
Translate the VALUES of this JSON object from Slovak to ${langName}.
RULES:
- Keep ALL JSON keys exactly as-is (they are Slovak text used as translation keys)
- Only translate the values
- Keep {variable} and %{variable} placeholders unchanged
- Keep brand names unchanged: NeuraDeskApp, NeuraDesk, AI Coach, WooCommerce, Elementor, GDPR, CTA, API, Instagram
- Use professional, natural business language — not overly formal
- Return ONLY valid JSON, no markdown, no explanation

${JSON.stringify(skChunk, null, 2)}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function translateLang(lang, langName) {
  const chunks = chunk(sk, 150);
  const result = {};

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  chunk ${i + 1}/${chunks.length}... `);
    try {
      const translated = await translateChunk(chunks[i], lang, langName);
      Object.assign(result, translated);
      process.stdout.write('✓\n');
    } catch (err) {
      process.stdout.write(`✗ (${err.message})\n`);
      // Use SK as fallback for failed chunk
      Object.assign(result, chunks[i]);
    }
    // Small delay between chunks
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
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
