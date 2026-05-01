'use strict';
/**
 * retranslate-missing.js — Retranslate keys that are still identical to Slovak source
 * 
 * Usage: node scripts/retranslate-missing.js [lang...]
 *   node scripts/retranslate-missing.js            — all languages
 *   node scripts/retranslate-missing.js en de      — specific languages
 */
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const PUBLIC  = path.join(__dirname, '..', 'public');
const LOCALES = path.join(PUBLIC, 'locales');

const LANG_NAMES = {
  en:'English', de:'German', fr:'French', es:'Spanish',
  pl:'Polish', cs:'Czech', hu:'Hungarian', ro:'Romanian', hr:'Croatian'
};

const BRAND = new Set([
  'Neoworkly','AI','GDPR','CTA','API','Instagram','Stripe','WordPress','Shopify',
  'PDF','URL','DM','ROI','NEOW','WhatsApp','YouTube','Vimeo','Ecomail',
  'Messenger','Facebook','Google','SEO','CSV','Pro','IČO',
]);

const SKIP_PATTERNS = [
  /^[A-Z_]+$/,/^\d/,/^https?:\/\//,/^[a-z-]+\.[a-z]{2,}/,/^@/,
  /^#[0-9a-f]/i,/^[+\-\d\s€$%.,/()]+$/,
];

function isGenuinelyUntranslated(key) {
  if (BRAND.has(key.trim())) return false;
  if (SKIP_PATTERNS.some(p => p.test(key.trim()))) return false;
  if (!/[a-zA-ZÀ-ž]/.test(key)) return false;
  return true;
}

function extractFromHTML(file) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const found = new Set();
  const c = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const re = />([^<]+)</g; let m;
  while ((m = re.exec(c)) !== null) {
    const s = m[1].trim()
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&nbsp;/g,' ').replace(/&mdash;/g,'—').replace(/&hellip;/g,'…');
    if (s.length >= 3 && /[a-zA-ZÀ-ž]/.test(s)) found.add(s);
  }
  ['placeholder','title','alt'].forEach(attr => {
    const ar = new RegExp(`\\b${attr}\\s*=\\s*"([^"]+)"`, 'g');
    while ((m = ar.exec(c)) !== null) {
      const s = m[1].trim();
      if (s.length >= 3 && /[a-zA-ZÀ-ž]/.test(s)) found.add(s);
    }
  });
  return found;
}

function chunk(obj, size) {
  const e = Object.entries(obj), p = [];
  for (let i = 0; i < e.length; i += size) p.push(Object.fromEntries(e.slice(i, i + size)));
  return p;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function translateChunk(obj, langName, client) {
  const prompt = `Translate these JSON values from Slovak to ${langName}.
Return ONLY valid JSON — no markdown, no explanation, no code fences.
Rules:
- Keep keys EXACTLY unchanged
- Keep brand names unchanged: ${[...BRAND].join(', ')}
- Keep {variable} tokens unchanged
- Keep emojis unchanged

${JSON.stringify(obj)}`;

  const r = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = r.content[0].text.trim().replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('✗ ANTHROPIC_API_KEY not set'); process.exit(1);
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const args = process.argv.slice(2);
  const targetLangs = args.filter(a => LANG_NAMES[a]);
  const langs = targetLangs.length ? targetLangs : Object.keys(LANG_NAMES);

  const sk = JSON.parse(fs.readFileSync(path.join(LOCALES, 'sk.json'), 'utf8'));

  // Collect strings from dashboard + index
  const htmlStrings = new Set([
    ...extractFromHTML('dashboard.html'),
    ...extractFromHTML('index.html'),
    ...extractFromHTML('onboarding.html'),
    ...extractFromHTML('demo.html'),
    ...extractFromHTML('present.html'),
  ]);

  const targetKeys = [...htmlStrings].filter(s => sk[s]);
  console.log(`\nTarget keys (in sk.json): ${targetKeys.length}`);

  for (const lang of langs) {
    const langName = LANG_NAMES[lang];
    const outFile  = path.join(LOCALES, `${lang}.json`);
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    // Find keys that are missing OR identical to Slovak source (not a brand/skip)
    const toRetranslate = {};
    for (const key of targetKeys) {
      if (!existing[key] || (existing[key] === sk[key] && isGenuinelyUntranslated(key))) {
        toRetranslate[key] = sk[key];
      }
    }

    if (Object.keys(toRetranslate).length === 0) {
      console.log(`\n${lang}: all up to date ✓`);
      continue;
    }

    console.log(`\n${lang} (${langName}): ${Object.keys(toRetranslate).length} keys to translate`);
    const chunks = chunk(toRetranslate, 40);

    for (let i = 0; i < chunks.length; i++) {
      process.stdout.write(`  chunk ${i+1}/${chunks.length}... `);
      let ok = false;
      for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
        try {
          const translated = await translateChunk(chunks[i], langName, client);
          Object.assign(existing, translated);
          process.stdout.write('✓\n');
          ok = true;
        } catch (e) {
          if (attempt < 4) { process.stdout.write(`retry${attempt}... `); await delay(1500 * attempt); }
          else { process.stdout.write(`✗ (${e.message})\n`); }
        }
      }
      if (i < chunks.length - 1) await delay(400);
    }

    fs.writeFileSync(outFile, JSON.stringify(existing, null, 2), 'utf8');
    console.log(`  ✓ ${lang}.json saved`);
    await delay(600);
  }

  console.log('\nDone! Run: git add public/locales/ && git commit -m "sync: fill missing translations"');
}

main().catch(console.error);
