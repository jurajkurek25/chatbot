/* Pošta (podľa Roundcube): webmail pre schránky na vlastnom mail serveri + správa domén a schránok (majiteľ).
   E-mail → úloha, prílohy → Disk, prílohy z Disku do správy. Používa NW.suite, esc, showToast, apiFetch. */
(function () {
  'use strict';
  const M = '/api/mail';
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;
  let boxes = [], cfg = null, cur = { box: null, folder: 'INBOX', page: 1, q: '', uid: null };
  let messages = { total: 0, items: [] };
  let open = null; // otvorená správa

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.mail = { title: 'Pošta', load };

  const fmtAddr = list => (list || []).map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
  const who = list => (list && list[0] ? list[0].name || list[0].address : '');
  const when = d => {
    const t = new Date(d), now = new Date();
    return t.toDateString() === now.toDateString() ? t.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric', year: t.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
  };
  const size = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
  const q = params => { const p = new URLSearchParams(params).toString(); return p ? `?${p}` : ''; };

  async function load() {
    const s = su();
    cfg = cfg || await s.api('GET', `${M}/config`);
    boxes = (await s.api('GET', `${M}/mailboxes`)) || [];
    const readable = boxes.filter(b => b.canRead);
    const settings = s.takeOpen('settings') || (!readable.length && s.role === 'owner');
    if (settings) return admin();
    if (!readable.length) {
      $('mail-body').innerHTML = `<div class="empty-state"><div class="empty-state-icon">✉️</div><p>Nemáte pridelenú žiadnu schránku. Požiadajte majiteľa priestoru o e-mailovú adresu.</p></div>`;
      return;
    }
    if (!cur.box || !readable.some(b => b.id === cur.box)) cur.box = readable[0].id;
    $('mail-body').innerHTML = `<div class="nw-mail" style="display:grid;grid-template-columns:220px minmax(260px,380px) minmax(0,1fr);gap:0.8rem;height:calc(100vh - 130px);min-height:480px">
      <aside class="panel" style="margin:0;padding:0.7rem;overflow:auto">
        <select class="form-control" id="ml-box" style="margin-bottom:0.6rem;font-size:0.85rem">${readable.map(b => `<option value="${esc(b.id)}" ${b.id === cur.box ? 'selected' : ''}>${b.shared ? '👥' : '👤'} ${esc(b.address)}</option>`).join('')}</select>
        <button class="btn btn-primary" id="ml-new" style="width:100%;margin-bottom:0.6rem">✏️ Napísať</button>
        <div id="ml-folders"></div>
        <div style="margin-top:1rem;display:flex;flex-direction:column;gap:0.3rem">
          <button class="btn btn-sm btn-secondary" id="ml-setup">📱 Nastaviť v telefóne</button>
          ${s.role === 'owner' ? '<button class="btn btn-sm btn-secondary" id="ml-admin">⚙ Domény a schránky</button>' : ''}</div>
      </aside>
      <section class="panel" style="margin:0;padding:0;display:flex;flex-direction:column;min-height:0">
        <div style="padding:0.6rem;border-bottom:1px solid rgba(255,255,255,0.08)"><input class="form-control" id="ml-q" placeholder="🔍 Hľadať v pošte" value="${esc(cur.q)}" style="font-size:0.85rem"></div>
        <div id="ml-list" style="flex:1;overflow:auto"></div>
      </section>
      <section class="panel" id="ml-read" style="margin:0;padding:0;display:flex;flex-direction:column;min-height:0;overflow:hidden"></section></div>
      <style>@media (max-width:1000px){.nw-mail{grid-template-columns:1fr !important;height:auto !important}.nw-mail > section{min-height:360px}}
        .ml-row{display:block;padding:0.55rem 0.75rem;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;color:#c4c4dc}
        .ml-row:hover{background:rgba(255,255,255,0.03)} .ml-row.on{background:rgba(91,79,255,0.16)} .ml-row.unread{color:#eeeef5}
        .ml-row.unread .ml-s{font-weight:700}</style>`;
    $('ml-box').onchange = e => { cur = { box: e.target.value, folder: 'INBOX', page: 1, q: '', uid: null }; load(); };
    $('ml-new').onclick = () => compose();
    $('ml-setup').onclick = setupHelp;
    if ($('ml-admin')) $('ml-admin').onclick = admin;
    let t;
    $('ml-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { cur.q = e.target.value.trim(); cur.page = 1; list(); }, 350); };
    reader();
    folders();
    list();
  }

  async function folders() {
    const f = (await su().api('GET', `${M}/mailboxes/${cur.box}/folders`)) || [];
    const icon = { '\\Inbox': '📥', '\\Sent': '📤', '\\Drafts': '📝', '\\Trash': '🗑', '\\Junk': '⚠️', '\\Archive': '📦' };
    if (!$('ml-folders')) return;
    $('ml-folders').innerHTML = f.map(x => `<button class="nav-item ${x.path === cur.folder ? 'active' : ''}" data-f="${esc(x.path)}" style="width:100%;font-size:0.86rem">
      <span>${icon[x.special] || '📁'}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name)}</span>${x.unseen ? `<span style="margin-left:auto;background:#5b4fff;color:#fff;border-radius:10px;font-size:0.7rem;padding:0 6px;font-weight:700">${x.unseen}</span>` : ''}</button>`).join('');
    $('ml-folders').querySelectorAll('[data-f]').forEach(b => { b.onclick = () => { cur.folder = b.dataset.f; cur.page = 1; cur.uid = null; folders(); list(); reader(); }; });
    window._mailFolders = f;
  }

  async function list() {
    const s = su();
    $('ml-list').innerHTML = `<p style="${s.muted};padding:1rem">Načítavam…</p>`;
    messages = (await s.api('GET', `${M}/mailboxes/${cur.box}/messages${q({ folder: cur.folder, page: cur.page, q: cur.q })}`)) || { total: 0, items: [] };
    const pages = Math.ceil(messages.total / 40);
    $('ml-list').innerHTML = (messages.items.map(m => `<a class="ml-row ${m.seen ? '' : 'unread'} ${m.uid === cur.uid ? 'on' : ''}" data-uid="${m.uid}">
        <div style="display:flex;gap:0.4rem;font-size:0.84rem"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.seen ? '' : '● '}${esc(cur.folder.match(/sent|odosl/i) ? `→ ${who(m.to)}` : who(m.from))}</span><span style="${s.muted}">${m.flagged ? '⭐ ' : ''}${m.attachments ? '📎 ' : ''}${when(m.date)}</span></div>
        <div class="ml-s" style="font-size:0.86rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.subject)}</div></a>`).join('')
      || `<div class="empty-state"><div class="empty-state-icon">📭</div><p>${cur.q ? 'Nič sa nenašlo.' : 'Žiadne správy.'}</p></div>`)
      + (pages > 1 ? `<div style="display:flex;gap:0.4rem;justify-content:center;padding:0.6rem"><button class="btn btn-sm btn-secondary" id="ml-prev" ${cur.page <= 1 ? 'disabled' : ''}>←</button><span style="${s.muted}">${cur.page} / ${pages}</span><button class="btn btn-sm btn-secondary" id="ml-next" ${cur.page >= pages ? 'disabled' : ''}>→</button></div>` : '');
    $('ml-list').querySelectorAll('[data-uid]').forEach(a => { a.onclick = () => read(Number(a.dataset.uid)); });
    if ($('ml-prev')) $('ml-prev').onclick = () => { cur.page--; list(); };
    if ($('ml-next')) $('ml-next').onclick = () => { cur.page++; list(); };
  }

  function reader(html) {
    $('ml-read').innerHTML = html || `<div class="empty-state" style="margin:auto"><div class="empty-state-icon">✉️</div><p>Vyberte správu.</p></div>`;
  }

  async function read(uid, images) {
    const s = su();
    cur.uid = uid;
    document.querySelectorAll('#ml-list [data-uid]').forEach(a => { a.classList.toggle('on', Number(a.dataset.uid) === uid); if (Number(a.dataset.uid) === uid) a.classList.remove('unread'); });
    reader(`<p style="${s.muted};padding:1rem">Načítavam…</p>`);
    const m = await s.api('GET', `${M}/mailboxes/${cur.box}/messages/${uid}${q({ folder: cur.folder, images: images ? 1 : '' })}`);
    if (!m) return reader();
    open = m;
    const others = (window._mailFolders || []).filter(f => f.path !== cur.folder);
    reader(`<div style="padding:0.8rem 1rem;border-bottom:1px solid rgba(255,255,255,0.08)">
        <div style="font-size:1.05rem;font-weight:700;margin-bottom:0.35rem">${esc(m.subject)}</div>
        <div style="font-size:0.84rem"><strong>${esc(who(m.from))}</strong> <span style="${s.muted}">&lt;${esc(m.from[0]?.address || '')}&gt; · ${esc(new Date(m.date).toLocaleString('sk-SK'))}</span></div>
        <div style="${s.muted}">Komu: ${esc(fmtAddr(m.to))}${m.cc.length ? ` · Kópia: ${esc(fmtAddr(m.cc))}` : ''}</div>
        <div style="display:flex;gap:0.3rem;flex-wrap:wrap;margin-top:0.55rem">
          <button class="btn btn-sm btn-primary" data-a="reply">↩ Odpovedať</button><button class="btn btn-sm btn-secondary" data-a="all">↩↩ Všetkým</button><button class="btn btn-sm btn-secondary" data-a="fwd">↪ Preposlať</button>
          ${s.canWrite ? '<button class="btn btn-sm btn-secondary" data-a="task" title="Vytvoriť úlohu z e-mailu">✅ Úloha</button>' : ''}
          <button class="btn btn-sm btn-secondary" data-a="flag">${m.flagged ? '★' : '☆'}</button>
          <select class="form-control" data-a="move" style="width:auto;font-size:0.8rem;padding:0.2rem 0.4rem"><option value="">Presunúť…</option>${others.map(f => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('')}</select>
          <button class="btn btn-sm btn-danger" data-a="del">🗑</button></div>
        ${m.attachments.length ? `<div style="display:flex;gap:0.35rem;flex-wrap:wrap;margin-top:0.55rem">${m.attachments.map(a => `<span style="display:inline-flex;gap:0.3rem;align-items:center;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:0.2rem 0.45rem;font-size:0.8rem">📎 <a href="#" data-dl="${a.idx}" style="color:#c4bcff">${esc(a.filename)}</a> <span style="${s.muted}">${size(a.size)}</span>${s.canWrite ? `<button class="btn btn-sm btn-secondary" data-drive="${a.idx}" style="padding:0 0.35rem" title="Uložiť na Disk">💾</button>` : ''}</span>`).join('')}</div>` : ''}
        ${m.blockedImages ? `<div style="margin-top:0.5rem;font-size:0.8rem;color:#f59e0b">🛡 ${m.blockedImages} obrázkov zo siete sme zablokovali (ochrana pred sledovaním). <a href="#" id="ml-img" style="color:#c4bcff">Zobraziť</a></div>` : ''}</div>
      <iframe id="ml-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" style="flex:1;border:0;background:#fff;width:100%"></iframe>`);
    const frame = $('ml-frame');
    frame.srcdoc = m.html ? `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111;margin:14px;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${m.html}</body></html>`
      : `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;margin:14px"><pre style="white-space:pre-wrap;font-family:inherit">${esc(m.text)}</pre></body></html>`;
    if ($('ml-img')) $('ml-img').onclick = e => { e.preventDefault(); read(uid, true); };
    const act = (sel, fn) => document.querySelectorAll(`#ml-read [data-a="${sel}"]`).forEach(b => { b[sel === 'move' ? 'onchange' : 'onclick'] = fn; });
    act('reply', () => compose({ mode: 'reply', m }));
    act('all', () => compose({ mode: 'all', m }));
    act('fwd', () => compose({ mode: 'fwd', m }));
    act('task', async () => { const t = await s.api('POST', `${M}/mailboxes/${cur.box}/messages/${uid}/to-task`, { folder: cur.folder }, 'Úloha vytvorená v projekte Doručené.'); if (t) s.modal('✅ Úloha z e-mailu', `<p style="margin-bottom:0.8rem">${esc(t.title)}</p><button class="btn btn-primary" data-go>Otvoriť úlohu</button>`, el => { el.querySelector('[data-go]').onclick = () => s.go(`/dashboard?view=tasks&task=${t.id}&ws=${s.ws}`); }); });
    act('flag', async () => { if (await s.api('POST', `${M}/mailboxes/${cur.box}/flag`, { folder: cur.folder, uids: [uid], flagged: !m.flagged })) { read(uid); list(); } });
    act('move', async e => { if (e.target.value && await s.api('POST', `${M}/mailboxes/${cur.box}/move`, { folder: cur.folder, uids: [uid], target: e.target.value }, 'Presunuté.')) { cur.uid = null; reader(); list(); folders(); } });
    act('del', async () => { if (await s.api('POST', `${M}/mailboxes/${cur.box}/delete`, { folder: cur.folder, uids: [uid] }, 'Zmazané.')) { cur.uid = null; reader(); list(); folders(); } });
    document.querySelectorAll('#ml-read [data-dl]').forEach(a => {
      a.onclick = async e => {
        e.preventDefault();
        const r = await apiFetch(s.url(`${M}/mailboxes/${cur.box}/messages/${uid}/attachments/${a.dataset.dl}`, { folder: cur.folder }));
        if (!r || !r.ok) return showToast('Príloha sa nedá stiahnuť.', 'error');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(await r.blob());
        link.download = m.attachments[Number(a.dataset.dl)].filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1500);
      };
    });
    document.querySelectorAll('#ml-read [data-drive]').forEach(b => { b.onclick = () => s.api('POST', `${M}/mailboxes/${cur.box}/messages/${uid}/attachments/${b.dataset.drive}/to-drive`, { folder: cur.folder }, 'Uložené na Disk (Prílohy z e-mailov).'); });
    folders();
  }

  /* ── Písanie ── */
  function compose({ mode, m } = {}) {
    const s = su();
    const box = boxes.find(b => b.id === cur.box);
    const re = x => (/^(re|odp|aw):/i.test(x) ? x : `Re: ${x}`);
    let to = '', cc = '', subject = '', quote = '';
    if (m) {
      const date = new Date(m.date).toLocaleString('sk-SK');
      quote = `\n\n${mode === 'fwd' ? '---------- Preposlaná správa ----------\nOd: ' + fmtAddr(m.from) + '\nDátum: ' + date + '\nPredmet: ' + m.subject + '\n\n' : `${date}, ${who(m.from)} napísal/a:\n`}${(m.text || '').split('\n').map(l => (mode === 'fwd' ? l : `> ${l}`)).join('\n')}`;
      if (mode === 'fwd') subject = /^(fwd|pošli|fw):/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`;
      else {
        subject = re(m.subject);
        to = fmtAddr(m.replyTo.length ? m.replyTo : m.from);
        if (mode === 'all') cc = fmtAddr([...m.to, ...m.cc].filter(a => a.address.toLowerCase() !== box.address));
      }
    }
    const sig = box.signature ? `\n\n-- \n${box.signature}` : '';
    let drive = [];
    s.modal(mode === 'fwd' ? '↪ Preposlať' : m ? '↩ Odpoveď' : '✏️ Nová správa', `
      <div style="${s.muted};margin-bottom:0.5rem">Od: ${esc(box.name ? `${box.name} <${box.address}>` : box.address)}</div>
      <div class="form-group"><input class="form-control" id="mc-to" placeholder="Komu (oddeľte čiarkou)" value="${esc(to)}"></div>
      <div class="form-group"><input class="form-control" id="mc-cc" placeholder="Kópia" value="${esc(cc)}"></div>
      <div class="form-group"><input class="form-control" id="mc-subject" placeholder="Predmet" value="${esc(subject)}"></div>
      <div class="form-group"><textarea class="form-control" id="mc-text" rows="12" style="font-family:inherit">${esc(sig + quote)}</textarea></div>
      <div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
        <label class="btn btn-sm btn-secondary" style="cursor:pointer">📎 Priložiť<input type="file" id="mc-files" multiple hidden></label>
        <button class="btn btn-sm btn-secondary" id="mc-drive">💾 Z Disku</button><span id="mc-att" style="${s.muted}"></span>
        <button class="btn btn-primary" id="mc-send" style="margin-left:auto">Odoslať</button></div>`, (el, close) => {
      const files = [];
      const att = () => { el.querySelector('#mc-att').textContent = [...files.map(f => f.name), ...drive.map(d => d.title)].join(', '); };
      el.querySelector('#mc-files').onchange = e => { files.push(...e.target.files); att(); };
      el.querySelector('#mc-drive').onclick = () => {
        const name = prompt('Názov súboru na Disku (časť názvu):');
        if (!name) return;
        s.api('GET', `/api/realtime/search${q({ q: name })}`).then(found => {
          const f = (found || []).find(x => x.type === 'file');
          if (!f) return showToast('Súbor sa nenašiel.', 'error');
          drive.push(f); att();
        });
      };
      if (!m || mode === 'fwd') el.querySelector('#mc-to').focus(); else { const t = el.querySelector('#mc-text'); t.focus(); t.setSelectionRange(0, 0); }
      el.querySelector('#mc-send').onclick = async () => {
        const fd = new FormData();
        const text = el.querySelector('#mc-text').value;
        fd.append('_json', JSON.stringify({
          to: el.querySelector('#mc-to').value, cc: el.querySelector('#mc-cc').value, subject: el.querySelector('#mc-subject').value, text,
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</div>`,
          driveFiles: drive.map(d => d.id), inReplyTo: m && mode !== 'fwd' ? m.messageId : undefined, references: m && mode !== 'fwd' ? [].concat(m.references || [], m.messageId || []) : undefined,
        }));
        files.forEach(f => fd.append('files', f));
        el.querySelector('#mc-send').disabled = true;
        const r = await s.api('POST', `${M}/mailboxes/${cur.box}/send`, fd, 'Odoslané.');
        el.querySelector('#mc-send').disabled = false;
        if (r) { close(); if (/sent|odosl/i.test(cur.folder)) list(); }
      };
    }, { wide: true });
  }

  function setupHelp() {
    const s = su();
    const box = boxes.find(b => b.id === cur.box);
    s.modal('📱 Pošta v telefóne a v Outlooku', `<p style="margin-bottom:0.7rem">Pridajte účet ako <strong>IMAP</strong>. Telefóny s automatickým nastavením stačí zadať e-mail a heslo.</p>
      <table style="font-size:0.88rem;border-collapse:collapse;width:100%">
        <tr><td style="padding:0.3rem 0;${s.muted}">E-mail / meno</td><td><strong>${esc(box.address)}</strong></td></tr>
        <tr><td style="padding:0.3rem 0;${s.muted}">Prichádzajúca (IMAP)</td><td>${esc(cfg.imap.host)}, port ${cfg.imap.port}, SSL/TLS</td></tr>
        <tr><td style="padding:0.3rem 0;${s.muted}">Odchádzajúca (SMTP)</td><td>${esc(cfg.smtp.host)}, port ${cfg.smtp.port}, SSL/TLS</td></tr>
        <tr><td style="padding:0.3rem 0;${s.muted}">Heslo</td><td>Ukáže sa pri založení schránky alebo po obnovení hesla.</td></tr></table>
      ${box.userId === (JSON.parse(localStorage.getItem('nd_user') || '{}') || {}).id || s.role === 'owner' ? '<button class="btn btn-secondary" id="ml-reset" style="margin-top:0.8rem">🔑 Vygenerovať nové heslo</button>' : ''}
      <div class="form-group" style="margin-top:1rem"><label>Podpis v e-mailoch</label><textarea class="form-control" id="ml-sig" rows="3" style="font-family:inherit">${esc(box.signature || '')}</textarea>
      <button class="btn btn-sm btn-primary" id="ml-sig-save" style="margin-top:0.4rem">Uložiť podpis</button></div>`, (el) => {
      if (el.querySelector('#ml-reset')) el.querySelector('#ml-reset').onclick = async () => {
        if (!confirm('Vygenerovať nové heslo? Staré prestane fungovať v telefóne aj v Outlooku.')) return;
        const r = await s.api('PATCH', `${M}/mailboxes/${box.id}`, { resetPassword: true });
        if (r) el.querySelector('#ml-reset').outerHTML = `<div style="margin-top:0.8rem;padding:0.6rem;border:1px solid #5b4fff;border-radius:8px">Nové heslo: <code style="font-size:1rem;user-select:all">${esc(r.password)}</code><div style="${s.muted}">Zobrazí sa iba teraz – uložte si ho.</div></div>`;
      };
      el.querySelector('#ml-sig-save').onclick = async () => { const r = await s.api('PATCH', `${M}/mailboxes/${box.id}`, { signature: el.querySelector('#ml-sig').value }, 'Podpis uložený.'); if (r) box.signature = r.signature; };
    });
  }

  /* ── Správa domén a schránok (majiteľ) ── */
  async function admin() {
    const s = su();
    const domains = (await s.api('GET', `${M}/domains`)) || [];
    const ok = v => (v === true ? '✅' : v === false ? '❌' : '–');
    $('mail-body').innerHTML = `<div style="display:flex;gap:0.6rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap">
        ${boxes.some(b => b.canRead) ? '<button class="btn btn-sm btn-secondary" id="ad-back">← Pošta</button>' : ''}<h3 style="margin:0">Domény a schránky</h3></div>
      ${cfg.configured ? '' : '<div class="panel" style="color:#f59e0b">⚠ Mail server nie je pripojený (premenné STALWART_URL a STALWART_API_KEY na serveri). Pozrite docs/EMAIL-STALWART.md.</div>'}
      <div class="panel"><div class="panel-title" style="margin-bottom:0.3rem">1. Doména</div>
        <p style="${s.muted};margin-bottom:0.7rem">Pridajte doménu svojej firmy a u registrátora (Websupport, WebHouse, Forpsi…) nastavte DNS záznamy nižšie. Schránky začnú prijímať poštu po overení MX.</p>
        <div style="display:flex;gap:0.4rem;max-width:460px"><input class="form-control" id="ad-domain" placeholder="mojafirma.sk"><button class="btn btn-primary" id="ad-add">Pridať</button></div>
        ${domains.map(d => `<div style="margin-top:1rem;border-top:1px solid rgba(255,255,255,0.06);padding-top:0.8rem">
          <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap"><strong>${esc(d.domain)}</strong>
            <span style="font-size:0.75rem;padding:0.1rem 0.5rem;border-radius:10px;${d.status === 'active' ? 'background:rgba(34,197,94,0.15);color:#4ade80' : 'background:rgba(245,158,11,0.15);color:#fbbf24'}">${d.status === 'active' ? 'Aktívna' : 'Čaká na DNS'}</span>
            <span style="${s.muted}">MX ${ok(d.checks.mx)} · SPF ${ok(d.checks.spf)} · DKIM ${ok(d.checks.dkim)} · DMARC ${ok(d.checks.dmarc)}</span>
            <button class="btn btn-sm btn-secondary" data-verify="${esc(d.id)}" style="margin-left:auto">↻ Overiť DNS</button><button class="btn btn-sm btn-danger" data-deldom="${esc(d.id)}">✕</button></div>
          <div style="overflow:auto;margin-top:0.5rem"><table style="width:100%;font-size:0.78rem;border-collapse:collapse">${d.records.map(r => `<tr style="border-top:1px solid rgba(255,255,255,0.05)"><td style="padding:0.3rem;width:60px"><strong>${esc(r.type)}</strong></td><td style="padding:0.3rem;font-family:monospace;user-select:all">${esc(r.name)}</td><td style="padding:0.3rem;font-family:monospace;word-break:break-all;user-select:all">${esc(r.content)}</td></tr>`).join('')}</table></div></div>`).join('')}</div>
      <div class="panel"><div class="panel-title" style="margin-bottom:0.3rem">2. Schránky</div>
        <p style="${s.muted};margin-bottom:0.7rem">Schránka pridelená kolegovi je iba jeho (ani majiteľ ju nečíta). Nepridelená, napr. info@, je spoločná pre vás a editorov.</p>
        ${domains.length ? `<div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;margin-bottom:0.8rem">
          <input class="form-control" id="ad-local" placeholder="info" style="width:140px"><span>@</span><select class="form-control" id="ad-dom" style="width:auto">${domains.map(d => `<option value="${esc(d.id)}">${esc(d.domain)}</option>`).join('')}</select>
          <input class="form-control" id="ad-name" placeholder="Zobrazované meno" style="width:200px">
          <select class="form-control" id="ad-user" style="width:auto"><option value="">👥 Spoločná</option>${s.members.map(x => `<option value="${esc(x.id)}">👤 ${esc(x.name)}</option>`).join('')}</select>
          <button class="btn btn-primary" id="ad-create">Založiť schránku</button></div>` : `<p style="${s.muted}">Najprv pridajte doménu.</p>`}
        ${boxes.map(b => `<div style="display:flex;gap:0.5rem;align-items:center;padding:0.45rem 0;border-top:1px solid rgba(255,255,255,0.05);flex-wrap:wrap">
          <strong>${esc(b.address)}</strong><span style="${s.muted}">${esc(b.name)}</span>
          <select class="form-control" data-assign="${esc(b.id)}" style="width:auto;margin-left:auto;font-size:0.82rem"><option value="">👥 Spoločná</option>${s.members.map(x => `<option value="${esc(x.id)}" ${b.userId === x.id ? 'selected' : ''}>👤 ${esc(x.name)}</option>`).join('')}</select>
          <button class="btn btn-sm btn-secondary" data-reset="${esc(b.id)}">🔑 Nové heslo</button><button class="btn btn-sm btn-danger" data-delbox="${esc(b.id)}">✕</button></div>`).join('')}
        <div id="ad-pass"></div></div>`;
    const showPass = r => { $('ad-pass').innerHTML = `<div style="margin-top:0.8rem;padding:0.7rem;border:1px solid #5b4fff;border-radius:8px">Heslo pre <strong>${esc(r.address)}</strong>: <code style="font-size:1rem;user-select:all">${esc(r.password)}</code>
      <div style="${s.muted}">Zobrazí sa iba teraz. IMAP ${esc(cfg.imap.host)}:${cfg.imap.port}, SMTP ${esc(cfg.smtp.host)}:${cfg.smtp.port} (SSL). Vo webmaile Neoworkly heslo netreba.</div></div>`; };
    if ($('ad-back')) $('ad-back').onclick = load;
    $('ad-add').onclick = async () => { if (await s.api('POST', `${M}/domains`, { domain: $('ad-domain').value }, 'Doména pridaná – nastavte DNS záznamy.')) admin(); };
    document.querySelectorAll('[data-verify]').forEach(b => { b.onclick = async () => { const d = await s.api('POST', `${M}/domains/${b.dataset.verify}/verify`, {}); if (d) { showToast(d.status === 'active' ? 'Doména je aktívna.' : 'DNS ešte nie sú nastavené (zmena môže trvať aj niekoľko hodín).'); admin(); } }; });
    document.querySelectorAll('[data-deldom]').forEach(b => { b.onclick = async () => { if (confirm('Odstrániť doménu z mail servera?') && await s.api('DELETE', `${M}/domains/${b.dataset.deldom}`, undefined, 'Doména odstránená.')) admin(); }; });
    if ($('ad-create')) $('ad-create').onclick = async () => {
      const r = await s.api('POST', `${M}/mailboxes`, { local: $('ad-local').value, domainId: $('ad-dom').value, name: $('ad-name').value, userId: $('ad-user').value || null }, 'Schránka založená.');
      if (r) { boxes = (await s.api('GET', `${M}/mailboxes`)) || []; await admin(); showPass(r); }
    };
    document.querySelectorAll('[data-assign]').forEach(sel => { sel.onchange = async () => { if (await s.api('PATCH', `${M}/mailboxes/${sel.dataset.assign}`, { userId: sel.value || null }, 'Uložené.')) boxes = (await s.api('GET', `${M}/mailboxes`)) || []; }; });
    document.querySelectorAll('[data-reset]').forEach(b => { b.onclick = async () => { if (!confirm('Vygenerovať nové heslo?')) return; const r = await s.api('PATCH', `${M}/mailboxes/${b.dataset.reset}`, { resetPassword: true }); if (r) showPass(r); }; });
    document.querySelectorAll('[data-delbox]').forEach(b => { b.onclick = async () => { if (confirm('Zmazať schránku aj so všetkou poštou? Nedá sa to vrátiť.') && await s.api('DELETE', `${M}/mailboxes/${b.dataset.delbox}`, undefined, 'Schránka zmazaná.')) { boxes = (await s.api('GET', `${M}/mailboxes`)) || []; admin(); } }; });
  }
})();
