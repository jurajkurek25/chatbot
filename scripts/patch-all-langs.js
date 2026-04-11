'use strict';
// Translates the manually-identified hard keys into all non-SK, non-EN languages.
// Uses the same __DQ__ placeholder technique as repair-translations.js.
// Run: node scripts/patch-all-langs.js
// Run single lang: node scripts/patch-all-langs.js de

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const locales = path.join(__dirname, '..', 'public', 'locales');

const LANG_NAMES = {
  de: 'German', fr: 'French', es: 'Spanish', pl: 'Polish',
  cs: 'Czech',  hu: 'Hungarian', ro: 'Romanian', hr: 'Croatian',
};

// ── Quote placeholder helpers ─────────────────────────────────────────────────
const DQ = '__DQ__';
const sanitize   = s => s.replace(/"/g, DQ);
const desanitize = s => s.replace(/__DQ__/g, '"');

function sanitizeObj(obj) {
  const sanitized = {}, keyMap = {};
  for (const [k, v] of Object.entries(obj)) {
    const sk2 = sanitize(k);
    sanitized[sk2] = sanitize(v);
    keyMap[sk2] = k;
  }
  return { sanitized, keyMap };
}

function restoreObj(translated, keyMap) {
  const out = {};
  for (const [sk2, sv] of Object.entries(translated)) {
    const origKey = keyMap[sk2] ?? desanitize(sk2);
    out[origKey] = desanitize(sv);
  }
  return out;
}

// ── Keys that need patching (Slovak originals) ────────────────────────────────
const PATCH_KEYS = {
  'Funkcie':            'Funkcie',
  'Leady':              'Leady',
  '📋 Leady':           '📋 Leady',
  'Cena':               'Cena',
  '/mesiac':            '/mesiac',
  'GDPR v cene':        'GDPR v cene',
  'Podmienky':          'Podmienky',
  'Kontakt':            'Kontakt',
  'Ako to funguje':     'Ako to funguje',
  'Ako to funguje?':    'Ako to funguje?',
  'Zaregistrujte sa':   'Zaregistrujte sa',
  'Ako vyzerá váš biznis,': 'Ako vyzerá váš biznis,',
  'neviete':            'neviete',
  'alebo zabudol.':     'alebo zabudol.',
  'AI reaguje na':      'AI reaguje na',
  'GDPR & Dokumenty':   'GDPR & Dokumenty',
  '✓ Import z CSV':     '✓ Import z CSV',
  '✓ Shopify skenovanie': '✓ Shopify skenovanie',
  'Nie chatbot. Vyškolený AI obchodník.':
    'Nie chatbot. Vyškolený AI obchodník.',
  'Vidím sa v tom ↓':   'Vidím sa v tom ↓',
  'Námietky':           'Námietky',
  '– len tušíte, že konverzia je nízka.':
    '– len tušíte, že konverzia je nízka.',
  'Veľké riešenia sú pre vás príliš drahé':
    'Veľké riešenia sú pre vás príliš drahé',
  'Čo keby mal váš web': 'Čo keby mal váš web',
  'čo nikdy nespí?':    'čo nikdy nespí?',
  '– a stálo to čas aj peniaze.': '– a stálo to čas aj peniaze.',
  'Vy chcete výsledok zajtra, nie IT projekt.':
    'Vy chcete výsledok zajtra, nie IT projekt.',
  'Intercom, ManyChat, Salesforce – tisíce eur, mesiace nastavení.':
    'Intercom, ManyChat, Salesforce – tisíce eur, mesiace nastavení.',
  '„Aká je cena?" – desiaty krát dnes':
    '„Aká je cena?" – desiaty krát dnes',
  'Spracúva námietky automaticky': 'Spracúva námietky automaticky',
  'typické námietky vášho odvetvia': 'typické námietky vášho odvetvia',
  'AI pripravuje vášho predajcu…': 'AI pripravuje vášho predajcu…',
  'AI karty leadov odhaľujú vzory – aké námietky sú najčastejšie, čo ich blokuje.':
    'AI karty leadov odhaľujú vzory – aké námietky sú najčastejšie, čo ich blokuje.',
  'Chatbot rieši „Aká je cena?" tisíckrát. Vy sa venujete práci s hodnotou.':
    'Chatbot rieši „Aká je cena?" tisíckrát. Vy sa venujete práci s hodnotou.',
  // Text nodes split around <strong> — key includes leading , or . punctuation
  ', ponúka riešenie cez benefity a uzatvára predaj. Nie náhodne – systematicky.':
    ', ponúka riešenie cez benefity a uzatvára predaj. Nie náhodne – systematicky.',
  'ktoré zákazník pochopí a ocení. Nie „8GB RAM" ale „pobeží ti na tom video editovanie".':
    'ktoré zákazník pochopí a ocení. Nie „8GB RAM" ale „pobeží ti na tom video editovanie".',
  '. Proaktívna bublina to zmení.': '. Proaktívna bublina to zmení.',
  '. AI sa riadi týmito pravidlami a zákazníkovi navrhne správny produkt v správnom momente.':
    '. AI sa riadi týmito pravidlami a zákazníkovi navrhne správny produkt v správnom momente.',
  ', vždy s priamym odkazom na nákup.': ', vždy s priamym odkazom na nákup.',
  'keď': 'keď',
  'AI obchodník robí svoju prácu': 'AI obchodník robí svoju prácu',
  'Zadajte URL vášho webu – AI ho naskenuje automaticky. Alebo nahrajte PDF, texty, cenníky drag & drop. AI navrhne otázky ihneď po spracovaní.':
    'Zadajte URL vášho webu – AI ho naskenuje automaticky. Alebo nahrajte PDF, texty, cenníky drag & drop. AI navrhne otázky ihneď po spracovaní.',
  'Opíšete váš produkt, cieľovku, námietky – AI si':
    'Opíšete váš produkt, cieľovku, námietky – AI si',
  '– kladie otázky, identifikuje problém zákazníka, spracúva námietky a aktívne uzatvára predaj. Na webe aj v Instagram DMs.':
    '– kladie otázky, identifikuje problém zákazníka, spracúva námietky a aktívne uzatvára predaj. Na webe aj v Instagram DMs.',
  'NeuraDesk sa naučí váš produkt, vaše ceny, vaše námietky – a vedie každého návštevníka od prvej otázky po uzavretý predaj. Presne tak, ako by ste to robili vy, len':
    'NeuraDesk sa naučí váš produkt, vaše ceny, vaše námietky – a vedie každého návštevníka od prvej otázky po uzavretý predaj. Presne tak, ako by ste to robili vy, len',
  'Napíšte čo predávate — za 10 sekúnd uvidíte, ako váš chatbot kladie otázky, rieši námietky a uzatvára predaj.':
    'Napíšte čo predávate — za 10 sekúnd uvidíte, ako váš chatbot kladie otázky, rieši námietky a uzatvára predaj.',
  'Je to skutočný predajný AI. Má zabudovaný 5-fázový framework (Discovery → Pain → Solution → Objections → Close), kladie otázky namiesto len odpovedania, identifikuje problém zákazníka a spracúva námietky. To je fundamentálny rozdiel oproti chatbotom, čo len hľadajú v FAQ.':
    'Je to skutočný predajný AI. Má zabudovaný 5-fázový framework (Discovery → Pain → Solution → Objections → Close), kladie otázky namiesto len odpovedania, identifikuje problém zákazníka a spracúva námietky. To je fundamentálny rozdiel oproti chatbotom, čo len hľadajú v FAQ.',
};

// ── Split into chunks ─────────────────────────────────────────────────────────
function splitObj(obj, size) {
  const entries = Object.entries(obj);
  const parts = [];
  for (let i = 0; i < entries.length; i += size)
    parts.push(Object.fromEntries(entries.slice(i, i + size)));
  return parts;
}

// ── Translate one chunk ───────────────────────────────────────────────────────
async function translateChunk(skChunk, langName) {
  const { sanitized, keyMap } = sanitizeObj(skChunk);
  const prompt = `Translate JSON values from Slovak to ${langName}. Return ONLY a valid JSON object — no explanation, no markdown, no code blocks.
Rules: keep keys EXACTLY unchanged, keep brand names (NeuraDeskApp, NeuraDesk, AI Coach, WooCommerce, GDPR, CTA, API, Instagram), keep {variable} placeholders, keep __DQ__ tokens as-is.

${JSON.stringify(sanitized)}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text  = response.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return restoreObj(JSON.parse(match[0]), keyMap);
}

// ── Patch one language ────────────────────────────────────────────────────────
async function patchLang(lang) {
  const langName = LANG_NAMES[lang];
  const outFile  = path.join(locales, `${lang}.json`);

  if (!fs.existsSync(outFile)) {
    console.log(`  ${lang}: file missing — run repair-translations.js first\n`);
    return;
  }

  const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const done     = new Set(existing.__done__ || []);

  // Remove patch keys from __done__ so they get re-translated
  for (const k of Object.keys(PATCH_KEYS)) done.delete(k);

  const parts = splitObj(PATCH_KEYS, 15);
  let patched = 0;

  console.log(`${lang} (${langName}): translating ${Object.keys(PATCH_KEYS).length} keys in ${parts.length} chunk(s)`);

  for (let i = 0; i < parts.length; i++) {
    process.stdout.write(`  chunk ${i + 1}/${parts.length}... `);
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const translated = await translateChunk(parts[i], langName);
        Object.assign(existing, translated);
        Object.keys(parts[i]).forEach(k => done.add(k));
        patched += Object.keys(parts[i]).length;
        process.stdout.write('✓\n');
        break;
      } catch (err) {
        if (attempt < 4) {
          process.stdout.write(`retry${attempt}... `);
          await new Promise(r => setTimeout(r, 1500 * attempt));
        } else {
          process.stdout.write(`✗ (${err.message})\n`);
        }
      }
    }
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  existing.__done__ = [...done].sort();
  fs.writeFileSync(outFile, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`  ✓ ${lang}.json: patched ${patched} keys\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const targetLang = process.argv[2];
  const langs = targetLang
    ? [targetLang].filter(l => LANG_NAMES[l])
    : Object.keys(LANG_NAMES);

  console.log(`Patching ${Object.keys(PATCH_KEYS).length} keys into ${langs.length} language(s)...\n`);

  for (const lang of langs) {
    try { await patchLang(lang); } catch (err) { console.error(`  ✗ ${lang}: ${err.message}\n`); }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log('Done! Run: git add public/locales/ && git commit -m "patch all langs"');
}

main().catch(console.error);
