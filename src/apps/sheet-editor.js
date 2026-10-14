// Tabuľky Neoworkly: vlastný ľahký editor s výpočtom vzorcov (shared/formula.js) a spoluprácou cez Yjs.
// Y.Doc: „tabs“ (Y.Array hárkov {id, name}), „cells“ (Y.Map „hárok:r:c“ → { v, s }), „meta“ (šírky stĺpcov, počty riadkov…).
// Import/export XLSX cez exceljs (MIT) – načíta sa až pri použití. Zostavenie: npm run build:apps
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import F from '../../shared/formula.js';

const token = (() => { try { return localStorage.getItem('nd_token'); } catch { return null; } })();
const id = location.pathname.split('/').filter(Boolean).pop();
const ws = new URLSearchParams(location.search).get('ws') || '';
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOCAL = { local: true }; // pôvod lokálnych zmien (pre späť/znova)
const DEF_ROWS = 200, DEF_COLS = 26, DEF_W = 100;
const hue = s => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const initials = n => String(n || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();

let meta, ydoc, provider, tabs, cells, metaMap, undo;
let tab = null; // id aktuálneho hárka
let sel = { r: 0, c: 0, r2: 0, c2: 0 };
let editing = null; // { r, c, input }
let values = {}; // vypočítané hodnoty aktuálneho hárka 'r:c'
let readonly = false;

async function api(method, path, body) {
  const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}ws=${encodeURIComponent(ws)}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/'; throw new Error('401'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Chyba');
  return d;
}
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

/* ── Model ── */
const key = (r, c, t = tab) => `${t}:${r}:${c}`;
const cell = (r, c, t = tab) => cells.get(key(r, c, t));
const rowsOf = (t = tab) => metaMap.get(`${t}:rows`) || DEF_ROWS;
const colsOf = (t = tab) => metaMap.get(`${t}:cols`) || DEF_COLS;
const widthOf = c => metaMap.get(`${tab}:cw:${c}`) || DEF_W;
const tabList = () => { const seen = new Set(); return tabs.toArray().filter(t => (seen.has(t.id) ? false : seen.add(t.id))); };
const tabName = t => (tabList().find(x => x.id === t) || {}).name || '';
const change = fn => ydoc.transact(fn, LOCAL);

function setCell(r, c, patch, t = tab) {
  const cur = cell(r, c, t) || {};
  const next = { ...cur, ...patch };
  if (patch.s) next.s = { ...(cur.s || {}), ...patch.s };
  if ((next.v === undefined || next.v === '') && (!next.s || !Object.keys(next.s).length)) cells.delete(key(r, c, t));
  else cells.set(key(r, c, t), next);
}

/** Prepočet hodnôt aktuálneho hárka (s odkazmi na ostatné hárky podľa mena). */
function recompute() {
  const byTab = {};
  tabList().forEach(t => { byTab[t.name] = {}; });
  cells.forEach((v, k) => {
    const [t, r, c] = k.split(':');
    const name = tabName(t);
    if (name && v && v.v !== undefined) byTab[name][`${r}:${c}`] = v.v;
  });
  const cur = tabName(tab);
  const others = { ...byTab };
  delete others[cur];
  values = F.computeAll(byTab[cur] || {}, others, cur);
}

/* ── Vykreslenie ── */
function display(r, c) {
  const x = cell(r, c);
  if (!x || x.v === undefined || x.v === '') return '';
  const v = values[`${r}:${c}`];
  const s = x.s || {};
  return F.format(v, s.fmt, s.d);
}
function styleOf(r, c) {
  const x = cell(r, c);
  const s = (x && x.s) || {};
  const v = values[`${r}:${c}`];
  const st = [];
  if (s.b) st.push('font-weight:700');
  if (s.i) st.push('font-style:italic');
  if (s.u) st.push('text-decoration:underline');
  if (s.fg) st.push(`color:${s.fg}`);
  if (s.bg) st.push(`background:${s.bg}`);
  st.push(`text-align:${s.al || (typeof v === 'number' ? 'right' : F.isErr(v) ? 'center' : 'left')}`);
  if (F.isErr(v)) st.push('color:#ff6080');
  return st.join(';');
}

