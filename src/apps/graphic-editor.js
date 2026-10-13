// Grafický editor Neoworkly (podľa Aktivisda): fabric.js (MIT), značka tímu, šablóny so zamknutými vrstvami,
// export PNG / JPG / PDF a uloženie na Disk. Zostavenie: npm run build:apps → public/apps/graphic-editor.js
import { Canvas, Textbox, Rect, Circle, FabricImage, FabricObject, Shadow, util } from 'fabric';
import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/caveat/700.css';

// fabric 7 má predvolený počiatok objektu v strede – šablóny počítajú s ľavým horným rohom
FabricObject.ownDefaults.originX = 'left';
FabricObject.ownDefaults.originY = 'top';

const token = (() => { try { return localStorage.getItem('nd_token'); } catch { return null; } })();
const id = location.pathname.split('/').filter(Boolean).pop();
const ws = new URLSearchParams(location.search).get('ws') || '';
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PROPS = ['nwName', 'nwLocked', 'nwColor', 'nwFont', 'nwRole']; // vlastné vlastnosti ukladané s objektmi
const MAX_IMG = 1800; // px – väčšie obrázky sa pri vložení zmenšia

let meta, canvas, zoom = 1, readonly = false, unlocked = false;
let history = [], future = [], restoring = false, saveT = null, dirty = false;

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

/* ── Značka ── */
const brandColor = key => (meta.brand.colors[key] || '#000000');
const resolveColor = c => (typeof c === 'string' && c.startsWith('brand.') ? brandColor(c.slice(6)) : c);
const resolveFont = f => (f === 'heading' ? meta.brand.fonts.heading : f === 'body' ? meta.brand.fonts.body : f || meta.brand.fonts.body);

/** Vstavaná šablóna (jednoduché vrstvy) → objekty fabric.js so značkou tímu. */
async function fromLayers(layers) {
  const out = [];
  for (const l of layers) {
    const common = { left: l.x, top: l.y, opacity: l.opacity ?? 1, nwName: l.name, nwLocked: !!l.locked };
    if (l.type === 'rect') out.push(new Rect({ ...common, width: l.w, height: l.h, rx: l.rx || 0, ry: l.rx || 0, fill: resolveColor(l.fill), nwColor: String(l.fill).startsWith('brand.') ? l.fill.slice(6) : undefined }));
    if (l.type === 'circle') out.push(new Circle({ ...common, left: l.x - l.r, top: l.y - l.r, radius: l.r, fill: resolveColor(l.fill), nwColor: String(l.fill).startsWith('brand.') ? l.fill.slice(6) : undefined }));
    if (l.type === 'text') {
      out.push(new Textbox(l.text, { ...common, width: l.w, fontFamily: resolveFont(l.font), fontSize: l.size, fontWeight: l.weight || 400, fill: resolveColor(l.color),
        textAlign: l.align || 'left', lineHeight: l.lineHeight || 1.2, nwFont: ['heading', 'body'].includes(l.font) ? l.font : undefined,
        nwColor: String(l.color).startsWith('brand.') ? l.color.slice(6) : undefined, splitByGrapheme: false }));
    }
    if (l.type === 'image') out.push(placeholder(l, 'Kliknite a vložte fotku', 'image'));
    if (l.type === 'logo') {
      const logo = meta.brand.logos[0];
      if (logo) {
        const img = await FabricImage.fromURL(logo.dataURL);
        const s = Math.min(l.w / img.width, l.h / img.height);
        img.set({ ...common, scaleX: s, scaleY: s, left: l.x + (l.w - img.width * s) / 2, top: l.y + (l.h - img.height * s) / 2, nwRole: 'logo' });
        out.push(img);
      } else out.push(placeholder(l, 'LOGO', 'logo'));
    }
  }
  return out;
}
function placeholder(l, label, role) {
  // Miesto na obrázok: priehľadný obdĺžnik s čiarkovaným okrajom a popisom (pri exporte sa skryje)
  return new Rect({ left: l.x, top: l.y, width: l.w, height: l.h, fill: 'rgba(148,163,184,0.25)', stroke: '#94a3b8', strokeDashArray: [14, 10], strokeWidth: 3,
    nwName: l.name || label, nwRole: `slot-${role}`, nwLabel: label });
}

