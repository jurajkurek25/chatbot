/* Digitálne produkty v dashboarde: produkty (súbory, kurzy, členstvá), objednávky, členovia, nastavenia obchodu.
   Používa apiFetch, esc, showToast a fmtMoney z dashboard.js. */
(function () {
  'use strict';
  const TYPE = { file: 'Súbor na stiahnutie', course: 'Online kurz', membership: 'Členstvo' };
  const ICON = { file: '📎', course: '🎓', membership: '⭐' };
  const CURRENCIES = ['EUR', 'CZK', 'USD', 'GBP', 'PLN', 'HUF', 'CHF'];
  const ORDER_STATUS = { paid: 'Zaplatená', free: 'Zadarmo', refunded: 'Vrátená' };
  const muted = 'color:#7e7ea0;font-size:0.78rem';
  const S = '/api/shop';
  let tab = 'products';
  let settings = null;
  let products = [];
  let editing = null; // celý produkt v editore
  let openLesson = null;

  const body = () => document.getElementById('shop-body');
  const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const size = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`;
  const price = p => p.price > 0 ? `${Number(p.price).toLocaleString('sk-SK', { minimumFractionDigits: 2 })} ${p.currency}` : 'Zadarmo';
  const date = t => new Date(t * 1000).toLocaleDateString('sk-SK');

  async function call(url, opts, ok) {
    const r = await apiFetch(url, opts);
    if (!r) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(d.error || 'Chyba', 'error'); return null; }
    if (ok) showToast(ok);
    return d;
  }

  async function upload(url, field, file, extra = {}) {
    const fd = new FormData();
    fd.append(field, file);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return call(url, { method: 'POST', body: fd }, 'Nahraté.');
  }

  window.loadShop = async function () {
    document.querySelectorAll('[data-shop-tab]').forEach(b => {
      b.classList.toggle('btn-primary', b.dataset.shopTab === tab);
      b.classList.toggle('btn-secondary', b.dataset.shopTab !== tab);
    });
    if (tab !== 'products') editing = null;
    if (tab === 'products') return editing ? renderEditor() : renderProducts();
    if (tab === 'orders') return renderOrders();
    if (tab === 'members') return renderMembers();
    return renderSettings();
  };
  window.shopTab = function (t) { tab = t; editing = null; loadShop(); };

  /* ── Zoznam produktov ───────────────────────────────────────── */
  async function renderProducts() {
    [settings, products] = await Promise.all([call(`${S}/settings`), call(`${S}/products`)]);
    if (!settings || !products) return;
    const paidWithoutStripe = products.some(p => p.price > 0 && p.active) && !settings.payments.ready;
    body().innerHTML = `
      ${paidWithoutStripe ? `<div class="panel" style="border:1px solid rgba(255,180,0,0.4)">⚠️ Platené produkty sa nedajú kúpiť, kým nie je prepojený Stripe.
        <button class="btn btn-sm btn-primary" style="margin-left:0.5rem" onclick="showView('payments')">Prepojiť Stripe</button></div>` : ''}
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title">Produkty</div>
          <div class="panel-subtitle">Súbory na stiahnutie, online kurzy a členstvá · predávajú sa na vlastnej stránke, prístup je v
            <a href="${esc(settings.membersUrl)}" target="_blank" rel="noopener" style="color:#9b8cff">členskej sekcii</a></div></div></div>
        <form id="shop-new" class="form-row" style="align-items:flex-end;gap:0.75rem;margin-bottom:1rem">
          <div class="form-group" style="flex:2;margin:0"><label>Názov nového produktu</label><input class="form-control" id="shop-new-title" required maxlength="150" placeholder="napr. E-book Zdravé raňajky"></div>
          <div class="form-group" style="flex:1;margin:0"><label>Typ</label><select class="form-control" id="shop-new-type">
            ${Object.entries(TYPE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <button class="btn btn-primary" type="submit">+ Vytvoriť</button>
        </form>
        ${products.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.85rem">
          <tr style="color:#9898b8;text-align:left"><th style="padding:0.4rem">Produkt</th><th>Cena</th><th>Predaje</th><th>Tržby</th><th></th></tr>
          ${products.map(p => `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
            <td style="padding:0.55rem 0.4rem">${ICON[p.type]} <b>${esc(p.title)}</b>${p.active ? '' : ' <span style="' + muted + '">(skrytý)</span>'}
              <div style="${muted}">${TYPE[p.type]} · ${p.file_count} súborov${p.type !== 'file' ? ` · ${p.lesson_count} lekcií` : ''}</div></td>
            <td>${price(p)}</td><td>${p.sales}</td><td>${fmtMoney(p.revenue, p.currency)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-sm btn-secondary" data-copy="${esc(p.url)}">Kopírovať odkaz</button>
              <a class="btn btn-sm btn-secondary" href="${esc(p.url)}" target="_blank" rel="noopener">Zobraziť</a>
              <button class="btn btn-sm btn-primary" data-edit="${esc(p.id)}">Upraviť</button></td></tr>`).join('')}
        </table>` : '<div class="empty-state"><div class="empty-state-icon">📦</div><p>Zatiaľ žiadne produkty. Vytvorte prvý – napr. e-book alebo kurz.</p></div>'}
      </div>`;
    document.getElementById('shop-new').onsubmit = async e => {
      e.preventDefault();
      const d = await call(`${S}/products`, json('POST', { title: document.getElementById('shop-new-title').value, type: document.getElementById('shop-new-type').value }));
      if (d) openEditor(d.id);
    };
    body().querySelectorAll('[data-edit]').forEach(b => { b.onclick = () => openEditor(b.dataset.edit); });
    body().querySelectorAll('[data-copy]').forEach(b => {
      b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => showToast('Odkaz skopírovaný.'));
    });
  }

  async function openEditor(id) {
    const p = await call(`${S}/products/${id}`);
    if (!p) return;
    editing = p;
    renderEditor();
  }
  async function reload() { await openEditor(editing.id); }

  /* ── Editor produktu ────────────────────────────────────────── */
  function filesTable(files) {
    return files.length ? `<table style="width:100%;font-size:0.84rem;margin-bottom:0.5rem">${files.map(f => `
      <tr><td style="padding:0.3rem 0">📎 ${esc(f.original_name)} <span style="${muted}">${size(f.size)}</span></td>
      <td style="text-align:right"><button class="btn btn-sm btn-danger" data-del-file="${esc(f.id)}">Zmazať</button></td></tr>`).join('')}</table>`
      : `<div style="${muted};margin-bottom:0.5rem">Zatiaľ žiadne súbory.</div>`;
  }

  function lessonEditor(l) {
    return `<div style="padding:0.75rem;margin:0.4rem 0 0.75rem;border-radius:10px;background:rgba(255,255,255,0.03)">
      <div class="form-group"><label>Názov lekcie</label><input class="form-control" id="ls-title" maxlength="150" value="${esc(l.title)}"></div>
      <div class="form-group"><label>Video (YouTube, Vimeo, Loom, Wistia, Bunny, Google Drive – odkaz https://)</label>
        <input class="form-control" id="ls-video" maxlength="500" value="${esc(l.video_url || '')}" placeholder="https://vimeo.com/...">
        ${l.video_url && !l.embeddable ? `<div style="${muted}">Toto video sa nedá vložiť do stránky – členovia dostanú tlačidlo s odkazom.</div>` : ''}</div>
      <div class="form-group"><label>Text lekcie</label><textarea class="form-control" id="ls-content" rows="6" maxlength="50000">${esc(l.content || '')}</textarea></div>
      <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;margin-bottom:0.75rem"><input type="checkbox" id="ls-preview" ${l.free_preview ? 'checked' : ''}> Ukážka zadarmo (vidno ju na predajnej stránke)</label>
      <div class="form-group"><label>Súbory k lekcii</label>${filesTable(l.files)}
        <input type="file" data-upload-lesson="${esc(l.id)}"></div>
      <button class="btn btn-sm btn-primary" data-save-lesson="${esc(l.id)}">Uložiť lekciu</button>
      <button class="btn btn-sm btn-danger" data-del-lesson="${esc(l.id)}">Zmazať lekciu</button>
    </div>`;
  }

  function curriculumPanel(p) {
    return `<div class="panel"><div class="panel-header"><div><div class="panel-title">Obsah kurzu</div>
      <div class="panel-subtitle">Moduly a lekcie s videom, textom a súbormi · členovia si značia hotové lekcie</div></div></div>
      ${p.modules.map((m, mi) => `<div style="margin-bottom:1rem;padding-bottom:0.75rem;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.4rem">
          <input class="form-control" style="font-weight:700" data-module-title="${esc(m.id)}" value="${esc(m.title)}" maxlength="150">
          <button class="btn btn-sm btn-secondary" data-move-module="${mi}" data-dir="-1" ${mi === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-sm btn-secondary" data-move-module="${mi}" data-dir="1" ${mi === p.modules.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-sm btn-danger" data-del-module="${esc(m.id)}">Zmazať</button></div>
        ${m.lessons.map((l, li) => `<div>
          <div style="display:flex;gap:0.5rem;align-items:center;padding:0.3rem 0 0.3rem 0.75rem;font-size:0.88rem">
            <span style="flex:1">${l.video_url ? '🎬' : '📄'} ${esc(l.title)}${l.free_preview ? ` <span style="${muted}">· ukážka</span>` : ''}${l.files.length ? ` <span style="${muted}">· ${l.files.length} súb.</span>` : ''}</span>
            <button class="btn btn-sm btn-secondary" data-move-lesson="${mi}:${li}" data-dir="-1" ${li === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-sm btn-secondary" data-move-lesson="${mi}:${li}" data-dir="1" ${li === m.lessons.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-sm ${openLesson === l.id ? 'btn-primary' : 'btn-secondary'}" data-open-lesson="${esc(l.id)}">${openLesson === l.id ? 'Zavrieť' : 'Upraviť'}</button></div>
          ${openLesson === l.id ? lessonEditor(l) : ''}</div>`).join('')}
        <button class="btn btn-sm btn-secondary" style="margin-left:0.75rem" data-add-lesson="${esc(m.id)}">+ Lekcia</button>
      </div>`).join('')}
      <button class="btn btn-secondary" id="add-module">+ Modul</button></div>`;
  }

  function renderEditor() {
    const p = editing;
    const others = products.filter(x => x.id !== p.id && x.type !== 'membership');
    body().innerHTML = `
      <button class="btn btn-sm btn-secondary" id="shop-back" style="margin-bottom:1rem">← Všetky produkty</button>
      <div class="panel">
        <div class="panel-header"><div><div class="panel-title">${ICON[p.type]} ${esc(p.title)}</div>
          <div class="panel-subtitle"><a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:#9b8cff">${esc(p.url)}</a></div></div></div>
        <div class="form-row">
          <div class="form-group" style="flex:2"><label>Názov</label><input class="form-control" id="pe-title" maxlength="150" value="${esc(p.title)}"></div>
          <div class="form-group" style="flex:1"><label>Typ</label><select class="form-control" id="pe-type">
            ${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <div class="form-group"><label>Podnadpis</label><input class="form-control" id="pe-subtitle" maxlength="250" value="${esc(p.subtitle || '')}"></div>
        <div class="form-row">
          <div class="form-group" style="flex:1"><label>Cena (prázdne = zadarmo)</label><input class="form-control" id="pe-price" type="number" min="0" step="0.01" value="${p.price ?? ''}"></div>
          <div class="form-group" style="flex:1"><label>Mena</label><select class="form-control" id="pe-currency">
            ${CURRENCIES.map(c => `<option ${p.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="form-group" style="flex:1"><label>Prístup na dní (0 = navždy)</label><input class="form-control" id="pe-days" type="number" min="0" max="3650" value="${p.access_days || 0}"></div>
        </div>
        <div class="form-group"><label>Popis na predajnej stránke</label><textarea class="form-control" id="pe-desc" rows="7" maxlength="20000">${esc(p.description || '')}</textarea></div>
        <div class="form-group"><label>Poďakovanie v e-maile po nákupe (nepovinné)</label><textarea class="form-control" id="pe-thanks" rows="3" maxlength="2000">${esc(p.thank_you || '')}</textarea></div>
        ${p.type === 'membership' ? `<div class="form-group"><label>Členstvo odomkne</label>
          ${others.length ? others.map(o => `<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.88rem;margin:0.25rem 0">
            <input type="checkbox" data-include="${esc(o.id)}" ${p.includes.includes(o.id) ? 'checked' : ''}> ${ICON[o.type]} ${esc(o.title)}</label>`).join('')
            : `<div style="${muted}">Najprv vytvorte súbory alebo kurzy, ktoré má členstvo obsahovať.</div>`}</div>` : ''}
        <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.88rem;margin-bottom:1rem"><input type="checkbox" id="pe-active" ${p.active ? 'checked' : ''}> Predáva sa (inak je stránka skrytá, kúpené prístupy zostávajú)</label>
        <button class="btn btn-primary" id="pe-save">Uložiť</button>
        <button class="btn btn-danger" id="pe-delete" style="float:right">Zmazať produkt</button>
      </div>
      <div class="panel"><div class="panel-header"><div><div class="panel-title">Obrázok</div><div class="panel-subtitle">Na predajnej stránke a v členskej sekcii · pomer 16 : 9, JPG/PNG/WebP do 5 MB</div></div></div>
        ${p.cover_url ? `<img src="${esc(p.cover_url)}" alt="" style="max-width:320px;width:100%;border-radius:10px;display:block;margin-bottom:0.75rem">` : ''}
        <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" id="pe-cover"></div>
      <div class="panel"><div class="panel-header"><div><div class="panel-title">${p.type === 'file' ? 'Súbory na stiahnutie' : 'Materiály na stiahnutie'}</div>
        <div class="panel-subtitle">Kupujúci ich dostane e-mailom a nájde v členskej sekcii · do 500 MB na súbor</div></div></div>
        ${filesTable(p.files)}<input type="file" id="pe-file"></div>
      ${p.type !== 'file' ? curriculumPanel(p) : ''}`;
    bindEditor();
  }

  function bindEditor() {
    const p = editing;
    const $ = id => document.getElementById(id);
    $('shop-back').onclick = () => { editing = null; openLesson = null; renderProducts(); };
    $('pe-save').onclick = async () => {
      const includes = [...body().querySelectorAll('[data-include]')].filter(c => c.checked).map(c => c.dataset.include);
      const d = await call(`${S}/products/${p.id}`, json('PUT', {
        title: $('pe-title').value, type: $('pe-type').value, subtitle: $('pe-subtitle').value, price: $('pe-price').value,
        currency: $('pe-currency').value, accessDays: $('pe-days').value, description: $('pe-desc').value,
        thankYou: $('pe-thanks').value, active: $('pe-active').checked, includes,
      }), 'Produkt uložený.');
      if (d) { editing = d; products = (await call(`${S}/products`)) || products; renderEditor(); }
    };
    $('pe-delete').onclick = async () => {
      if (!confirm(`Zmazať produkt „${p.title}“ aj so súbormi? Kupujúci k nemu stratia prístup.`)) return;
      if (await call(`${S}/products/${p.id}`, { method: 'DELETE' }, 'Produkt zmazaný.')) { editing = null; renderProducts(); }
    };
    $('pe-cover').onchange = async e => { if (e.target.files[0] && await upload(`${S}/products/${p.id}/cover`, 'cover', e.target.files[0])) reload(); };
    $('pe-file').onchange = async e => {
      if (!e.target.files[0]) return;
      e.target.disabled = true;
      showToast('Nahrávam…');
      if (await upload(`${S}/products/${p.id}/files`, 'file', e.target.files[0])) reload(); else e.target.disabled = false;
    };
    body().querySelectorAll('[data-upload-lesson]').forEach(inp => {
      inp.onchange = async () => {
        if (!inp.files[0]) return;
        inp.disabled = true;
        showToast('Nahrávam…');
        if (await upload(`${S}/products/${p.id}/files`, 'file', inp.files[0], { lessonId: inp.dataset.uploadLesson })) reload(); else inp.disabled = false;
      };
    });
    body().querySelectorAll('[data-del-file]').forEach(b => {
      b.onclick = async () => { if (confirm('Zmazať súbor?') && await call(`${S}/files/${b.dataset.delFile}`, { method: 'DELETE' }, 'Súbor zmazaný.')) reload(); };
    });
    if (p.type === 'file') return;
    $('add-module').onclick = async () => { if (await call(`${S}/products/${p.id}/modules`, json('POST', { title: `Modul ${p.modules.length + 1}` }))) reload(); };
    body().querySelectorAll('[data-module-title]').forEach(inp => {
      inp.onchange = () => call(`${S}/modules/${inp.dataset.moduleTitle}`, json('PUT', { title: inp.value }), 'Modul premenovaný.');
    });
    body().querySelectorAll('[data-del-module]').forEach(b => {
      b.onclick = async () => { if (confirm('Zmazať modul aj s lekciami a ich súbormi?') && await call(`${S}/modules/${b.dataset.delModule}`, { method: 'DELETE' }, 'Modul zmazaný.')) reload(); };
    });
    body().querySelectorAll('[data-add-lesson]').forEach(b => {
      b.onclick = async () => {
        const d = await call(`${S}/modules/${b.dataset.addLesson}/lessons`, json('POST', { title: 'Nová lekcia' }));
        if (d) { openLesson = d.id; reload(); }
      };
    });
    body().querySelectorAll('[data-open-lesson]').forEach(b => {
      b.onclick = () => { openLesson = openLesson === b.dataset.openLesson ? null : b.dataset.openLesson; renderEditor(); };
    });
    body().querySelectorAll('[data-save-lesson]').forEach(b => {
      b.onclick = async () => {
        if (await call(`${S}/lessons/${b.dataset.saveLesson}`, json('PUT', {
          title: $('ls-title').value, videoUrl: $('ls-video').value, content: $('ls-content').value, freePreview: $('ls-preview').checked,
        }), 'Lekcia uložená.')) reload();
      };
    });
    body().querySelectorAll('[data-del-lesson]').forEach(b => {
      b.onclick = async () => {
        if (confirm('Zmazať lekciu aj s jej súbormi?') && await call(`${S}/lessons/${b.dataset.delLesson}`, { method: 'DELETE' }, 'Lekcia zmazaná.')) { openLesson = null; reload(); }
      };
    });
    // Poradie: presun o jedno miesto hore/dole, potom uloženie celej osnovy
    const order = () => p.modules.map(m => ({ id: m.id, lessons: m.lessons.map(l => l.id) }));
    const swap = (arr, i, j) => { [arr[i], arr[j]] = [arr[j], arr[i]]; };
    const saveOrder = async o => { if (await call(`${S}/products/${p.id}/curriculum`, json('PUT', { modules: o }))) reload(); };
    body().querySelectorAll('[data-move-module]').forEach(b => {
      b.onclick = () => { const o = order(); const i = +b.dataset.moveModule; swap(o, i, i + +b.dataset.dir); saveOrder(o); };
    });
    body().querySelectorAll('[data-move-lesson]').forEach(b => {
      b.onclick = () => { const o = order(); const [mi, li] = b.dataset.moveLesson.split(':').map(Number); swap(o[mi].lessons, li, li + +b.dataset.dir); saveOrder(o); };
    });
  }

  /* ── Objednávky ─────────────────────────────────────────────── */
  async function renderOrders() {
    const orders = await call(`${S}/orders`);
    if (!orders) return;
    body().innerHTML = `<div class="panel"><div class="panel-header"><div><div class="panel-title">Objednávky</div>
      <div class="panel-subtitle">Posledných 200 · faktúry a výplaty nájdete v Stripe</div></div></div>
      ${orders.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.84rem">
        <tr style="color:#9898b8;text-align:left"><th style="padding:0.4rem">Dátum</th><th>Zákazník</th><th>Produkt</th><th>Suma</th><th>Stav</th><th></th></tr>
        ${orders.map(o => `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
          <td style="padding:0.5rem 0.4rem">${date(o.paid_at || o.created_at)}</td>
          <td>${esc(o.name)}<div style="${muted}">${esc(o.email)}</div></td>
          <td>${esc(o.product_title)}</td>
          <td style="font-weight:700">${o.amount ? fmtMoney(o.amount, o.currency) : '—'}${o.amount_refunded ? `<div style="color:#ff4060;font-size:0.75rem">−${fmtMoney(o.amount_refunded, o.currency)}</div>` : ''}</td>
          <td>${ORDER_STATUS[o.status] || esc(o.status)}</td>
          <td style="text-align:right">${o.status === 'paid' ? `<button class="btn btn-sm btn-danger" data-refund="${esc(o.id)}">Vrátiť peniaze</button>` : ''}</td></tr>`).join('')}
      </table>` : '<div style="color:#7e7ea0;font-size:0.875rem">Zatiaľ žiadne objednávky.</div>'}</div>`;
    body().querySelectorAll('[data-refund]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Vrátiť celú sumu cez Stripe? Zákazník stratí prístup k produktu.')) return;
        b.disabled = true;
        if (await call(`${S}/orders/${b.dataset.refund}/refund`, { method: 'POST' }, 'Peniaze vrátené.')) renderOrders(); else b.disabled = false;
      };
    });
  }

  /* ── Členovia ───────────────────────────────────────────────── */
  async function renderMembers() {
    const [members, list] = await Promise.all([call(`${S}/members`), call(`${S}/products`)]);
    if (!members || !list) return;
    const now = Date.now() / 1000;
    body().innerHTML = `<div class="panel"><div class="panel-header"><div><div class="panel-title">Pridať prístup ručne</div>
        <div class="panel-subtitle">Darček, platba prevodom… · zákazník dostane e-mail s prístupom</div></div></div>
      <form id="grant" class="form-row" style="align-items:flex-end;gap:0.75rem">
        <div class="form-group" style="flex:2;margin:0"><label>E-mail</label><input class="form-control" type="email" id="g-email" required></div>
        <div class="form-group" style="flex:2;margin:0"><label>Meno</label><input class="form-control" id="g-name" maxlength="120"></div>
        <div class="form-group" style="flex:2;margin:0"><label>Produkt</label><select class="form-control" id="g-product" required>
          ${list.map(p => `<option value="${esc(p.id)}">${ICON[p.type]} ${esc(p.title)}</option>`).join('')}</select></div>
        <button class="btn btn-primary" type="submit" ${list.length ? '' : 'disabled'}>Pridať</button></form></div>
      <div class="panel"><div class="panel-header"><div><div class="panel-title">Členovia</div><div class="panel-subtitle">${members.length} zákazníkov s účtom v členskej sekcii</div></div></div>
      ${members.length ? `<table style="width:100%;border-collapse:collapse;font-size:0.84rem">
        <tr style="color:#9898b8;text-align:left"><th style="padding:0.4rem">Člen</th><th>Prístupy</th><th>Posledné prihlásenie</th></tr>
        ${members.map(m => `<tr style="border-top:1px solid rgba(255,255,255,0.06);vertical-align:top">
          <td style="padding:0.5rem 0.4rem">${esc(m.name || '—')}<div style="${muted}">${esc(m.email)}</div></td>
          <td>${m.access.map(a => {
            const off = a.revoked || (a.expires_at && a.expires_at < now);
            return `<div style="${off ? 'opacity:0.5;text-decoration:line-through' : ''}">${esc(a.title)}${a.expires_at ? ` <span style="${muted}">do ${date(a.expires_at)}</span>` : ''}
              ${off ? '' : `<button class="btn btn-sm btn-secondary" style="padding:0 0.4rem" title="Odobrať prístup" data-revoke="${esc(m.id)}:${esc(a.product_id)}">×</button>`}</div>`;
          }).join('') || '—'}</td>
          <td>${m.last_login_at ? date(m.last_login_at) : '—'}</td></tr>`).join('')}
      </table>` : '<div style="color:#7e7ea0;font-size:0.875rem">Zatiaľ žiadni členovia.</div>'}</div>`;
    document.getElementById('grant').onsubmit = async e => {
      e.preventDefault();
      if (await call(`${S}/members`, json('POST', { email: document.getElementById('g-email').value, name: document.getElementById('g-name').value, productId: document.getElementById('g-product').value }), 'Prístup pridaný a odoslaný e-mailom.')) renderMembers();
    };
    body().querySelectorAll('[data-revoke]').forEach(b => {
      b.onclick = async () => {
        const [mid, pid] = b.dataset.revoke.split(':');
        if (confirm('Odobrať členovi prístup k produktu?') && await call(`${S}/members/${mid}/access/${pid}`, { method: 'DELETE' }, 'Prístup odobraný.')) renderMembers();
      };
    });
  }

  /* ── Nastavenia obchodu ─────────────────────────────────────── */
  async function renderSettings() {
    const s = await call(`${S}/settings`);
    if (!s) return;
    body().innerHTML = `<div class="panel"><div class="panel-header"><div><div class="panel-title">Obchod</div>
        <div class="panel-subtitle">Vzhľad predajných stránok, členskej sekcie a e-mailov kupujúcim</div></div></div>
      <div class="form-row">
        <div class="form-group" style="flex:2"><label>Názov obchodu</label><input class="form-control" id="st-name" maxlength="100" value="${esc(s.storeName)}" placeholder="${esc(s.name)}"></div>
        <div class="form-group" style="flex:1"><label>Farba</label><input class="form-control" type="color" id="st-color" value="${esc(s.color)}" style="height:42px;padding:4px"></div>
      </div>
      <div class="form-group"><label>E-mail pre otázky zákazníkov (odpovede na e-maily)</label><input class="form-control" type="email" id="st-email" value="${esc(s.supportEmail)}"></div>
      <div class="form-group"><label>Členská sekcia</label><div style="display:flex;gap:0.5rem">
        <input class="form-control" readonly value="${esc(s.membersUrl)}"><button class="btn btn-secondary" id="st-copy">Kopírovať</button></div></div>
      <div class="form-group"><label>Vlastné CSS (nepovinné)</label><textarea class="form-control" id="st-css" rows="5" maxlength="20000" style="font-family:monospace;font-size:0.8rem">${esc(s.customCss)}</textarea></div>
      <button class="btn btn-primary" id="st-save">Uložiť</button></div>`;
    document.getElementById('st-copy').onclick = () => navigator.clipboard.writeText(s.membersUrl).then(() => showToast('Odkaz skopírovaný.'));
    document.getElementById('st-save').onclick = () => call(`${S}/settings`, json('PUT', {
      storeName: document.getElementById('st-name').value, color: document.getElementById('st-color').value,
      supportEmail: document.getElementById('st-email').value, customCss: document.getElementById('st-css').value,
    }), 'Nastavenia uložené.');
  }
})();