function renderGrid() {
  const rows = rowsOf(), cols = colsOf();
  const freeze = metaMap.get(`${tab}:freeze`);
  let h = `<table id="grid"><colgroup><col style="width:46px">${Array.from({ length: cols }, (_, c) => `<col style="width:${widthOf(c)}px">`).join('')}</colgroup>
    <thead><tr><th class="corner"></th>${Array.from({ length: cols }, (_, c) => `<th data-col="${c}">${F.indexToCol(c)}<span class="rs" data-resize="${c}"></span></th>`).join('')}</tr></thead><tbody>`;
  for (let r = 0; r < rows; r++) {
    h += `<tr${freeze && r === 0 ? ' class="frozen"' : ''}><th data-row="${r}">${r + 1}</th>`;
    for (let c = 0; c < cols; c++) h += `<td data-r="${r}" data-c="${c}" style="${styleOf(r, c)}">${esc(display(r, c))}</td>`;
    h += '</tr>';
  }
  h += '</tbody></table>';
  $('#gridWrap').innerHTML = h;
  $('#gridWrap').insertAdjacentHTML('beforeend', `<div class="more">${readonly ? '' : '<button id="addRows">+ 100 riadkov</button> <button id="addCols">+ 10 stĺpcov</button>'}</div>`);
  if ($('#addRows')) $('#addRows').onclick = () => change(() => metaMap.set(`${tab}:rows`, rowsOf() + 100));
  if ($('#addCols')) $('#addCols').onclick = () => change(() => metaMap.set(`${tab}:cols`, Math.min(200, colsOf() + 10)));
  paintSelection();
  paintPresence();
}

/** Aktualizuje iba zmenené bunky (bez prekreslenia celej tabuľky). */
function refreshCells() {
  const grid = $('#grid');
  if (!grid) return;
  grid.querySelectorAll('td').forEach(td => {
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    if (editing && editing.r === r && editing.c === c) return;
    const txt = display(r, c);
    if (td.textContent !== txt) td.textContent = txt;
    const st = styleOf(r, c);
    if (td.getAttribute('style') !== st) td.setAttribute('style', st);
  });
  paintSelection();
  paintPresence(); // style buniek sa prepísali – vrátiť rámiky kolegov
  stats();
}

const td = (r, c) => $(`#grid td[data-r="${r}"][data-c="${c}"]`);
const range = () => ({ r1: Math.min(sel.r, sel.r2), r2: Math.max(sel.r, sel.r2), c1: Math.min(sel.c, sel.c2), c2: Math.max(sel.c, sel.c2) });

function paintSelection() {
  document.querySelectorAll('#grid .sel, #grid .cur').forEach(e => e.classList.remove('sel', 'cur'));
  document.querySelectorAll('#grid th.hl').forEach(e => e.classList.remove('hl'));
  const g = range();
  for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) { const e = td(r, c); if (e) e.classList.add('sel'); }
  const cur = td(sel.r, sel.c);
  if (cur) cur.classList.add('cur');
  for (let c = g.c1; c <= g.c2; c++) { const e = $(`#grid th[data-col="${c}"]`); if (e) e.classList.add('hl'); }
  for (let r = g.r1; r <= g.r2; r++) { const e = $(`#grid th[data-row="${r}"]`); if (e) e.classList.add('hl'); }
  // pole, do ktorého práve niekto píše, neprepisujeme (prekreslenie po zmene od kolegu)
  if (document.activeElement !== $('#addr')) $('#addr').value = g.r1 === g.r2 && g.c1 === g.c2 ? F.addr(sel.r, sel.c) : `${F.addr(g.r1, g.c1)}:${F.addr(g.r2, g.c2)}`;
  if (!editing && document.activeElement !== $('#fx')) $('#fx').value = (cell(sel.r, sel.c) || {}).v ?? '';
  toolbarState();
  if (provider) provider.awareness.setLocalStateField('cell', { tab, r: sel.r, c: sel.c });
}

function paintPresence() {
  document.querySelectorAll('#grid .peer').forEach(e => { e.classList.remove('peer'); e.style.boxShadow = ''; e.removeAttribute('data-peer'); e.removeAttribute('title'); });
  const people = new Map();
  provider.awareness.getStates().forEach((s, clientId) => {
    if (s.user) people.set(s.user.id, s.user);
    if (clientId === ydoc.clientID || !s.cell || s.cell.tab !== tab) return;
    const e = td(s.cell.r, s.cell.c);
    if (!e) return;
    const col = `hsl(${hue(s.user.id)} 65% 55%)`;
    e.classList.add('peer');
    e.style.boxShadow = `inset 0 0 0 2px ${col}`;
    e.setAttribute('data-peer', initials(s.user.name));
    e.title = s.user.name;
    e.style.setProperty('--peer', col);
  });
  $('#people').innerHTML = [...people.values()].map(u => `<span title="${esc(u.name)}" style="background:hsl(${hue(u.id)} 55% 45%)">${initials(u.name)}</span>`).join('');
}

