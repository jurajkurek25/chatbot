'use strict';

/**
 * Translation audit script — checks which keys are missing or untranslated per language.
 *
 * USAGE:
 *   node scripts/check-translations.js              # audit all languages
 *   node scripts/check-translations.js --lang en,de # audit specific languages
 *   node scripts/check-translations.js --lang en    # audit one language
 *   node scripts/check-translations.js --missing    # show only missing keys (skip untranslated)
 *   node scripts/check-translations.js --untranslated # show only keys with value == SK source
 *   node scripts/check-translations.js --json       # output as JSON (for scripts)
 */

const fs   = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'public', 'locales');

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

const args          = process.argv.slice(2);
const langArg       = args.find(a => a.startsWith('--lang=') || (args[args.indexOf(a) - 1] === '--lang'));
const langFilter    = (() => {
  const idx = args.indexOf('--lang');
  const val = idx !== -1 ? args[idx + 1] : (args.find(a => a.startsWith('--lang=')) || '').replace('--lang=', '');
  return val ? val.split(',').map(l => l.trim()).filter(Boolean) : null;
})();
const showMissing      = args.includes('--missing')      || (!args.includes('--untranslated'));
const showUntranslated = args.includes('--untranslated') || (!args.includes('--missing'));
const jsonOutput       = args.includes('--json');

// ── Colours (ANSI) ────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  bgRed:  '\x1b[41m',
};

function c(color, str) { return jsonOutput ? str : color + str + C.reset; }

// ── Load JSON ─────────────────────────────────────────────────────────────────

function loadJson(file) {
  try {
    const raw = fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8');
    const parsed = JSON.parse(raw);
    delete parsed.__done__;
    return parsed;
  } catch (e) {
    return null;
  }
}

// ── Main audit ────────────────────────────────────────────────────────────────

const sk = loadJson('sk.json');
if (!sk) {
  console.error('ERROR: Cannot read sk.json');
  process.exit(1);
}

const skKeys = Object.keys(sk);
const totalKeys = skKeys.length;

const langsToCheck = langFilter
  ? langFilter.filter(l => ALL_LANGS[l])
  : Object.keys(ALL_LANGS);

if (!jsonOutput) {
  console.log('');
  console.log(c(C.bold + C.cyan, '══════════════════════════════════════════════════'));
  console.log(c(C.bold + C.cyan, '  🌍  Neoworkly — Translation Audit'));
  console.log(c(C.bold + C.cyan, '══════════════════════════════════════════════════'));
  console.log(c(C.dim, `  Source: sk.json  (${totalKeys} keys)`));
  console.log(c(C.dim, `  Checking: ${langsToCheck.join(', ')}`));
  console.log('');
}

const report = {};
let anyProblems = false;