/* ── Plátno ── */
function fit() {
  const area = $('#stage');
  const z = Math.min((area.clientWidth - 48) / meta.width, (area.clientHeight - 48) / meta.height, 1);
  setZoom(z);
}
function setZoom(z) {
  zoom = Math.max(0.05, Math.min(z, 3));
  canvas.setDimensions({ width: Math.round(meta.width * zoom), height: Math.round(meta.height * zoom) });
  canvas.setZoom(zoom);
  $('#zoomLbl').textContent = `${Math.round(zoom * 100)} %`;
  canvas.requestRenderAll();
}

function applyLocks() {
  canvas.getObjects().forEach(o => {
    const locked = o.nwLocked && !unlocked;
    o.set({ selectable: !readonly && !locked, evented: !readonly && !locked, hoverCursor: locked ? 'default' : 'move' });
  });
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}

const json = () => JSON.stringify(canvas.toObject(PROPS.concat(['nwLabel'])));
function snapshot() {
  if (restoring) return;
  history.push(json());
  if (history.length > 60) history.shift();
  future = [];
  dirty = true;
  scheduleSave();
  layers();
}
async function restore(state) {
  restoring = true;
  await canvas.loadFromJSON(state);
  applyLocks();
  restoring = false;
  layers();
  props();
  dirty = true;
  scheduleSave();
}

function scheduleSave() {
  if (readonly) return;
  $('#status').textContent = 'Neuložené zmeny…';
  clearTimeout(saveT);
  saveT = setTimeout(save, 1500);
}
async function save() {
  if (!dirty || readonly) return;
  dirty = false;
  try {
    const thumb = exportURL('jpeg', 360 / Math.max(meta.width, meta.height), 0.75);
    await api('PATCH', `/api/graphics/designs/${id}`, { data: json(), thumb });
    $('#status').textContent = 'Uložené';
  } catch (e) { dirty = true; $('#status').textContent = e.message; }
}
window.addEventListener('beforeunload', e => { if (dirty) { save(); e.preventDefault(); } });

/** Export bez mriežky výberu a bez prázdnych miest na obrázky. */
function exportURL(format, scale = 1, quality = 0.92) {
  const active = canvas.getActiveObject();
  canvas.discardActiveObject();
  const slots = canvas.getObjects().filter(o => String(o.nwRole || '').startsWith('slot-'));
  slots.forEach(o => { o.visible = false; });
  const url = canvas.toDataURL({ format, quality, multiplier: scale / zoom, enableRetinaScaling: false });
  slots.forEach(o => { o.visible = true; });
  if (active) canvas.setActiveObject(active);
  canvas.requestRenderAll();
  return url;
}
const dataURLtoBlob = url => fetch(url).then(r => r.blob());

