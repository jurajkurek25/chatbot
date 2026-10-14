// PDF nástroje Neoworkly (podľa PdfCraft): čítanie, usporiadanie, spájanie, rozdelenie, čísla strán, vodoznak, podpis.
// pdf.js (Apache-2.0) na náhľady, pdf-lib (MIT) na úpravy – všetko v prehliadači, výsledok na Disk alebo stiahnuť.
// Zostavenie: npm run build:apps → public/apps/pdf/
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, degrees } from 'pdf-lib';

pdfjs.GlobalWorkerOptions.workerSrc = '/apps/pdf/pdf.worker.min.mjs';

const token = (() => { try { return localStorage.getItem('nd_token'); } catch { return null; } })();
const qs = new URLSearchParams(location.search);
const ws = qs.get('ws') || '';
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let sources = []; // { name, bytes, doc (pdf.js), lib (pdf-lib, lazy) }
let pages = []; // { src, index, rot, sel, key }
let folderId = null; // kam uložiť výsledok (priečinok pôvodného súboru)
let title = 'Dokument';
let canWrite = true;
let lastClick = null;

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
  toast.t = setTimeout(() => { t.style.display = 'none'; }, 2800);
}
const busy = (on, text = 'Pracujem…') => { $('#busy').style.display = on ? 'flex' : 'none'; $('#busy span').textContent = text; };

/* ── Načítanie ── */
async function addSource(name, bytes) {
  const copy = bytes.slice(0); // pdf.js si buffer odovzdá workeru
  const doc = await pdfjs.getDocument({ data: new Uint8Array(copy) }).promise;
  const src = sources.push({ name, bytes, doc }) - 1;
  for (let i = 0; i < doc.numPages; i++) pages.push({ src, index: i, rot: 0, sel: false, key: `${src}:${i}:${Math.random().toString(36).slice(2, 6)}` });
  if (sources.length === 1) title = name.replace(/\.pdf$/i, '');
  render();
}
async function fromDrive(itemId) {
  const meta = await api('GET', `/api/drive/items/${encodeURIComponent(itemId)}/url`);
  const r = await fetch(meta.url);
  if (!r.ok) throw new Error('Súbor sa nepodarilo načítať.');
  return r.arrayBuffer();
}

/* ── Náhľady ── */
const thumbCache = new Map();
async function thumb(p) {
  const k = `${p.src}:${p.index}`;
  if (thumbCache.has(k)) return thumbCache.get(k);
  const page = await sources[p.src].doc.getPage(p.index + 1);
  const vp = page.getViewport({ scale: 1 });
  const scale = 220 / Math.max(vp.width, vp.height);
  const v = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(v.width); c.height = Math.round(v.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: v, canvas: c }).promise;
  const url = c.toDataURL('image/jpeg', 0.8);
  thumbCache.set(k, url);
  return url;
}

function render() {
  const grid = $('#grid');
  $('#empty').style.display = pages.length ? 'none' : 'block';
  $('#count').textContent = pages.length ? `${pages.length} ${pages.length === 1 ? 'strana' : pages.length < 5 ? 'strany' : 'strán'}${pages.some(p => p.sel) ? ` · vybrané ${pages.filter(p => p.sel).length}` : ''}${sources.length > 1 ? ` · ${sources.length} súbory` : ''}` : '';
  document.querySelectorAll('.need').forEach(b => { b.disabled = !pages.length; });
  document.querySelectorAll('.needsel').forEach(b => { b.disabled = !pages.some(p => p.sel); });
  grid.innerHTML = pages.map((p, i) => `<div class="pg ${p.sel ? 'sel' : ''}" data-i="${i}" draggable="true">
    <div class="img"><img data-k="${p.key}" style="transform:rotate(${p.rot}deg)${p.rot % 180 ? ' scale(0.7)' : ''}" alt=""></div>
    <div class="cap"><span>${i + 1}</span>${sources.length > 1 ? `<em title="${esc(sources[p.src].name)}">${esc(sources[p.src].name)}</em>` : ''}
      <button data-rot="${i}" title="Otočiť">↻</button><button data-del="${i}" title="Odstrániť stranu">✕</button></div></div>`).join('');
  pages.forEach(async p => { const img = grid.querySelector(`img[data-k="${p.key}"]`); if (img) img.src = await thumb(p); });
  let from = null;
  grid.querySelectorAll('.pg').forEach(el => {
    const i = Number(el.dataset.i);
    el.onclick = e => {
      if (e.target.closest('button')) return;
      if (e.shiftKey && lastClick !== null) { const [a, b] = [Math.min(lastClick, i), Math.max(lastClick, i)]; for (let j = a; j <= b; j++) pages[j].sel = true; }
      else if (e.ctrlKey || e.metaKey) pages[i].sel = !pages[i].sel;
      else { const was = pages[i].sel && pages.filter(x => x.sel).length === 1; pages.forEach(x => { x.sel = false; }); pages[i].sel = !was; }
      lastClick = i;
      render();
    };
    el.ondblclick = () => preview(i);
    el.ondragstart = () => { from = i; el.classList.add('drag'); };
    el.ondragend = () => el.classList.remove('drag');
    el.ondragover = e => { e.preventDefault(); el.classList.add('over'); };
    el.ondragleave = () => el.classList.remove('over');
    el.ondrop = e => { e.preventDefault(); el.classList.remove('over'); if (from === null || from === i) return; const [p] = pages.splice(from, 1); pages.splice(i, 0, p); from = null; render(); };
  });
  grid.querySelectorAll('[data-rot]').forEach(b => { b.onclick = () => { const p = pages[Number(b.dataset.rot)]; p.rot = (p.rot + 90) % 360; render(); }; });
  grid.querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { pages.splice(Number(b.dataset.del), 1); render(); }; });
}

