/* Úlohy (podľa Vikunja): projekty, kanban / zoznam, Moje úlohy, rýchle zadanie, detail úlohy.
   Používa NW.suite (suite-common.js), esc a showToast z dashboard.js. */
(function () {
  'use strict';
  const T = '/api/tasks';
  const PRIO = ['', '⬇ nízka', '• normálna', '▲ vyššia', '🔥 vysoká', '🚨 urgentná'];
  const PRIO_COLOR = ['', '#64748b', '#9898b8', '#f59e0b', '#f97316', '#ff4060'];
  let state = { projectId: null, mode: 'kanban', projects: [], labels: [], data: null };
  let reloadTimer = null;
  const $ = id => document.getElementById(id);
  const body = () => $('tasks-body');
  const su = () => window.NW.suite;

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.tasks = { title: 'Úlohy', load };

  async function load() {
    const s = su();
    [state.projects, state.labels] = await Promise.all([s.api('GET', `${T}/projects`), s.api('GET', `${T}/labels`)]);
    state.projects = state.projects || [];
    state.labels = state.labels || [];
    try { state.mode = localStorage.getItem('nw_tasks_mode') || 'kanban'; } catch { /* nič */ }
    const open = s.takeOpen('task');
    if (state.projectId !== 'mine' && !state.projects.some(p => p.id === state.projectId)) state.projectId = state.projects.find(p => !p.archived)?.id || 'mine';
    await render();
    if (open) openTask(open);
  }

  // Zmeny od kolegov: prekresli (s oneskorením, aby sa viac zmien spojilo do jednej)
  if (window.NW && NW.rt) {
    const later = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if ($('view-tasks') && $('view-tasks').style.display !== 'none' && !document.querySelector('[data-task-modal]')) render(); }, 400); };
    NW.rt.on('task', later);
    NW.rt.on('project', later);
  }

  function labelChip(id) {
    const l = state.labels.find(x => x.id === id);
    return l ? `<span style="background:${esc(l.color)}33;color:${esc(l.color)};border-radius:6px;padding:0 6px;font-size:0.7rem;font-weight:700">${esc(l.name)}</span>` : '';
  }

  function card(t) {
    const s = su();
    return `<div class="nw-card" draggable="${s.canWrite}" data-task="${esc(t.id)}" style="background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:0.6rem 0.7rem;margin-bottom:0.5rem;cursor:pointer;${t.done ? 'opacity:0.55' : ''}">
      <div style="display:flex;gap:0.45rem;align-items:flex-start">
        <input type="checkbox" data-done="${esc(t.id)}" ${t.done ? 'checked' : ''} ${s.canWrite ? '' : 'disabled'} style="margin-top:4px">
        <div style="flex:1;min-width:0;font-size:0.88rem;${t.done ? 'text-decoration:line-through' : ''}">${t.priority >= 3 ? `<span style="color:${PRIO_COLOR[t.priority]}">${PRIO[t.priority].split(' ')[0]}</span> ` : ''}${esc(t.title)}</div></div>
      ${t.labels.length ? `<div style="display:flex;gap:0.25rem;flex-wrap:wrap;margin-top:0.35rem">${t.labels.map(labelChip).join('')}</div>` : ''}
      <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem;flex-wrap:wrap">${s.due(t.dueAt)}
        ${t.repeatDays ? `<span style="${s.muted}">↻</span>` : ''}
        ${t.subtasks.total ? `<span style="${s.muted}">☑ ${t.subtasks.done}/${t.subtasks.total}</span>` : ''}
        ${t.comments ? `<span style="${s.muted}">💬 ${t.comments}</span>` : ''}${t.links ? `<span style="${s.muted}">🔗 ${t.links}</span>` : ''}
        <span style="margin-left:auto;display:flex;gap:2px">${t.assignees.map(a => s.avatar(a, 20)).join('')}</span></div></div>`;
  }

  async function render() {
    const s = su();
    const mine = state.projectId === 'mine';
    const data = mine ? await s.api('GET', `${T}/overview`) : await s.api('GET', `${T}/projects/${state.projectId}`);
    if (!data && !mine) { state.projectId = 'mine'; return render(); }
    state.data = data;
    const p = !mine && data.project;
    const picker = s.wsPicker(load);
    body().innerHTML = `
      <div style="display:grid;grid-template-columns:220px minmax(0,1fr);gap:1rem;align-items:start" class="nw-tasks-grid">
        <aside class="panel" style="padding:0.75rem">
          ${picker ? `<div style="margin-bottom:0.6rem">${picker}</div>` : ''}
          <button class="nav-item ${mine ? 'active' : ''}" data-proj="mine" style="width:100%">👤 Moje úlohy</button>
          <div style="${s.muted};margin:0.6rem 0 0.3rem">Projekty</div>
          ${state.projects.filter(x => !x.archived).map(x => `<button class="nav-item ${x.id === state.projectId ? 'active' : ''}" data-proj="${esc(x.id)}" style="width:100%;justify-content:space-between">
            <span style="display:flex;gap:0.45rem;align-items:center;min-width:0"><span style="width:9px;height:9px;border-radius:50%;background:${esc(x.color)};flex-shrink:0"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name)}</span></span>
            <span style="${s.muted}">${x.total - x.done}</span></button>`).join('')}
          ${s.canWrite ? '<button class="btn btn-sm btn-secondary" id="tk-newproj" style="width:100%;margin-top:0.5rem">+ Projekt</button>' : ''}
          ${state.projects.some(x => x.archived) ? `<details style="margin-top:0.6rem"><summary style="${s.muted};cursor:pointer">Archív</summary>${state.projects.filter(x => x.archived).map(x => `<button class="nav-item" data-proj="${esc(x.id)}" style="width:100%">${esc(x.name)}</button>`).join('')}</details>` : ''}
        </aside>
        <section style="min-width:0">
          <div class="panel" style="padding:0.75rem;margin-bottom:0.75rem">
            <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
              <h2 style="font-size:1.05rem;margin-right:auto">${mine ? '👤 Moje úlohy' : `<span style="color:${esc(p.color)}">●</span> ${esc(p.name)}`}</h2>
              ${!mine ? `<button class="btn btn-sm ${state.mode === 'kanban' ? 'btn-primary' : 'btn-secondary'}" data-mode="kanban">▦ Kanban</button>
              <button class="btn btn-sm ${state.mode === 'list' ? 'btn-primary' : 'btn-secondary'}" data-mode="list">☰ Zoznam</button>
              ${s.canWrite ? '<button class="btn btn-sm btn-secondary" id="tk-editproj">⚙</button>' : ''}` : ''}
            </div>
            ${s.canWrite ? `<input class="form-control" id="tk-quick" placeholder="+ Nová úloha… (napr. Zavolať Jane zajtra o 14:00 !3 #klient @eva)" style="margin-top:0.6rem">
              <div style="${s.muted};margin-top:0.25rem">!1–5 priorita · #štítok · @meno · dnes, zajtra, piatok, 15.11. · o 14:00</div>` : ''}
          </div>
          <div id="tk-board"></div>
        </section>
      </div>
      <style>@media (max-width: 860px) { .nw-tasks-grid { grid-template-columns: 1fr !important; } } .nw-card:hover { border-color: rgba(155,140,255,0.45) !important; }</style>`;
    body().querySelectorAll('[data-proj]').forEach(b => { b.onclick = () => { state.projectId = b.dataset.proj; render(); }; });
    body().querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { state.mode = b.dataset.mode; try { localStorage.setItem('nw_tasks_mode', state.mode); } catch { /* nič */ } render(); }; });
    if ($('tk-newproj')) $('tk-newproj').onclick = async () => {
      const name = prompt('Názov projektu:');
      if (!name) return;
      const np = await s.api('POST', `${T}/projects`, { name });
      if (np) { state.projectId = np.id; load(); }
    };
    if ($('tk-editproj')) $('tk-editproj').onclick = () => projectDialog(p);
    if ($('tk-quick')) $('tk-quick').onkeydown = async e => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      // V „Moje úlohy“ ide úloha do projektu Doručené a je pridelená mne
      const me = (JSON.parse(localStorage.getItem('nd_user') || '{}') || {}).id;
      const t = await s.api('POST', `${T}/tasks`, { projectId: mine ? null : state.projectId, title: e.target.value, quick: true, assignees: mine && me ? [me] : [] });
      if (!t) return;
      e.target.value = '';
      if (!state.projects.some(x => x.id === t.projectId)) state.projects = (await s.api('GET', `${T}/projects`)) || state.projects;
      state.labels = (await s.api('GET', `${T}/labels`)) || state.labels;
      render().then(() => $('tk-quick') && $('tk-quick').focus());
    };
    if (mine) return renderMine(data);
    return state.mode === 'kanban' ? renderKanban(data) : renderList(data);
  }

  function renderMine(d) {
    const s = su();
    const proj = id => state.projects.find(p => p.id === id);
    const row = t => `<div style="display:flex;gap:0.5rem;align-items:center"><div style="flex:1;min-width:0">${card(t)}</div>
      <span style="${s.muted};width:120px;flex-shrink:0">${proj(t.projectId) ? `<span style="color:${esc(proj(t.projectId).color)}">●</span> ${esc(proj(t.projectId).name)}` : ''}</span></div>`;
    $('tk-board').innerHTML = `<div class="panel"><div class="panel-title" style="margin-bottom:0.6rem">Pridelené mne (${d.mine.length})</div>${d.mine.map(row).join('') || `<p style="${s.muted}">Nemáte žiadne otvorené úlohy. 🎉</p>`}</div>
      <div class="panel"><div class="panel-title" style="margin-bottom:0.6rem">Termíny do 7 dní v tíme</div>${d.upcoming.map(row).join('') || `<p style="${s.muted}">Žiadne.</p>`}</div>`;
    bindCards();
  }

  function renderList(d) {
    const s = su();
    const top = d.tasks.filter(t => !t.parentId);
    const open = top.filter(t => !t.done), done = top.filter(t => t.done);
    $('tk-board').innerHTML = `<div class="panel">${open.map(card).join('') || `<p style="${s.muted}">Žiadne otvorené úlohy.</p>`}
      ${done.length ? `<details style="margin-top:0.75rem"><summary style="${s.muted};cursor:pointer">Hotové (${done.length})</summary><div style="margin-top:0.5rem">${done.map(card).join('')}</div></details>` : ''}</div>`;
    bindCards();
  }

  function renderKanban(d) {
    const s = su();
    const top = d.tasks.filter(t => !t.parentId);
    $('tk-board').innerHTML = `<div style="display:flex;gap:0.75rem;overflow-x:auto;padding-bottom:0.5rem;align-items:flex-start">
      ${d.buckets.map(b => {
        const items = top.filter(t => t.bucketId === b.id).sort((x, y) => x.position - y.position);
        return `<div data-bucket="${esc(b.id)}" style="flex:0 0 280px;background:#14142a;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:0.6rem;min-height:120px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
            <b style="font-size:0.85rem">${b.isDone ? '✅ ' : ''}${esc(b.name)} <span style="${s.muted}">${items.length}</span></b>
            ${s.canWrite ? `<button class="btn btn-sm btn-secondary" style="padding:0 0.4rem" data-bmenu="${esc(b.id)}">⋯</button>` : ''}</div>
          <div data-drop="${esc(b.id)}" style="min-height:40px">${items.map(card).join('')}</div>
          ${s.canWrite ? `<button class="btn btn-sm btn-secondary" data-addin="${esc(b.id)}" style="width:100%;margin-top:0.25rem">+ Úloha</button>` : ''}</div>`;
      }).join('')}
      ${s.canWrite ? '<button class="btn btn-secondary" id="tk-addbucket" style="flex:0 0 160px">+ Stĺpec</button>' : ''}</div>`;
    bindCards();
    if (!s.canWrite) return;
    $('tk-addbucket').onclick = async () => { const name = prompt('Názov stĺpca:'); if (name && await s.api('POST', `${T}/projects/${state.projectId}/buckets`, { name })) render(); };
    body().querySelectorAll('[data-addin]').forEach(b => {
      b.onclick = async () => {
        const title = prompt('Názov úlohy:');
        if (title && await s.api('POST', `${T}/tasks`, { projectId: state.projectId, bucketId: b.dataset.addin, title, quick: true })) render();
      };
    });
    body().querySelectorAll('[data-bmenu]').forEach(b => { b.onclick = () => bucketDialog(d.buckets.find(x => x.id === b.dataset.bmenu)); });
    // Presúvanie kariet: pozícia = stred medzi susedmi
    let dragId = null;
    body().querySelectorAll('[data-task][draggable=true]').forEach(c => {
      c.ondragstart = e => { dragId = c.dataset.task; e.dataTransfer.effectAllowed = 'move'; c.style.opacity = '0.4'; };
      c.ondragend = () => { c.style.opacity = ''; };
    });
    body().querySelectorAll('[data-drop]').forEach(zone => {
      zone.ondragover = e => { e.preventDefault(); zone.style.background = 'rgba(91,79,255,0.08)'; };
      zone.ondragleave = () => { zone.style.background = ''; };
      zone.ondrop = async e => {
        e.preventDefault();
        zone.style.background = '';
        if (!dragId) return;
        const cards = [...zone.querySelectorAll('[data-task]')].filter(x => x.dataset.task !== dragId);
        const after = cards.find(x => e.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
        const pos = id => state.data.tasks.find(t => t.id === id)?.position ?? 0;
        const idx = after ? cards.indexOf(after) : cards.length;
        const prev = idx > 0 ? pos(cards[idx - 1].dataset.task) : null;
        const next = idx < cards.length ? pos(cards[idx].dataset.task) : null;
        const position = prev === null && next === null ? 1 : prev === null ? next - 1 : next === null ? prev + 1 : (prev + next) / 2;
        const id = dragId;
        dragId = null;
        if (await s.api('PATCH', `${T}/tasks/${id}`, { bucketId: zone.dataset.drop, position })) render();
      };
    });
  }

  function bindCards() {
    const s = su();
    body().querySelectorAll('[data-task]').forEach(c => { c.onclick = e => { if (!e.target.matches('input')) openTask(c.dataset.task); }; });
    body().querySelectorAll('[data-done]').forEach(cb => {
      cb.onclick = e => e.stopPropagation();
      cb.onchange = async () => { if (await s.api('PATCH', `${T}/tasks/${cb.dataset.done}`, { done: cb.checked })) render(); };
    });
  }

  function projectDialog(p) {
    const s = su();
    s.modal('⚙ Projekt', `<div class="form-group"><label>Názov</label><input class="form-control" id="pj-name" value="${esc(p.name)}"></div>
      <div class="form-group"><label>Farba</label><input class="form-control" type="color" id="pj-color" value="${esc(p.color)}" style="height:42px;padding:4px;width:90px"></div>
      <div class="form-group"><label>Popis</label><textarea class="form-control" id="pj-desc" rows="3">${esc(p.description)}</textarea></div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap"><button class="btn btn-primary" id="pj-save">Uložiť</button>
      <button class="btn btn-secondary" id="pj-arch">${p.archived ? 'Obnoviť z archívu' : 'Archivovať'}</button>
      <button class="btn btn-danger" id="pj-del" style="margin-left:auto">Zmazať</button></div>`, (el, close) => {
      el.querySelector('#pj-save').onclick = async () => { if (await s.api('PATCH', `${T}/projects/${p.id}`, { name: el.querySelector('#pj-name').value, color: el.querySelector('#pj-color').value, description: el.querySelector('#pj-desc').value }, 'Uložené.')) { close(); load(); } };
      el.querySelector('#pj-arch').onclick = async () => { if (await s.api('PATCH', `${T}/projects/${p.id}`, { archived: !p.archived })) { close(); load(); } };
      el.querySelector('#pj-del').onclick = async () => {
        if (!confirm(`Zmazať projekt „${p.name}“ so všetkými úlohami? Nedá sa vrátiť.`)) return;
        if (await s.api('DELETE', `${T}/projects/${p.id}`, undefined, 'Projekt zmazaný.')) { close(); state.projectId = null; load(); }
      };
    });
  }

  function bucketDialog(b) {
    const s = su();
    s.modal('Stĺpec', `<div class="form-group"><label>Názov</label><input class="form-control" id="bk-name" value="${esc(b.name)}"></div>
      <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:1rem"><input type="checkbox" id="bk-done" ${b.isDone ? 'checked' : ''}> Úlohy v tomto stĺpci sú hotové</label>
      <button class="btn btn-primary" id="bk-save">Uložiť</button> <button class="btn btn-danger" id="bk-del">Zmazať stĺpec</button>`, (el, close) => {
      el.querySelector('#bk-save').onclick = async () => { if (await s.api('PATCH', `${T}/buckets/${b.id}`, { name: el.querySelector('#bk-name').value, isDone: el.querySelector('#bk-done').checked })) { close(); render(); } };
      el.querySelector('#bk-del').onclick = async () => { if (confirm('Zmazať stĺpec? Úlohy sa presunú do prvého stĺpca.') && await s.api('DELETE', `${T}/buckets/${b.id}`)) { close(); render(); } };
    });
  }

  /* ── Detail úlohy ──────────────────────────────────────────── */
  const toLocal = sec => { if (!sec) return ''; const d = new Date(sec * 1000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const fromLocal = v => v ? Math.floor(new Date(v).getTime() / 1000) : null;

  async function openTask(id) {
    const s = su();
    const t = await s.api('GET', `${T}/tasks/${id}`);
    if (!t) return;
    const ro = s.canWrite ? '' : 'disabled';
    const proj = state.projects.find(p => p.id === t.projectId);
    s.modal(`${t.done ? '✅' : '○'} <span id="td-title-h">${esc(t.title)}</span>`, `<div data-task-modal style="display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:1rem" class="nw-td-grid">
      <div>
        <input class="form-control" id="td-title" value="${esc(t.title)}" ${ro} style="font-weight:700;font-size:1rem;margin-bottom:0.6rem">
        <label style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.6rem"><input type="checkbox" id="td-done" ${t.done ? 'checked' : ''} ${ro}> Hotovo</label>
        <div class="form-group"><label>Popis</label><textarea class="form-control" id="td-desc" rows="5" ${ro}>${esc(t.description)}</textarea></div>
        <div class="form-group"><label>Podúlohy</label><div id="td-subs">${t.subtaskList.map(x => `<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;padding:0.15rem 0"><input type="checkbox" data-sub="${esc(x.id)}" ${x.done ? 'checked' : ''} ${ro}> <span style="${x.done ? 'text-decoration:line-through;opacity:0.6' : ''}">${esc(x.title)}</span></label>`).join('')}</div>
          ${s.canWrite ? '<input class="form-control" id="td-newsub" placeholder="+ Podúloha (Enter)" style="font-size:0.84rem;margin-top:0.3rem">' : ''}</div>
        <div class="form-group"><label>Komentáre</label><div id="td-comments">${t.comments.map(c => `<div style="display:flex;gap:0.5rem;margin-bottom:0.5rem">${c.user_id ? s.avatar(c.user_id, 26) : '<span style="width:26px">↻</span>'}
          <div style="flex:1;min-width:0"><div style="${s.muted}">${esc(c.user_name || 'Systém')} · ${s.date(c.created_at, { dateStyle: 'short', timeStyle: 'short' })}</div><div style="font-size:0.88rem;white-space:pre-line">${esc(c.body)}</div></div></div>`).join('') || `<div style="${s.muted}">Zatiaľ žiadne.</div>`}</div>
          ${s.canWrite ? '<textarea class="form-control" id="td-comment" rows="2" placeholder="Napíšte komentár… (Ctrl+Enter)" style="min-height:0"></textarea>' : ''}</div>
      </div>
      <aside style="font-size:0.85rem">
        <div class="form-group"><label>Projekt</label><select class="form-control" id="td-proj" ${ro}>${state.projects.map(p => `<option value="${esc(p.id)}" ${p.id === t.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Termín</label><input class="form-control" type="datetime-local" id="td-due" value="${toLocal(t.dueAt)}" ${ro}></div>
        <div class="form-group"><label>Pripomenúť</label><input class="form-control" type="datetime-local" id="td-remind" value="${toLocal(t.remindAt)}" ${ro}></div>
        <div class="form-group"><label>Opakovať</label><select class="form-control" id="td-repeat" ${ro}>${[[0, 'Nie'], [1, 'Denne'], [7, 'Týždenne'], [14, 'Každé 2 týždne'], [30, 'Každých 30 dní'], [365, 'Ročne']].map(([v, l]) => `<option value="${v}" ${t.repeatDays === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="form-group"><label>Priorita</label><select class="form-control" id="td-prio" ${ro}>${PRIO.map((l, i) => `<option value="${i}" ${t.priority === i ? 'selected' : ''}>${i ? l : '—'}</option>`).join('')}</select></div>
        <div class="form-group"><label>Hotovo na ${t.percent} %</label><input type="range" min="0" max="100" step="10" id="td-pct" value="${t.percent}" ${ro} style="width:100%"></div>
        <div class="form-group"><label>Riešitelia</label>${s.members.map(m => `<label style="display:flex;gap:0.4rem;align-items:center;padding:0.1rem 0"><input type="checkbox" data-asg="${esc(m.id)}" ${t.assignees.includes(m.id) ? 'checked' : ''} ${ro}> ${s.avatar(m.id, 20)} ${esc(m.name)}</label>`).join('')}</div>
        <div class="form-group"><label>Štítky</label><div style="display:flex;gap:0.3rem;flex-wrap:wrap">${state.labels.map(l => `<label style="cursor:pointer"><input type="checkbox" data-lbl="${esc(l.id)}" ${t.labels.includes(l.id) ? 'checked' : ''} ${ro} hidden><span data-lchip="${esc(l.id)}" style="border-radius:6px;padding:1px 7px;font-size:0.75rem;font-weight:700;border:1px solid ${esc(l.color)};color:${t.labels.includes(l.id) ? '#fff' : esc(l.color)};background:${t.labels.includes(l.id) ? esc(l.color) : 'transparent'}">${esc(l.name)}</span></label>`).join('')}</div>
          ${s.canWrite ? '<input class="form-control" id="td-newlabel" placeholder="+ štítok (Enter)" style="font-size:0.8rem;margin-top:0.35rem">' : ''}</div>
        <div class="form-group"><div id="td-links"></div>
          ${s.canWrite ? '<label class="btn btn-sm btn-secondary" style="cursor:pointer;margin-top:0.4rem">📎 Pridať prílohu<input type="file" id="td-file" multiple hidden></label>' : ''}</div>
        ${s.canWrite ? '<button class="btn btn-sm btn-secondary" id="td-meet" style="width:100%;margin-bottom:0.5rem">🎥 Videohovor k úlohe</button><button class="btn btn-sm btn-danger" id="td-del" style="width:100%">Zmazať úlohu</button>' : ''}
        <div style="${s.muted};margin-top:0.5rem">${proj ? esc(proj.name) + ' · ' : ''}vytvorené ${s.date(t.createdAt, { dateStyle: 'short', timeStyle: 'short' })}</div>
      </aside></div><style>@media (max-width:720px){.nw-td-grid{grid-template-columns:1fr !important}}</style>`, (el, close) => {
      s.linksPanel(el.querySelector('#td-links'), 'task', t.id);
      if (!s.canWrite) return;
      const patch = async (b, msg) => {
        const r = await s.api('PATCH', `${T}/tasks/${t.id}`, b, msg);
        if (r) { Object.assign(t, r); render(); }
        return r;
      };
      el.querySelector('#td-title').onchange = e => { patch({ title: e.target.value }); el.parentElement.parentElement.querySelector('#td-title-h').textContent = e.target.value; };
      el.querySelector('#td-desc').onchange = e => patch({ description: e.target.value });
      el.querySelector('#td-done').onchange = async e => { const r = await patch({ done: e.target.checked }); if (r && e.target.checked && r.done === false) { showToast('Opakovaná úloha – posunutá na ďalší termín.'); close(); } };
      el.querySelector('#td-proj').onchange = e => patch({ projectId: e.target.value });
      el.querySelector('#td-due').onchange = e => patch({ dueAt: fromLocal(e.target.value) });
      el.querySelector('#td-remind').onchange = e => patch({ remindAt: fromLocal(e.target.value) }, 'Pripomienka nastavená.');
      el.querySelector('#td-repeat').onchange = e => patch({ repeatDays: Number(e.target.value) });
      el.querySelector('#td-prio').onchange = e => patch({ priority: Number(e.target.value) });
      el.querySelector('#td-pct').onchange = e => { patch({ percent: Number(e.target.value) }); e.target.previousElementSibling.textContent = `Hotovo na ${e.target.value} %`; };
      el.querySelectorAll('[data-asg]').forEach(cb => { cb.onchange = () => patch({ assignees: [...el.querySelectorAll('[data-asg]')].filter(x => x.checked).map(x => x.dataset.asg) }); });
      el.querySelectorAll('[data-lbl]').forEach(cb => {
        cb.onchange = () => {
          const chip = el.querySelector(`[data-lchip="${cb.dataset.lbl}"]`);
          const l = state.labels.find(x => x.id === cb.dataset.lbl);
          chip.style.background = cb.checked ? l.color : 'transparent';
          chip.style.color = cb.checked ? '#fff' : l.color;
          patch({ labels: [...el.querySelectorAll('[data-lbl]')].filter(x => x.checked).map(x => x.dataset.lbl) });
        };
      });
      el.querySelector('#td-newlabel').onkeydown = async e => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        const l = await s.api('POST', `${T}/labels`, { name: e.target.value });
        if (!l) return;
        state.labels = (await s.api('GET', `${T}/labels`)) || state.labels;
        await patch({ labels: [...new Set([...t.labels, l.id])] });
        close();
        openTask(t.id);
      };
      el.querySelectorAll('[data-sub]').forEach(cb => { cb.onchange = async () => { await s.api('PATCH', `${T}/tasks/${cb.dataset.sub}`, { done: cb.checked }); render(); }; });
      el.querySelector('#td-newsub').onkeydown = async e => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        if (await s.api('POST', `${T}/tasks`, { projectId: t.projectId, parentId: t.id, title: e.target.value })) { close(); openTask(t.id); render(); }
      };
      el.querySelector('#td-comment').onkeydown = async e => {
        if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !e.target.value.trim()) return;
        if (await s.api('POST', `${T}/tasks/${t.id}/comments`, { body: e.target.value })) { close(); openTask(t.id); }
      };
      el.querySelector('#td-file').onchange = async e => {
        const fd = new FormData();
        for (const f of e.target.files) fd.append('files', f);
        showToast('Nahrávam…');
        if (await s.api('POST', `${T}/tasks/${t.id}/files`, fd, 'Príloha pridaná (uložená na Disku).')) s.linksPanel(el.querySelector('#td-links'), 'task', t.id);
      };
      el.querySelector('#td-meet').onclick = async () => {
        const r = await s.api('POST', `${T}/tasks/${t.id}/meet`, {});
        if (r) { close(); s.meet(r.room); openTask(t.id); }
      };
      el.querySelector('#td-del').onclick = async () => { if (confirm('Zmazať úlohu aj s podúlohami?') && await s.api('DELETE', `${T}/tasks/${t.id}`, undefined, 'Zmazané.')) { close(); render(); } };
    }, { wide: true });
  }
})();