for (const lang of langsToCheck) {
  const langName = ALL_LANGS[lang];
  const data = loadJson(`${lang}.json`);

  if (!data) {
    if (!jsonOutput) {
      console.log(c(C.red, `  ✗ ${lang} (${langName}) — súbor sa nedá načítať!`));
    }
    report[lang] = { error: 'File not found or invalid JSON', missing: [], untranslated: [] };
    anyProblems = true;
    continue;
  }

  const missing       = [];
  const untranslated  = [];
  const ok            = [];

  for (const key of skKeys) {
    if (!(key in data)) {
      missing.push(key);
    } else if (data[key] === key) {
      // Value equals the Slovak key — likely not translated yet
      untranslated.push(key);
    } else {
      ok.push(key);
    }
  }

  // Extra keys in lang file not in sk.json (orphans)
  const orphans = Object.keys(data).filter(k => !(k in sk));

  report[lang] = { missing, untranslated, ok: ok.length, orphans, total: totalKeys };

  if (!jsonOutput) {
    const hasMissing      = missing.length > 0;
    const hasUntranslated = untranslated.length > 0;
    const hasOrphans      = orphans.length > 0;
    const perfect         = !hasMissing && !hasUntranslated;

    const statusIcon  = perfect ? c(C.green, '✓') : c(C.red, '✗');
    const pct         = Math.round((ok.length / totalKeys) * 100);
    const pctColor    = pct === 100 ? C.green : pct >= 80 ? C.yellow : C.red;

    console.log(c(C.bold, `  ${statusIcon} ${lang.toUpperCase()} — ${langName}`));
    console.log(`     Preložené: ${c(pctColor, `${ok.length}/${totalKeys} (${pct} %)`)}${hasOrphans ? c(C.dim, `  |  ${orphans.length} obsolete kľúčov`) : ''}`);

    if (hasMissing && showMissing) {
      console.log(`     ${c(C.red + C.bold, `CHÝBAJÚCE KĽÚČE (${missing.length}):`)}`);
      for (const key of missing) {
        const preview = key.length > 80 ? key.slice(0, 77) + '…' : key;
        console.log(`       ${c(C.red, '–')} ${c(C.dim, preview)}`);
      }
    } else if (hasMissing) {
      console.log(`     ${c(C.red, `⚠  ${missing.length} chýbajúcich kľúčov (použi --missing na zobrazenie)`)}`);
    }

    if (hasUntranslated && showUntranslated) {
      console.log(`     ${c(C.yellow + C.bold, `NEPRELOŽENÉ (hodnota = SK zdroj) (${untranslated.length}):`)}`);
      for (const key of untranslated) {
        const preview = key.length > 80 ? key.slice(0, 77) + '…' : key;
        console.log(`       ${c(C.yellow, '~')} ${c(C.dim, preview)}`);
      }
    } else if (hasUntranslated) {
      console.log(`     ${c(C.yellow, `⚠  ${untranslated.length} kľúčov s hodnotou = SK zdroj (použi --untranslated na zobrazenie)`)}`);
    }

    if (perfect) {
      console.log(`     ${c(C.green, '🎉 Všetky kľúče preložené!')}`);
    }

    if (hasOrphans && orphans.length <= 10) {
      console.log(`     ${c(C.dim, `Obsolete: ${orphans.join(', ')}`)}`)
    }

    console.log('');
    anyProblems = anyProblems || !perfect;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

if (!jsonOutput) {
  console.log(c(C.bold + C.cyan, '══════════════════════════════════════════════════'));
  console.log(c(C.bold, '  Súhrn'));
  console.log(c(C.bold + C.cyan, '══════════════════════════════════════════════════'));

  let totalMissing = 0;
  let totalUntranslated = 0;
  for (const lang of langsToCheck) {
    const r = report[lang];
    if (r.error) continue;
    const pct = Math.round((r.ok / r.total) * 100);
    const bar = buildBar(pct, 20);
    const col = pct === 100 ? C.green : pct >= 80 ? C.yellow : C.red;
    const missingStr      = r.missing.length      ? c(C.red,    ` -${r.missing.length} chýba`) : '';
    const untranslatedStr = r.untranslated.length  ? c(C.yellow, ` ~${r.untranslated.length} nepreložené`) : '';
    console.log(`  ${lang.toUpperCase().padEnd(3)} ${c(col, bar)} ${String(pct).padStart(3)} %${missingStr}${untranslatedStr}`);
    totalMissing      += r.missing.length;
    totalUntranslated += r.untranslated.length;
  }

  console.log('');
  if (totalMissing === 0 && totalUntranslated === 0) {
    console.log(c(C.green + C.bold, '  ✅  Všetky preklady sú kompletné!'));
  } else {
    if (totalMissing > 0) {
      console.log(c(C.red,    `  ✗  ${totalMissing} chýbajúcich kľúčov celkovo`));
      console.log(c(C.dim,    `     → Spusti: node scripts/translate.js`));
    }
    if (totalUntranslated > 0) {
      console.log(c(C.yellow, `  ~  ${totalUntranslated} kľúčov s hodnotou = SK zdroj`));
      console.log(c(C.dim,    `     → Spusti: node scripts/translate.js --full`));
    }
  }
  console.log('');
}

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
}

process.exit(anyProblems ? 1 : 0);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}