async function preview(i) {
  const p = pages[i];
  const page = await sources[p.src].doc.getPage(p.index + 1);
  const vp0 = page.getViewport({ scale: 1, rotation: (page.rotate + p.rot) % 360 });
  const scale = Math.min((innerWidth - 80) / vp0.width, (innerHeight - 100) / vp0.height, 2.5);
  const vp = page.getViewport({ scale, rotation: (page.rotate + p.rot) % 360 });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp, canvas: c }).promise;
  const box = $('#modal');
  box.innerHTML = `<div class="mbox wide"><div class="mhead"><strong>Strana ${i + 1} / ${pages.length}</strong><span><button id="pvPrev">◀</button> <button id="pvNext">▶</button> <button id="mClose">✕</button></span></div></div>`;
  box.querySelector('.mbox').appendChild(c);
  box.style.display = 'flex';
  $('#mClose').onclick = () => { box.style.display = 'none'; };
  $('#pvPrev').onclick = () => { if (i > 0) preview(i - 1); };
  $('#pvNext').onclick = () => { if (i < pages.length - 1) preview(i + 1); };
}

/* ── Text a podpis ako obrázok (písmo s diakritikou bez vkladania fontov) ── */
function textPNG(text, { size = 48, color = '#000000', weight = 700, opacity = 1 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${weight} ${size}px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  c.width = w; c.height = Math.ceil(size * 1.35);
  ctx.font = font;
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 4, c.height / 2);
  return { url: c.toDataURL('image/png'), w: c.width, h: c.height };
}
const pngBytes = url => Uint8Array.from(atob(url.split(',')[1]), ch => ch.charCodeAt(0));

/* ── Zostavenie výsledného PDF ── */
async function libOf(src) {
  const s = sources[src];
  if (!s.lib) s.lib = await PDFDocument.load(s.bytes, { ignoreEncryption: true });
  return s.lib;
}
/**
 * @param list strany v poradí
 * @param opts { numbers, watermark: { text, opacity }, signature: { url, pages: Set<index v list>, pos } }
 */
async function build(list, opts = {}) {
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setProducer('Neoworkly');
  for (const p of list) {
    const lib = await libOf(p.src);
    const [copied] = await out.copyPages(lib, [p.index]);
    copied.setRotation(degrees((copied.getRotation().angle + p.rot) % 360));
    out.addPage(copied);
  }
  const all = out.getPages();
  const embed = new Map();
  const img = async url => { if (!embed.has(url)) embed.set(url, await out.embedPng(pngBytes(url))); return embed.get(url); };
  for (let i = 0; i < all.length; i++) {
    const page = all[i];
    const { width, height } = page.getSize();
    const rot = page.getRotation().angle % 360;
    // súradnice na zobrazenej (otočenej) strane → do súradníc strany
    const place = (image, x, y, w, h) => {
      if (rot === 0) page.drawImage(image, { x, y, width: w, height: h });
      else if (rot === 90) page.drawImage(image, { x: width - y, y: x, width: w, height: h, rotate: degrees(90) });
      else if (rot === 180) page.drawImage(image, { x: width - x, y: height - y, width: w, height: h, rotate: degrees(180) });
      else page.drawImage(image, { x: y, y: height - x, width: w, height: h, rotate: degrees(270) });
    };
    const [vw, vh] = rot % 180 ? [height, width] : [width, height];
    if (opts.watermark?.text) {
      const t = textPNG(opts.watermark.text, { size: 120, color: '#888888', opacity: opts.watermark.opacity ?? 0.25, weight: 800 });
      const im = await img(t.url);
      const w = vw * 0.8, h = w * t.h / t.w;
      if (rot === 0) {
        // otočenie okolo ľavého dolného rohu → posun tak, aby stred obrázka bol v strede strany
        const a = 35 * Math.PI / 180, cx = (w / 2) * Math.cos(a) - (h / 2) * Math.sin(a), cy = (w / 2) * Math.sin(a) + (h / 2) * Math.cos(a);
        page.drawImage(im, { x: vw / 2 - cx, y: vh / 2 - cy, width: w, height: h, rotate: degrees(35) });
      }
      else place(im, (vw - w) / 2, (vh - h) / 2, w, h);
    }
    if (opts.numbers) {
      const t = textPNG(`${i + 1} / ${all.length}`, { size: 36, color: '#444444', weight: 600 });
      const im = await img(t.url);
      const h = 12, w = h * t.w / t.h;
      place(im, (vw - w) / 2, 18, w, h);
    }
    if (opts.signature?.url && opts.signature.pages.has(i)) {
      const im = await img(opts.signature.url);
      const w = Math.min(160, vw * 0.3), h = w * im.height / im.width;
      const x = opts.signature.pos === 'left' ? 40 : vw - w - 40;
      place(im, x, 50, w, h);
    }
  }
  return new Blob([await out.save()], { type: 'application/pdf' });
}

