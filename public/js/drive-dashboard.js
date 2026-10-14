/* Disk v dashboarde: súbory majiteľa a tímu, zdieľanie odkazom, priečinky klientov, kôš.
   Používa apiFetch, esc a showToast z dashboard.js. */
(function () {
  'use strict';
  const D = '/api/drive';
  const muted = 'color:#7e7ea0;font-size:0.78rem';
  let ws = null;          // ownerId aktuálneho Disku (null = môj)
  let workspaces = [];
  let parent = null;      // id otvoreného priečinka
  let data = null;        // posledná odpoveď /items
  let mode = 'files';     // files | trash | search
  let query = '';

  const body = () => document.getElementById('drive-body');
  const q = (extra = {}) => {
    const p = new URLSearchParams(extra);
    if (ws) p.set('ws', ws);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const json = (method, b) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const size = b => !b ? '—' : b > 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`;
  const date = t => new Date(t * 1000).toLocaleDateString('sk-SK');
  const writable = () => !data || data.role === 'owner' || data.role === 'editor';

  function icon(i) {
    if (i.kind === 'folder') return i.system === 'clients' ? '👥' : i.member ? '🧑' : '📁';
    const m = i.mime || '';
    if (m.startsWith('image/')) return '🖼';
    if (m.startsWith('video/')) return '🎬';
    if (m.startsWith('audio/')) return '🎵';
    if (m === 'application/pdf') return '📕';
    if (/sheet|excel|csv/.test(m)) return '📊';
    if (/word|document|text/.test(m)) return '📄';
    if (/zip|compressed|rar|7z/.test(m)) return '🗜';
    return '📎';
  }

  async function call(url, opts, ok) {
    const r = await apiFetch(url, opts);
    if (!r) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(d.error || 'Chyba', 'error'); return null; }
    if (ok) showToast(ok);
    return d;
  }

  /* ── Modálne okno ──────────────────────────────────────────── */
  function modal(title, html, onReady) {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1100;display:flex;align-items:center;justify-content:center;padding:0.75rem';
    o.innerHTML = `<div class="modal-box modal-box-lg" style="max-height:90vh;overflow:auto"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <h2 style="font-size:1.05rem;font-weight:700">${title}</h2><button class="btn btn-sm btn-secondary" data-close>✕</button></div><div data-body>${html}</div></div>`;
    const close = () => o.remove();
    o.addEventListener('click', e => { if (e.target === o || e.target.closest('[data-close]')) close(); });
    document.body.appendChild(o);
    if (onReady) onReady(o.querySelector('[data-body]'), close);
    return close;
  }

  /* ── Načítanie a vykreslenie ───────────────────────────────── */
  window.loadDrive = async function () {
    workspaces = (await call(`${D}/workspaces`)) || [];
    if (!ws || !workspaces.some(w => w.ownerId === ws)) ws = null;
    mode = 'files';
    render();
  };

  async function render() {
    if (mode === 'trash') return renderTrash();
    const d = mode === 'search'
      ? { ...(data || {}), items: (await call(`${D}/search${q({ q: query })}`)) || [], path: [] }
      : await call(`${D}/items${q(parent ? { parent } : {})}`);
    if (!d) { if (parent) { parent = null; render(); } return; }
    data = d;
    const pct = d.quota ? Math.min(100, Math.round(100 * d.usage / d.quota)) : 0;
    const current = workspaces.find(w => w.ownerId === (ws || workspaces[0]?.ownerId));
    body().innerHTML = `
      <div class="panel">
        <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:0.9rem">
          <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
            ${workspaces.length > 1 ? `<select class="form-control" id="dr-ws" style="width:auto">${workspaces.map(w => `<option value="${esc(w.ownerId)}" ${w === current ? 'selected' : ''}>${w.mine ? '💾 Môj Disk' : `👥 ${esc(w.name)} (${w.role === 'editor' ? 'editor' : 'čítanie'})`}</option>`).join('')}</select>` : ''}
            <input class="form-control" id="dr-search" placeholder="🔍 Hľadať na Disku" value="${esc(mode === 'search' ? query : '')}" style="width:220px">
          </div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
            ${writable() && mode === 'files' ? `<button class="btn btn-sm btn-secondary" id="dr-folder">+ Priečinok</button>
              <label class="btn btn-sm btn-primary" style="cursor:pointer">⬆ Nahrať<input type="file" id="dr-upload" multiple hidden></label>
              <button class="btn btn-sm btn-secondary" id="dr-client">🧑 Priečinok pre klienta</button>` : ''}
            <button class="btn btn-sm btn-secondary" id="dr-trash">🗑 Kôš</button>
          </div>
        </div>
        <div style="font-size:0.88rem;margin-bottom:0.75rem">${mode === 'search'
          ? `Výsledky pre „${esc(query)}“ · <button class="btn btn-sm btn-secondary" data-crumb="">Zrušiť hľadanie</button>`
          : [`<a href="#" data-crumb="" style="color:#9b8cff">${current && !current.mine ? esc(current.name) : 'Môj Disk'}</a>`, ...d.path.map(p => `<a href="#" data-crumb="${esc(p.id)}" style="color:#9b8cff">${esc(p.name)}</a>`)].join(' <span style="color:#7e7ea0">/</span> ')}</div>
        ${d.folder && d.folder.member ? `<div style="padding:0.6rem 0.8rem;border-radius:10px;background:rgba(155,140,255,0.08);margin-bottom:0.75rem;font-size:0.84rem;display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap">
          🧑 Priečinok klienta <b>${esc(d.folder.member.email)}</b> – vidí ho v členskej sekcii.
          ${writable() ? `<label style="display:flex;gap:0.35rem;align-items:center"><input type="checkbox" id="dr-mu" ${d.folder.memberUpload ? 'checked' : ''}> Klient môže nahrávať</label>
          <button class="btn btn-sm btn-secondary" id="dr-notify">✉ Upozorniť klienta</button>` : ''}</div>` : ''}
        <div id="dr-drop" style="border-radius:12px;transition:background .15s">
        ${d.items.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.86rem">
          <tr style="color:#9898b8;text-align:left"><th style="padding:0.4rem">Názov</th><th>Veľkosť</th><th>Zmenené</th><th></th></tr>
          ${d.items.map(i => `<tr style="border-top:1px solid rgba(255,255,255,0.06)" data-row="${esc(i.id)}" ${i.kind === 'folder' ? `data-folder="${esc(i.id)}"` : ''} draggable="${writable() && !i.system}">
            <td style="padding:0.5rem 0.4rem"><a href="#" data-open="${esc(i.id)}" style="color:#eeeef5;text-decoration:none">${icon(i)} ${esc(i.name)}</a>
              ${i.shares ? ` <span title="Zdieľané odkazom" style="${muted}">🔗 ${i.shares}</span>` : ''}
              ${i.member ? ` <span style="${muted}">· ${esc(i.member.email)}</span>` : ''}
              ${i.path !== undefined ? `<div style="${muted}">${esc(i.path || 'Môj Disk')}</div>` : ''}</td>
            <td style="${muted}">${i.kind === 'file' ? size(i.size) : ''}</td>
            <td style="${muted}">${date(i.updatedAt)}</td>
            <td style="text-align:right;white-space:nowrap">
              ${i.kind === 'file' ? `<button class="btn btn-sm btn-secondary" data-dl="${esc(i.id)}" title="Stiahnuť">⬇</button>` : ''}
              ${writable() ? `<button class="btn btn-sm btn-secondary" data-share="${esc(i.id)}" title="Zdieľať odkazom">🔗</button>
              <button class="btn btn-sm btn-secondary" data-more="${esc(i.id)}">⋯</button>` : ''}</td></tr>`).join('')}
        </table>` : `<div class="empty-state"><div class="empty-state-icon">${mode === 'search' ? '🔍' : '📂'}</div><p>${mode === 'search' ? 'Nič sa nenašlo.' : writable() ? 'Priečinok je prázdny. Pretiahnite sem súbory alebo kliknite na Nahrať.' : 'Priečinok je prázdny.'}</p></div>`}
        </div>
        <div style="margin-top:1rem;${muted}">Využité ${size(d.usage)} z ${size(d.quota)}
          <div style="height:5px;background:rgba(255,255,255,0.08);border-radius:5px;margin-top:0.3rem;overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct > 90 ? '#ff4060' : '#5b4fff'}"></div></div></div>
      </div>`;
    bind();
  }

  function bind() {
    const b = body();
    const $ = id => document.getElementById(id);
    if ($('dr-ws')) $('dr-ws').onchange = e => { ws = e.target.value === workspaces[0].ownerId ? null : e.target.value; parent = null; mode = 'files'; render(); };
    $('dr-search').onkeydown = e => {
      if (e.key !== 'Enter') return;
      query = e.target.value.trim();
      mode = query.length >= 2 ? 'search' : 'files';
      render();
    };
    b.querySelectorAll('[data-crumb]').forEach(a => { a.onclick = e => { e.preventDefault(); parent = a.dataset.crumb || null; mode = 'files'; render(); }; });
    b.querySelectorAll('[data-open]').forEach(a => {
      a.onclick = e => {
        e.preventDefault();
        const it = data.items.find(i => i.id === a.dataset.open);
        if (it.kind === 'folder') { parent = it.id; mode = 'files'; render(); } else preview(it);
      };
    });
    b.querySelectorAll('[data-dl]').forEach(x => { x.onclick = () => download(x.dataset.dl); });
    b.querySelectorAll('[data-share]').forEach(x => { x.onclick = () => shareDialog(data.items.find(i => i.id === x.dataset.share)); });
    b.querySelectorAll('[data-more]').forEach(x => { x.onclick = () => moreDialog(data.items.find(i => i.id === x.dataset.more)); });
    $('dr-trash').onclick = () => { mode = 'trash'; render(); };
    if ($('dr-folder')) $('dr-folder').onclick = async () => {
      const name = prompt('Názov priečinka:');
      if (name && await call(`${D}/folders${q()}`, json('POST', { name, parentId: parent }))) render();
    };
    if ($('dr-upload')) $('dr-upload').onchange = e => upload(e.target.files);
    if ($('dr-client')) $('dr-client').onclick = clientDialog;
    if ($('dr-mu')) $('dr-mu').onchange = e => call(`${D}/items/${data.folder.id}${q()}`, json('PATCH', { memberUpload: e.target.checked }), e.target.checked ? 'Klient môže nahrávať.' : 'Nahrávanie klientom vypnuté.');
    if ($('dr-notify')) $('dr-notify').onclick = async () => {
      const d = await call(`${D}/items/${data.folder.id}/notify-client${q()}`, { method: 'POST' });
      if (d) showToast(d.sent ? 'Klientovi sme poslali e-mail s prihlásením.' : 'E-mail sa nepodarilo odoslať (skontrolujte SMTP).', d.sent ? 'success' : 'error');
    };
    // Presúvanie myšou: riadok na priečinok alebo na drobčeky; súbory z počítača na zoznam
    const drop = $('dr-drop');
    if (!writable() || mode !== 'files') return;
    b.querySelectorAll('[draggable=true]').forEach(r => { r.ondragstart = e => e.dataTransfer.setData('text/nw-item', r.dataset.row); });
    const target = (el, folderId) => {
      el.ondragover = e => { e.preventDefault(); el.style.background = 'rgba(91,79,255,0.12)'; };
      el.ondragleave = () => { el.style.background = ''; };
      el.ondrop = async e => {
        e.preventDefault();
        e.stopPropagation();
        el.style.background = '';
        const id = e.dataTransfer.getData('text/nw-item');
        if (id) { if (id !== folderId && await call(`${D}/items/${id}${q()}`, json('PATCH', { parentId: folderId }), 'Presunuté.')) render(); }
        else if (e.dataTransfer.files.length) upload(e.dataTransfer.files, folderId);
      };
    };
    b.querySelectorAll('[data-folder]').forEach(r => target(r, r.dataset.folder));
    b.querySelectorAll('[data-crumb]').forEach(a => { if (mode === 'files') target(a, a.dataset.crumb || null); });
    target(drop, parent);
  }

  async function upload(files, folderId = parent) {
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (folderId) fd.append('parentId', folderId);
    showToast(`Nahrávam ${files.length} ${files.length === 1 ? 'súbor' : 'súbory'}…`);
    if (await call(`${D}/files${q()}`, { method: 'POST', body: fd }, 'Nahraté.')) render();
  }

  async function fileUrl(id, inline) {
    const d = await call(`${D}/items/${id}/url${q(inline ? { inline: 1 } : {})}`);
    return d && d.url;
  }
  async function download(id) {
    const url = await fileUrl(id);
    if (url) location.href = url;
  }

  async function preview(it) {
    const url = await fileUrl(it.id, true);
    if (!url) return;
    const m = it.mime || '';
    const view = m.startsWith('image/') ? `<img src="${esc(url)}" style="max-width:100%;border-radius:10px">`
      : m.startsWith('video/') ? `<video src="${esc(url)}" controls style="width:100%;border-radius:10px"></video>`
      : m.startsWith('audio/') ? `<audio src="${esc(url)}" controls style="width:100%"></audio>`
      : m === 'application/pdf' || m === 'text/plain' ? `<iframe src="${esc(url)}" sandbox="" style="width:100%;height:65vh;border:0;border-radius:10px;background:#fff"></iframe>`
      : `<p style="${muted}">Náhľad pre tento typ súboru nie je k dispozícii.</p>`;
    modal(`${icon(it)} ${esc(it.name)}`, `${view}<div style="margin-top:1rem;display:flex;gap:0.5rem"><button class="btn btn-primary" data-dl>⬇ Stiahnuť</button>
      <span style="${muted};align-self:center">${size(it.size)}</span></div>`, el => { el.querySelector('[data-dl]').onclick = () => download(it.id); });
  }

  /* ── Zdieľanie odkazom ─────────────────────────────────────── */
  async function shareDialog(it) {
    modal(`🔗 Zdieľať „${esc(it.name)}“`, '<div data-list></div><div data-form></div>', async (el) => {
      const list = el.querySelector('[data-list]');
      const loadList = async () => {
        const shares = (await call(`${D}/items/${it.id}/shares${q()}`)) || [];
        list.innerHTML = shares.length ? shares.map(s => `<div style="padding:0.6rem 0;border-bottom:1px solid rgba(255,255,255,0.06)">
          <div style="display:flex;gap:0.4rem"><input class="form-control" readonly value="${esc(s.url)}" style="font-size:0.8rem">
            <button class="btn btn-sm btn-secondary" data-copy="${esc(s.url)}">Kopírovať</button><button class="btn btn-sm btn-danger" data-revoke="${esc(s.id)}">Zrušiť</button></div>
          <div style="${muted};margin-top:0.3rem">${s.hasPassword ? '🔒 s heslom' : 'bez hesla'} · ${s.allowUpload ? '⬆ môžu nahrávať' : 'iba čítanie'} · ${s.expiresAt ? `platí do ${date(s.expiresAt)}` : 'bez obmedzenia'} · ${s.downloads}× stiahnuté</div></div>`).join('')
          : `<p style="${muted};margin-bottom:0.5rem">Zatiaľ žiadny odkaz.</p>`;
        list.querySelectorAll('[data-copy]').forEach(b => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => showToast('Odkaz skopírovaný.')); });
        list.querySelectorAll('[data-revoke]').forEach(b => { b.onclick = async () => { if (await call(`${D}/shares/${b.dataset.revoke}${q()}`, { method: 'DELETE' }, 'Odkaz zrušený.')) loadList(); }; });
      };
      el.querySelector('[data-form]').innerHTML = `<h3 style="font-size:0.9rem;margin:1rem 0 0.5rem">Nový odkaz</h3>
        <div class="form-row"><div class="form-group" style="flex:1"><label>Heslo (nepovinné)</label><input class="form-control" id="sh-pass" type="text" autocomplete="off"></div>
        <div class="form-group" style="flex:1"><label>Platnosť</label><select class="form-control" id="sh-exp"><option value="">Bez obmedzenia</option><option value="1">1 deň</option><option value="7">7 dní</option><option value="30">30 dní</option><option value="90">90 dní</option></select></div></div>
        ${it.kind === 'folder' ? '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:0.75rem"><input type="checkbox" id="sh-up"> Návštevníci môžu nahrávať súbory (napr. podklady od klienta)</label>' : ''}
        <button class="btn btn-primary" id="sh-create">Vytvoriť odkaz</button>`;
      el.querySelector('#sh-create').onclick = async () => {
        const s = await call(`${D}/items/${it.id}/shares${q()}`, json('POST', {
          password: el.querySelector('#sh-pass').value, expiresDays: el.querySelector('#sh-exp').value, allowUpload: !!el.querySelector('#sh-up')?.checked,
        }));
        if (!s) return;
        navigator.clipboard.writeText(s.url).catch(() => {});
        showToast('Odkaz vytvorený a skopírovaný.');
        el.querySelector('#sh-pass').value = '';
        loadList();
        render();
      };
      loadList();
    });
  }

  /* ── Ďalšie akcie: premenovať, presunúť, použiť v module, zmazať ── */
  function moreDialog(it) {
    modal(`${icon(it)} ${esc(it.name)}`, `
      <div class="form-group"><label>Názov</label><div style="display:flex;gap:0.4rem"><input class="form-control" id="mo-name" value="${esc(it.name)}"><button class="btn btn-secondary" id="mo-rename">Premenovať</button></div></div>
      ${it.system ? '' : '<div class="form-group"><label>Presunúť do</label><div id="mo-move"></div></div>'}
      ${it.kind === 'file' ? `<div class="form-group"><label>Použiť súbor v Neoworkly</label><div id="mo-use" style="${muted}">Načítavam…</div></div>` : ''}
      <button class="btn btn-danger" id="mo-del" style="margin-top:0.5rem">🗑 Presunúť do koša</button>`, (el, close) => {
      el.querySelector('#mo-rename').onclick = async () => { if (await call(`${D}/items/${it.id}${q()}`, json('PATCH', { name: el.querySelector('#mo-name').value }), 'Premenované.')) { close(); render(); } };
      el.querySelector('#mo-del').onclick = async () => {
        if (!confirm(`Presunúť „${it.name}“ do koša?${it.kind === 'folder' ? ' Aj s celým obsahom.' : ''} Odkazy na zdieľanie prestanú platiť.`)) return;
        if (await call(`${D}/items/${it.id}${q()}`, { method: 'DELETE' }, 'Presunuté do koša.')) { close(); render(); }
      };
      if (!it.system) folderPicker(el.querySelector('#mo-move'), async target => {
        if (await call(`${D}/items/${it.id}${q()}`, json('PATCH', { parentId: target }), 'Presunuté.')) { close(); render(); }
      }, it.id);
      if (it.kind === 'file') useInModules(el.querySelector('#mo-use'), it);
    });
  }

  /** Prechádzanie priečinkov a výber cieľa presunu (bez priečinka samotného). */
  function folderPicker(el, onPick, excludeId) {
    let at = null;
    const show = async () => {
      const d = await call(`${D}/items${q(at ? { parent: at } : {})}`);
      if (!d) return;
      const folders = d.items.filter(i => i.kind === 'folder' && i.id !== excludeId);
      el.innerHTML = `<div style="${muted};margin-bottom:0.3rem">${['<a href="#" data-to="">Môj Disk</a>', ...d.path.map(p => `<a href="#" data-to="${esc(p.id)}">${esc(p.name)}</a>`)].join(' / ')}</div>
        <div style="max-height:180px;overflow:auto;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.3rem">${folders.map(f => `<div><a href="#" data-to="${esc(f.id)}" style="color:#eeeef5;text-decoration:none">📁 ${esc(f.name)}</a></div>`).join('') || `<span style="${muted}">Žiadne podpriečinky.</span>`}</div>
        <button class="btn btn-sm btn-primary" data-here style="margin-top:0.4rem">Presunúť sem</button>`;
      el.querySelectorAll('[data-to]').forEach(a => { a.onclick = e => { e.preventDefault(); at = a.dataset.to || null; show(); }; });
      el.querySelector('[data-here]').onclick = () => onPick(at);
    };
    show();
  }

  async function useInModules(el, it) {
    const t = await call(`${D}/targets${q()}`);
    if (!t) return;
    const lessons = t.products.flatMap(p => p.lessons.map(l => ({ ...l, product: p })));
    el.innerHTML = `
      <div style="display:flex;gap:0.4rem;margin-bottom:0.4rem"><select class="form-control" id="u-prod">${t.products.map(p => `<option value="${esc(p.id)}">📦 ${esc(p.title)}</option>`).join('')}
        ${lessons.map(l => `<option value="${esc(l.product.id)}|${esc(l.id)}">🎓 ${esc(l.product.title)} → ${esc(l.title)}</option>`).join('')}</select>
        <button class="btn btn-sm btn-secondary" id="u-prod-go" ${t.products.length ? '' : 'disabled'}>Do produktu</button></div>
      <div style="display:flex;gap:0.4rem;margin-bottom:0.4rem"><select class="form-control" id="u-lm">${t.leadMagnets.map(l => `<option value="${esc(l.id)}">🧲 ${esc(l.name)} (${esc(l.widget)})</option>`).join('')}</select>
        <button class="btn btn-sm btn-secondary" id="u-lm-go" ${t.leadMagnets.length ? '' : 'disabled'}>Ako lead magnet</button></div>
      <div style="display:flex;gap:0.4rem"><select class="form-control" id="u-kb">${t.widgets.map(w => `<option value="${esc(w.id)}">🤖 ${esc(w.name)}</option>`).join('')}</select>
        <button class="btn btn-sm btn-secondary" id="u-kb-go" ${t.widgets.length ? '' : 'disabled'}>Do znalostí chatbota</button></div>
      <div style="${muted};margin-top:0.3rem">Súbor sa skopíruje – zmeny na Disku sa do modulu neprenesú.</div>
      ${/pdf$/i.test(it.mime || '') || /\.pdf$/i.test(it.name) ? `<a class="btn btn-sm btn-secondary" style="margin-top:0.5rem;display:inline-block" href="/pdf${q({ file: it.id, name: it.name, parent: parent || '' })}">📑 Upraviť v PDF nástrojoch (spojiť, rozdeliť, podpísať)</a>` : ''}`;
    el.querySelector('#u-prod-go').onclick = () => {
      const [productId, lessonId] = el.querySelector('#u-prod').value.split('|');
      call(`${D}/items/${it.id}/to-product${q()}`, json('POST', { productId, lessonId }), 'Pridané do produktu.');
    };
    el.querySelector('#u-lm-go').onclick = () => call(`${D}/items/${it.id}/to-lead-magnet${q()}`, json('POST', { leadMagnetId: el.querySelector('#u-lm').value }), 'Súbor lead magnetu nahradený.');
    el.querySelector('#u-kb-go').onclick = async () => {
      const d = await call(`${D}/items/${it.id}/to-knowledge${q()}`, json('POST', { widgetId: el.querySelector('#u-kb').value }));
      if (d) showToast(`Pridané do znalostí (${d.chars.toLocaleString('sk-SK')} znakov).`);
    };
  }

  /* ── Priečinok pre klienta ─────────────────────────────────── */
  function clientDialog() {
    modal('🧑 Priečinok pre klienta', `<p style="${muted};margin-bottom:1rem">Klient ho uvidí v členskej sekcii vášho obchodu (prihlásenie odkazom z e-mailu, bez hesla). Priečinok sa vytvorí v „Klienti“.</p>
      <div class="form-row"><div class="form-group" style="flex:1"><label>E-mail klienta</label><input class="form-control" type="email" id="cl-email" required></div>
      <div class="form-group" style="flex:1"><label>Meno</label><input class="form-control" id="cl-name" maxlength="120"></div></div>
      <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:0.4rem"><input type="checkbox" id="cl-up"> Klient môže nahrávať súbory</label>
      <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:1rem"><input type="checkbox" id="cl-notify"> Poslať klientovi e-mail s prístupom hneď</label>
      <button class="btn btn-primary" id="cl-go">Vytvoriť</button>`, (el, close) => {
      el.querySelector('#cl-go').onclick = async () => {
        const f = await call(`${D}/client-folders${q()}`, json('POST', {
          email: el.querySelector('#cl-email').value, name: el.querySelector('#cl-name').value,
          memberUpload: el.querySelector('#cl-up').checked, notify: el.querySelector('#cl-notify').checked,
        }), 'Priečinok klienta vytvorený.');
        if (f) { close(); parent = f.id; mode = 'files'; render(); }
      };
    });
  }

  /* ── Kôš ───────────────────────────────────────────────────── */
  async function renderTrash() {
    const items = await call(`${D}/trash${q()}`);
    if (!items) return;
    body().innerHTML = `<div class="panel"><div class="panel-header"><div><div class="panel-title">🗑 Kôš</div>
      <div class="panel-subtitle">Položky sa po 30 dňoch zmažú natrvalo</div></div>
      <div style="display:flex;gap:0.5rem"><button class="btn btn-sm btn-secondary" id="tr-back">← Späť na Disk</button>
      ${items.length && writable() ? '<button class="btn btn-sm btn-danger" id="tr-empty">Vysypať kôš</button>' : ''}</div></div>
      ${items.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.86rem">${items.map(i => `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
        <td style="padding:0.5rem 0.4rem">${icon(i)} ${esc(i.name)}</td><td style="${muted}">${i.kind === 'file' ? size(i.size) : 'priečinok'}</td>
        <td style="${muted}">zmazané ${date(i.trashedAt)}</td><td style="text-align:right">${writable() ? `<button class="btn btn-sm btn-secondary" data-restore="${esc(i.id)}">Obnoviť</button>
        <button class="btn btn-sm btn-danger" data-destroy="${esc(i.id)}">Zmazať natrvalo</button>` : ''}</td></tr>`).join('')}</table>`
        : '<div class="empty-state"><div class="empty-state-icon">🗑</div><p>Kôš je prázdny.</p></div>'}</div>`;
    document.getElementById('tr-back').onclick = () => { mode = 'files'; render(); };
    if (document.getElementById('tr-empty')) document.getElementById('tr-empty').onclick = async () => {
      if (confirm('Natrvalo zmazať všetko v koši?') && await call(`${D}/trash${q()}`, { method: 'DELETE' }, 'Kôš vysypaný.')) renderTrash();
    };
    body().querySelectorAll('[data-restore]').forEach(b => { b.onclick = async () => { if (await call(`${D}/trash/${b.dataset.restore}/restore${q()}`, { method: 'POST' }, 'Obnovené.')) renderTrash(); }; });
    body().querySelectorAll('[data-destroy]').forEach(b => {
      b.onclick = async () => { if (confirm('Zmazať natrvalo? Nedá sa vrátiť.') && await call(`${D}/trash/${b.dataset.destroy}${q()}`, { method: 'DELETE' }, 'Zmazané.')) renderTrash(); };
    });
  }
})();
