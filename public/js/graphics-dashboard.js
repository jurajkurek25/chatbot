/* Grafika zo šablón (podľa Aktivisda): návrhy tímu, galéria šablón (vstavané vo farbách značky + tímové),
   nastavenie značky (farby, písma, logá). Editor beží na /graphics/:id. Používa NW.suite, esc, showToast, apiFetch. */
(function () {
  'use strict';
  const G = '/api/graphics';
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;
  let tab = 'designs';
  let brand = null;
  let kind = 'graphic'; // 'graphic' = Grafika, 'deck' = Prezentácie (ten istý editor so snímkami)
  const VIEW = { graphic: 'graphics', deck: 'decks' };
  const root = () => `${VIEW[kind]}-body`;

  /** Obe sekcie zdieľajú tento modul; skrytá sekcia sa vyprázdni, aby sa neopakovali id prvkov. */
  function enter(k) {
    kind = k;
    const other = $(`${VIEW[k === 'deck' ? 'graphic' : 'deck']}-body`);
    if (other) other.innerHTML = '';
    return load();
  }
  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.graphics = { title: 'Grafika', load: () => enter('graphic') };
  window.NW_SUITE.decks = { title: 'Prezentácie', load: () => enter('deck') };
  if (window.NW && NW.rt) {
    let t;
    NW.rt.on('design', () => { clearTimeout(t); t = setTimeout(() => { const v = $(`view-${VIEW[kind]}`); if (v && v.style.display !== 'none' && tab === 'designs') body(); }, 500); });
  }

  /** Náhľad vstavanej šablóny ako SVG vo farbách a písmach značky. */
  function preview(t) {
    const c = k => (typeof k === 'string' && k.startsWith('brand.') ? brand.colors[k.slice(6)] : k);
    const f = k => (k === 'heading' ? brand.fonts.heading : k === 'body' ? brand.fonts.body : k);
    const logo = brand.logos[0];
    const parts = t.layers.map(l => {
      const op = l.opacity !== undefined ? ` opacity="${l.opacity}"` : '';
      if (l.type === 'rect') return `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.rx || 0}" fill="${esc(c(l.fill))}"${op}/>`;
      if (l.type === 'circle') return `<circle cx="${l.x}" cy="${l.y}" r="${l.r}" fill="${esc(c(l.fill))}"${op}/>`;
      if (l.type === 'image') return `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" fill="#94a3b8" opacity="0.35"/>`;
      if (l.type === 'logo') return logo ? `<image href="${logo.dataURL}" x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" preserveAspectRatio="xMidYMid meet"/>` : `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" fill="none" stroke="#94a3b8" stroke-dasharray="10 8" stroke-width="3"/>`;
      if (l.type === 'text') {
        const anchor = l.align === 'center' ? 'middle' : l.align === 'right' ? 'end' : 'start';
        const x = l.align === 'center' ? l.x + l.w / 2 : l.align === 'right' ? l.x + l.w : l.x;
        // jednoduché zalomenie podľa šírky (náhľad)
        const perLine = Math.max(4, Math.floor(l.w / (l.size * 0.55)));
        const lines = [];
        l.text.split('\n').forEach(p => { let cur = ''; p.split(' ').forEach(w => { if ((cur + ' ' + w).trim().length > perLine) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }); lines.push(cur.trim()); });
        return `<text x="${x}" y="${l.y + l.size}" font-family="${esc(f(l.font))}" font-size="${l.size}" font-weight="${l.weight || 400}" fill="${esc(c(l.color))}" text-anchor="${anchor}">${lines.slice(0, 6).map((ln, i) => `<tspan x="${x}" dy="${i ? l.size * (l.lineHeight || 1.2) : 0}">${esc(ln)}</tspan>`).join('')}</text>`;
      }
      return '';
    }).join('');
    return `<svg viewBox="0 0 ${t.width} ${t.height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block">${parts}</svg>`;
  }

  async function load() {
    const s = su();
    brand = await s.api('GET', `${G}/brand`);
    if (!brand) return;
    $(root()).innerHTML = `<div style="display:flex;gap:0.6rem;align-items:center;margin-bottom:0.9rem;flex-wrap:wrap">
        <div style="display:flex;gap:0.3rem">${[['designs', kind === 'deck' ? '📽 Prezentácie' : '🖼 Návrhy'], ['brand', '🎨 Značka']].map(([k, l]) => `<button class="nav-item ${tab === k ? 'active' : ''}" data-gt="${k}" style="width:auto">${l}</button>`).join('')}</div>
        <span style="margin-left:auto;display:flex;gap:0.5rem;align-items:center">${s.wsPicker(load)}${s.canWrite ? `<button class="btn btn-primary" id="gr-new">${kind === 'deck' ? '+ Nová prezentácia' : '+ Nový návrh'}</button>` : ''}</span></div>
      <div id="gr-body"></div>`;
    document.querySelectorAll(`#${root()} [data-gt]`).forEach(b => { b.onclick = () => { tab = b.dataset.gt; load(); }; });
    if ($('gr-new')) $('gr-new').onclick = gallery;
    body();
  }
  function body() { (tab === 'brand' ? brandPanel : designs)(); }

  async function designs() {
    const s = su();
    const list = (await s.api('GET', `${G}/designs?kind=${kind}`)) || [];
    $('gr-body').innerHTML = list.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:0.85rem">${list.map(d => `
      <div class="panel" style="margin:0;padding:0.6rem;display:flex;flex-direction:column;gap:0.45rem">
        <a href="${esc(d.url)}" style="display:flex;align-items:center;justify-content:center;aspect-ratio:${kind === 'deck' ? '16/9' : '1'};background:#0a0a14;border-radius:8px;overflow:hidden">
          ${d.thumb ? `<img src="${d.thumb}" alt="" style="max-width:100%;max-height:100%;object-fit:contain">` : '<span style="font-size:2rem">🖼</span>'}</a>
        <a href="${esc(d.url)}" style="font-weight:700;color:#eeeef5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.title)}</a>
        <div style="${s.muted}">${d.width}×${d.height} · ${esc(d.author)} · ${s.date(d.updatedAt, { dateStyle: 'short' })}</div>
        ${s.canWrite ? `<div style="display:flex;gap:0.3rem"><button class="btn btn-sm btn-secondary" data-dup="${esc(d.id)}" title="Duplikovať">⧉</button><button class="btn btn-sm btn-danger" data-del="${esc(d.id)}" title="Do koša">✕</button></div>` : ''}</div>`).join('')}</div>`
      : (kind === 'deck' ? `<div class="empty-state"><div class="empty-state-icon">📽</div><p>Zatiaľ žiadna prezentácia. ${s.canWrite ? 'Začnite šablónou vo farbách značky – úvodná snímka, obsah, fotka a záver. Prezentujete priamo z prehliadača, export do PDF aj PowerPointu.' : ''}</p></div>` : `<div class="empty-state"><div class="empty-state-icon">🖼</div><p>Zatiaľ žiadna grafika. ${s.canWrite ? 'Vyberte šablónu – príspevok na Instagram, story, plagát, miniatúru… Farby a logo sa doplnia zo značky tímu.' : ''}</p></div>`);
    document.querySelectorAll('#gr-body [data-dup]').forEach(b => { b.onclick = async () => { if (await s.api('POST', `${G}/designs/${b.dataset.dup}/duplicate`, {}, 'Skopírované.')) designs(); }; });
    document.querySelectorAll('#gr-body [data-del]').forEach(b => { b.onclick = async () => { if (confirm('Presunúť návrh do koša na Disku?') && await s.api('DELETE', `${G}/designs/${b.dataset.del}`, undefined, 'Presunuté do koša.')) designs(); }; });
  }

  async function gallery() {
    const s = su();
    const tpls = ((await s.api('GET', `${G}/templates`)) || []).filter(t => (t.kind || 'graphic') === kind);
    const groups = {};
    tpls.forEach(t => { (groups[t.team ? '⭐ Šablóny tímu' : t.category] = groups[t.team ? '⭐ Šablóny tímu' : t.category] || []).push(t); });
    const card = t => `<button data-tpl="${esc(t.id)}" style="background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:0.45rem;cursor:pointer;color:#eeeef5;text-align:left">
      <div style="aspect-ratio:${t.width}/${t.height};max-height:190px;margin:0 auto 0.35rem;background:#0a0a14;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center">
        ${t.builtin ? preview(t) : t.thumb ? `<img src="${t.thumb}" alt="" style="max-width:100%;max-height:100%">` : '🖼'}</div>
      <div style="font-size:0.82rem;font-weight:600">${esc(t.title)}</div><div style="${s.muted}">${t.width}×${t.height}</div></button>`;
    s.modal('🖼 Nový návrh', `<p style="${s.muted};margin-bottom:0.8rem">Šablóny sa vyfarbia podľa značky tímu (Grafika → Značka). Zamknuté vrstvy (🔒) držia jednotný vzhľad.</p>
      ${Object.entries(groups).map(([g, list]) => `<div style="font-weight:700;margin:0.8rem 0 0.4rem">${esc(g)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0.6rem;align-items:start">${list.map(card).join('')}</div>`).join('')}
      <div style="font-weight:700;margin:1rem 0 0.4rem">Prázdne plátno</div>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap">${Object.entries(brand.sizes).filter(([, z]) => (z.kind || 'graphic') === kind).map(([k, z]) => `<button class="btn btn-sm btn-secondary" data-blank="${k}">${esc(z.label)} <span style="${s.muted}">${z.width}×${z.height}</span></button>`).join('')}</div>`, (el, close) => {
      el.querySelectorAll('[data-tpl]').forEach(b => {
        b.onclick = async () => {
          const t = tpls.find(x => x.id === b.dataset.tpl);
          const body = { title: t.title, kind, width: t.width, height: t.height, templateId: t.id };
          if (t.team) { const full = await s.api('GET', `${G}/templates/${t.id}`); if (!full) return; body.data = full.data; body.thumb = t.thumb; }
          const d = await s.api('POST', `${G}/designs`, body);
          if (d) { close(); location.href = d.url; }
        };
      });
      el.querySelectorAll('[data-blank]').forEach(b => {
        b.onclick = async () => {
          const z = brand.sizes[b.dataset.blank];
          const d = await s.api('POST', `${G}/designs`, { title: z.label, kind, width: z.width, height: z.height });
          if (d) { close(); location.href = d.url; }
        };
      });
      // tímové šablóny môže autor/majiteľ zmazať (pravým klikom)
      el.querySelectorAll('[data-tpl]').forEach(b => {
        const t = tpls.find(x => x.id === b.dataset.tpl);
        if (!t.team || !s.canWrite) return;
        b.oncontextmenu = async e => { e.preventDefault(); if (confirm(`Zmazať tímovú šablónu „${t.title}“?`) && await s.api('DELETE', `${G}/templates/${t.id}`, undefined, 'Šablóna zmazaná.')) { close(); gallery(); } };
        b.title = 'Pravý klik: zmazať šablónu';
      });
    }, { wide: true });
  }

  function brandPanel() {
    const s = su();
    const ro = s.canWrite ? '' : 'disabled';
    const names = { primary: 'Hlavná', secondary: 'Doplnková', accent: 'Akcent', text: 'Text', background: 'Pozadie' };
    $('gr-body').innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:1rem;align-items:start" class="nw-br-grid">
      <div class="panel" style="margin:0">
        <div class="panel-title" style="margin-bottom:0.3rem">Značka tímu</div>
        <p style="${s.muted};margin-bottom:1rem">Platí pre všetky šablóny. Kto robí grafiku, nemusí riešiť farby ani logo – vyberie šablónu a prepíše text.</p>
        <div class="form-group"><label>Farby</label><div style="display:flex;gap:0.8rem;flex-wrap:wrap">${Object.entries(names).map(([k, n]) => `
          <label style="display:flex;flex-direction:column;align-items:center;gap:0.25rem;font-size:0.78rem"><input type="color" data-color="${k}" value="${esc(brand.colors[k])}" ${ro} style="width:54px;height:54px;border:0;background:none;padding:0;cursor:pointer">${n}</label>`).join('')}</div></div>
        <div class="form-row"><div class="form-group" style="flex:1"><label>Písmo nadpisov</label><select class="form-control" id="br-heading" ${ro}>${brand.fontsAvailable.map(f => `<option ${brand.fonts.heading === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
          <div class="form-group" style="flex:1"><label>Písmo textu</label><select class="form-control" id="br-body" ${ro}>${brand.fontsAvailable.map(f => `<option ${brand.fonts.body === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div></div>
        <div class="form-group"><label>Logá (PNG/SVG s priehľadným pozadím, max. 600 kB)</label>
          <div id="br-logos" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem"></div>
          ${s.canWrite ? '<label class="btn btn-sm btn-secondary" style="cursor:pointer">+ Nahrať logo<input type="file" id="br-file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden></label>' : ''}</div>
        ${s.canWrite ? '<button class="btn btn-primary" id="br-save">Uložiť značku</button>' : ''}
      </div>
      <div class="panel" style="margin:0"><div style="${s.muted};margin-bottom:0.5rem">Náhľad</div><div id="br-prev"></div></div></div>
      <style>@media (max-width:860px){.nw-br-grid{grid-template-columns:1fr !important}}</style>`;
    const logos = brand.logos;
    const renderLogos = () => {
      $('br-logos').innerHTML = logos.map((l, i) => `<div style="position:relative;background:#fff;border-radius:8px;padding:0.3rem;width:96px;height:64px;display:flex;align-items:center;justify-content:center">
        <img src="${l.dataURL}" alt="" style="max-width:100%;max-height:100%">${s.canWrite ? `<button data-rm="${i}" style="position:absolute;top:-6px;right:-6px;background:#ff4060;color:#fff;border:0;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:0.7rem">✕</button>` : ''}</div>`).join('') || `<span style="${s.muted}">Zatiaľ žiadne logo.</span>`;
      $('br-logos').querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { logos.splice(Number(b.dataset.rm), 1); renderLogos(); prev(); }; });
    };
    const current = () => {
      const colors = {};
      document.querySelectorAll('#gr-body [data-color]').forEach(i => { colors[i.dataset.color] = i.value; });
      return { colors, fonts: { heading: $('br-heading').value, body: $('br-body').value }, logos };
    };
    const prev = () => {
      Object.assign(brand, current()); // náhľad neuloženej značky (uloží sa tlačidlom)
      $('br-prev').innerHTML = `<div style="aspect-ratio:1;border-radius:8px;overflow:hidden">${preview({ width: 1080, height: 1080, layers: [
        { type: 'rect', x: 0, y: 0, w: 1080, h: 1080, fill: 'brand.primary' }, { type: 'circle', x: 900, y: 180, r: 220, fill: 'brand.accent', opacity: 0.9 },
        { type: 'text', x: 90, y: 330, w: 900, text: 'Nadpis vo vašom štýle', font: 'heading', size: 96, weight: 800, color: '#ffffff', lineHeight: 1.1 },
        { type: 'text', x: 90, y: 640, w: 900, text: 'Text príspevku v písme značky', font: 'body', size: 46, color: '#ffffff' },
        { type: 'logo', x: 90, y: 880, w: 220, h: 110 }] })}</div>`;
    };
    renderLogos();
    prev();
    document.querySelectorAll('#gr-body [data-color], #br-heading, #br-body').forEach(i => { i.oninput = prev; i.onchange = prev; });
    if ($('br-file')) $('br-file').onchange = e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 600 * 1024) return showToast('Logo je väčšie ako 600 kB.', 'error');
      const fr = new FileReader();
      fr.onload = () => { logos.push({ name: f.name.replace(/\.[^.]+$/, ''), dataURL: fr.result }); renderLogos(); prev(); };
      fr.readAsDataURL(f);
    };
    if ($('br-save')) $('br-save').onclick = async () => {
      const r = await s.api('PUT', `${G}/brand`, current(), 'Značka uložená.');
      if (r) Object.assign(brand, r);
    };
  }
})();
