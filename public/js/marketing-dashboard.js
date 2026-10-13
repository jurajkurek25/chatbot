/* E-mail marketing v dashboarde: kampane, automatické série, kontakty, odosielateľ a doména (Resend).
   Používa apiFetch, esc a showToast z dashboard.js. */
(function () {
  'use strict';
  const M = '/api/marketing';
  const muted = 'color:#7e7ea0;font-size:0.78rem';
  const STATUS = { subscribed: '✅ prihlásený', unsubscribed: 'odhlásený', bounced: '⚠ nedoručiteľný', complained: '⚠ sťažnosť' };
  const CSTATUS = { draft: 'Koncept', scheduled: '🕒 Naplánovaná', sending: '📤 Odosiela sa', sent: '✅ Odoslaná', failed: '⚠ Zlyhala' };
  const TRIGGERS = { contact_added: 'Nový kontakt (súhlas s odberom)', lead_magnet: 'Stiahnutie lead magnetu', purchase: 'Nákup / produkt zadarmo', tag: 'Pridaný štítok' };
  let tab = 'campaigns';
  let overview = null;
  let options = null;

  const body = () => document.getElementById('mk-body');
  const json = (method, b) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const date = t => t ? new Date(t * 1000).toLocaleString('sk-SK', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const pct = (a, b) => b ? `${Math.round(100 * a / b)} %` : '—';

  async function call(url, opts, ok) {
    const r = await apiFetch(url, opts);
    if (!r) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(d.error || 'Chyba', 'error'); return null; }
    if (ok) showToast(ok);
    return d;
  }

  window.loadMarketing = async function () {
    document.querySelectorAll('[data-mk-tab]').forEach(b => {
      b.classList.toggle('btn-primary', b.dataset.mkTab === tab);
      b.classList.toggle('btn-secondary', b.dataset.mkTab !== tab);
    });
    [overview, options] = await Promise.all([call(`${M}/overview`), call(`${M}/options`)]);
    if (!overview) return;
    if (!overview.configured) {
      body().innerHTML = `<div class="panel">⚠️ E-mail marketing ešte nie je na serveri zapnutý. Správca musí nastaviť <code>RESEND_API_KEY</code>.</div>`;
      return;
    }
    if (tab === 'contacts') return renderContacts();
    if (tab === 'sequences') return renderSequences();
    if (tab === 'settings') return renderSettings();
    return renderCampaigns();
  };
  window.mkTab = function (t) { tab = t; loadMarketing(); };

  function banner() {
    const o = overview;
    const used = `${o.usage.toLocaleString('sk-SK')} / ${o.limit.toLocaleString('sk-SK')} e-mailov tento mesiac`;
    if (!o.settings.enabled && tab !== 'settings') return `<div class="panel">👋 Začnite nastavením odosielateľa (meno, adresa firmy do pätičky). <button class="btn btn-sm btn-primary" onclick="mkTab('settings')">Nastaviť</button></div>`;
    if (o.senderError) return `<div class="panel" style="border:1px solid rgba(255,180,0,0.4)">⚠️ ${esc(o.senderError)} <button class="btn btn-sm btn-primary" onclick="mkTab('settings')">Nastaviť doménu</button><div style="${muted};margin-top:0.3rem">${used}</div></div>`;
    return `<div style="${muted};margin-bottom:0.75rem">Odosielateľ: <b style="color:#eeeef5">${esc(o.sender.from)}</b>${o.sender.replyTo ? ` · odpovede na ${esc(o.sender.replyTo)}` : ''} · ${used}</div>`;
  }

  /* ── Segment (kampane) ────────────────────────────────────── */
  function segmentFields(seg = {}) {
    return `<div class="form-group"><label>Príjemcovia (prázdne = všetci prihlásení)</label>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.4rem">${Object.entries(options.sources).map(([k, v]) => `<label style="display:flex;gap:0.3rem;align-items:center;font-size:0.84rem">
        <input type="checkbox" data-src="${k}" ${(seg.sources || []).includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div>
      <div class="form-row"><input class="form-control" id="seg-tags" placeholder="Štítky oddelené čiarkou (aspoň jeden)" value="${esc((seg.tags || []).join(', '))}" list="mk-tags">
      <select class="form-control" id="seg-product"><option value="">— kúpili produkt (nepovinné) —</option>${options.products.map(p => `<option value="${esc(p.id)}" ${seg.productId === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select></div>
      <datalist id="mk-tags">${options.tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      <div id="seg-count" style="${muted};margin-top:0.3rem"></div></div>`;
  }
  function readSegment(el) {
    return {
      sources: [...el.querySelectorAll('[data-src]')].filter(c => c.checked).map(c => c.dataset.src),
      tags: el.querySelector('#seg-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      productId: el.querySelector('#seg-product').value || null,
    };
  }
  async function updateCount(el) {
    const d = await call(`${M}/segment/count`, json('POST', { segment: readSegment(el) }));
    if (d) el.querySelector('#seg-count').textContent = `→ ${d.count} prihlásených príjemcov`;
  }

  /* ── Kampane ──────────────────────────────────────────────── */
  async function renderCampaigns() {
    const list = (await call(`${M}/campaigns`)) || [];
    body().innerHTML = `${banner()}<div class="panel"><div class="panel-header"><div><div class="panel-title">Kampane</div>
      <div class="panel-subtitle">Jednorazové e-maily vybraným kontaktom so súhlasom · v pätičke je vždy odkaz na odhlásenie</div></div>
      <button class="btn btn-primary btn-sm" id="cp-new">+ Nová kampaň</button></div>
      ${list.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <tr style="color:#9898b8;text-align:left"><th style="padding:0.4rem">Kampaň</th><th>Stav</th><th>Príjemcovia</th><th>Otvorené</th><th>Kliknutia</th><th></th></tr>
        ${list.map(c => `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
          <td style="padding:0.5rem 0.4rem"><b>${esc(c.name)}</b><div style="${muted}">${esc(c.subject || '(bez predmetu)')}</div></td>
          <td>${CSTATUS[c.status]}${c.status === 'scheduled' ? `<div style="${muted}">${date(c.scheduledAt)}</div>` : c.sentAt ? `<div style="${muted}">${date(c.sentAt)}</div>` : ''}${c.error ? `<div style="color:#ff4060;font-size:0.75rem">${esc(c.error)}</div>` : ''}</td>
          <td>${c.recipients || '—'}</td><td>${c.stats ? pct(c.stats.opened, c.stats.sent) : '—'}</td><td>${c.stats ? pct(c.stats.clicked, c.stats.sent) : '—'}</td>
          <td style="text-align:right"><button class="btn btn-sm ${['draft', 'failed'].includes(c.status) ? 'btn-primary' : 'btn-secondary'}" data-open="${esc(c.id)}">${['draft', 'failed'].includes(c.status) ? 'Upraviť' : 'Detail'}</button></td></tr>`).join('')}
      </table>` : '<div class="empty-state"><div class="empty-state-icon">✉️</div><p>Zatiaľ žiadne kampane.</p></div>'}</div>`;
    document.getElementById('cp-new').onclick = async () => {
      const c = await call(`${M}/campaigns`, json('POST', { name: 'Nová kampaň' }));
      if (c) editCampaign(c);
    };
    body().querySelectorAll('[data-open]').forEach(b => { b.onclick = () => editCampaign(list.find(c => c.id === b.dataset.open)); });
  }

  function editCampaign(c) {
    const editable = ['draft', 'failed'].includes(c.status);
    const ro = editable ? '' : 'disabled';
    body().innerHTML = `${banner()}<button class="btn btn-sm btn-secondary" id="cp-back" style="margin-bottom:1rem">← Kampane</button>
      <div class="panel"><div class="panel-header"><div><div class="panel-title">${esc(c.name)}</div><div class="panel-subtitle">${CSTATUS[c.status]}</div></div></div>
      ${c.stats ? `<div style="display:flex;gap:1.25rem;flex-wrap:wrap;margin-bottom:1rem;font-size:0.85rem">${[['Odoslané', c.stats.sent], ['Doručené', c.stats.delivered],
        ['Otvorené', `${c.stats.opened} (${pct(c.stats.opened, c.stats.sent)})`], ['Kliknutia', `${c.stats.clicked} (${pct(c.stats.clicked, c.stats.sent)})`],
        ['Nedoručené', c.stats.bounced], ['Sťažnosti', c.stats.complained], ['Vo fronte', c.stats.queued]].map(([k, v]) => `<div><div style="${muted}">${k}</div><b>${v}</b></div>`).join('')}</div>` : ''}
      <div class="form-group"><label>Interný názov</label><input class="form-control" id="cp-name" value="${esc(c.name)}" ${ro}></div>
      <div class="form-group"><label>Predmet</label><input class="form-control" id="cp-subject" maxlength="200" value="${esc(c.subject)}" ${ro} placeholder="napr. {{meno}}, máme pre vás novinku"></div>
      <div class="form-group"><label>Náhľadový text (za predmetom v schránke)</label><input class="form-control" id="cp-pre" maxlength="200" value="${esc(c.preheader)}" ${ro}></div>
      <div class="form-group"><label>Text e-mailu</label><textarea class="form-control" id="cp-body" rows="10" ${ro}>${esc(c.body)}</textarea>
        <div style="${muted}">Odseky oddeľte prázdnym riadkom · **tučné** · odkazy https://… sa vložia samy · {{meno}} a {{email}} sa doplnia</div></div>
      <div class="form-row"><div class="form-group" style="flex:1"><label>Tlačidlo (nepovinné)</label><input class="form-control" id="cp-btn" maxlength="80" value="${esc(c.buttonText)}" ${ro}></div>
        <div class="form-group" style="flex:2"><label>Odkaz tlačidla</label><input class="form-control" id="cp-url" value="${esc(c.buttonUrl)}" placeholder="https://" ${ro}></div></div>
      ${editable ? segmentFields(c.segment) : ''}
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        ${editable ? `<button class="btn btn-secondary" id="cp-save">Uložiť</button><button class="btn btn-secondary" id="cp-test">Poslať test na môj e-mail</button>
          <button class="btn btn-secondary" id="cp-preview">Náhľad</button>
          <input class="form-control" type="datetime-local" id="cp-at" style="width:auto"><button class="btn btn-secondary" id="cp-schedule">Naplánovať</button>
          <button class="btn btn-primary" id="cp-send">Odoslať teraz</button>` : ''}
        ${c.status === 'scheduled' ? '<button class="btn btn-secondary" id="cp-cancel">Zrušiť naplánovanie</button>' : ''}
        ${c.status !== 'sending' ? '<button class="btn btn-danger" id="cp-del" style="margin-left:auto">Zmazať</button>' : ''}
      </div><div id="cp-frame"></div></div>`;
    const $ = id => document.getElementById(id);
    $('cp-back').onclick = renderCampaigns;
    const save = async () => {
      const d = await call(`${M}/campaigns/${c.id}`, json('PUT', {
        name: $('cp-name').value, subject: $('cp-subject').value, preheader: $('cp-pre').value, body: $('cp-body').value,
        buttonText: $('cp-btn').value, buttonUrl: $('cp-url').value, segment: readSegment(body()),
      }));
      if (d) Object.assign(c, d);
      return d;
    };
    if ($('cp-del')) $('cp-del').onclick = async () => { if (confirm('Zmazať kampaň?') && await call(`${M}/campaigns/${c.id}`, { method: 'DELETE' }, 'Zmazané.')) renderCampaigns(); };
    if ($('cp-cancel')) $('cp-cancel').onclick = async () => { const d = await call(`${M}/campaigns/${c.id}/cancel`, { method: 'POST' }, 'Naplánovanie zrušené.'); if (d) editCampaign(d); };
    if (!editable) return;
    updateCount(body());
    body().querySelectorAll('[data-src], #seg-tags, #seg-product').forEach(i => { i.onchange = () => updateCount(body()); });
    $('cp-save').onclick = async () => { if (await save()) showToast('Uložené.'); };
    $('cp-test').onclick = async () => {
      if (!(await save())) return;
      const d = await call(`${M}/campaigns/${c.id}/test`, json('POST', {}));
      if (d) showToast(`Test odoslaný na ${d.to}.`);
    };
    $('cp-preview').onclick = async () => {
      if (!(await save())) return;
      const d = await call(`${M}/campaigns/${c.id}/preview`, json('POST', {}));
      if (d) $('cp-frame').innerHTML = `<iframe sandbox="" style="width:100%;height:520px;border:0;border-radius:10px;margin-top:1rem;background:#f4f4f8" srcdoc="${esc(d.html)}"></iframe>`;
    };
    $('cp-schedule').onclick = async () => {
      if (!$('cp-at').value) return showToast('Vyberte dátum a čas.', 'error');
      if (!(await save())) return;
      const d = await call(`${M}/campaigns/${c.id}/send`, json('POST', { scheduledAt: new Date($('cp-at').value).toISOString() }), 'Kampaň naplánovaná.');
      if (d) editCampaign(d);
    };
    $('cp-send').onclick = async () => {
      if (!(await save())) return;
      const n = (await call(`${M}/segment/count`, json('POST', { segment: c.segment })))?.count;
      if (!confirm(`Odoslať kampaň „${c.subject}“ ${n} príjemcom? Odoslanie sa nedá vrátiť.`)) return;
      const d = await call(`${M}/campaigns/${c.id}/send`, json('POST', {}), 'Kampaň sa odosiela.');
      if (d) editCampaign(d);
    };
  }

  /* ── Automatické série ────────────────────────────────────── */
  async function renderSequences() {
    const list = (await call(`${M}/sequences`)) || [];
    body().innerHTML = `${banner()}<div class="panel"><div class="panel-header"><div><div class="panel-title">Automatické série</div>
      <div class="panel-subtitle">E-maily, ktoré odídu samy po udalosti – napr. uvítanie po stiahnutí lead magnetu alebo návod po kúpe kurzu</div></div>
      <button class="btn btn-primary btn-sm" id="sq-new">+ Nová séria</button></div>
      ${list.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <tr style="color:#9898b8;text-align:left"><th style="padding:0.4rem">Séria</th><th>Spúšťač</th><th>E-maily</th><th>V sérii / dokončili</th><th></th></tr>
        ${list.map(s => `<tr style="border-top:1px solid rgba(255,255,255,0.06)"><td style="padding:0.5rem 0.4rem"><b>${esc(s.name)}</b> ${s.active ? '' : `<span style="${muted}">(vypnutá)</span>`}</td>
          <td>${TRIGGERS[s.trigger]}${s.triggerRef ? `<div style="${muted}">${esc(refLabel(s.trigger, s.triggerRef))}</div>` : ''}</td><td>${s.steps.length}</td><td>${s.running} / ${s.finished}</td>
          <td style="text-align:right"><button class="btn btn-sm btn-primary" data-open="${esc(s.id)}">Upraviť</button></td></tr>`).join('')}</table>`
        : '<div class="empty-state"><div class="empty-state-icon">⚙️</div><p>Zatiaľ žiadne série.</p></div>'}</div>`;
    document.getElementById('sq-new').onclick = () => editSequence({ name: 'Uvítacia séria', trigger: 'contact_added', triggerRef: null, active: false, steps: [{ delayHours: 0, subject: '', body: '' }] });
    body().querySelectorAll('[data-open]').forEach(b => { b.onclick = () => editSequence(list.find(s => s.id === b.dataset.open)); });
  }
  function refLabel(trigger, ref) {
    if (trigger === 'lead_magnet') return options.leadMagnets.find(l => l.id === ref)?.name || ref;
    if (trigger === 'purchase') return options.products.find(p => p.id === ref)?.title || ref;
    return ref;
  }
  function refField(trigger, ref) {
    if (trigger === 'lead_magnet') return `<select class="form-control" id="sq-ref"><option value="">Ktorýkoľvek lead magnet</option>${options.leadMagnets.map(l => `<option value="${esc(l.id)}" ${l.id === ref ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`;
    if (trigger === 'purchase') return `<select class="form-control" id="sq-ref"><option value="">Ktorýkoľvek produkt</option>${options.products.map(p => `<option value="${esc(p.id)}" ${p.id === ref ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select>`;
    if (trigger === 'tag') return `<input class="form-control" id="sq-ref" placeholder="Štítok" value="${esc(ref || '')}" list="mk-tags2"><datalist id="mk-tags2">${options.tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>`;
    return '';
  }

  function editSequence(s) {
    const steps = s.steps.map(x => ({ ...x }));
    const draw = () => {
      body().innerHTML = `${banner()}<button class="btn btn-sm btn-secondary" id="sq-back" style="margin-bottom:1rem">← Série</button>
        <div class="panel">
        <div class="form-row"><div class="form-group" style="flex:2"><label>Názov</label><input class="form-control" id="sq-name" value="${esc(s.name)}"></div>
          <div class="form-group" style="flex:2"><label>Spustí sa, keď</label><select class="form-control" id="sq-trigger">${Object.entries(TRIGGERS).map(([k, v]) => `<option value="${k}" ${s.trigger === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="form-group" style="flex:2"><label>&nbsp;</label><div id="sq-refbox">${refField(s.trigger, s.triggerRef)}</div></div></div>
        <p style="${muted};margin-bottom:1rem">Do série vstúpia iba kontakty so súhlasom s odberom; odhlásenie ju okamžite zastaví.</p>
        ${steps.map((st, i) => `<div style="padding:0.9rem;border-radius:12px;background:rgba(255,255,255,0.03);margin-bottom:0.75rem" data-step="${i}">
          <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem"><b>E-mail ${i + 1}</b>
            <span style="${muted}">odíde</span><input class="form-control" type="number" min="0" step="1" data-k="delayHours" value="${st.delayHours || 0}" style="width:90px">
            <span style="${muted}">${i === 0 ? 'hodín po spustení' : 'hodín po predchádzajúcom'}</span>
            <button class="btn btn-sm btn-danger" data-rm="${i}" style="margin-left:auto" ${steps.length === 1 ? 'disabled' : ''}>Odobrať</button></div>
          <input class="form-control" data-k="subject" placeholder="Predmet" value="${esc(st.subject)}" style="margin-bottom:0.4rem">
          <textarea class="form-control" data-k="body" rows="5" placeholder="Text e-mailu ({{meno}}, **tučné**, odkazy https://…)">${esc(st.body)}</textarea>
          <div class="form-row" style="margin-top:0.4rem"><input class="form-control" data-k="buttonText" placeholder="Tlačidlo (nepovinné)" value="${esc(st.buttonText || '')}">
            <input class="form-control" data-k="buttonUrl" placeholder="https://" value="${esc(st.buttonUrl || '')}"></div></div>`).join('')}
        <button class="btn btn-secondary btn-sm" id="sq-add" ${steps.length >= 20 ? 'disabled' : ''}>+ Ďalší e-mail</button>
        <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.88rem;margin:1rem 0"><input type="checkbox" id="sq-active" ${s.active ? 'checked' : ''}> Séria je zapnutá</label>
        <button class="btn btn-primary" id="sq-save">Uložiť</button>
        ${s.id ? '<button class="btn btn-danger" id="sq-del" style="float:right">Zmazať</button>' : ''}</div>`;
      const $ = id => document.getElementById(id);
      const collect = () => {
        body().querySelectorAll('[data-step]').forEach(el => {
          const st = steps[+el.dataset.step];
          el.querySelectorAll('[data-k]').forEach(i => { st[i.dataset.k] = i.dataset.k === 'delayHours' ? Number(i.value) || 0 : i.value; });
        });
        s.name = $('sq-name').value; s.trigger = $('sq-trigger').value; s.triggerRef = $('sq-ref') ? $('sq-ref').value || null : null; s.active = $('sq-active').checked;
      };
      $('sq-back').onclick = renderSequences;
      $('sq-trigger').onchange = () => { collect(); s.triggerRef = null; draw(); };
      $('sq-add').onclick = () => { collect(); steps.push({ delayHours: 24, subject: '', body: '' }); draw(); };
      body().querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { collect(); steps.splice(+b.dataset.rm, 1); draw(); }; });
      $('sq-save').onclick = async () => {
        collect();
        const payload = { name: s.name, trigger: s.trigger, triggerRef: s.triggerRef, active: s.active, steps };
        const d = await call(s.id ? `${M}/sequences/${s.id}` : `${M}/sequences`, json(s.id ? 'PUT' : 'POST', payload), 'Séria uložená.');
        if (d) Object.assign(s, d);
      };
      if ($('sq-del')) $('sq-del').onclick = async () => { if (confirm('Zmazať sériu? Rozbehnuté e-maily sa už nepošlú.') && await call(`${M}/sequences/${s.id}`, { method: 'DELETE' }, 'Zmazané.')) renderSequences(); };
    };
    draw();
  }

  /* ── Kontakty ─────────────────────────────────────────────── */
  async function renderContacts(q = '', status = '') {
    const list = (await call(`${M}/contacts?q=${encodeURIComponent(q)}&status=${status}`)) || [];
    const c = overview.counts;
    body().innerHTML = `${banner()}<div class="panel"><div class="panel-header"><div><div class="panel-title">Kontakty</div>
      <div class="panel-subtitle">${c.subscribed || 0} prihlásených · ${c.unsubscribed || 0} odhlásených · ${(c.bounced || 0) + (c.complained || 0)} nedoručiteľných.
        Pribúdajú sami zo súhlasu s novinkami v chatbote, funneloch a pri nákupe.</div></div>
      <a class="btn btn-sm btn-secondary" id="ct-export" href="#">⬇ Export CSV</a></div>
      <div class="form-row" style="margin-bottom:0.75rem"><input class="form-control" id="ct-q" placeholder="Hľadať e-mail alebo meno" value="${esc(q)}">
        <select class="form-control" id="ct-status" style="max-width:200px"><option value="">Všetky stavy</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      ${list.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.84rem">
        <tr style="color:#9898b8;text-align:left"><th style="padding:0.4rem">Kontakt</th><th>Stav</th><th>Zdroj</th><th>Štítky</th><th></th></tr>
        ${list.map(x => `<tr style="border-top:1px solid rgba(255,255,255,0.06)"><td style="padding:0.45rem 0.4rem">${esc(x.name || '—')}<div style="${muted}">${esc(x.email)}</div></td>
          <td>${STATUS[x.status]}</td><td>${esc(options.sources[x.source] || x.source)}</td>
          <td><input class="form-control" data-tags="${esc(x.id)}" value="${esc(x.tags.join(', '))}" style="padding:0.25rem 0.5rem;font-size:0.8rem"></td>
          <td style="text-align:right;white-space:nowrap">${x.status === 'subscribed' ? `<button class="btn btn-sm btn-secondary" data-unsub="${esc(x.id)}">Odhlásiť</button>` : ''}
            <button class="btn btn-sm btn-danger" data-del="${esc(x.id)}" title="Zmazať (GDPR)">✕</button></td></tr>`).join('')}</table>`
        : `<p style="${muted}">Žiadne kontakty.</p>`}</div>
      <div class="panel"><div class="panel-title" style="margin-bottom:0.75rem">Pridať kontakty</div>
        <div class="form-row"><input class="form-control" id="ct-email" type="email" placeholder="e-mail"><input class="form-control" id="ct-name" placeholder="meno"><input class="form-control" id="ct-tags" placeholder="štítky"></div>
        <textarea class="form-control" id="ct-csv" rows="4" placeholder="Alebo vložte zoznam / CSV: e-mail,meno na každý riadok" style="margin-top:0.5rem"></textarea>
        <label style="display:flex;gap:0.5rem;align-items:flex-start;font-size:0.84rem;margin:0.6rem 0"><input type="checkbox" id="ct-consent">
          Potvrdzujem, že tieto osoby výslovne súhlasili so zasielaním noviniek (GDPR). Bez súhlasu kontakty nepridávajte.</label>
        <button class="btn btn-primary" id="ct-add">Pridať</button></div>`;
    const $ = id => document.getElementById(id);
    const reload = () => renderContacts($('ct-q').value, $('ct-status').value);
    $('ct-q').onkeydown = e => { if (e.key === 'Enter') reload(); };
    $('ct-status').onchange = reload;
    $('ct-export').onclick = async e => {
      e.preventDefault();
      const r = await apiFetch(`${M}/contacts/export.csv`);
      if (!r || !r.ok) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = 'kontakty.csv';
      a.click();
    };
    body().querySelectorAll('[data-tags]').forEach(i => { i.onchange = () => call(`${M}/contacts/${i.dataset.tags}`, json('PATCH', { tags: i.value.split(',') }), 'Štítky uložené.'); });
    body().querySelectorAll('[data-unsub]').forEach(b => { b.onclick = async () => { if (await call(`${M}/contacts/${b.dataset.unsub}`, json('PATCH', { status: 'unsubscribed' }), 'Odhlásený.')) reload(); }; });
    body().querySelectorAll('[data-del]').forEach(b => { b.onclick = async () => { if (confirm('Natrvalo zmazať kontakt aj jeho históriu?') && await call(`${M}/contacts/${b.dataset.del}`, { method: 'DELETE' }, 'Zmazané.')) reload(); }; });
    $('ct-add').onclick = async () => {
      const consent = $('ct-consent').checked;
      if (!consent) return showToast('Potvrďte súhlas kontaktov.', 'error');
      if ($('ct-csv').value.trim()) {
        const d = await call(`${M}/contacts/import`, json('POST', { csv: $('ct-csv').value, tags: $('ct-tags').value.split(','), consent }));
        if (d) showToast(`Pridané: ${d.added}, preskočené: ${d.skipped}.`);
      } else if (!(await call(`${M}/contacts`, json('POST', { email: $('ct-email').value, name: $('ct-name').value, tags: $('ct-tags').value, consent }), 'Kontakt pridaný.'))) return;
      overview = await call(`${M}/overview`);
      reload();
    };
  }

  /* ── Nastavenia: odosielateľ a doména ─────────────────────── */
  function renderSettings() {
    const s = overview.settings;
    const verified = s.domainStatus === 'verified';
    body().innerHTML = `${banner()}<div class="panel"><div class="panel-title" style="margin-bottom:0.75rem">Odosielateľ</div>
      <div class="form-row"><div class="form-group" style="flex:1"><label>Meno odosielateľa</label><input class="form-control" id="st-name" maxlength="80" value="${esc(s.fromName)}" placeholder="napr. Štúdio Ema"></div>
        <div class="form-group" style="flex:1"><label>Odpovede chodia na</label><input class="form-control" id="st-reply" type="email" value="${esc(s.replyTo)}"></div></div>
      <div class="form-group"><label>Adresa firmy do pätičky (vyžaduje zákon)</label><input class="form-control" id="st-address" maxlength="300" value="${esc(s.address)}" placeholder="Ulica 1, 811 01 Bratislava"></div>
      <div class="form-group"><label>Adresa odosielateľa na vlastnej doméne</label><div style="display:flex;gap:0.4rem;align-items:center">
        <input class="form-control" id="st-local" value="${esc(s.fromLocal)}" style="max-width:160px"><span>@${esc(s.domain || 'vasa-domena.sk')}</span></div></div>
      <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:1rem"><input type="checkbox" id="st-widget" ${s.widgetOptin ? 'checked' : ''}> Ponúknuť „Chcem dostávať novinky“ vo formulári chatbota</label>
      <button class="btn btn-primary" id="st-save">Uložiť</button></div>
      <div class="panel"><div class="panel-header"><div><div class="panel-title">Vlastná doména ${verified ? '✅' : ''}</div>
        <div class="panel-subtitle">E-maily z vašej domény (napr. info@vasafirma.sk) majú lepšiu doručiteľnosť.${overview.platformDomain ? ` Kým ju neoveríte, posielame z ${esc(overview.platformDomain)} s odpoveďami na váš e-mail.` : ' Bez overenej domény sa nedá posielať.'}</div></div></div>
      ${s.domain ? `<p style="margin-bottom:0.75rem"><b>${esc(s.domain)}</b> · stav: <b>${esc({ verified: 'overená', pending: 'overuje sa', not_started: 'čaká na DNS záznamy', failed: 'overenie zlyhalo', partially_verified: 'čiastočne overená', partially_failed: 'čiastočne zlyhala' }[s.domainStatus] || s.domainStatus)}</b></p>
        <p style="${muted};margin-bottom:0.5rem">Pridajte tieto záznamy v DNS u správcu domény (Websupport, WebHouse, Cloudflare…), potom kliknite na Overiť. Zmena DNS môže trvať až niekoľko hodín.</p>
        <table style="width:100%;border-collapse:collapse;font-size:0.8rem;margin-bottom:0.75rem"><tr style="color:#9898b8;text-align:left"><th style="padding:0.3rem">Typ</th><th>Názov</th><th>Hodnota</th><th>Priorita</th><th>Stav</th></tr>
        ${s.domainRecords.map(r => `<tr style="border-top:1px solid rgba(255,255,255,0.06)"><td style="padding:0.35rem 0.3rem">${esc(r.type)}</td><td><code>${esc(r.name)}</code></td>
          <td><code style="word-break:break-all">${esc(r.value)}</code> <button class="btn btn-sm btn-secondary" data-copy="${esc(r.value)}">Kopírovať</button></td><td>${esc(r.priority ?? '')}</td><td>${r.status === 'verified' ? '✅' : '…'}</td></tr>`).join('')}</table>
        <button class="btn btn-primary" id="dm-verify">Overiť</button> <button class="btn btn-danger" id="dm-del">Odstrániť doménu</button>`
        : `<div style="display:flex;gap:0.5rem"><input class="form-control" id="dm-name" placeholder="vasafirma.sk"><button class="btn btn-primary" id="dm-add">Pridať doménu</button></div>`}</div>`;
    const $ = id => document.getElementById(id);
    $('st-save').onclick = async () => {
      if (await call(`${M}/settings`, json('PUT', { fromName: $('st-name').value, replyTo: $('st-reply').value, address: $('st-address').value, fromLocal: $('st-local').value, widgetOptin: $('st-widget').checked }), 'Uložené.')) loadMarketing();
    };
    body().querySelectorAll('[data-copy]').forEach(b => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => showToast('Skopírované.')); });
    if ($('dm-add')) $('dm-add').onclick = async () => { if (await call(`${M}/domain`, json('POST', { domain: $('dm-name').value }), 'Doména pridaná – nastavte DNS záznamy.')) loadMarketing(); };
    if ($('dm-verify')) $('dm-verify').onclick = async () => {
      const d = await call(`${M}/domain/verify`, { method: 'POST' });
      if (d) { showToast(d.domainStatus === 'verified' ? 'Doména je overená ✓' : 'Ešte nie je overená – DNS sa môže šíriť aj niekoľko hodín.', d.domainStatus === 'verified' ? 'success' : 'error'); loadMarketing(); }
    };
    if ($('dm-del')) $('dm-del').onclick = async () => { if (confirm('Odstrániť doménu?') && await call(`${M}/domain`, { method: 'DELETE' }, 'Odstránené.')) loadMarketing(); };
  }
})();