function stats() {
  const g = range();
  if (g.r1 === g.r2 && g.c1 === g.c2) { $('#stats').textContent = ''; return; }
  const nums = [];
  let count = 0;
  for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) { const v = values[`${r}:${c}`]; if (v !== undefined && v !== '') count++; if (typeof v === 'number') nums.push(v); }
  const sum = nums.reduce((a, b) => a + b, 0);
  $('#stats').textContent = nums.length ? `Súčet: ${F.format(sum)} · Priemer: ${F.format(Math.round((sum / nums.length) * 1e6) / 1e6)} · Počet: ${count}` : `Počet: ${count}`;
}

function toolbarState() {
  const s = ((cell(sel.r, sel.c) || {}).s) || {};
  $('#tbB').classList.toggle('on', !!s.b);
  $('#tbI').classList.toggle('on', !!s.i);
  $('#tbU').classList.toggle('on', !!s.u);
  document.querySelectorAll('[data-al]').forEach(b => b.classList.toggle('on', s.al === b.dataset.al));
  $('#tbFmt').value = s.fmt || 'general';
  $('#tbFreeze').classList.toggle('on', !!metaMap.get(`${tab}:freeze`));
}

function renderTabs() {
  $('#tabs').innerHTML = tabList().map(t => `<button class="tab ${t.id === tab ? 'on' : ''}" data-tab="${esc(t.id)}">${esc(t.name)}</button>`).join('') + (readonly ? '' : '<button class="tab add" id="addTab" title="Nový hárok">+</button>');
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.onclick = () => { if (tab !== b.dataset.tab) { commit(); tab = b.dataset.tab; sel = { r: 0, c: 0, r2: 0, c2: 0 }; recompute(); renderGrid(); renderTabs(); } };
    if (readonly) return;
    b.ondblclick = () => {
      const t = tabList().find(x => x.id === b.dataset.tab);
      const name = prompt('Názov hárka:', t.name);
      if (!name || name === t.name) return;
      if (tabList().some(x => x.name.toLowerCase() === name.trim().toLowerCase())) return toast('Hárok s týmto názvom už existuje.');
      change(() => { const i = tabs.toArray().findIndex(x => x.id === t.id); tabs.delete(i, 1); tabs.insert(i, [{ id: t.id, name: name.trim().slice(0, 40) }]); });
    };
    b.oncontextmenu = e => {
      e.preventDefault();
      if (tabList().length < 2) return toast('Posledný hárok sa nedá zmazať.');
      const t = tabList().find(x => x.id === b.dataset.tab);
      if (!confirm(`Zmazať hárok „${t.name}“ so všetkými údajmi?`)) return;
      change(() => {
        tabs.delete(tabs.toArray().findIndex(x => x.id === t.id), 1);
        [...cells.keys()].filter(k => k.startsWith(`${t.id}:`)).forEach(k => cells.delete(k));
        [...metaMap.keys()].filter(k => k.startsWith(`${t.id}:`)).forEach(k => metaMap.delete(k));
      });
      if (tab === t.id) { tab = tabList()[0].id; recompute(); renderGrid(); }
    };
  });
  if ($('#addTab')) $('#addTab').onclick = () => addTab();
}
function addTab(name) {
  let n = tabList().length + 1;
  while (!name && tabList().some(x => x.name === `Hárok${n}`)) n++;
  const t = { id: Math.random().toString(36).slice(2, 9), name: (name || `Hárok${n}`).slice(0, 40) };
  change(() => tabs.push([t]));
  return t.id;
}

