/* Poznámky (podľa Memos): rýchle písanie, časová os, #štítky, zaškrtávacie zoznamy, pripnutie, archív, z poznámky úloha.
   Používa NW.suite (suite-common.js), esc a showToast z dashboard.js. */
(function () {
  'use strict';
  const N = '/api/notes';
  let filter = { q: '', tag: '', archived: false, mine: false };
  let notes = [];
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.notes = { title: 'Poznámky', load };

  if (window.NW && NW.rt) {
    let t;
    NW.rt.on('note', () => { clearTimeout(t); t = setTimeout(() => { if ($('view-notes') && $('view-notes').style.display !== 'none' && !document.activeElement.matches('#nt-text, [data-edit-text]')) list(); }, 400); });
  }

  /** Text poznámky → HTML: odseky, **tučné**, odkazy, #štítky, - [ ] úlohy (klikateľné). */
  function renderContent(n) {
    let i = -1;
    return esc(n.content).split('\n').map(line => {
      const m = line.match(/^(\s*)[-*] \[( |x)\] (.*)$/i);
      let h = (m ? m[3] : line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener" style="color:#c4bcff">$1</a>')
        .replace(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu, '$1<a href="#" data-tag="$2" style="color:#9b8cff">#$2</a>');
      if (m) { i++; return `<label style="display:flex;gap:0.4rem;align-items:flex-start"><input type="checkbox" data-check="${i}" ${m[2].toLowerCase() === 'x' ? 'checked' : ''} style="margin-top:5px"><span style="${m[2].toLowerCase() === 'x' ? 'text-decoration:line-through;opacity:0.6' : ''}">${h}</span></label>`; }
      if (/^#{1,3} /.test(line)) h = `<strong style="font-size:1.05em">${h.replace(/^#{1,3} /, '')}</strong>`;
      return h ? `<div>${h}</div>` : '<div style="height:0.6em"></div>';
    }).join('');
  }

  async function load() {
    const s = su();
    const open = s.takeOpen('note');
    $('notes-body').innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:1rem;align-items:start;max-width:1100px" class="nw-notes-grid">
      <section>
        ${s.canWrite ? `<div class="panel" style="padding:0.85rem">
          <textarea class="form-control" id="nt-text" rows="3" placeholder="Čo máte na mysli? #štítok, - [ ] úloha, **tučné** … (Ctrl+Enter uloží)" style="min-height:70px"></textarea>
          <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem"><select class="form-control" id="nt-vis" style="width:auto"><option value="workspace">👥 Tím</option><option value="private">🔒 Iba ja</option></select>
          <button class="btn btn-primary" id="nt-save" style="margin-left:auto">Uložiť</button></div></div>` : ''}
        <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap">
          <input class="form-control" id="nt-q" placeholder="🔍 Hľadať" value="${esc(filter.q)}" style="max-width:260px">
          ${filter.tag ? `<span class="btn btn-sm btn-primary" id="nt-cleartag">#${esc(filter.tag)} ✕</span>` : ''}
          <span style="margin-left:auto;${s.muted}">${s.wsPicker(load)}</span></div>
        <div id="nt-list"></div>
      </section>
      <aside class="panel" style="padding:0.75rem">
        <button class="nav-item ${!filter.archived && !filter.mine ? 'active' : ''}" data-f="all" style="width:100%">🗒 Všetky</button>
        <button class="nav-item ${filter.mine ? 'active' : ''}" data-f="mine" style="width:100%">✍ Moje</button>
        <button class="nav-item ${filter.archived ? 'active' : ''}" data-f="archived" style="width:100%">📦 Archív</button>
        <div style="${s.muted};margin:0.7rem 0 0.3rem">Štítky</div><div id="nt-tags"></div>
      </aside></div><style>@media (max-width:860px){.nw-notes-grid{grid-template-columns:1fr !important}}</style>`;
    if ($('nt-save')) {
      const save = async () => {
        const content = $('nt-text').value.trim();
        if (!content) return;
        if (await s.api('POST', N, { content, visibility: $('nt-vis').value })) { $('nt-text').value = ''; list(); tags(); }
      };
      $('nt-save').onclick = save;
      $('nt-text').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); };
    }
    let t;
    $('nt-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { filter.q = e.target.value.trim(); list(); }, 300); };
    if ($('nt-cleartag')) $('nt-cleartag').onclick = () => { filter.tag = ''; load(); };
    $('notes-body').querySelectorAll('[data-f]').forEach(b => {
      b.onclick = () => { filter.archived = b.dataset.f === 'archived'; filter.mine = b.dataset.f === 'mine'; load(); };
    });
    await Promise.all([list(), tags()]);
    if (open) {
      const el = document.querySelector(`[data-note="${open}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.style.boxShadow = '0 0 0 2px #9b8cff'; }
    }
  }

  async function tags() {
    const s = su();
    const list_ = (await s.api('GET', `${N}/tags`)) || [];
    $('nt-tags').innerHTML = list_.map(t => `<a href="#" data-tag="${esc(t.tag)}" style="display:inline-block;margin:0 0.3rem 0.3rem 0;font-size:0.82rem;color:${filter.tag === t.tag ? '#fff' : '#9b8cff'}">#${esc(t.tag)} <span style="${s.muted}">${t.count}</span></a>`).join('') || `<div style="${s.muted}">Pridajte #štítok do poznámky.</div>`;
    bindTags($('nt-tags'));
  }
  function bindTags(root) {
    root.querySelectorAll('[data-tag]').forEach(a => { a.onclick = e => { e.preventDefault(); filter.tag = a.dataset.tag; load(); }; });
  }

  async function list() {
    const s = su();
    const params = { q: filter.q, tag: filter.tag };
    if (filter.archived) params.archived = 1;
    if (filter.mine) params.mine = 1;
    notes = (await apiFetch(s.url(N, params)).then(r => (r && r.ok ? r.json() : [])));
    const me = (JSON.parse(localStorage.getItem('nd_user') || '{}') || {}).id;
    $('nt-list').innerHTML = notes.map(n => `<div class="panel" data-note="${esc(n.id)}" style="padding:0.85rem 1rem">
      <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.4rem">${s.avatar(n.author.id, 22)}
        <span style="${s.muted}">${esc(n.author.name)} · ${s.date(n.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}${n.visibility === 'private' ? ' · 🔒' : ''}${n.pinned ? ' · 📌' : ''}${n.links ? ` · 🔗 ${n.links}` : ''}</span>
        ${s.canWrite ? `<span style="margin-left:auto;display:flex;gap:0.25rem">
          <button class="btn btn-sm btn-secondary" data-act="pin" title="${n.pinned ? 'Odopnúť' : 'Pripnúť'}">📌</button>
          <button class="btn btn-sm btn-secondary" data-act="task" title="Urobiť z poznámky úlohu">✅</button>
          <button class="btn btn-sm btn-secondary" data-act="link" title="Prepojiť">🔗</button>
          ${n.author.id === me ? '<button class="btn btn-sm btn-secondary" data-act="edit" title="Upraviť">✏️</button>' : ''}
          <button class="btn btn-sm btn-secondary" data-act="archive" title="${n.archived ? 'Obnoviť' : 'Archivovať'}">📦</button>
          <button class="btn btn-sm btn-danger" data-act="del" title="Zmazať">✕</button></span>` : ''}</div>
      <div data-content style="font-size:0.92rem;line-height:1.6;word-break:break-word">${renderContent(n)}</div></div>`).join('') || `<div class="empty-state"><div class="empty-state-icon">🗒</div><p>${filter.q || filter.tag ? 'Nič sa nenašlo.' : 'Zatiaľ žiadne poznámky.'}</p></div>`;
    bindTags($('nt-list'));
    $('nt-list').querySelectorAll('[data-note]').forEach(card => {
      const n = notes.find(x => x.id === card.dataset.note);
      card.querySelectorAll('[data-check]').forEach(cb => {
        cb.disabled = !s.canWrite || n.author.id !== me;
        cb.onchange = async () => {
          let i = -1;
          const content = n.content.split('\n').map(line => line.replace(/^(\s*[-*] \[)( |x)(\] )/i, (all, a, mark, b) => (++i === Number(cb.dataset.check) ? `${a}${cb.checked ? 'x' : ' '}${b}` : all))).join('\n');
          if (await s.api('PATCH', `${N}/${n.id}`, { content })) list();
        };
      });
      card.querySelectorAll('[data-act]').forEach(b => {
        b.onclick = async () => {
          const act = b.dataset.act;
          if (act === 'pin' && await s.api('PATCH', `${N}/${n.id}`, { pinned: !n.pinned })) list();
          if (act === 'archive' && await s.api('PATCH', `${N}/${n.id}`, { archived: !n.archived }, n.archived ? 'Obnovené.' : 'Archivované.')) { list(); tags(); }
          if (act === 'del' && confirm('Zmazať poznámku?') && await s.api('DELETE', `${N}/${n.id}`, undefined, 'Zmazané.')) { list(); tags(); }
          if (act === 'task') {
            const t = await s.api('POST', `${N}/${n.id}/to-task`, {}, 'Úloha vytvorená v projekte Doručené a prepojená s poznámkou.');
            if (t) list();
          }
          if (act === 'link') s.modal('🔗 Prepojenia poznámky', '<div data-l></div>', el => s.linksPanel(el.querySelector('[data-l]'), 'note', n.id));
          if (act === 'edit') {
            const box = card.querySelector('[data-content]');
            box.innerHTML = `<textarea class="form-control" data-edit-text rows="5">${esc(n.content)}</textarea>
              <div style="display:flex;gap:0.5rem;margin-top:0.4rem"><select class="form-control" data-vis style="width:auto"><option value="workspace">👥 Tím</option><option value="private" ${n.visibility === 'private' ? 'selected' : ''}>🔒 Iba ja</option></select>
              <button class="btn btn-sm btn-primary" data-save>Uložiť</button><button class="btn btn-sm btn-secondary" data-cancel>Zrušiť</button></div>`;
            box.querySelector('[data-cancel]').onclick = list;
            box.querySelector('[data-save]').onclick = async () => {
              if (await s.api('PATCH', `${N}/${n.id}`, { content: box.querySelector('[data-edit-text]').value, visibility: box.querySelector('[data-vis]').value })) { list(); tags(); }
            };
          }
        };
      });
    });
  }
})();
