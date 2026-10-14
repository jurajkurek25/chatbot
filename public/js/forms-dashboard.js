/* Formuláre (podľa HeyForm): zoznam, stavač otázok s podmienkami, dizajn, napojenia (marketing, úlohy),
   zdieľanie a vloženie na web, odpovede s prehľadom a exportom. Používa NW.suite, esc, showToast, apiFetch. */
(function () {
  'use strict';
  const F = '/api/forms';
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;
  const ICON = { text: '✏️', textarea: '📝', email: '✉️', phone: '📞', number: '🔢', url: '🔗', choice: '🔘', checkbox: '☑️', select: '🔽', date: '📅', rating: '⭐', yesno: '👍', consent: '✅', file: '📎', statement: '💬' };
  const CHOICES = ['choice', 'checkbox', 'select'];
  let meta = null; // { types, templates }
  let form = null;
  let tab = 'questions';
  let saveT = null;

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.forms = { title: 'Formuláre', load };

  if (window.NW && NW.rt) NW.rt.on('form', e => { if (form && e.id === form.id && tab === 'results' && $('view-forms').style.display !== 'none') results(); });

  async function load() {
    const s = su();
    if (!meta) meta = await s.api('GET', `${F}/types`);
    const open = s.takeOpen('form');
    if (open) { const f = await s.api('GET', `${F}/${open}`); if (f) return edit(f, 'results'); }
    form = null;
    list();
  }

  /* ── Zoznam formulárov ── */
  async function list() {
    const s = su();
    const items = (await s.api('GET', F)) || [];
    $('forms-body').innerHTML = `<div style="display:flex;gap:0.6rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap">
        <p style="${s.muted};font-size:0.88rem;flex:1;min-width:240px">Formuláre na web, prihlášky a dotazníky. Odpovede môžu pridať kontakt do e-mail marketingu, vytvoriť úlohu a súbory sa uložia na Disk.</p>
        ${s.wsPicker(load)}${s.canWrite ? '<button class="btn btn-primary" id="fm-new">+ Nový formulár</button>' : ''}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:0.9rem">${items.map(f => `<div class="panel" style="margin:0;padding:1rem;display:flex;flex-direction:column;gap:0.5rem">
        <div style="display:flex;gap:0.5rem;align-items:flex-start"><span style="font-size:1.4rem">📝</span><div style="min-width:0;flex:1">
          <a href="#" data-edit="${esc(f.id)}" style="font-weight:700;color:#eeeef5;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.title)}</a>
          <div style="${s.muted}">${f.fields.length} ${f.fields.length === 1 ? 'otázka' : f.fields.length < 5 && f.fields.length ? 'otázky' : 'otázok'} · upravené ${s.date(f.updatedAt)}</div></div>
          <span style="font-size:0.72rem;padding:0.1rem 0.5rem;border-radius:10px;${f.status === 'open' ? 'background:rgba(34,197,94,0.15);color:#4ade80' : 'background:rgba(255,255,255,0.08);color:#9898b8'}">${f.status === 'open' ? 'Prijíma' : 'Uzavretý'}</span></div>
        <div style="font-size:1.6rem;font-weight:800">${f.responses} <span style="${s.muted};font-weight:400">odpovedí${f.lastResponse ? ` · posledná ${s.date(f.lastResponse, { dateStyle: 'short', timeStyle: 'short' })}` : ''}</span></div>
        <div style="display:flex;gap:0.35rem;flex-wrap:wrap;margin-top:auto">
          <button class="btn btn-sm btn-secondary" data-edit="${esc(f.id)}">${s.canWrite ? '✏️ Upraviť' : '👁 Otvoriť'}</button>
          <button class="btn btn-sm btn-secondary" data-res="${esc(f.id)}">📊 Odpovede</button>
          <button class="btn btn-sm btn-secondary" data-copy="${esc(f.url)}" title="Kopírovať odkaz">🔗</button>
          ${s.canWrite ? `<button class="btn btn-sm btn-secondary" data-dup="${esc(f.id)}" title="Duplikovať">⧉</button><button class="btn btn-sm btn-danger" data-del="${esc(f.id)}" title="Zmazať">✕</button>` : ''}</div></div>`).join('')
        || `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">📝</div><p>Zatiaľ žiadny formulár. ${s.canWrite ? 'Začnite šablónou – kontaktný formulár, spätná väzba, registrácia…' : ''}</p></div>`}</div>`;
    if ($('fm-new')) $('fm-new').onclick = newDialog;
    const byId = id => items.find(x => x.id === id);
    document.querySelectorAll('#forms-body [data-edit]').forEach(b => { b.onclick = e => { e.preventDefault(); edit(byId(b.dataset.edit), 'questions'); }; });
    document.querySelectorAll('#forms-body [data-res]').forEach(b => { b.onclick = () => edit(byId(b.dataset.res), 'results'); });
    document.querySelectorAll('#forms-body [data-copy]').forEach(b => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => showToast('Odkaz skopírovaný.')); });
    document.querySelectorAll('#forms-body [data-dup]').forEach(b => { b.onclick = async () => { if (await s.api('POST', `${F}/${b.dataset.dup}/duplicate`, {}, 'Formulár duplikovaný.')) list(); }; });
    document.querySelectorAll('#forms-body [data-del]').forEach(b => {
      b.onclick = async () => { if (confirm(`Zmazať formulár „${byId(b.dataset.del).title}“ aj s odpoveďami? Nahrané súbory zostanú na Disku.`) && await s.api('DELETE', `${F}/${b.dataset.del}`, undefined, 'Zmazané.')) list(); };
    });
  }

  function newDialog() {
    const s = su();
    const desc = { blank: 'Začnite od nuly', contact: 'Meno, e-mail, správa, súhlas s novinkami', feedback: 'Hodnotenie, návrhy, odporúčanie', registration: 'Prihláška na podujatie s výberom termínu', order: 'Dopyt so službami, rozpočtom a podkladmi' };
    s.modal('📝 Nový formulár', `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:0.6rem">${Object.entries(meta.templates).map(([k, t]) => `
      <button class="panel" data-tpl="${k}" style="margin:0;padding:0.9rem;text-align:left;cursor:pointer;border:1px solid rgba(255,255,255,0.08);color:#eeeef5">
        <div style="font-weight:700;margin-bottom:0.2rem">${k === 'blank' ? '➕ Prázdny' : esc(t)}</div><div style="${s.muted}">${esc(desc[k] || '')}</div></button>`).join('')}</div>`, (el, close) => {
      el.querySelectorAll('[data-tpl]').forEach(b => { b.onclick = async () => { const f = await s.api('POST', F, { template: b.dataset.tpl }); if (f) { close(); edit(f, 'questions'); } }; });
    }, { wide: true });
  }

  /* ── Editor ── */
  function edit(f, startTab) {
    const s = su();
    form = f;
    tab = s.canWrite ? startTab : (startTab === 'questions' ? 'share' : startTab);
    const tabs = [['questions', '✏️ Otázky'], ['design', '🎨 Dizajn'], ['flows', '🔌 Napojenia'], ['share', '🔗 Zdieľať'], ['results', `📊 Odpovede`]].filter(([k]) => s.canWrite || ['share', 'results'].includes(k));
    $('forms-body').innerHTML = `<div style="display:flex;gap:0.6rem;align-items:center;margin-bottom:0.8rem;flex-wrap:wrap">
        <button class="btn btn-sm btn-secondary" id="fe-back">← Formuláre</button>
        <input class="form-control" id="fe-title" value="${esc(f.title)}" ${s.canWrite ? '' : 'disabled'} style="max-width:360px;font-weight:700">
        <span id="fe-saved" style="${s.muted}"></span>
        <span style="margin-left:auto;display:flex;gap:0.4rem;align-items:center">
          ${s.canWrite ? `<label style="display:flex;gap:0.4rem;align-items:center;font-size:0.85rem"><input type="checkbox" id="fe-open" ${f.status === 'open' ? 'checked' : ''}> Prijíma odpovede</label>` : ''}
          <a class="btn btn-sm btn-secondary" href="${esc(f.url)}?preview=1" target="_blank" rel="noopener">👁 Náhľad</a></span></div>
      <div style="display:flex;gap:0.3rem;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:1rem;overflow-x:auto">${tabs.map(([k, l]) => `<button class="nav-item ${k === tab ? 'active' : ''}" data-tab="${k}" style="width:auto;border-radius:8px 8px 0 0">${l}</button>`).join('')}</div>
      <div id="fe-body"></div>`;
    $('fe-back').onclick = () => { form = null; list(); };
    if (s.canWrite) {
      $('fe-title').oninput = () => save({ title: $('fe-title').value });
      $('fe-open').onchange = () => save({ status: $('fe-open').checked ? 'open' : 'closed' }, true);
    }
    document.querySelectorAll('#forms-body [data-tab]').forEach(b => {
      b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('#forms-body [data-tab]').forEach(x => x.classList.toggle('active', x === b)); body(); };
    });
    body();
  }
  function body() { ({ questions, design, flows, share, results })[tab](); }

  /** Uloženie s oneskorením (autosave). */
  function save(patch, now) {
    Object.assign(pendingPatch, patch);
    clearTimeout(saveT);
    if ($('fe-saved')) $('fe-saved').textContent = 'Ukladám…';
    saveT = setTimeout(async () => {
      const p = pendingPatch;
      pendingPatch = {};
      const r = await su().api('PATCH', `${F}/${form.id}`, p);
      if (r) { form = r; if ($('fe-saved')) $('fe-saved').textContent = '✓ Uložené'; }
    }, now ? 0 : 600);
  }
  let pendingPatch = {};
  const saveFields = () => save({ fields: form.fields });

  /* Otázky */
  function questions() {
    const s = su();
    const types = Object.entries(meta.types);
    $('fe-body').innerHTML = `<div style="display:grid;grid-template-columns:200px minmax(0,1fr);gap:1rem;align-items:start" class="nw-fe-grid">
      <aside class="panel" style="margin:0;padding:0.6rem;position:sticky;top:0.5rem"><div style="${s.muted};margin:0 0 0.4rem 0.3rem">Pridať otázku</div>
        ${types.map(([k, l]) => `<button class="nav-item" data-add="${k}" style="width:100%;font-size:0.85rem;padding:0.4rem 0.6rem"><span>${ICON[k]}</span> ${esc(l)}</button>`).join('')}</aside>
      <section id="fe-fields"></section></div>
      <style>@media (max-width:820px){.nw-fe-grid{grid-template-columns:1fr !important}.nw-fe-grid aside{position:static !important}}</style>`;
    document.querySelectorAll('#fe-body [data-add]').forEach(b => {
      b.onclick = () => {
        const t = b.dataset.add;
        const f = { id: Math.random().toString(36).slice(2, 10), type: t, label: t === 'statement' ? 'Nadpis sekcie' : meta.types[t], required: false };
        if (CHOICES.includes(t)) f.options = ['Možnosť 1', 'Možnosť 2'];
        if (t === 'rating') f.max = 5;
        form.fields.push(f);
        saveFields();
        renderFields(form.fields.length - 1);
      };
    });
    renderFields();
  }

  function renderFields(focusIdx) {
    const s = su();
    const el = $('fe-fields');
    el.innerHTML = form.fields.map((f, i) => {
      const conds = form.fields.slice(0, i).filter(x => [...CHOICES, 'yesno'].includes(x.type));
      const condField = f.showIf && form.fields.find(x => x.id === f.showIf.field);
      const condValues = condField ? (condField.type === 'yesno' ? [['yes', 'Áno'], ['no', 'Nie']] : condField.options.map(o => [o, o])) : [];
      return `<div class="panel" data-i="${i}" draggable="true" style="margin:0 0 0.7rem;padding:0.85rem 1rem;border-left:3px solid ${f.type === 'statement' ? '#7e7ea0' : '#5b4fff'}">
        <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">
          <span style="cursor:grab;color:#7e7ea0" title="Potiahnite na presun">⋮⋮</span><span>${ICON[f.type]}</span><span style="${s.muted}">${i + 1}. ${esc(meta.types[f.type])}</span>
          <span style="margin-left:auto;display:flex;gap:0.25rem">
            ${f.type !== 'statement' ? `<label style="display:flex;gap:0.3rem;align-items:center;font-size:0.8rem;margin-right:0.4rem"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''}> Povinné</label>` : ''}
            <button class="btn btn-sm btn-secondary" data-mv="-1" style="padding:0 0.4rem" title="Vyššie">↑</button><button class="btn btn-sm btn-secondary" data-mv="1" style="padding:0 0.4rem" title="Nižšie">↓</button>
            <button class="btn btn-sm btn-secondary" data-dup style="padding:0 0.4rem" title="Duplikovať">⧉</button><button class="btn btn-sm btn-danger" data-rm style="padding:0 0.4rem" title="Odstrániť">✕</button></span></div>
        <input class="form-control" data-k="label" value="${esc(f.label)}" placeholder="${f.type === 'consent' ? 'Text súhlasu' : 'Otázka'}" style="font-weight:600;margin-bottom:0.4rem">
        <input class="form-control" data-k="help" value="${esc(f.help || '')}" placeholder="${f.type === 'statement' ? 'Text pod nadpisom (nepovinné)' : 'Pomocný text (nepovinné)'}" style="font-size:0.85rem;margin-bottom:0.4rem">
        ${CHOICES.includes(f.type) ? `<textarea class="form-control" data-k="options" rows="3" style="font-size:0.85rem;font-family:inherit" placeholder="Jedna možnosť na riadok">${esc((f.options || []).join('\n'))}</textarea>` : ''}
        ${f.placeholder !== undefined || ['text', 'textarea', 'email', 'phone', 'number', 'url'].includes(f.type) ? `<input class="form-control" data-k="placeholder" value="${esc(f.placeholder || '')}" placeholder="Zástupný text v poli (nepovinné)" style="font-size:0.82rem">` : ''}
        ${f.type === 'rating' ? `<select class="form-control" data-k="max" style="width:auto;font-size:0.85rem"><option value="5" ${f.max !== 10 ? 'selected' : ''}>1 – 5 hviezdičiek</option><option value="10" ${f.max === 10 ? 'selected' : ''}>1 – 10 (NPS)</option></select>` : ''}
        ${conds.length ? `<div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.5rem;flex-wrap:wrap;font-size:0.82rem"><span style="${s.muted}">Zobraziť iba ak</span>
          <select class="form-control" data-cond style="width:auto;font-size:0.82rem;padding:0.25rem 0.5rem"><option value="">— vždy —</option>${conds.map(c => `<option value="${esc(c.id)}" ${f.showIf && f.showIf.field === c.id ? 'selected' : ''}>${esc(c.label || meta.types[c.type])}</option>`).join('')}</select>
          ${condField ? `<span style="${s.muted}">=</span><select class="form-control" data-condv style="width:auto;font-size:0.82rem;padding:0.25rem 0.5rem">${condValues.map(([v, l]) => `<option value="${esc(v)}" ${f.showIf.value === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}</div>` : ''}
      </div>`;
    }).join('') || `<div class="empty-state"><div class="empty-state-icon">➕</div><p>Pridajte prvú otázku z ponuky vľavo.</p></div>`;
    let dragFrom = null;
    el.querySelectorAll('[data-i]').forEach(card => {
      const i = Number(card.dataset.i);
      const f = form.fields[i];
      card.querySelectorAll('[data-k]').forEach(inp => {
        const k = inp.dataset.k;
        const apply = () => {
          if (k === 'required') f.required = inp.checked;
          else if (k === 'options') f.options = inp.value.split('\n').map(x => x.trim()).filter(Boolean);
          else if (k === 'max') f.max = Number(inp.value);
          else f[k] = inp.value;
          saveFields();
        };
        inp.oninput = apply;
        if (inp.type === 'checkbox' || inp.tagName === 'SELECT') inp.onchange = apply;
        if (k === 'options') inp.onblur = () => renderFields(); // podmienky iných otázok uvidia nové možnosti
      });
      const cond = card.querySelector('[data-cond]');
      if (cond) cond.onchange = () => {
        const c = form.fields.find(x => x.id === cond.value);
        if (!c) delete f.showIf; else f.showIf = { field: c.id, value: c.type === 'yesno' ? 'yes' : (c.options[0] || '') };
        saveFields(); renderFields();
      };
      const condv = card.querySelector('[data-condv]');
      if (condv) condv.onchange = () => { f.showIf.value = condv.value; saveFields(); };
      card.querySelectorAll('[data-mv]').forEach(b => { b.onclick = () => { const j = i + Number(b.dataset.mv); if (j < 0 || j >= form.fields.length) return; move(i, j); }; });
      card.querySelector('[data-dup]').onclick = () => { form.fields.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(f)), id: Math.random().toString(36).slice(2, 10) }); saveFields(); renderFields(i + 1); };
      card.querySelector('[data-rm]').onclick = () => {
        form.fields.splice(i, 1);
        form.fields.forEach(x => { if (x.showIf && x.showIf.field === f.id) delete x.showIf; });
        saveFields(); renderFields();
      };
      card.ondragstart = e => { if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && card.contains(document.activeElement)) { e.preventDefault(); return; } dragFrom = i; card.style.opacity = '0.5'; };
      card.ondragend = () => { card.style.opacity = ''; };
      card.ondragover = e => { e.preventDefault(); card.style.boxShadow = '0 -2px 0 #9b8cff'; };
      card.ondragleave = () => { card.style.boxShadow = ''; };
      card.ondrop = e => { e.preventDefault(); card.style.boxShadow = ''; if (dragFrom !== null && dragFrom !== i) move(dragFrom, i); dragFrom = null; };
    });
    if (focusIdx !== undefined) { const c = el.querySelector(`[data-i="${focusIdx}"]`); if (c) { c.scrollIntoView({ block: 'center' }); c.querySelector('[data-k=label]').select(); } }
  }
  function move(from, to) {
    const [f] = form.fields.splice(from, 1);
    form.fields.splice(to, 0, f);
    // podmienka smie odkazovať iba na otázku vyššie
    form.fields.forEach((x, idx) => { if (x.showIf && form.fields.findIndex(y => y.id === x.showIf.field) >= idx) delete x.showIf; });
    saveFields();
    renderFields();
  }

  /* Dizajn */
  function design() {
    const st = form.settings;
    $('fe-body').innerHTML = `<div class="panel" style="max-width:720px">
      <div class="form-group"><label>Rozloženie</label><div style="display:flex;gap:0.6rem;flex-wrap:wrap">
        ${[['classic', '📄 Klasické', 'Všetky otázky na jednej stránke'], ['steps', '➡️ Po jednej otázke', 'Konverzačný štýl, vyšší počet dokončení']].map(([v, l, d]) => `<label class="panel" style="margin:0;padding:0.7rem 0.9rem;cursor:pointer;flex:1;min-width:200px;${st.layout === v ? 'border:1px solid #5b4fff' : ''}"><input type="radio" name="fd-layout" value="${v}" ${st.layout === v ? 'checked' : ''} hidden><strong>${l}</strong><div style="color:#7e7ea0;font-size:0.8rem">${d}</div></label>`).join('')}</div></div>
      <div class="form-row"><div class="form-group" style="flex:1"><label>Téma</label><select class="form-control" id="fd-theme"><option value="light" ${st.theme === 'light' ? 'selected' : ''}>☀️ Svetlá</option><option value="dark" ${st.theme === 'dark' ? 'selected' : ''}>🌙 Tmavá</option></select></div>
        <div class="form-group" style="flex:1"><label>Farba značky</label><input type="color" class="form-control" id="fd-color" value="${esc(st.color)}" style="height:42px;padding:0.2rem"></div>
        <div class="form-group" style="flex:1"><label>Text tlačidla</label><input class="form-control" id="fd-submit" value="${esc(st.submitLabel)}"></div></div>
      <div class="form-group"><label>Popis pod nadpisom</label><textarea class="form-control" id="fd-desc" rows="2" style="font-family:inherit">${esc(form.description)}</textarea></div>
      <div class="form-group"><label>Poďakovanie po odoslaní</label><textarea class="form-control" id="fd-thanks" rows="2" style="font-family:inherit">${esc(st.thankYou)}</textarea></div>
      <div class="form-group"><label>…alebo presmerovať na adresu (nepovinné)</label><input class="form-control" id="fd-redirect" value="${esc(st.redirect)}" placeholder="https://mojweb.sk/dakujeme"></div></div>`;
    const sv = () => save({ description: $('fd-desc').value, settings: { layout: (document.querySelector('[name=fd-layout]:checked') || {}).value, theme: $('fd-theme').value, color: $('fd-color').value, submitLabel: $('fd-submit').value, thankYou: $('fd-thanks').value, redirect: $('fd-redirect').value } });
    document.querySelectorAll('#fe-body input, #fe-body textarea, #fe-body select').forEach(x => { x.oninput = sv; x.onchange = sv; });
    document.querySelectorAll('[name=fd-layout]').forEach(r => { r.onchange = () => { sv(); setTimeout(design, 650); }; });
  }

  /* Napojenia */
  async function flows() {
    const s = su();
    const st = form.settings;
    const projects = (await s.api('GET', '/api/tasks/projects')) || [];
    const hasEmail = form.fields.some(f => f.type === 'email');
    const hasConsent = form.fields.some(f => f.type === 'consent');
    $('fe-body').innerHTML = `<div style="display:grid;gap:0.9rem;max-width:760px">
      <div class="panel" style="margin:0"><label style="display:flex;gap:0.6rem;align-items:center;font-weight:700"><input type="checkbox" id="ff-notify" ${st.notify ? 'checked' : ''}> 🔔 Upozorniť ma na novú odpoveď</label>
        <p style="${s.muted};margin-top:0.3rem">V zvončeku aj e-mailom – vám a tomu, kto formulár vytvoril.</p></div>
      <div class="panel" style="margin:0"><label style="display:flex;gap:0.6rem;align-items:center;font-weight:700"><input type="checkbox" id="ff-mk" ${st.marketing.enabled ? 'checked' : ''}> ✉️ Pridať do e-mail marketingu</label>
        <p style="${s.muted};margin:0.3rem 0 0.5rem">Nový kontakt vznikne iba so súhlasom (pole „Súhlas“). Štítky môžu spustiť automatickú sériu e-mailov.</p>
        ${!hasEmail ? '<p style="color:#f59e0b;font-size:0.82rem">⚠ Formulár nemá pole E-mail.</p>' : ''}${!hasConsent ? '<p style="color:#f59e0b;font-size:0.82rem">⚠ Pridajte otázku „Súhlas“ – bez nej sa noví ľudia do zoznamu nepridajú.</p>' : ''}
        <input class="form-control" id="ff-tags" value="${esc((st.marketing.tags || []).join(', '))}" placeholder="Štítky, napr. webinar, dopyt" style="font-size:0.88rem"></div>
      <div class="panel" style="margin:0"><label style="display:flex;gap:0.6rem;align-items:center;font-weight:700"><input type="checkbox" id="ff-task" ${st.task.enabled ? 'checked' : ''}> ✅ Z každej odpovede úloha</label>
        <p style="${s.muted};margin:0.3rem 0 0.5rem">Úloha obsahuje všetky odpovede a je prepojená s formulárom.</p>
        <select class="form-control" id="ff-proj" style="max-width:320px"><option value="">Doručené</option>${projects.map(p => `<option value="${esc(p.id)}" ${st.task.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="panel" style="margin:0"><div style="font-weight:700">💾 Nahraté súbory</div><p style="${s.muted};margin-top:0.3rem">Súbory z otázky „Nahratie súboru“ sa ukladajú na Disk do priečinka „Odpovede z formulárov“.</p></div>
      <div class="panel" style="margin:0" id="ff-links"></div></div>`;
    const sv = () => save({ settings: { notify: $('ff-notify').checked, marketing: { enabled: $('ff-mk').checked, tags: $('ff-tags').value.split(',').map(t => t.trim()).filter(Boolean) }, task: { enabled: $('ff-task').checked, projectId: $('ff-proj').value || null } } });
    ['ff-notify', 'ff-mk', 'ff-task', 'ff-proj'].forEach(id => { $(id).onchange = sv; });
    $('ff-tags').oninput = sv;
    s.linksPanel($('ff-links'), 'form', form.id);
  }

  /* Zdieľanie */
  function share() {
    const s = su();
    const embed = `<iframe src="${form.url}?embed=1" style="width:100%;min-height:640px;border:0" title="${esc(form.title).replace(/"/g, '')}"></iframe>`;
    $('fe-body').innerHTML = `<div style="display:grid;gap:0.9rem;max-width:760px">
      ${form.status === 'closed' ? '<div class="panel" style="margin:0;color:#f59e0b">⚠ Formulár je uzavretý – zapnite „Prijíma odpovede“.</div>' : ''}
      <div class="panel" style="margin:0"><div style="font-weight:700;margin-bottom:0.5rem">🔗 Odkaz</div>
        <div style="display:flex;gap:0.4rem"><input class="form-control" readonly value="${esc(form.url)}"><button class="btn btn-secondary" data-cp="${esc(form.url)}">Kopírovať</button><a class="btn btn-primary" href="${esc(form.url)}" target="_blank" rel="noopener">Otvoriť</a></div>
        <p style="${s.muted};margin-top:0.4rem">Pošlite e-mailom, v chate alebo dajte na sociálne siete.</p></div>
      <div class="panel" style="margin:0"><div style="font-weight:700;margin-bottom:0.5rem">🧩 Vložiť na web</div>
        <textarea class="form-control" readonly rows="3" style="font-family:monospace;font-size:0.8rem">${esc(embed)}</textarea>
        <div style="margin-top:0.4rem"><button class="btn btn-secondary btn-sm" data-cp="${esc(embed)}">Kopírovať kód</button></div>
        <p style="${s.muted};margin-top:0.4rem">Funguje na WordPresse, Shoptete, Webnode a ďalších – vložte do bloku „HTML“.</p></div></div>`;
    document.querySelectorAll('#fe-body [data-cp]').forEach(b => { b.onclick = () => navigator.clipboard.writeText(b.dataset.cp).then(() => showToast('Skopírované.')); });
  }

  /* Odpovede */
  async function results() {
    const s = su();
    const [st, rows] = await Promise.all([s.api('GET', `${F}/${form.id}/stats`), s.api('GET', `${F}/${form.id}/responses`)]);
    if (!st) return;
    const fields = form.fields.filter(f => f.type !== 'statement');
    const answer = (f, v) => {
      if (v === undefined || v === null || v === '') return '';
      if (f.type === 'consent') return v ? 'Áno' : 'Nie';
      if (f.type === 'yesno') return v === 'yes' ? 'Áno' : 'Nie';
      if (f.type === 'file') return v.map(x => x.name).join(', ');
      if (Array.isArray(v)) return v.join(', ');
      if (f.type === 'rating') return `${v}/${f.max || 5}`;
      return String(v);
    };
    const bar = (label, n, total) => `<div style="margin:0.25rem 0"><div style="display:flex;font-size:0.82rem"><span>${esc(label)}</span><span style="margin-left:auto;color:#9898b8">${n} (${total ? Math.round((n / total) * 100) : 0} %)</span></div>
      <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:4px"><div style="height:100%;width:${total ? (n / total) * 100 : 0}%;background:#5b4fff;border-radius:4px"></div></div></div>`;
    $('fe-body').innerHTML = `<div style="display:flex;gap:0.6rem;align-items:center;margin-bottom:0.9rem;flex-wrap:wrap">
        <div style="font-size:1.4rem;font-weight:800">${st.total} <span style="${s.muted};font-weight:400">odpovedí</span></div>
        <button class="btn btn-sm btn-secondary" id="fr-csv" style="margin-left:auto" ${st.total ? '' : 'disabled'}>⬇ Export CSV (Excel)</button></div>
      ${st.total ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0.8rem;margin-bottom:1rem">${st.fields.map(f => `<div class="panel" style="margin:0;padding:0.85rem">
        <div style="font-weight:700;font-size:0.88rem;margin-bottom:0.15rem">${esc(f.label || meta.types[f.type])}</div><div style="${s.muted};margin-bottom:0.4rem">${f.answered} odpovedí</div>
        ${f.counts ? Object.entries(f.counts).map(([k, n]) => bar(k, n, st.total)).join('') : ''}
        ${f.avg !== undefined && f.avg !== null ? `<div style="font-size:1.5rem;font-weight:800">${f.type === 'rating' ? '⭐ ' : 'Ø '}${f.avg}${f.max ? `<span style="${s.muted}"> / ${f.max}</span>` : ''}</div>` : ''}
        ${f.latest ? f.latest.map(t => `<div style="font-size:0.82rem;padding:0.25rem 0;border-bottom:1px solid rgba(255,255,255,0.05);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t)}</div>`).join('') || `<div style="${s.muted}">—</div>` : ''}</div>`).join('')}</div>
      <div class="panel" style="margin:0;padding:0;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:0.84rem">
        <thead><tr style="text-align:left;color:#9898b8"><th style="padding:0.6rem">Čas</th>${fields.slice(0, 4).map(f => `<th style="padding:0.6rem">${esc(f.label || meta.types[f.type])}</th>`).join('')}<th></th></tr></thead>
        <tbody>${rows.map(r => `<tr data-r="${esc(r.id)}" style="border-top:1px solid rgba(255,255,255,0.06);cursor:pointer"><td style="padding:0.55rem 0.6rem;white-space:nowrap">${s.date(r.createdAt, { dateStyle: 'short', timeStyle: 'short' })}</td>
          ${fields.slice(0, 4).map(f => `<td style="padding:0.55rem 0.6rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(answer(f, r.data[f.id]))}</td>`).join('')}<td style="padding:0.55rem 0.6rem;color:#9b8cff">Detail →</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty-state"><div class="empty-state-icon">📭</div><p>Zatiaľ žiadne odpovede. Pošlite odkaz zo záložky Zdieľať.</p></div>`}`;
    if ($('fr-csv')) $('fr-csv').onclick = async () => {
      const r = await apiFetch(s.url(`${F}/${form.id}/export.csv`));
      if (!r || !r.ok) return showToast('Export zlyhal.', 'error');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = `${form.title.replace(/[\\/:*?"<>|]/g, '_')}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    document.querySelectorAll('#fe-body [data-r]').forEach(tr => {
      tr.onclick = () => {
        const r = rows.find(x => x.id === tr.dataset.r);
        s.modal(`📝 Odpoveď · ${s.date(r.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}`, `${fields.filter(f => r.data[f.id] !== undefined).map(f => `<div style="margin-bottom:0.7rem"><div style="${s.muted}">${esc(f.label || meta.types[f.type])}</div>
            <div style="white-space:pre-line">${f.type === 'file' ? (r.data[f.id] || []).map(x => `<a href="#" data-file="${esc(x.id)}" style="color:#c4bcff">📎 ${esc(x.name)}</a>`).join('<br>') : esc(answer(f, r.data[f.id])) || '—'}</div></div>`).join('')}
          ${s.canWrite ? '<button class="btn btn-sm btn-danger" data-delr>Zmazať odpoveď</button>' : ''}`, (el, close) => {
          el.querySelectorAll('[data-file]').forEach(a => {
            a.onclick = async e => { e.preventDefault(); const w = window.open('about:blank', '_blank'); const d = await s.api('GET', `/api/drive/items/${encodeURIComponent(a.dataset.file)}/url`); if (d && w) w.location.href = d.url; else if (w) w.close(); };
          });
          const del = el.querySelector('[data-delr]');
          if (del) del.onclick = async () => { if (confirm('Zmazať túto odpoveď?') && await s.api('DELETE', `${F}/${form.id}/responses/${r.id}`, undefined, 'Zmazané.')) { close(); results(); } };
        });
      };
    });
  }
})();