/* ── Úpravy ── */
function startEdit(keep, initial) {
  if (readonly) return;
  const e = td(sel.r, sel.c);
  if (!e) return;
  const raw = (cell(sel.r, sel.c) || {}).v ?? '';
  const input = document.createElement('input');
  input.className = 'editor';
  input.value = keep ? raw : (initial ?? '');
  e.textContent = '';
  e.appendChild(input);
  input.focus();
  editing = { r: sel.r, c: sel.c, input };
  $('#fx').value = input.value;
  input.oninput = () => { $('#fx').value = input.value; };
  input.onkeydown = ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); move(ev.shiftKey ? -1 : 1, 0); }
    else if (ev.key === 'Tab') { ev.preventDefault(); commit(); move(0, ev.shiftKey ? -1 : 1); }
    else if (ev.key === 'Escape') { cancelEdit(); }
    ev.stopPropagation();
  };
}
function commit() {
  if (!editing) return;
  const { r, c, input } = editing;
  editing = null;
  const v = input.value;
  const prev = (cell(r, c) || {}).v ?? '';
  if (v !== prev) change(() => setCell(r, c, { v }));
  else { const e = td(r, c); if (e) e.textContent = display(r, c); }
}
function cancelEdit() {
  if (!editing) return;
  const { r, c } = editing;
  editing = null;
  const e = td(r, c);
  if (e) e.textContent = display(r, c);
  $('#fx').value = (cell(r, c) || {}).v ?? '';
}
function move(dr, dc, extend) {
  const r = Math.max(0, Math.min(rowsOf() - 1, (extend ? sel.r2 : sel.r) + dr));
  const c = Math.max(0, Math.min(colsOf() - 1, (extend ? sel.c2 : sel.c) + dc));
  if (extend) { sel.r2 = r; sel.c2 = c; } else sel = { r, c, r2: r, c2: c };
  paintSelection();
  stats();
  const e = extend ? td(sel.r2, sel.c2) : td(sel.r, sel.c);
  if (e) e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function forRange(fn) {
  const g = range();
  change(() => { for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) fn(r, c); });
}
function style(patch) { if (!readonly) forRange((r, c) => setCell(r, c, { s: patch })); }
function toggleStyle(k) { const on = !(((cell(sel.r, sel.c) || {}).s || {})[k]); style({ [k]: on || undefined }); }
function clearRange() { if (!readonly) forRange((r, c) => { const x = cell(r, c); if (x) setCell(r, c, { v: '' }); }); }

/** Posun buniek pri vložení / zmazaní riadka alebo stĺpca (vzorce sa neprepisujú – ako pri ľahkých editoroch). */
function shift(axis, at, delta) {
  const entries = [];
  cells.forEach((v, k) => { const [t, r, c] = k.split(':'); if (t === tab) entries.push([Number(r), Number(c), v]); });
  change(() => {
    entries.forEach(([r, c]) => cells.delete(key(r, c)));
    entries.forEach(([r, c, v]) => {
      const pos = axis === 'r' ? r : c;
      if (delta < 0 && pos >= at && pos < at - delta) return; // zmazané
      const np = pos >= at ? pos + delta : pos;
      cells.set(axis === 'r' ? key(np, c) : key(r, np), v);
    });
    if (axis === 'r') metaMap.set(`${tab}:rows`, Math.max(1, rowsOf() + delta));
    else metaMap.set(`${tab}:cols`, Math.max(1, Math.min(200, colsOf() + delta)));
  });
}

function sortRange(desc) {
  const g = range();
  let { r1, r2 } = g;
  const c1 = 0, c2 = colsOf() - 1;
  if (r1 === r2) { // celý blok údajov pod hlavičkou
    r1 = metaMap.get(`${tab}:freeze`) ? 1 : 0;
    r2 = r1;
    cells.forEach((v, k) => { const [t, r] = k.split(':'); if (t === tab) r2 = Math.max(r2, Number(r)); });
  }
  const rows = [];
  for (let r = r1; r <= r2; r++) rows.push(Array.from({ length: c2 - c1 + 1 }, (_, i) => cell(r, c1 + i)));
  const col = sel.c - c1;
  const val = row => { const x = row[col]; return x ? F.literal(x.v) : ''; };
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === '' && y !== '') return 1;
    if (y === '' && x !== '') return -1;
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'sk', { numeric: true });
    return desc ? -cmp : cmp;
  });
  change(() => rows.forEach((row, i) => row.forEach((x, j) => { if (x) cells.set(key(r1 + i, c1 + j), x); else cells.delete(key(r1 + i, c1 + j)); })));
}

