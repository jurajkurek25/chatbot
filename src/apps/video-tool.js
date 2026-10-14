// Video štúdio Neoworkly (podľa FilmCraft, ľahká verzia v prehliadači): klipy z Disku alebo z počítača, strih,
// poradie, formát pre sociálne siete, titulok a logo zo značky tímu, hudba. Export cez MediaRecorder (MP4 alebo WebM).
// Bez externých knižníc. Zostavenie: npm run build:apps → public/apps/video/
const token = (() => { try { return localStorage.getItem('nd_token'); } catch { return null; } })();
const qs = new URLSearchParams(location.search);
const ws = qs.get('ws') || '';
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FORMATS = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080], '4:5': [1080, 1350] };
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;

let clips = []; // { url, name, el, duration, in, out, thumb }
let selected = -1;
let brand = { colors: { primary: '#5b4fff', accent: '#f59e0b', text: '#111827', background: '#000000' }, fonts: { heading: 'Inter' }, logos: [] };
let canWrite = true;
let folderId = qs.get('parent') || null;
let music = null; // { url, name, el }
let playing = null; // { stop() }
let logoImg = null;

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
  toast.t = setTimeout(() => { t.style.display = 'none'; }, 3000);
}

/* ── Klipy ── */
function loadVideo(url) {
  return new Promise((ok, fail) => {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.src = url;
    el.onloadedmetadata = () => ok(el);
    el.onerror = () => fail(new Error('Video sa nedá prehrať v tomto prehliadači (skúste MP4 alebo WebM).'));
  });
}
const seek = (el, t) => new Promise(ok => { if (Math.abs(el.currentTime - t) < 0.01) return ok(); el.onseeked = () => { el.onseeked = null; ok(); }; el.currentTime = t; });
async function addClip(name, blob) {
  const url = URL.createObjectURL(blob);
  const el = await loadVideo(url);
  const duration = Number.isFinite(el.duration) ? el.duration : 0;
  await seek(el, Math.min(1, duration / 3));
  const c = document.createElement('canvas');
  c.width = 160; c.height = Math.round(160 * (el.videoHeight || 9) / (el.videoWidth || 16));
  c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
  clips.push({ url, name, el, duration, in: 0, out: duration, thumb: c.toDataURL('image/jpeg', 0.7) });
  selected = clips.length - 1;
  renderTimeline();
  drawAt(totalBefore(selected));
}
const length = c => Math.max(0, c.out - c.in);
const total = () => clips.reduce((s, c) => s + length(c), 0);
const totalBefore = i => clips.slice(0, i).reduce((s, c) => s + length(c), 0);

function renderTimeline() {
  const el = $('#timeline');
  $('#empty').style.display = clips.length ? 'none' : 'block';
  $('#stageWrap').style.display = clips.length ? 'flex' : 'none';
  document.querySelectorAll('.need').forEach(b => { b.disabled = !clips.length; });
  $('#dur').textContent = clips.length ? `Spolu ${fmtTime(total())}` : '';
  el.innerHTML = clips.map((c, i) => `<div class="clip ${i === selected ? 'on' : ''}" data-i="${i}" draggable="true" style="flex-grow:${Math.max(1, length(c))}">
      <img src="${c.thumb}" alt=""><div class="meta"><b>${i + 1}</b> ${esc(c.name)}<span>${fmtTime(length(c))}</span></div>
      <button data-rm="${i}" title="Odstrániť klip">✕</button></div>`).join('');
  let from = null;
  el.querySelectorAll('.clip').forEach(div => {
    const i = Number(div.dataset.i);
    div.onclick = e => { if (e.target.closest('[data-rm]')) return; selected = i; renderTimeline(); drawAt(totalBefore(i)); };
    div.ondragstart = () => { from = i; };
    div.ondragover = e => e.preventDefault();
    div.ondrop = e => { e.preventDefault(); if (from === null || from === i) return; const [c] = clips.splice(from, 1); clips.splice(i, 0, c); selected = i; from = null; renderTimeline(); };
  });
  el.querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { const [c] = clips.splice(Number(b.dataset.rm), 1); URL.revokeObjectURL(c.url); selected = Math.min(selected, clips.length - 1); renderTimeline(); if (clips.length) drawAt(0); }; });
  trimPanel();
}