/** PDF s jedným obrázkom JPEG (veľkosť strany podľa návrhu, 150 DPI). */
async function pdfBlob() {
  const url = exportURL('jpeg', 1, 0.92);
  const bin = atob(url.split(',')[1]);
  const img = Uint8Array.from(bin, c => c.charCodeAt(0));
  const w = meta.width * 72 / 150, h = meta.height * 72 / 150;
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = p => { const b = typeof p === 'string' ? enc.encode(p) : p; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${meta.width} /Height ${meta.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`); push(img); push('\nendstream'); });
  const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im0 Do Q`;
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileName = ext => `${(meta.title || 'grafika').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;

/* ── Obrázky ── */
function readImage(file) {
  return new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        const s = Math.min(1, MAX_IMG / Math.max(im.width, im.height));
        const png = /png|webp|svg/.test(file.type);
        if (s === 1 && file.size < 1.5 * 1024 * 1024) return ok(fr.result);
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        ok(c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88));
      };
      im.onerror = fail;
      im.src = fr.result;
    };
    fr.onerror = fail;
    fr.readAsDataURL(file);
  });
}
function pickFile() {
  return new Promise(ok => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => ok(inp.files[0] || null);
    inp.click();
  });
}
/** Vloží obrázok – do vybraného miesta (vyplní ho ako „cover“) alebo do stredu plátna. */
async function placeImage(dataURL, target) {
  const img = await FabricImage.fromURL(dataURL);
  if (target) {
    const w = target.width * target.scaleX, h = target.height * target.scaleY;
    const s = Math.max(w / img.width, h / img.height);
    img.set({ scaleX: s, scaleY: s, left: target.left + (w - img.width * s) / 2, top: target.top + (h - img.height * s) / 2, nwName: target.nwName, nwLocked: false });
    img.clipPath = new Rect({ left: target.left, top: target.top, width: w, height: h, absolutePositioned: true });
    const idx = canvas.getObjects().indexOf(target);
    canvas.remove(target);
    canvas.insertAt(idx, img);
  } else {
    const s = Math.min(1, (meta.width * 0.6) / img.width, (meta.height * 0.6) / img.height);
    img.set({ scaleX: s, scaleY: s, left: (meta.width - img.width * s) / 2, top: (meta.height - img.height * s) / 2, nwName: 'Obrázok' });
    canvas.add(img);
  }
  canvas.setActiveObject(img);
  snapshot();
}

/* ── Panely ── */
const label = o => o.nwName || (o.type === 'textbox' ? (o.text || '').slice(0, 24) : { rect: 'Obdĺžnik', circle: 'Kruh', image: 'Obrázok' }[o.type] || o.type);
function layers() {
  const el = $('#layers');
  const objs = canvas.getObjects().slice().reverse();
  el.innerHTML = objs.map((o, i) => `<div class="layer ${canvas.getActiveObjects().includes(o) ? 'on' : ''}" data-l="${objs.length - 1 - i}">
    <span class="ic">${o.type === 'textbox' ? 'T' : o.type === 'image' ? '🖼' : String(o.nwRole || '').startsWith('slot') ? '⬚' : o.type === 'circle' ? '●' : '■'}</span>
    <span class="nm">${esc(label(o))}</span>${o.nwLocked ? '<span title="Zamknuté – súčasť značky">🔒</span>' : ''}</div>`).join('');
  el.querySelectorAll('[data-l]').forEach(d => {
    d.onclick = () => { const o = canvas.item(Number(d.dataset.l)); if (o && o.selectable) { canvas.setActiveObject(o); canvas.requestRenderAll(); props(); layers(); } else if (o && o.nwLocked) toast('Vrstva je zamknutá v šablóne.'); };
  });
}

function swatches(current, attr) {
  const brand = Object.entries(meta.brand.colors);
  return `<div class="sw">${brand.map(([k, c]) => `<button data-${attr}="${c}" data-brand="${k}" title="Značka: ${k}" style="background:${c}" class="${String(current).toLowerCase() === c ? 'on' : ''}"></button>`).join('')}
    <button data-${attr}="#ffffff" style="background:#ffffff" title="Biela"></button><button data-${attr}="#000000" style="background:#000" title="Čierna"></button>
    <input type="color" data-${attr}-custom value="${/^#[0-9a-f]{6}$/i.test(current) ? current : '#000000'}" title="Vlastná farba"></div>`;
}

function props() {
  const el = $('#props');
  const o = canvas.getActiveObject();
  if (readonly) { el.innerHTML = '<p class="hint">Návrh máte iba na prezeranie. Môžete ho exportovať.</p>'; return; }
  if (!o) {
    el.innerHTML = `<h4>Plátno</h4><div class="row"><label>Pozadie</label>${swatches(canvas.backgroundColor || '#ffffff', 'bg')}</div>
      <p class="hint">Kliknite na prvok na plátne alebo vo vrstvách. Prázdne miesta (⬚) vyplníte fotkou – vyberte ich a kliknite „Vložiť fotku“.</p>
      ${meta.role !== 'readonly' && canvas.getObjects().some(x => x.nwLocked) ? `<label class="chk"><input type="checkbox" id="unlock" ${unlocked ? 'checked' : ''}> Upravovať aj zamknuté vrstvy značky</label>` : ''}`;
    el.querySelectorAll('[data-bg]').forEach(b => { b.onclick = () => { canvas.backgroundColor = b.dataset.bg; canvas.requestRenderAll(); snapshot(); props(); }; });
    const c = el.querySelector('[data-bg-custom]');
    if (c) c.oninput = () => { canvas.backgroundColor = c.value; canvas.requestRenderAll(); }, c.onchange = snapshot;
    if ($('#unlock')) $('#unlock').onchange = e => { unlocked = e.target.checked; applyLocks(); layers(); };
    return;
  }
  const isText = o.type === 'textbox';
  const slot = String(o.nwRole || '').startsWith('slot-');
  const fill = typeof o.fill === 'string' ? o.fill : '#000000';
  el.innerHTML = `<h4>${esc(label(o))}</h4>
    ${isText ? `<div class="row"><label>Text</label><textarea id="pText" rows="3">${esc(o.text)}</textarea></div>
      <div class="row two"><div><label>Písmo</label><select id="pFont">${meta.fonts.map(f => `<option ${o.fontFamily === f ? 'selected' : ''} style="font-family:'${f}'">${f}</option>`).join('')}</select></div>
        <div><label>Veľkosť</label><input type="number" id="pSize" value="${Math.round(o.fontSize)}" min="8" max="600"></div></div>
      <div class="row btns"><button id="pBold" class="${Number(o.fontWeight) >= 700 ? 'on' : ''}"><b>B</b></button><button id="pItalic" class="${o.fontStyle === 'italic' ? 'on' : ''}"><i>I</i></button>
        ${['left', 'center', 'right'].map(a => `<button data-align="${a}" class="${o.textAlign === a ? 'on' : ''}">${{ left: '⇤', center: '↔', right: '⇥' }[a]}</button>`).join('')}
        <button id="pShadow" class="${o.shadow ? 'on' : ''}" title="Tieň">☁</button></div>` : ''}
    ${slot ? '<button class="primary wide" id="pFill">🖼 Vložiť fotku</button><button class="wide" id="pFillDrive">💾 Z Disku</button>' : ''}
    ${o.type === 'image' ? '<button class="wide" id="pReplace">🔄 Nahradiť obrázok</button>' : ''}
    ${!slot && o.type !== 'image' ? `<div class="row"><label>${isText ? 'Farba textu' : 'Farba'}</label>${swatches(fill, 'fill')}</div>` : ''}
    ${o.type === 'rect' && !slot ? `<div class="row"><label>Zaoblenie</label><input type="range" id="pRadius" min="0" max="${Math.round(Math.min(o.width, o.height) / 2)}" value="${o.rx || 0}"></div>` : ''}
    <div class="row"><label>Priehľadnosť</label><input type="range" id="pOpacity" min="0.05" max="1" step="0.05" value="${o.opacity ?? 1}"></div>
    <div class="row btns"><button id="pUp" title="Dopredu">⬆</button><button id="pDown" title="Dozadu">⬇</button><button id="pDup" title="Duplikovať">⧉</button><button id="pDel" class="danger" title="Zmazať">🗑</button></div>
    ${meta.role !== 'readonly' ? `<label class="chk"><input type="checkbox" id="pLock" ${o.nwLocked ? 'checked' : ''}> 🔒 Zamknúť ako súčasť značky (v šablóne)</label>` : ''}`;
  const set = (k, v) => { o.set(k, v); if (k === 'fill' || k === 'fontFamily') { o.nwColor = undefined; o.nwFont = undefined; } canvas.requestRenderAll(); };
  if (isText) {
    $('#pText').oninput = e => { o.set('text', e.target.value); canvas.requestRenderAll(); };
    $('#pText').onchange = snapshot;
    $('#pFont').onchange = async e => { await document.fonts.load(`${o.fontWeight} 40px "${e.target.value}"`); set('fontFamily', e.target.value); o.initDimensions(); snapshot(); };
    $('#pSize').oninput = e => { set('fontSize', Number(e.target.value) || o.fontSize); };
    $('#pSize').onchange = snapshot;
    $('#pBold').onclick = () => { set('fontWeight', Number(o.fontWeight) >= 700 ? 400 : (o.fontFamily === 'Montserrat' ? 800 : 700)); snapshot(); props(); };
    $('#pItalic').onclick = () => { set('fontStyle', o.fontStyle === 'italic' ? 'normal' : 'italic'); snapshot(); props(); };
    el.querySelectorAll('[data-align]').forEach(b => { b.onclick = () => { set('textAlign', b.dataset.align); snapshot(); props(); }; });
    $('#pShadow').onclick = () => { o.set('shadow', o.shadow ? null : new Shadow({ color: 'rgba(0,0,0,0.45)', blur: 18, offsetX: 0, offsetY: 6 })); canvas.requestRenderAll(); snapshot(); props(); };
  }
  el.querySelectorAll('[data-fill]').forEach(b => { b.onclick = () => { set('fill', b.dataset.fill); if (b.dataset.brand) o.nwColor = b.dataset.brand; snapshot(); props(); }; });
  const custom = el.querySelector('[data-fill-custom]');
  if (custom) { custom.oninput = () => set('fill', custom.value); custom.onchange = snapshot; }
  if ($('#pRadius')) { $('#pRadius').oninput = e => { o.set({ rx: Number(e.target.value), ry: Number(e.target.value) }); canvas.requestRenderAll(); }; $('#pRadius').onchange = snapshot; }
  $('#pOpacity').oninput = e => set('opacity', Number(e.target.value));
  $('#pOpacity').onchange = snapshot;
  $('#pUp').onclick = () => { canvas.bringObjectForward(o); snapshot(); };
  $('#pDown').onclick = () => { canvas.sendObjectBackwards(o); snapshot(); };
  $('#pDup').onclick = async () => { const c = await o.clone(PROPS); c.set({ left: o.left + 30, top: o.top + 30, nwLocked: false }); canvas.add(c); canvas.setActiveObject(c); snapshot(); };
  $('#pDel').onclick = () => { canvas.remove(o); canvas.discardActiveObject(); snapshot(); props(); };
  if ($('#pLock')) $('#pLock').onchange = e => { o.nwLocked = e.target.checked; if (o.nwLocked && !unlocked) applyLocks(); snapshot(); props(); };
  if ($('#pFill')) $('#pFill').onclick = async () => { const f = await pickFile(); if (f) placeImage(await readImage(f), o); };
  if ($('#pFillDrive')) $('#pFillDrive').onclick = () => drivePicker(url => placeImage(url, o));
  if ($('#pReplace')) $('#pReplace').onclick = async () => {
    const f = await pickFile();
    if (!f) return;
    const url = await readImage(f);
    await o.setSrc(url);
    canvas.requestRenderAll();
    snapshot();
  };
}

/** Výber obrázka z Disku tímu. */
async function drivePicker(done) {
  const box = $('#modal');
  const load = async (parent, crumbs) => {
    const d = await api('GET', `/api/drive/items${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`);
    const items = d.items.filter(i => i.kind === 'folder' || /^image\//.test(i.mime || ''));
    box.innerHTML = `<div class="mbox"><div class="mhead"><strong>💾 Obrázok z Disku</strong><button id="mClose">✕</button></div>
      <div class="crumbs">${crumbs.map((c, i) => `<a href="#" data-crumb="${i}">${esc(c.name)}</a>`).join(' › ')}</div>
      <div class="grid">${items.map(i => `<button data-it="${esc(i.id)}" data-kind="${i.kind}" data-name="${esc(i.name)}">${i.kind === 'folder' ? '📁' : '🖼'}<span>${esc(i.name)}</span></button>`).join('') || '<p class="hint">Žiadne obrázky.</p>'}</div></div>`;
    box.style.display = 'flex';
    $('#mClose').onclick = () => { box.style.display = 'none'; };
    box.querySelectorAll('[data-crumb]').forEach(a => { a.onclick = e => { e.preventDefault(); const c = crumbs.slice(0, Number(a.dataset.crumb) + 1); load(c[c.length - 1].id, c); }; });
    box.querySelectorAll('[data-it]').forEach(b => {
      b.onclick = async () => {
        if (b.dataset.kind === 'folder') return load(b.dataset.it, crumbs.concat({ id: b.dataset.it, name: b.dataset.name }));
        const u = await api('GET', `/api/drive/items/${encodeURIComponent(b.dataset.it)}/url?inline=1`);
        const blob = await (await fetch(u.url)).blob();
        box.style.display = 'none';
        done(await readImage(new File([blob], b.dataset.name, { type: blob.type })));
      };
    });
  };
  try { await load(null, [{ id: null, name: 'Disk' }]); } catch (e) { toast(e.message); }
}

/* ── Pridávanie prvkov ── */
function add(kind) {
  const cx = meta.width / 2, cy = meta.height / 2, base = Math.round(Math.min(meta.width, meta.height) / 12);
  let o;
  if (kind === 'heading') o = new Textbox('Nadpis', { left: cx - base * 4, top: cy - base, width: base * 8, fontFamily: meta.brand.fonts.heading, fontWeight: 800, fontSize: base * 1.4, fill: brandColor('text'), textAlign: 'center', nwFont: 'heading', nwColor: 'text' });
  if (kind === 'text') o = new Textbox('Sem napíšte text', { left: cx - base * 4, top: cy, width: base * 8, fontFamily: meta.brand.fonts.body, fontSize: base * 0.6, fill: brandColor('text'), textAlign: 'center', lineHeight: 1.3, nwFont: 'body', nwColor: 'text' });
  if (kind === 'rect') o = new Rect({ left: cx - base * 2, top: cy - base, width: base * 4, height: base * 2, fill: brandColor('primary'), nwColor: 'primary' });
  if (kind === 'circle') o = new Circle({ left: cx - base, top: cy - base, radius: base, fill: brandColor('accent'), nwColor: 'accent' });
  if (kind === 'slot') o = placeholder({ x: cx - base * 3, y: cy - base * 2, w: base * 6, h: base * 4 }, 'Kliknite a vložte fotku', 'image');
  if (!o) return;
  canvas.add(o);
  canvas.setActiveObject(o);
  snapshot();
  props();
}
async function addLogo(i) {
  const logo = meta.brand.logos[i];
  if (!logo) return toast('Logo nahráte v Grafika → Značka.');
  const img = await FabricImage.fromURL(logo.dataURL);
  const s = Math.min((meta.width * 0.25) / img.width, (meta.height * 0.15) / img.height);
  img.set({ scaleX: s, scaleY: s, left: meta.width * 0.05, top: meta.height * 0.05, nwName: logo.name, nwRole: 'logo' });
  canvas.add(img);
  canvas.setActiveObject(img);
  snapshot();
}

/** Použije aktuálnu značku na prvky s farbou/písmom značky (napr. po zmene farieb tímu). */
async function applyBrand() {
  for (const o of canvas.getObjects()) {
    if (o.nwColor && meta.brand.colors[o.nwColor]) o.set('fill', meta.brand.colors[o.nwColor]);
    if (o.nwFont) o.set('fontFamily', resolveFont(o.nwFont));
    if (o.type === 'textbox') o.initDimensions();
  }
  canvas.requestRenderAll();
  snapshot();
  toast('Farby a písma značky použité.');
}

/* ── Štart ── */
async function start() {
  if (!token) { location.href = '/'; return; }
  try {
    meta = await api('GET', `/api/graphics/designs/${encodeURIComponent(id)}`);
  } catch (e) {
    $('#stage').innerHTML = `<p class="msg">${e.message === '401' ? '' : 'Návrh sa nenašiel alebo k nemu nemáte prístup.'}</p>`;
    return;
  }
  readonly = meta.role === 'readonly';
  document.title = `${meta.title} – Neoworkly`;
  $('.back').href = `/dashboard?view=graphics&ws=${encodeURIComponent(meta.ownerId)}`;
  $('#title').value = meta.title;
  $('#title').disabled = readonly;
  $('#size').textContent = `${meta.width} × ${meta.height} px`;
  await Promise.all(meta.fonts.filter(f => !['Georgia', 'Arial'].includes(f)).flatMap(f => ['400', '700', '800'].map(w => document.fonts.load(`${w} 40px "${f}"`).catch(() => null))));
  canvas = new Canvas($('#c'), { preserveObjectStacking: true, backgroundColor: '#ffffff', selection: !readonly });
  if (meta.data) {
    restoring = true;
    await canvas.loadFromJSON(meta.data);
    restoring = false;
  } else if (meta.templateId) {
    // nový návrh zo vstavanej šablóny: vrstvy so značkou tímu
    const t = await api('GET', `/api/graphics/templates/${encodeURIComponent(meta.templateId)}`);
    if (t.layers) (await fromLayers(t.layers)).forEach(o => canvas.add(o));
    else if (t.data) { restoring = true; await canvas.loadFromJSON(t.data); restoring = false; }
  }
  applyLocks();
  fit();
  window.addEventListener('resize', fit);
  history = [json()];
  if (!meta.data && !readonly) { dirty = true; save(); }

  canvas.on('object:modified', snapshot);
  canvas.on('text:changed', () => { dirty = true; scheduleSave(); });
  canvas.on('text:editing:exited', snapshot);
  canvas.on('selection:created', () => { props(); layers(); });
  canvas.on('selection:updated', () => { props(); layers(); });
  canvas.on('selection:cleared', () => { props(); layers(); });
  canvas.on('mouse:dblclick', e => { const o = e.target; if (o && String(o.nwRole || '').startsWith('slot-') && !readonly) $('#pFill') && $('#pFill').click(); });
  // Popis v prázdnom mieste na obrázok
  canvas.on('after:render', ({ ctx }) => {
    canvas.getObjects().filter(o => String(o.nwRole || '').startsWith('slot-') && o.visible).forEach(o => {
      const p = util.transformPoint({ x: o.left + (o.width * o.scaleX) / 2, y: o.top + (o.height * o.scaleY) / 2 }, canvas.viewportTransform);
      ctx.save();
      ctx.font = `600 ${Math.max(11, 30 * zoom)}px Inter, sans-serif`;
      ctx.fillStyle = '#475569';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.nwLabel || 'Obrázok', p.x, p.y);
      ctx.restore();
    });
  });

  layers();
  props();
  $('#status').textContent = readonly ? 'Iba na prezeranie' : 'Uložené';
  if (readonly) document.body.classList.add('ro');

  // Panel prvkov
  document.querySelectorAll('[data-add]').forEach(b => { b.onclick = () => add(b.dataset.add); });
  $('#addImg').onclick = async () => { const f = await pickFile(); if (f) placeImage(await readImage(f)); };
  $('#addDrive').onclick = () => drivePicker(url => placeImage(url));
  $('#logos').innerHTML = meta.brand.logos.map((l, i) => `<button data-logo="${i}" title="${esc(l.name)}"><img src="${l.dataURL}" alt=""></button>`).join('') || '<p class="hint">Logo nahráte v dashboarde: Grafika → Značka.</p>';
  document.querySelectorAll('[data-logo]').forEach(b => { b.onclick = () => addLogo(Number(b.dataset.logo)); });
  $('#applyBrand').onclick = applyBrand;

  // Lišta
  let tt;
  $('#title').oninput = () => { clearTimeout(tt); tt = setTimeout(() => api('PATCH', `/api/graphics/designs/${id}`, { title: $('#title').value }).then(d => { meta.title = d.title; document.title = `${d.title} – Neoworkly`; }).catch(e => toast(e.message)), 600); };
  $('#undo').onclick = async () => { if (history.length < 2) return; future.push(history.pop()); await restore(history[history.length - 1]); };
  $('#redo').onclick = async () => { if (!future.length) return; const s = future.pop(); history.push(s); await restore(s); };
  $('#zin').onclick = () => setZoom(zoom * 1.2);
  $('#zout').onclick = () => setZoom(zoom / 1.2);
  $('#zfit').onclick = fit;
  const menu = $('#menu');
  $('#exportBtn').onclick = e => { e.stopPropagation(); menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; };
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  menu.querySelectorAll('[data-export]').forEach(b => {
    b.onclick = async () => {
      const t = b.dataset.export;
      if (t === 'png') download(await dataURLtoBlob(exportURL('png')), fileName('png'));
      if (t === 'jpg') download(await dataURLtoBlob(exportURL('jpeg')), fileName('jpg'));
      if (t === 'pdf') download(await pdfBlob(), fileName('pdf'));
      if (t === 'drive') {
        try {
          const fd = new FormData();
          fd.append('files', new File([await dataURLtoBlob(exportURL('png'))], fileName('png'), { type: 'image/png' }));
          await api('POST', `/api/drive/files${meta.folderId ? `?parentId=${encodeURIComponent(meta.folderId)}` : ''}`, fd);
          toast('PNG uložené na Disk (priečinok Grafika).');
        } catch (e) { toast(e.message); }
      }
      if (t === 'template') {
        const name = prompt('Názov tímovej šablóny:', meta.title);
        if (!name) return;
        try {
          await api('POST', '/api/graphics/templates', { title: name, width: meta.width, height: meta.height, data: json(), thumb: exportURL('jpeg', 360 / Math.max(meta.width, meta.height), 0.75) });
          toast('Šablóna uložená – tím ju nájde pri novom návrhu.');
        } catch (e) { toast(e.message); }
      }
    };
  });
  if (readonly) menu.querySelectorAll('[data-export=drive],[data-export=template]').forEach(b => { b.style.display = 'none'; });

  // Klávesy
  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const o = canvas.getActiveObject();
    if (o && o.isEditing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? $('#redo') : $('#undo')).click(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && o && !readonly) { canvas.getActiveObjects().forEach(x => canvas.remove(x)); canvas.discardActiveObject(); snapshot(); props(); }
    if (o && !readonly && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      o.set({ left: o.left + (e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0), top: o.top + (e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0) });
      o.setCoords();
      canvas.requestRenderAll();
      clearTimeout(start.k);
      start.k = setTimeout(snapshot, 400);
    }
  });
}
start();