/* ── Schránka (TSV – funguje aj s Excelom a Google Sheets) ── */
function copyRange(cut) {
  const g = range();
  const lines = [];
  for (let r = g.r1; r <= g.r2; r++) {
    const row = [];
    for (let c = g.c1; c <= g.c2; c++) row.push(String((cell(r, c) || {}).v ?? '').replace(/\t|\n/g, ' '));
    lines.push(row.join('\t'));
  }
  navigator.clipboard.writeText(lines.join('\n')).then(() => toast(cut ? 'Vystrihnuté.' : 'Skopírované.')).catch(() => {});
  if (cut) clearRange();
}
async function pasteAt(text) {
  if (readonly || !text) return;
  const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
  change(() => rows.forEach((row, i) => row.forEach((v, j) => setCell(sel.r + i, sel.c + j, { v }))));
  sel.r2 = sel.r + rows.length - 1;
  sel.c2 = sel.c + Math.max(...rows.map(r => r.length)) - 1;
  if (sel.r2 >= rowsOf()) change(() => metaMap.set(`${tab}:rows`, sel.r2 + 50));
  paintSelection();
}

/* ── Import / export ── */
const fileName = ext => `${(meta.title || 'tabulka').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function usedRange(t) {
  let rows = 0, cols = 0;
  cells.forEach((v, k) => { const [tt, r, c] = k.split(':'); if (tt === t) { rows = Math.max(rows, Number(r) + 1); cols = Math.max(cols, Number(c) + 1); } });
  return { rows, cols };
}
function csv() {
  const { rows, cols } = usedRange(tab);
  const q = s => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [];
  for (let r = 0; r < rows; r++) lines.push(Array.from({ length: cols }, (_, c) => q(display(r, c))).join(';'));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
function parseCSV(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const XFMT = { currency: '#,##0.00 "€"', percent: '0.00%', number: '#,##0.00', date: 'd.m.yyyy' };
async function xlsxBlob() {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Neoworkly';
  const saved = tab;
  for (const t of tabList()) {
    tab = t.id;
    recompute();
    const sh = wb.addWorksheet(t.name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Hárok');
    const { cols } = usedRange(t.id);
    for (let c = 0; c < cols; c++) sh.getColumn(c + 1).width = Math.round(widthOf(c) / 7);
    cells.forEach((x, k) => {
      const [tt, r, c] = k.split(':');
      if (tt !== t.id || !x) return;
      const xc = sh.getCell(Number(r) + 1, Number(c) + 1);
      const v = values[`${r}:${c}`];
      if (typeof x.v === 'string' && x.v.startsWith('=')) xc.value = { formula: x.v.slice(1).replace(/;/g, ','), result: F.isErr(v) ? undefined : v };
      else if (x.v !== undefined && x.v !== '') xc.value = v;
      const s = x.s || {};
      if (s.b || s.i || s.u || s.fg) xc.font = { bold: !!s.b, italic: !!s.i, underline: !!s.u, color: s.fg ? { argb: `FF${s.fg.slice(1)}` } : undefined };
      if (s.bg) xc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${s.bg.slice(1)}` } };
      if (s.al) xc.alignment = { horizontal: s.al };
      if (s.fmt && XFMT[s.fmt]) xc.numFmt = XFMT[s.fmt];
    });
    if (metaMap.get(`${t.id}:freeze`)) sh.views = [{ state: 'frozen', ySplit: 1 }];
  }
  tab = saved;
  recompute();
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
async function importXLSX(file) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  let first = null;
  wb.eachSheet(sh => {
    let name = sh.name.slice(0, 40);
    while (tabList().some(x => x.name.toLowerCase() === name.toLowerCase())) name = `${name} (import)`.slice(0, 40);
    const t = addTab(name);
    first = first || t;
    change(() => {
      let maxR = 0, maxC = 0;
      sh.eachRow({ includeEmpty: false }, (row, rn) => {
        row.eachCell({ includeEmpty: false }, (xc, cn) => {
          const r = rn - 1, c = cn - 1;
          maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
          let v = xc.value;
          const s = {};
          if (v && typeof v === 'object') {
            if (v.formula || v.sharedFormula) v = `=${xc.formula || v.formula}`;
            else if (v.richText) v = v.richText.map(x => x.text).join('');
            else if (v instanceof Date) { v = String((Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86400000); s.fmt = 'date'; }
            else if (v.text) v = v.text;
            else if (v.error) v = v.error;
            else v = '';
          }
          if (xc.font) { if (xc.font.bold) s.b = true; if (xc.font.italic) s.i = true; if (xc.font.color?.argb && xc.font.color.argb.length === 8) s.fg = `#${xc.font.color.argb.slice(2).toLowerCase()}`; }
          if (xc.fill?.fgColor?.argb && xc.fill.fgColor.argb.length === 8 && xc.fill.pattern === 'solid') s.bg = `#${xc.fill.fgColor.argb.slice(2).toLowerCase()}`;
          if (['left', 'center', 'right'].includes(xc.alignment?.horizontal)) s.al = xc.alignment.horizontal;
          const nf = String(xc.numFmt || '');
          if (/%/.test(nf)) s.fmt = 'percent'; else if (/€|EUR/.test(nf)) s.fmt = 'currency'; else if (/[dmy]{1,4}[./-]/i.test(nf)) s.fmt = 'date'; else if (/0\.00/.test(nf)) s.fmt = 'number';
          cells.set(key(r, c, t), { v: v === null || v === undefined ? '' : String(v), ...(Object.keys(s).length ? { s } : {}) });
        });
      });
      sh.columns?.forEach((col, i) => { if (col.width) metaMap.set(`${t}:cw:${i}`, Math.round(col.width * 7)); });
      metaMap.set(`${t}:rows`, Math.max(DEF_ROWS, maxR + 50));
      metaMap.set(`${t}:cols`, Math.max(DEF_COLS, Math.min(200, maxC + 5)));
    });
  });
  if (first) { tab = first; recompute(); renderGrid(); renderTabs(); }
}