function trimPanel() {
  const p = $('#trim');
  const c = clips[selected];
  if (!c) { p.innerHTML = '<p class="hint">Vyberte klip na časovej osi.</p>'; return; }
  p.innerHTML = `<h4>Klip ${selected + 1}: ${esc(c.name)}</h4>
    <label>Začiatok <span id="tIn">${fmtTime(c.in)}</span></label><input type="range" id="rIn" min="0" max="${c.duration}" step="0.1" value="${c.in}">
    <label>Koniec <span id="tOut">${fmtTime(c.out)}</span></label><input type="range" id="rOut" min="0" max="${c.duration}" step="0.1" value="${c.out}">
    <p class="hint">Dĺžka ${fmtTime(length(c))} z ${fmtTime(c.duration)}</p>`;
  $('#rIn').oninput = e => { c.in = Math.min(Number(e.target.value), c.out - 0.2); $('#tIn').textContent = fmtTime(c.in); preview(c, c.in); };
  $('#rOut').oninput = e => { c.out = Math.max(Number(e.target.value), c.in + 0.2); $('#tOut').textContent = fmtTime(c.out); preview(c, c.out); };
  $('#rIn').onchange = $('#rOut').onchange = () => renderTimeline();
}
async function preview(c, t) { await seek(c.el, t); draw(c.el); }

