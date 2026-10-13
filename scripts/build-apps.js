// Zostaví editory tímových modulov (React/knižnice) zo src/apps/*.js(x) do public/apps/.
// Výstup je v gite – produkčný server nič nezostavuje. Spustenie: npm run build:apps
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src', 'apps');
const OUT = path.join(__dirname, '..', 'public', 'apps');

async function build() {
  const entries = fs.readdirSync(SRC).filter(f => /^[a-z-]+\.jsx?$/.test(f)).map(f => path.join(SRC, f));
  if (!entries.length) return console.log('Žiadne aplikácie na zostavenie.');
  const result = await esbuild.build({
    entryPoints: entries, outdir: OUT, bundle: true, minify: true, format: 'iife', target: ['es2020'],
    loader: { '.js': 'jsx', '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
    legalComments: 'external', metafile: true, logLevel: 'warning',
  });
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    if (/\.(js|css)$/.test(file)) console.log(`${path.relative(process.cwd(), file)}  ${(info.bytes / 1024).toFixed(0)} KiB`);
  }
}

build().catch(err => { console.error(err); process.exit(1); });