/* ── Udalosti mriežky ── */
function bindGrid() {
  const wrap = $('#gridWrap');
  let dragging = false;
  wrap.addEventListener('mousedown', e => {
    const rs = e.target.closest('[data-resize]');
    if (rs && !readonly) {
      e.preventDefault();
      const c = Number(rs.dataset.resize), x0 = e.clientX, w0 = widthOf(c);
      const colEl = $('#grid colgroup').children[c + 1];
      const mv = ev => { colEl.style.width = `${Math.max(30, w0 + ev.clientX - x0)}px`; };
      const up = ev => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); change(() => metaMap.set(`${tab}:cw:${c}`, Math.max(30, w0 + ev.clientX - x0))); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      return;
    }
    const cellEl = e.target.closest('td[data-r]');
    const colH = e.target.closest('th[data-col]');
    const rowH = e.target.closest('th[data-row]');
    if (editing && cellEl && editing.input.value.startsWith('=') && /[=(;,+\-*/^&<>:]$/.test(editing.input.value)) {
      // počas písania vzorca klik vloží odkaz na bunku
      e.preventDefault();
      editing.input.value += F.addr(Number(cellEl.dataset.r), Number(cellEl.dataset.c));
      $('#fx').value = editing.input.value;
      editing.input.focus();
      return;
    }
    if (cellEl && cellEl.querySelector('.editor')) return;
    commit();
    if (cellEl) {
      const r = Number(cellEl.dataset.r), c = Number(cellEl.dataset.c);
      if (e.shiftKey) { sel.r2 = r; sel.c2 = c; } else sel = { r, c, r2: r, c2: c };
      dragging = true;
    } else if (colH) { const c = Number(colH.dataset.col); sel = { r: 0, c, r2: rowsOf() - 1, c2: c }; }
    else if (rowH) { const r = Number(rowH.dataset.row); sel = { r, c: 0, r2: r, c2: colsOf() - 1 }; }
    else return;
    paintSelection();
    stats();
  });
  wrap.addEventListener('mouseover', e => {
    if (!dragging) return;
    const cellEl = e.target.closest('td[data-r]');
    if (!cellEl) return;
    sel.r2 = Number(cellEl.dataset.r);
    sel.c2 = Number(cellEl.dataset.c);
    paintSelection();
  });
  document.addEventListener('mouseup', () => { if (dragging) { dragging = false; stats(); } });
  wrap.addEventListener('dblclick', e => { if (e.target.closest('td[data-r]')) startEdit(true); });

  document.addEventListener('keydown', e => {
    if (editing || document.activeElement === $('#fx') || document.activeElement === $('#title') || document.activeElement === $('#addr')) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) undo.redo(); else undo.undo(); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); undo.redo(); return; }
    if (mod && k.toLowerCase() === 'b') { e.preventDefault(); toggleStyle('b'); return; }
    if (mod && k.toLowerCase() === 'i') { e.preventDefault(); toggleStyle('i'); return; }
    if (mod && k.toLowerCase() === 'u') { e.preventDefault(); toggleStyle('u'); return; }
    if (mod && k.toLowerCase() === 'c') { e.preventDefault(); copyRange(); return; }
    if (mod && k.toLowerCase() === 'x') { e.preventDefault(); copyRange(true); return; }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); sel = { r: 0, c: 0, r2: rowsOf() - 1, c2: colsOf() - 1 }; paintSelection(); stats(); return; }
    if (mod) return; // Ctrl+V rieši udalosť paste
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); move(...arrows[k], e.shiftKey); return; }
    if (k === 'Enter') { e.preventDefault(); if (e.shiftKey) move(-1, 0); else startEdit(true); return; }
    if (k === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return; }
    if (k === 'F2') { e.preventDefault(); startEdit(true); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); clearRange(); return; }
    if (k.length === 1 && !e.altKey) { e.preventDefault(); startEdit(false, k); }
  });
  document.addEventListener('paste', e => {
    if (editing || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    pasteAt(e.clipboardData.getData('text/plain'));
  });
}

