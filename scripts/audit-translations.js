'use strict';
/**
 * audit-translations.js — Translation coverage report for NeuraDeskApp
 *
 * Shows:
 *   • Coverage table: which language files exist and how many keys they have
 *   • Keys found in HTML but MISSING from sk.json (need to be added to master)
 *   • Keys in sk.json that are missing from each language file
 *   • Per-file breakdown of missing strings
 *
 * Usage:
 *   node scripts/audit-translations.js             — full report
 *   node scripts/audit-translations.js --missing   — only show missing keys
 *   node scripts/audit-translations.js en          — check one language only
 *
 * No changes are made. Safe to run at any time.
 */

const fs   = require('fs');
const path = require('path');

const PUBLIC  = path.join(__dirname, '..', 'public');
const LOCALES = path.join(PUBLIC, 'locales');
const SK_FILE = path.join(LOCALES, 'sk.json');

const LANGUAGES = {
  sk: 'Slovenčina',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pl: 'Polski',
  cs: 'Čeština',
  hu: 'Magyar',
  ro: 'Română',
  hr: 'Hrvatski',
};

const HTML_FILES = [
  'index.html', 'dashboard.html', 'booking.html', 'onboarding.html',
  'demo.html',  'shopify.html',   'wordpress.html', '404.html',
];

const SKIP_EXACT = new Set([
  '✕', '×', '+', '−', '→', '←', '↓', '↑', '•', '…',
  '/', '/mesiac', '€', '$', '%', '●', '⚡', '✓', '✗',
]);

const SKIP_PATTERNS = [
  /^[\d\s.,€$%/\-:+×÷=()[\]{}]+$/,
  /^[A-Z_]{2,}$/,
  /^https?:\/\//,
  /^[a-z-]+\.[a-z]{2,4}$/i,
  /^#[0-9a-f]{3,8}$/i,
  /^\d{1,2}:\d{2}$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^v\d/i,
  /^[A-Z][a-z]+[A-Z]/,
  /^\s*$/,
];

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': '\u00a0', '&mdash;': '—', '&ndash;': '–',
  '&rarr;': '→', '&larr;': '←', '&hellip;': '…',
};

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
  for (const attr of ['placeholder', 'title', 'alt']) {
    const re = new RegExp(`\\b${attr}\\s*=\\s*"([^"]+)"`, 'g');
    while ((m = re.exec(c)) !== null) {
      const s = decodeEntities(m[1]).trim();
      if (isTranslatable(s)) found.add(s);
    }
  }
  return found;
}

