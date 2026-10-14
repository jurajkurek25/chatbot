/* Dokumenty: zoznam, hľadanie v obsahu, nový dokument; editor beží na /docs/:id (BlockNote, spolupráca v reálnom čase).
   Používa NW.suite (suite-common.js), esc z dashboard.js. */
(function () {
  'use strict';
  const D = '/api/docs';
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;
  let q = '';

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.docs = { title: 'Dokumenty', load };
  if (window.NW && NW.rt) {
    let t;
    NW.rt.on('doc', () => { clearTimeout(t); t = setTimeout(() => { if ($('view-docs') && $('view-docs').style.display !== 'none') list(); }, 500); });
  }

  async function load() {
    const s = su();
    $('docs-body').innerHTML = `<div class="panel"><div class="panel-header"><div><div class="panel-title">Dokumenty</div>
      <div class="panel-subtitle">Píšte spolu v reálnom čase – zmeny vidia všetci hneď. Dokumenty sú aj na Disku (priečinok Dokumenty), kde ich triedite a zdieľate.</div></div>
      <div style="display:flex;gap:0.5rem;align-items:center">${s.wsPicker(load)}${s.canWrite ? '<button class="btn btn-primary btn-sm" id="dc-new">+ Nový dokument</button>' : ''}</div></div>
      <input class="form-control" id="dc-q" placeholder="🔍 Hľadať v názvoch aj texte" value="${esc(q)}" style="max-width:340px;margin-bottom:0.75rem">
      <div id="dc-list"></div></div>`;
    if ($('dc-new')) $('dc-new').onclick = async () => {
      const title = prompt('Názov dokumentu:', 'Bez názvu');
      if (title === null) return;
      const d = await s.api('POST', D, { title });
      if (d) location.href = d.url;
    };
    let t;
    $('dc-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); list(); }, 300); };
    list();
  }

  async function list() {
    const s = su();
    const r = await apiFetch(s.url(D, { q }));
    const docs = r && r.ok ? await r.json() : [];
    $('dc-list').innerHTML = docs.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:0.75rem">${docs.map(d => `
      <a href="${esc(d.url)}" target="_blank" style="display:block;background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:0.85rem">
        <div style="font-size:1.4rem">${esc(d.icon)}</div><div style="font-weight:700;margin:0.2rem 0">${esc(d.title)}</div>
        <div style="${s.muted};height:3.2em;overflow:hidden">${esc(d.excerpt || 'Prázdny dokument')}</div>
        <div style="${s.muted};margin-top:0.4rem">${esc(d.author)} · ${s.date(d.updatedAt, { dateStyle: 'short', timeStyle: 'short' })}</div></a>`).join('')}</div>`
      : `<div class="empty-state"><div class="empty-state-icon">📄</div><p>${q ? 'Nič sa nenašlo.' : 'Zatiaľ žiadne dokumenty.'}</p></div>`;
  }
})();
