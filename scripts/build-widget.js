// Minifies src/widget.js (the human-edited source) into public/widget.js
// (the file server.js actually serves at /widget.js). Runs automatically
// before `npm start` via the "prestart" script, and can be run by hand
// with `npm run build:widget`.
//
// Edit src/widget.js, never public/widget.js directly — it's a build
// artifact and gets overwritten.
'use strict';

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const SRC = path.join(__dirname, '..', 'src', 'widget.js');
const OUT = path.join(__dirname, '..', 'public', 'widget.js');
const BANNER = '/* Neoworkly Embeddable Widget — minified build. Source: src/widget.js */';

async function build() {
  const code = fs.readFileSync(SRC, 'utf8');
  const result = await minify(code, {
    compress: true,
    mangle: true,
    format: { comments: false }
  });
  if (!result.code) throw new Error('terser produced no output');
  fs.writeFileSync(OUT, BANNER + '\n' + result.code + '\n');
  const before = Buffer.byteLength(code, 'utf8');
  const after = Buffer.byteLength(result.code, 'utf8');
  console.log(`widget.js built: ${(before / 1024).toFixed(1)} KiB -> ${(after / 1024).toFixed(1)} KiB`);
}

build().catch(err => {
  console.error('widget build failed:', err);
  process.exit(1);
});