const name = suffix => `${title}${suffix ? ` – ${suffix}` : ''}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
function download(blob, fname) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
async function toDrive(files) {
  const fd = new FormData();
  files.forEach(([blob, fname]) => fd.append('files', new File([blob], fname, { type: 'application/pdf' })));
  await api('POST', `/api/drive/files${folderId ? `?parentId=${encodeURIComponent(folderId)}` : ''}`, fd);
}
const options = () => ({
  numbers: $('#optNumbers').checked,
  watermark: $('#optWm').value.trim() ? { text: $('#optWm').value.trim(), opacity: 0.22 } : null,
  signature: signature ? { url: signature, pages: new Set(pages.map((p, i) => (p.sel || $('#sigWhere').value === 'all' || ($('#sigWhere').value === 'last' && i === pages.length - 1) ? i : -1)).filter(i => i >= 0)), pos: 'right' } : null,
});

/* ── Podpis ── */
let signature = null;
function signDialog() {
  const box = $('#modal');
  box.innerHTML = `<div class="mbox"><div class="mhead"><strong>✍ Podpis</strong><button id="mClose">✕</button></div>
    <p class="hint">Podpíšte sa myšou alebo prstom. Podpis sa vloží vpravo dole na vybrané strany (alebo na poslednú).</p>
    <canvas id="pad" width="560" height="200"></canvas>
    <div class="row"><button id="padClear">Vymazať</button><button class="primary" id="padOk">Použiť podpis</button></div></div>`;
  box.style.display = 'flex';
  const pad = $('#pad');
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1e3a8a';
  let drawing = false, drawn = false;
  const pos = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.onpointerdown = e => { drawing = true; drawn = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  pad.onpointermove = e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); };
  pad.onpointerup = () => { drawing = false; };
  $('#padClear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };
  $('#mClose').onclick = () => { box.style.display = 'none'; };
  $('#padOk').onclick = () => {
    if (!drawn) return toast('Najprv sa podpíšte.');
    signature = pad.toDataURL('image/png');
    $('#sigState').innerHTML = `<img src="${signature}" alt="" style="height:28px;background:#fff;border-radius:4px"> <button id="sigDel">✕</button>`;
    $('#sigDel').onclick = () => { signature = null; $('#sigState').textContent = 'bez podpisu'; };
    box.style.display = 'none';
  };
}

/* ── Výber súboru z Disku ── */
function drivePicker(onPick) {
  const box = $('#modal');
  const load = async (parent, crumbs) => {
    const d = await api('GET', `/api/drive/items${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`);
    const items = d.items.filter(i => i.kind === 'folder' || i.mime === 'application/pdf' || /\.pdf$/i.test(i.name));
    box.innerHTML = `<div class="mbox"><div class="mhead"><strong>💾 PDF z Disku</strong><button id="mClose">✕</button></div>
      <div class="crumbs">${crumbs.map((c, i) => `<a href="#" data-crumb="${i}">${esc(c.name)}</a>`).join(' › ')}</div>
      <div class="list">${items.map(i => `<button data-it="${esc(i.id)}" data-kind="${i.kind}" data-name="${esc(i.name)}" data-parent="${esc(parent || '')}">${i.kind === 'folder' ? '📁' : '📄'} ${esc(i.name)}</button>`).join('') || '<p class="hint">Žiadne PDF.</p>'}</div></div>`;
    box.style.display = 'flex';
    $('#mClose').onclick = () => { box.style.display = 'none'; };
    box.querySelectorAll('[data-crumb]').forEach(a => { a.onclick = e => { e.preventDefault(); const c = crumbs.slice(0, Number(a.dataset.crumb) + 1); load(c[c.length - 1].id, c); }; });
    box.querySelectorAll('[data-it]').forEach(b => {
      b.onclick = () => {
        if (b.dataset.kind === 'folder') return load(b.dataset.it, crumbs.concat({ id: b.dataset.it, name: b.dataset.name }));
        box.style.display = 'none';
        onPick(b.dataset.it, b.dataset.name, b.dataset.parent || null);
      };
    });
  };
  load(null, [{ id: null, name: 'Disk' }]).catch(e => toast(e.message));
}
async function openFromDrive(itemId, fname, parent) {
  busy(true, 'Načítavam PDF…');
  try {
    await addSource(fname || 'dokument.pdf', await fromDrive(itemId));
    if (sources.length === 1) folderId = parent;
  } catch (e) { toast(e.message); }
  busy(false);
}

/* ── Štart ── */
async function start() {
  if (!token) { location.href = '/'; return; }
  try {
    const list = await api('GET', '/api/realtime/workspaces');
    const w = list.find(x => x.ownerId === ws) || list[0];
    canWrite = !w || ['owner', 'editor'].includes(w.role);
  } catch { /* predvolene môže */ }
  $('.back').href = `/dashboard?view=drive${ws ? `&ws=${encodeURIComponent(ws)}` : ''}`;
  if (!canWrite) document.querySelectorAll('.write').forEach(b => { b.style.display = 'none'; });
  $('#openDrive').onclick = () => drivePicker(openFromDrive);
  $('#openFile').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    busy(true, 'Načítavam PDF…');
    for (const f of e.target.files) { try { await addSource(f.name, await f.arrayBuffer()); } catch { toast(`${f.name}: nie je platné PDF.`); } }
    e.target.value = '';
    busy(false);
  };
  // pretiahnutie súborov do okna
  document.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', async e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    busy(true, 'Načítavam PDF…');
    for (const f of e.dataTransfer.files) if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) { try { await addSource(f.name, await f.arrayBuffer()); } catch { toast(`${f.name}: nie je platné PDF.`); } }
    busy(false);
  });
  $('#selAll').onclick = () => { const all = pages.every(p => p.sel); pages.forEach(p => { p.sel = !all; }); render(); };
  $('#rotSel').onclick = () => { pages.filter(p => p.sel).forEach(p => { p.rot = (p.rot + 90) % 360; }); render(); };
  $('#delSel').onclick = () => { pages = pages.filter(p => !p.sel); render(); };
  $('#reverse').onclick = () => { pages.reverse(); render(); };
  $('#sign').onclick = signDialog;
  const run = async (what, fn) => { busy(true, what); try { await fn(); } catch (e) { toast(`Chyba: ${e.message}`); } busy(false); };
  $('#dl').onclick = () => run('Zostavujem PDF…', async () => download(await build(pages, options()), name()));
  $('#save').onclick = () => run('Ukladám na Disk…', async () => { await toDrive([[await build(pages, options()), name('upravené')]]); toast('Uložené na Disk vedľa pôvodného súboru.'); });
  $('#extract').onclick = () => run('Vyberám strany…', async () => {
    const sel = pages.filter(p => p.sel);
    const blob = await build(sel, { ...options(), signature: options().signature ? { ...options().signature, pages: new Set(sel.map((_, i) => i)) } : null });
    if (canWrite) { await toDrive([[blob, name(`strany ${sel.length}`)]]); toast('Vybrané strany uložené na Disk ako nové PDF.'); } else download(blob, name('výber'));
  });
  $('#split').onclick = () => run('Rozdeľujem…', async () => {
    const every = Math.max(1, Number(prompt('Po koľkých stranách rozdeliť? (1 = každá strana zvlášť)', '1')) || 1);
    const files = [];
    for (let i = 0; i < pages.length; i += every) files.push([await build(pages.slice(i, i + every), { numbers: false }), name(`časť ${files.length + 1}`)]);
    if (canWrite) { await toDrive(files); toast(`${files.length} súborov uložených na Disk.`); } else files.forEach(([b, n]) => download(b, n));
  });
  $('#clear').onclick = () => { if (confirm('Zavrieť všetky súbory?')) { sources = []; pages = []; thumbCache.clear(); folderId = null; render(); } };
  render();
  // otvorené z Disku: /pdf?file=<id>&name=…&parent=<priečinok>
  if (qs.get('file')) await openFromDrive(qs.get('file'), qs.get('name') || 'dokument.pdf', qs.get('parent') || null);
}
start();