// ── Colour helpers ──────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
};
const col = (c, s) => `${c}${s}${C.reset}`;
const pct = (n, total) => total === 0 ? '—' : `${Math.round(n / total * 100)}%`;
const bar = (n, total, width = 20) => {
  if (total === 0) return ' '.repeat(width);
  const filled = Math.round(n / total * width);
  const color = filled === width ? C.green : filled > width * 0.5 ? C.yellow : C.red;
  return col(color, '█'.repeat(filled)) + col(C.gray, '░'.repeat(width - filled));
};

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const args        = process.argv.slice(2);
  const missingOnly = args.includes('--missing');
  const singleLang  = args.find(a => LANGUAGES[a] && a !== 'sk');

  // ── 1. Load sk.json ────────────────────────────────────────────────────────
  if (!fs.existsSync(SK_FILE)) {
    console.error(col(C.red, 'ERROR: sk.json not found at ' + SK_FILE));
    process.exit(1);
  }
  const sk      = JSON.parse(fs.readFileSync(SK_FILE, 'utf8'));
  const skKeys  = new Set(Object.keys(sk));
  const skCount = skKeys.size;

  // ── 2. Scan HTML files ─────────────────────────────────────────────────────
  const foundInHTML  = new Map(); // string → Set of filenames
  const perFile      = {};        // file → Set of strings
  for (const file of HTML_FILES) {
    const fp = path.join(PUBLIC, file);
    if (!fs.existsSync(fp)) continue;
    const html = fs.readFileSync(fp, 'utf8');
    perFile[file] = extractFromHTML(html);
    for (const s of perFile[file]) {
      if (!foundInHTML.has(s)) foundInHTML.set(s, new Set());
      foundInHTML.get(s).add(file);
    }
  }

  // Strings in HTML but not in sk.json
  const missingFromSK = [];
  for (const [s, files] of foundInHTML) {
    if (!skKeys.has(s)) missingFromSK.push({ s, files: [...files] });
  }

  // ── HEADER ─────────────────────────────────────────────────────────────────
  console.log('\n' + col(C.bold, '═'.repeat(70)));
  console.log(col(C.bold + C.cyan, '  NeuraDesk Translation Audit'));
  console.log(col(C.bold, '═'.repeat(70)));
  console.log(`  sk.json master keys : ${col(C.bold, skCount)}`);
  console.log(`  HTML strings found  : ${col(C.bold, foundInHTML.size)}`);
  console.log(`  Missing from sk.json: ${missingFromSK.length > 0 ? col(C.red + C.bold, missingFromSK.length) : col(C.green, '0 ✓')}`);
  console.log(col(C.bold, '─'.repeat(70)));

  // ── COVERAGE TABLE ─────────────────────────────────────────────────────────
  if (!missingOnly) {
    console.log('\n' + col(C.bold, '  LANGUAGE FILE COVERAGE'));
    console.log(col(C.gray, '  ' + '-'.repeat(66)));
    const header = `  ${'Lang'.padEnd(5)} ${'Language'.padEnd(14)} ${'Keys'.padStart(6)}  ${'Coverage'.padEnd(10)} ${'Missing'.padStart(8)}  Progress`;
    console.log(col(C.bold, header));
    console.log(col(C.gray, '  ' + '-'.repeat(66)));

    const targetLangs = singleLang ? [singleLang] : Object.keys(LANGUAGES);
    for (const lang of targetLangs) {
      const langName = LANGUAGES[lang];
      const file     = path.join(LOCALES, `${lang}.json`);

      if (lang === 'sk') {
        const coverage = pct(skCount - missingFromSK.length, skCount);
        const notInHtml = [...skKeys].filter(k => !foundInHTML.has(k)).length;
        console.log(
          `  ${col(C.green, lang.toUpperCase().padEnd(5))} ${langName.padEnd(14)} ${String(skCount).padStart(6)}  ` +
          `${col(C.green, 'MASTER'.padEnd(10))} ${String(missingFromSK.length).padStart(8)}  ` +
          `${bar(skCount - missingFromSK.length, skCount)} (${notInHtml} dynamic keys)`
        );
        continue;
      }

      if (!fs.existsSync(file)) {
        const statusColor = singleLang === lang ? C.red : C.red;
        console.log(
          `  ${col(statusColor, lang.toUpperCase().padEnd(5))} ${langName.padEnd(14)} ${'0'.padStart(6)}  ` +
          `${col(C.red, '0%'.padEnd(10))} ${String(skCount).padStart(8)}  ` +
          `${bar(0, skCount)} ${col(C.red, '✗ FILE MISSING')}`
        );
        continue;
      }

      const existing    = JSON.parse(fs.readFileSync(file, 'utf8'));
      const existCount  = Object.keys(existing).length;
      const missingKeys = [...skKeys].filter(k => !existing[k]);
      const missCnt     = missingKeys.length;
      const coverage    = pct(existCount, skCount);
      const statusColor = missCnt === 0 ? C.green : missCnt < skCount * 0.1 ? C.yellow : C.red;

      console.log(
        `  ${col(statusColor, lang.toUpperCase().padEnd(5))} ${langName.padEnd(14)} ${String(existCount).padStart(6)}  ` +
        `${col(statusColor, coverage.padEnd(10))} ${String(missCnt).padStart(8)}  ` +
        `${bar(existCount, skCount)}`
      );
    }
    console.log(col(C.gray, '  ' + '-'.repeat(66)));
  }

  // ── PER-FILE BREAKDOWN ─────────────────────────────────────────────────────
  if (missingFromSK.length > 0) {
    console.log('\n' + col(C.bold + C.yellow, `  STRINGS IN HTML BUT NOT IN sk.json (${missingFromSK.length} total)`));
    console.log(col(C.gray, '  These need to be added to sk.json before translation.\n'));

    const byFile = {};
    for (const { s, files } of missingFromSK) {
      for (const f of files) {
        if (!byFile[f]) byFile[f] = [];
        byFile[f].push(s);
      }
    }
    for (const [file, strs] of Object.entries(byFile)) {
      console.log(col(C.cyan, `  📄 ${file} (${strs.length} missing)`));
      for (const s of strs) {
        const display = s.length > 90 ? s.slice(0, 87) + '…' : s;
        console.log(col(C.gray, '     • ') + display);
      }
      console.log();
    }
  } else {
    console.log('\n' + col(C.green, '  ✓ sk.json is fully up to date — all HTML strings are covered.'));
  }

  // ── MISSING KEYS PER LANGUAGE ──────────────────────────────────────────────
  if (!missingOnly) {
    const targetLangs = singleLang ? [singleLang] : Object.keys(LANGUAGES).filter(l => l !== 'sk');
    const anyMissing  = targetLangs.some(lang => {
      const file = path.join(LOCALES, `${lang}.json`);
      if (!fs.existsSync(file)) return true;
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      return [...skKeys].some(k => !existing[k]);
    });

    if (anyMissing) {
      console.log(col(C.bold + C.yellow, `  MISSING KEYS PER LANGUAGE`));
      console.log(col(C.gray, '  (first 10 missing keys shown per language)\n'));
      for (const lang of targetLangs) {
        const file = path.join(LOCALES, `${lang}.json`);
        if (!fs.existsSync(file)) {
          console.log(col(C.red, `  ${lang.toUpperCase()}: no file — run sync to create`));
          continue;
        }
        const existing    = JSON.parse(fs.readFileSync(file, 'utf8'));
        const missingKeys = [...skKeys].filter(k => !existing[k]);
        if (missingKeys.length === 0) {
          console.log(col(C.green, `  ${lang.toUpperCase()}: ✓ complete`));
          continue;
        }
        console.log(col(C.yellow, `  ${lang.toUpperCase()} (${missingKeys.length} missing):`));
        for (const k of missingKeys.slice(0, 10)) {
          const display = k.length > 75 ? k.slice(0, 72) + '…' : k;
          console.log(col(C.gray, '     • ') + display);
        }
        if (missingKeys.length > 10) console.log(col(C.gray, `     … and ${missingKeys.length - 10} more`));
        console.log();
      }
    } else {
      console.log('\n' + col(C.green, '  ✓ All language files are complete.'));
    }
  }

  // ── RECOMMENDED ACTIONS ────────────────────────────────────────────────────
  console.log(col(C.bold, '═'.repeat(70)));
  console.log(col(C.bold, '  RECOMMENDED ACTIONS'));
  console.log(col(C.bold, '─'.repeat(70)));

  if (missingFromSK.length > 0) {
    console.log(col(C.yellow, `  1. Add ${missingFromSK.length} missing strings to sk.json + translate all languages:`));
    console.log(col(C.cyan,   '     node scripts/sync-translations.js'));
  }

  const missingFiles = Object.keys(LANGUAGES).filter(l => l !== 'sk' && !fs.existsSync(path.join(LOCALES, `${l}.json`)));
  if (missingFiles.length > 0) {
    console.log(col(C.yellow, `  ${missingFromSK.length > 0 ? 2 : 1}. Create missing language files (${missingFiles.join(', ')}):`));
    console.log(col(C.cyan,   '     node scripts/sync-translations.js'));
    console.log(col(C.gray,   '     (requires ANTHROPIC_API_KEY in .env)'));
  }

  const allComplete = missingFromSK.length === 0 && missingFiles.length === 0;
  if (allComplete) {
    console.log(col(C.green, '  ✓ Everything is up to date! Nothing to do.'));
  }

  console.log(col(C.gray, '\n  Quick commands:'));
  console.log(col(C.gray, '  node scripts/audit-translations.js          — this report'));
  console.log(col(C.gray, '  node scripts/audit-translations.js en       — check one language'));
  console.log(col(C.gray, '  node scripts/sync-translations.js           — add missing + translate all'));
  console.log(col(C.gray, '  node scripts/sync-translations.js de        — translate one language only'));
  console.log(col(C.gray, '  node scripts/sync-translations.js --full    — rebuild all from scratch'));
  console.log(col(C.bold, '═'.repeat(70)) + '\n');
}

main();