function bindToolbar() {
  $('#tbUndo').onclick = () => undo.undo();
  $('#tbRedo').onclick = () => undo.redo();
  $('#tbB').onclick = () => toggleStyle('b');
  $('#tbI').onclick = () => toggleStyle('i');
  $('#tbU').onclick = () => toggleStyle('u');
  document.querySelectorAll('[data-al]').forEach(b => { b.onclick = () => style({ al: b.dataset.al }); });
  $('#tbFg').oninput = e => style({ fg: e.target.value });
  $('#tbBg').oninput = e => style({ bg: e.target.value });
  $('#tbNoBg').onclick = () => style({ bg: undefined, fg: undefined });
  $('#tbFmt').onchange = e => style({ fmt: e.target.value === 'general' ? undefined : e.target.value });
  $('#tbDecUp').onclick = () => { const s = (cell(sel.r, sel.c) || {}).s || {}; style({ d: Math.min(10, (s.d ?? 2) + 1), fmt: s.fmt || 'number' }); };
  $('#tbDecDown').onclick = () => { const s = (cell(sel.r, sel.c) || {}).s || {}; style({ d: Math.max(0, (s.d ?? 2) - 1), fmt: s.fmt || 'number' }); };
  $('#tbRowAdd').onclick = () => shift('r', range().r1, 1);
  $('#tbRowDel').onclick = () => { const g = range(); shift('r', g.r1, -(g.r2 - g.r1 + 1)); };
  $('#tbColAdd').onclick = () => shift('c', range().c1, 1);
  $('#tbColDel').onclick = () => { const g = range(); shift('c', g.c1, -(g.c2 - g.c1 + 1)); };
  $('#tbSortAsc').onclick = () => sortRange(false);
  $('#tbSortDesc').onclick = () => sortRange(true);
  $('#tbFreeze').onclick = () => change(() => metaMap.set(`${tab}:freeze`, !metaMap.get(`${tab}:freeze`)));
  $('#tbSum').onclick = () => {
    const g = range();
    if (g.r1 === g.r2 && g.c1 === g.c2) { // súčet čísel nad bunkou
      let r = g.r1 - 1;
      while (r >= 0 && typeof values[`${r}:${g.c1}`] === 'number') r--;
      if (r === g.r1 - 1) return toast('Nad bunkou nie sú čísla.');
      change(() => setCell(g.r1, g.c1, { v: `=SUM(${F.addr(r + 1, g.c1)}:${F.addr(g.r1 - 1, g.c1)})` }));
    } else change(() => setCell(g.r2 + 1, g.c1, { v: `=SUM(${F.addr(g.r1, g.c1)}:${F.addr(g.r2, g.c2)})` }));
  };
  $('#fx').onkeydown = e => {
    e.stopPropagation(); // Enter/šípky nepatria mriežke
    if (e.key === 'Enter') { e.preventDefault(); if (!readonly) change(() => setCell(sel.r, sel.c, { v: $('#fx').value })); $('#fx').blur(); move(1, 0); }
    if (e.key === 'Escape') { $('#fx').value = (cell(sel.r, sel.c) || {}).v ?? ''; $('#fx').blur(); }
  };
  $('#addr').onkeydown = e => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const [a, b] = $('#addr').value.trim().toUpperCase().split(':').map(F.parseRef);
    if (!a) return toast('Neplatná adresa.');
    sel = { r: a.r, c: a.c, r2: (b || a).r, c2: (b || a).c };
    $('#addr').blur();
    paintSelection();
    stats();
    const el = td(a.r, a.c);
    if (el) el.scrollIntoView({ block: 'center' });
  };
  const menu = $('#menu');
  $('#fileBtn').onclick = e => { e.stopPropagation(); menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; };
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  menu.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      const act = b.dataset.act;
      try {
        if (act === 'xlsx') download(await xlsxBlob(), fileName('xlsx'));
        if (act === 'csv') download(csv(), fileName('csv'));
        if (act === 'print') window.print();
        if (act === 'drive') {
          const fd = new FormData();
          fd.append('files', new File([await xlsxBlob()], fileName('xlsx')));
          await api('POST', `/api/drive/files${meta.folderId ? `?parentId=${encodeURIComponent(meta.folderId)}` : ''}`, fd);
          toast('Súbor .xlsx uložený na Disk.');
        }
        if (act === 'import') {
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.accept = '.xlsx,.csv';
          inp.onchange = async () => {
            const f = inp.files[0];
            if (!f) return;
            try {
              if (/\.csv$/i.test(f.name)) {
                const rows = parseCSV(await f.text());
                const t = addTab(f.name.replace(/\.csv$/i, '').slice(0, 40));
                change(() => rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') cells.set(key(r, c, t), { v }); })));
                change(() => metaMap.set(`${t}:rows`, Math.max(DEF_ROWS, rows.length + 50)));
                tab = t; recompute(); renderGrid(); renderTabs();
              } else await importXLSX(f);
              toast('Importované ako nový hárok.');
            } catch (err) { toast(`Import zlyhal: ${err.message}`); }
          };
          inp.click();
        }
      } catch (err) { toast(err.message); }
    };
  });
  if (readonly) { document.querySelectorAll('.tb button, .tb select, .tb input').forEach(x => { x.disabled = true; }); menu.querySelectorAll('[data-act=drive],[data-act=import]').forEach(x => { x.style.display = 'none'; }); $('#fx').readOnly = true; }
}