/* ── Kompozícia ── */
function settings() {
  const [w, h] = FORMATS[$('#format').value];
  return {
    w, h, fit: $('#fit').value, bg: $('#bg').value,
    title: $('#title').value.trim(), titlePos: $('#titlePos').value, titleColor: $('#titleColor').value, titleBar: $('#titleBar').checked, titleSize: Number($('#titleSize').value),
    logo: $('#useLogo').checked && logoImg, logoPos: $('#logoPos').value,
    origVol: Number($('#origVol').value), musicVol: Number($('#musicVol').value),
  };
}
function draw(video, s = settings()) {
  const cv = $('#cv');
  if (cv.width !== s.w || cv.height !== s.h) { cv.width = s.w; cv.height = s.h; }
  const ctx = cv.getContext('2d');
  ctx.fillStyle = s.bg;
  ctx.fillRect(0, 0, s.w, s.h);
  if (video && video.videoWidth) {
    const r = s.fit === 'cover' ? Math.max(s.w / video.videoWidth, s.h / video.videoHeight) : Math.min(s.w / video.videoWidth, s.h / video.videoHeight);
    const vw = video.videoWidth * r, vh = video.videoHeight * r;
    ctx.drawImage(video, (s.w - vw) / 2, (s.h - vh) / 2, vw, vh);
  }
  if (s.title) {
    const size = Math.round(Math.min(s.w, s.h) * s.titleSize / 100);
    ctx.font = `800 ${size}px "${brand.fonts.heading}", Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrap(ctx, s.title, s.w * 0.86);
    const lh = size * 1.15;
    const blockH = lines.length * lh;
    const y0 = s.titlePos === 'top' ? s.h * 0.1 : s.titlePos === 'center' ? (s.h - blockH) / 2 : s.h * 0.88 - blockH;
    if (s.titleBar) {
      const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
      ctx.fillStyle = hexA(brand.colors.primary, 0.85);
      roundRect(ctx, (s.w - maxW) / 2 - size * 0.5, y0 - size * 0.35, maxW + size, blockH + size * 0.7, size * 0.3);
    }
    ctx.fillStyle = s.titleColor;
    if (!s.titleBar) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = size * 0.25; }
    lines.forEach((l, i) => ctx.fillText(l, s.w / 2, y0 + lh * i + lh / 2));
    ctx.shadowBlur = 0;
  }
  if (s.logo) {
    const lw = Math.min(s.w, s.h) * 0.2, lh = lw * s.logo.height / s.logo.width, m = Math.min(s.w, s.h) * 0.04;
    const x = s.logoPos.includes('l') ? m : s.w - lw - m, y = s.logoPos.includes('t') ? m : s.h - lh - m;
    ctx.globalAlpha = 0.92;
    ctx.drawImage(s.logo, x, y, lw, lh);
    ctx.globalAlpha = 1;
  }
}
function wrap(ctx, text, maxW) {
  const out = [];
  text.split('\n').forEach(p => { let cur = ''; p.split(' ').forEach(w => { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; }); out.push(cur); });
  return out.slice(0, 4);
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.fill(); }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
async function drawAt(t) {
  let acc = 0;
  for (const c of clips) {
    if (t < acc + length(c) || c === clips[clips.length - 1]) { await seek(c.el, Math.min(c.out, c.in + Math.max(0, t - acc))); draw(c.el); return; }
    acc += length(c);
  }
  draw(null);
}

/* ── Prehrávanie a export (rovnaká cesta – export je prehranie do nahrávača) ── */
let audioCtx = null, audioDest = null;
const sources = new WeakMap();
function audioFor(el, gain) {
  if (!audioCtx) { audioCtx = new AudioContext(); audioDest = audioCtx.createMediaStreamDestination(); }
  let node = sources.get(el);
  if (!node) {
    const src = audioCtx.createMediaElementSource(el);
    const g = audioCtx.createGain();
    src.connect(g);
    g.connect(audioCtx.destination);
    g.connect(audioDest);
    node = g;
    sources.set(el, node);
  }
  node.gain.value = gain;
  return node;
}

function play({ record } = {}) {
  if (playing) { playing.stop(); return null; }
  const s = settings();
  let stopped = false;
  let raf = 0;
  const btn = $('#play');
  btn.textContent = '■ Zastaviť';
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  let rec = null, chunks = [];
  const done = new Promise(resolve => {
    playing = { stop: () => { stopped = true; } };
    (async () => {
      clips.forEach(c => audioFor(c.el, s.origVol));
      if (music) { audioFor(music.el, s.musicVol); music.el.currentTime = 0; }
      if (record) {
        const stream = $('#cv').captureStream(30);
        audioDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        const type = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
        rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
        rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        rec.start(1000);
      }
      if (music) music.el.play().catch(() => {});
      const start = record ? 0 : selected;
      for (let i = Math.max(0, start); i < clips.length && !stopped; i++) {
        const c = clips[i];
        selected = i;
        document.querySelectorAll('.clip').forEach((d, j) => d.classList.toggle('on', j === i));
        await seek(c.el, c.in);
        await c.el.play();
        await new Promise(next => {
          const tick = () => {
            if (stopped || c.el.currentTime >= c.out - 0.03 || c.el.ended) { c.el.pause(); return next(); }
            draw(c.el, s);
            $('#pos').textContent = `${fmtTime(totalBefore(i) + c.el.currentTime - c.in)} / ${fmtTime(total())}`;
            if (record) $('#progress').style.width = `${Math.round(((totalBefore(i) + c.el.currentTime - c.in) / total()) * 100)}%`;
            raf = requestAnimationFrame(tick);
          };
          tick();
        });
      }
      cancelAnimationFrame(raf);
      if (music) music.el.pause();
      if (rec) {
        await new Promise(r => { rec.onstop = r; rec.stop(); });
        resolve(stopped ? null : new Blob(chunks, { type: rec.mimeType.split(';')[0] }));
      } else resolve(null);
      playing = null;
      btn.textContent = '▶ Prehrať';
    })();
  });
  return done;
}

async function exportVideo(toDisk) {
  if (!clips.length) return;
  if (playing) playing.stop();
  $('#exporting').style.display = 'flex';
  $('#progress').style.width = '0%';
  $('#cancelExport').onclick = () => playing && playing.stop();
  try {
    const blob = await play({ record: true });
    if (!blob) { toast('Export zrušený.'); return; }
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const fname = `${($('#name').value || 'video').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
    if (toDisk) {
      const fd = new FormData();
      fd.append('files', new File([blob], fname, { type: blob.type }));
      await api('POST', `/api/drive/files${folderId ? `?parentId=${encodeURIComponent(folderId)}` : ''}`, fd);
      toast(`Video ${fname} uložené na Disk.`);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  } catch (e) { toast(e.message); } finally { $('#exporting').style.display = 'none'; }
}

/* ── Disk ── */
function drivePicker(accept, onPick) {
  const box = $('#modal');
  const load = async (parent, crumbs) => {
    const d = await api('GET', `/api/drive/items${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`);
    const items = d.items.filter(i => i.kind === 'folder' || accept.test(i.mime || ''));
    box.innerHTML = `<div class="mbox"><div class="mhead"><strong>💾 Vybrať z Disku</strong><button id="mClose">✕</button></div>
      <div class="crumbs">${crumbs.map((c, i) => `<a href="#" data-crumb="${i}">${esc(c.name)}</a>`).join(' › ')}</div>
      <div class="list">${items.map(i => `<button data-it="${esc(i.id)}" data-kind="${i.kind}" data-name="${esc(i.name)}">${i.kind === 'folder' ? '📁' : accept.source.includes('audio') ? '🎵' : '🎬'} ${esc(i.name)}</button>`).join('') || '<p class="hint">Nič vhodné.</p>'}</div></div>`;
    box.style.display = 'flex';
    $('#mClose').onclick = () => { box.style.display = 'none'; };
    box.querySelectorAll('[data-crumb]').forEach(a => { a.onclick = e => { e.preventDefault(); const c = crumbs.slice(0, Number(a.dataset.crumb) + 1); load(c[c.length - 1].id, c); }; });
    box.querySelectorAll('[data-it]').forEach(b => {
      b.onclick = () => {
        if (b.dataset.kind === 'folder') return load(b.dataset.it, crumbs.concat({ id: b.dataset.it, name: b.dataset.name }));
        box.style.display = 'none';
        onPick(b.dataset.it, b.dataset.name);
      };
    });
  };
  load(null, [{ id: null, name: 'Disk' }]).catch(e => toast(e.message));
}
async function driveBlob(itemId) {
  const u = await api('GET', `/api/drive/items/${encodeURIComponent(itemId)}/url?inline=1`);
  const r = await fetch(u.url);
  if (!r.ok) throw new Error('Súbor sa nepodarilo načítať.');
  return r.blob();
}
async function addFromDrive(itemId, name) {
  $('#loading').style.display = 'flex';
  try { await addClip(name, await driveBlob(itemId)); } catch (e) { toast(e.message); }
  $('#loading').style.display = 'none';
}
async function setMusic(name, blob) {
  if (music) URL.revokeObjectURL(music.url);
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  el.loop = true;
  music = { url, name, el };
  $('#musicName').textContent = name;
}

/* ── Štart ── */
async function start() {
  if (!token) { location.href = '/'; return; }
  try {
    const list = await api('GET', '/api/realtime/workspaces');
    const w = list.find(x => x.ownerId === ws) || list[0];
    canWrite = !w || ['owner', 'editor'].includes(w.role);
  } catch { /* predvolene môže */ }
  try { brand = await api('GET', '/api/graphics/brand'); } catch { /* predvolená značka */ }
  if (brand.logos[0]) { logoImg = new Image(); logoImg.src = brand.logos[0].dataURL; } else $('#useLogo').disabled = true;
  $('#bg').value = brand.colors.secondary || '#000000';
  $('#titleColor').value = '#ffffff';
  $('#swatches').innerHTML = Object.values(brand.colors).concat(['#ffffff', '#000000']).map(c => `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
  $('#swatches').querySelectorAll('[data-c]').forEach(b => { b.onclick = () => { $('#titleColor').value = b.dataset.c; drawAt(0); }; });
  document.fonts.load(`800 40px "${brand.fonts.heading}"`).catch(() => {});
  $('.back').href = `/dashboard?view=drive${ws ? `&ws=${encodeURIComponent(ws)}` : ''}`;
  if (!canWrite) document.querySelectorAll('.write').forEach(b => { b.style.display = 'none'; });

  $('#addDrive').onclick = () => drivePicker(/^video\//, addFromDrive);
  $('#addFile').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    $('#loading').style.display = 'flex';
    for (const f of e.target.files) { try { await addClip(f.name, f); } catch (err) { toast(`${f.name}: ${err.message}`); } }
    e.target.value = '';
    $('#loading').style.display = 'none';
  };
  $('#musicDrive').onclick = () => drivePicker(/^audio\//, async (itemId, name) => { try { await setMusic(name, await driveBlob(itemId)); } catch (e) { toast(e.message); } });
  $('#musicFile').onclick = () => $('#mfile').click();
  $('#mfile').onchange = e => { const f = e.target.files[0]; if (f) setMusic(f.name, f); e.target.value = ''; };
  $('#musicDel').onclick = () => { if (music) { music.el.pause(); URL.revokeObjectURL(music.url); } music = null; $('#musicName').textContent = 'bez hudby'; };
  $('#play').onclick = () => play();
  $('#dl').onclick = () => exportVideo(false);
  $('#save').onclick = () => exportVideo(true);
  document.querySelectorAll('#settings input, #settings select').forEach(x => { x.oninput = () => { if (!playing) drawAt(totalBefore(Math.max(0, selected))); }; });
  renderTimeline();
  if (qs.get('file')) await addFromDrive(qs.get('file'), qs.get('name') || 'video');
}
start();
