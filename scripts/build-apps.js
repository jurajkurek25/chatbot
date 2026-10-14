// Zostaví editory tímových modulov (React/knižnice) zo src/apps/*.js(x) do public/apps/.
// Výstup je v gite – produkčný server nič nezostavuje. Spustenie: npm run build:apps
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src', 'apps');
const OUT = path.join(__dirname, '..', 'public', 'apps');

// CSS @import "balík/style.css" – esbuild ich v CSS nerieši cez exports s podmienkou "style"; Node áno
const cssFromPackages = {
  name: 'css-from-packages',
  setup(b) {
    b.onResolve({ filter: /^[^./].*\.css$/ }, args => {
      try { return { path: require.resolve(args.path, { paths: [args.resolveDir] }) }; } catch { return undefined; }
    });
  },
};

// Aplikácie s množstvom súborov majú vlastný priečinok; Excalidraw ide ako ES modul s rozdelením (jazyky sa načítajú až pri potrebe)
const OWN = { 'doc-editor.js': { dir: 'doc', esm: true }, 'board-editor.jsx': { dir: 'board', esm: true }, 'sheet-editor.js': { dir: 'sheet', esm: true }, 'graphic-editor.js': { dir: 'graphic', esm: true }, 'pdf-tool.js': { dir: 'pdf', esm: true }, 'video-tool.js': { dir: 'video', esm: true } };
const common = {
  bundle: true, minify: true, target: ['es2020'],
  loader: { '.js': 'jsx', '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  legalComments: 'external', metafile: true, logLevel: 'warning', conditions: ['production'],
  plugins: [cssFromPackages],
};

/** Písma Excalidraw na vlastný server (bez 13 MB čínskeho Xiaolai – ten sa pri potrebe načíta z CDN). */
function copyExcalidrawFonts() {
  const from = path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts'); // dist/prod/index.js → dist/prod/fonts
  const to = path.join(OUT, 'excalidraw', 'fonts');
  fs.rmSync(to, { recursive: true, force: true });
  for (const family of fs.readdirSync(from).filter(f => f !== 'Xiaolai')) fs.cpSync(path.join(from, family), path.join(to, family), { recursive: true });
}

async function build() {
  const files = fs.readdirSync(SRC).filter(f => /^[a-z-]+\.jsx?$/.test(f));
  if (!files.length) return console.log('Žiadne aplikácie na zostavenie.');
  const outputs = [];
  const iife = files.filter(f => !OWN[f]).map(f => path.join(SRC, f));
  if (iife.length) outputs.push((await esbuild.build({ ...common, entryPoints: iife, outdir: OUT, format: 'iife' })).metafile.outputs);
  for (const [f, { dir, esm }] of Object.entries(OWN).filter(([f]) => files.includes(f))) {
    fs.rmSync(path.join(OUT, dir), { recursive: true, force: true });
    const opts = esm ? { format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]' } : { format: 'iife' };
    outputs.push((await esbuild.build({ ...common, ...opts, entryPoints: [path.join(SRC, f)], outdir: path.join(OUT, dir) })).metafile.outputs);
  }
  if (files.includes('board-editor.jsx')) copyExcalidrawFonts();
  // pdf.js vykresľuje strany v samostatnom vlákne
  if (files.includes('pdf-tool.js')) fs.copyFileSync(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build', 'pdf.worker.min.mjs'), path.join(OUT, 'pdf', 'pdf.worker.min.mjs'));
  for (const [file, info] of outputs.flatMap(o => Object.entries(o))) {
    if (/\.(js|css)$/.test(file) && !/chunks\//.test(file)) console.log(`${path.relative(process.cwd(), file)}  ${(info.bytes / 1024).toFixed(0)} KiB`);
  }
}

build().catch(err => { console.error(err); process.exit(1); });