/* ── Štart ── */
async function start() {
  if (!token) { location.href = '/'; return; }
  try {
    meta = await api('GET', `/api/sheets/${encodeURIComponent(id)}`);
  } catch (e) {
    $('#gridWrap').innerHTML = `<p class="msg">${e.message === '401' ? '' : 'Tabuľka sa nenašla alebo k nej nemáte prístup.'}</p>`;
    return;
  }
  readonly = meta.role === 'readonly';
  document.title = `${meta.title} – Neoworkly`;
  $('.back').href = `/dashboard?view=sheets&ws=${encodeURIComponent(meta.ownerId)}`;
  const title = $('#title');
  title.value = meta.title;
  title.disabled = readonly;
  let tt;
  title.oninput = () => { clearTimeout(tt); tt = setTimeout(() => api('PATCH', `/api/sheets/${id}`, { title: title.value }).then(d => { meta.title = d.title; document.title = `${d.title} – Neoworkly`; }).catch(() => {}), 600); };

  ydoc = new Y.Doc();
  tabs = ydoc.getArray('tabs');
  cells = ydoc.getMap('cells');
  metaMap = ydoc.getMap('meta');
  const ticket = async () => (await api('POST', '/api/realtime/ticket')).ticket;
  provider = new WebsocketProvider(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/yjs`, meta.room, ydoc, { params: { ticket: await ticket() }, disableBc: true });
  provider.awareness.setLocalStateField('user', { id: meta.me.id, name: meta.me.name || 'Ja' });
  setInterval(async () => { try { provider.params.ticket = await ticket(); } catch { /* skúsi neskôr */ } }, 45 * 1000);
  provider.on('status', e => { $('#status').textContent = e.status === 'connected' ? (readonly ? 'Iba na čítanie' : 'Uložené automaticky') : 'Pripájam…'; });
  await new Promise(ok => provider.once('sync', ok));

  if (!tabList().length && !readonly) change(() => tabs.push([{ id: 's1', name: 'Hárok1' }]));
  tab = (tabList()[0] || { id: 's1' }).id;
  undo = new Y.UndoManager([cells, metaMap, tabs], { trackedOrigins: new Set([LOCAL]) });

  recompute();
  renderGrid();
  renderTabs();
  bindGrid();
  bindToolbar();

  let t;
  const later = (fn) => { clearTimeout(t); t = setTimeout(fn, 30); };
  cells.observe(() => later(() => { recompute(); refreshCells(); }));
  metaMap.observeDeep(ev => later(() => { if (!tabList().some(x => x.id === tab)) tab = tabList()[0].id; recompute(); renderGrid(); }));
  tabs.observe(() => { if (!tabList().some(x => x.id === tab)) { tab = (tabList()[0] || {}).id; recompute(); renderGrid(); } renderTabs(); });
  provider.awareness.on('change', paintPresence);
}
start();
