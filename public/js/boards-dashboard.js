/* Tabule: zoznam, hľadanie v textoch, nová tabuľa; kreslí sa na /boards/:id (Excalidraw, spolupráca v reálnom čase).
   Používa NW.suite (suite-common.js), esc z dashboard.js. */
(function () {
  'use strict';
  const B = '/api/boards';
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;
  let q = '';

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.boards = { title: 'Tabule', load };
  if (window.NW && NW.rt) {
    let t;
    NW.rt.on('board', () => { clearTimeout(t); t = setTimeout(() => { if ($('view-boards') && $('view-boards').style.display !== 'none') list(); }, 500); });
  }

  async function load() {
    const s = su();
    $('boards-body').innerHTML = `<div class="panel"><div class="panel-header"><div><div class="panel-title">Tabule</div>
      <div class="panel-subtitle">Kreslite spolu: nápady, procesy, schémy webu, mapy myšlienok. Kurzory kolegov vidíte naživo. Tabule sú aj na Disku (priečinok Tabule).</div></div>
      <div style="display:flex;gap:0.5rem;align-items:center">${s.wsPicker(load)}${s.canWrite ? '<button class="btn btn-primary btn-sm" id="bd-new">+ Nová tabuľa</button>' : ''}</div></div>
      <input class="form-control" id="bd-q" placeholder="🔍 Hľadať v názvoch aj textoch na tabuliach" value="${esc(q)}" style="max-width:340px;margin-bottom:0.75rem">
      <div id="bd-list"></div></div>`;
    if ($('bd-new')) $('bd-new').onclick = async () => {
      const title = prompt('Názov tabule:', 'Tabuľa');
      if (title === null) return;
      const b = await s.api('POST', B, { title });
      if (b) location.href = b.url;
    };
    let t;
    $('bd-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); list(); }, 300); };
    list();
  }

  async function list() {
    const s = su();
    const r = await apiFetch(s.url(B, { q }));
    const boards = r && r.ok ? await r.json() : [];
    $('bd-list').innerHTML = boards.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:0.75rem">${boards.map(b => `
      <a href="${esc(b.url)}" style="display:block;background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:0.85rem">
        <div style="font-size:1.4rem">🎨</div><div style="font-weight:700;margin:0.2rem 0">${esc(b.title)}</div>
        <div style="${s.muted};height:3.2em;overflow:hidden">${esc(b.excerpt || 'Bez textu')}</div>
        <div style="${s.muted};margin-top:0.4rem">${esc(b.author)} · ${s.date(b.updatedAt, { dateStyle: 'short', timeStyle: 'short' })}</div></a>`).join('')}</div>`
      : `<div class="empty-state"><div class="empty-state-icon">🎨</div><p>${q ? 'Nič sa nenašlo.' : 'Zatiaľ žiadne tabule.'}</p></div>`;
  }
})();
