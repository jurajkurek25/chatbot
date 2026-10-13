/* Spoločné pre tímové moduly (Úlohy, Kalendár, Poznámky, Dokumenty…): priestor tímu, ľudia,
   API s ?ws=, modálne okno, panel prepojení, zvonček upozornení, registrácia sekcií dashboardu.
   Používa apiFetch, esc a showToast z dashboard.js. */
(function () {
  'use strict';
  const S = window.NW_SUITE = window.NW_SUITE || {}; // sekcie: { title, load }
  const muted = 'color:#7e7ea0;font-size:0.78rem';
  let workspaces = [];
  let members = [];
  let ws = (() => { try { return localStorage.getItem('nw_ws') || null; } catch { return null; } })();

  const suite = {
    muted,
    get ws() { return ws; },
    get role() { return (workspaces.find(w => w.ownerId === ws) || {}).role || 'owner'; },
    get canWrite() { return ['owner', 'editor'].includes(suite.role); },
    get members() { return members; },
    member: id => members.find(m => m.id === id),
    initials: name => String(name || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(),
    avatar(id, size = 24) {
      const m = suite.member(id);
      const hue = [...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
      return `<span title="${esc(m ? m.name : '')}" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:hsl(${hue} 55% 45%);color:#fff;font-size:${Math.round(size * 0.42)}px;font-weight:700;flex-shrink:0">${esc(suite.initials(m ? m.name : '?'))}</span>`;
    },
    /** Načíta priestory a ľudí; pri chybnom uloženom priestore prepne na vlastný. */
    async ready() {
      const r = await apiFetch('/api/realtime/workspaces');
      workspaces = r && r.ok ? await r.json() : [];
      if (!ws || !workspaces.some(w => w.ownerId === ws)) ws = workspaces[0] ? workspaces[0].ownerId : null;
      const m = await apiFetch(`/api/realtime/members?ws=${encodeURIComponent(ws || '')}`);
      members = m && m.ok ? await m.json() : [];
      if (window.NW && NW.rt && ws) NW.rt.workspace(ws);
      return ws;
    },
    setWorkspace(id) {
      ws = id;
      try { localStorage.setItem('nw_ws', id); } catch { /* nič */ }
    },
    /** Prepínač priestoru (vlastný + tímy) – vráti HTML, onChange zavolá reload. */
    wsPicker(onChange) {
      if (workspaces.length < 2) return '';
      setTimeout(() => {
        const el = document.getElementById('nw-ws-pick');
        if (el) el.onchange = async () => { suite.setWorkspace(el.value); await suite.ready(); onChange(); };
      });
      return `<select class="form-control" id="nw-ws-pick" style="width:auto">${workspaces.map(w => `<option value="${esc(w.ownerId)}" ${w.ownerId === ws ? 'selected' : ''}>${w.mine ? '🏠 Môj priestor' : `👥 ${esc(w.name)}${w.role === 'readonly' ? ' (čítanie)' : ''}`}</option>`).join('')}</select>`;
    },
    url(path, params = {}) {
      const p = new URLSearchParams(params);
      if (ws) p.set('ws', ws);
      return `${path}${path.includes('?') ? '&' : '?'}${p.toString()}`;
    },
    async api(method, path, body, ok) {
      const opts = { method };
      if (body instanceof FormData) opts.body = body;
      else if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
      const r = await apiFetch(suite.url(path), opts);
      if (!r) return null;
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(d.error || 'Chyba', 'error'); return null; }
      if (ok) showToast(ok);
      return d;
    },
    date(sec, opts = { dateStyle: 'medium' }) { return sec ? new Date(sec * 1000).toLocaleString('sk-SK', opts) : ''; },
    /** Termín s farbou: po termíne červená, dnes oranžová. */
    due(sec) {
      if (!sec) return '';
      const d = new Date(sec * 1000), now = new Date();
      const today = d.toDateString() === now.toDateString();
      const late = d < now;
      const color = late ? '#ff4060' : today ? '#f59e0b' : '#9898b8';
      return `<span style="color:${color};font-size:0.78rem">📅 ${today ? 'dnes ' + d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
    },
    /** Modálne okno v štýle dashboardu. */
    modal(title, html, onReady, { wide } = {}) {
      const o = document.createElement('div');
      o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1100;display:flex;align-items:center;justify-content:center;padding:0.75rem';
      o.innerHTML = `<div class="modal-box modal-box-lg" style="max-height:92vh;overflow:auto;${wide ? 'max-width:880px' : ''}"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:0.5rem">
        <h2 style="font-size:1.05rem;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis">${title}</h2><button class="btn btn-sm btn-secondary" data-close>✕</button></div><div data-body>${html}</div></div>`;
      const close = () => { o.remove(); document.removeEventListener('keydown', esc_); };
      const esc_ = e => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', esc_);
      o.addEventListener('mousedown', e => { if (e.target === o) close(); });
      o.querySelector('[data-close]').onclick = close;
      document.body.appendChild(o);
      if (onReady) onReady(o.querySelector('[data-body]'), close);
      return close;
    },
    /** Panel „Prepojené“: zoznam + hľadanie a pridanie prepojenia na úlohu, poznámku, dokument, súbor, udalosť. */
    async linksPanel(el, type, id) {
      const load = async () => {
        const r = await apiFetch(suite.url('/api/realtime/links', { type, id }));
        const items = r && r.ok ? await r.json() : [];
        el.innerHTML = `<div style="${muted};margin-bottom:0.3rem">Prepojené</div>
          ${items.map(i => `<div style="display:flex;gap:0.4rem;align-items:center;font-size:0.85rem;padding:0.2rem 0">
            <span>${i.icon}</span><a href="${esc(i.url)}" data-go style="color:#c4bcff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.title)}</a>
            <span style="${muted}">${esc(i.label)}</span>${suite.canWrite ? `<button class="btn btn-sm btn-secondary" style="padding:0 0.4rem" data-unlink="${esc(i.type)}|${esc(i.id)}">×</button>` : ''}</div>`).join('') || `<div style="${muted}">Nič.</div>`}
          ${suite.canWrite ? `<input class="form-control" data-find placeholder="🔗 Prepojiť s úlohou, poznámkou, dokumentom, súborom…" style="margin-top:0.4rem;font-size:0.82rem"><div data-results></div>` : ''}`;
        el.querySelectorAll('[data-unlink]').forEach(b => {
          b.onclick = async () => {
            const [t, i] = b.dataset.unlink.split('|');
            const rr = await apiFetch(suite.url('/api/realtime/links'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: { type, id }, b: { type: t, id: i } }) });
            if (rr && rr.ok) load();
          };
        });
        el.querySelectorAll('[data-go]').forEach(a => { a.onclick = e => { e.preventDefault(); suite.go(a.getAttribute('href')); }; });
        const find = el.querySelector('[data-find]');
        if (!find) return;
        let timer;
        find.oninput = () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const res = el.querySelector('[data-results]');
            if (find.value.trim().length < 2) { res.innerHTML = ''; return; }
            const rr = await apiFetch(suite.url('/api/realtime/search', { q: find.value.trim() }));
            const found = (rr && rr.ok ? await rr.json() : []).filter(x => !(x.type === type && x.id === id));
            res.innerHTML = found.map(x => `<div data-add="${esc(x.type)}|${esc(x.id)}" style="cursor:pointer;padding:0.3rem 0.4rem;border-radius:6px;font-size:0.84rem">${x.icon} ${esc(x.title)} <span style="${muted}">${esc(x.label)}</span></div>`).join('') || `<div style="${muted}">Nič sa nenašlo.</div>`;
            res.querySelectorAll('[data-add]').forEach(d => {
              d.onmouseenter = () => { d.style.background = 'rgba(91,79,255,0.15)'; };
              d.onmouseleave = () => { d.style.background = ''; };
              d.onclick = async () => {
                const [t, i] = d.dataset.add.split('|');
                if (await suite.api('POST', '/api/realtime/links', { a: { type, id }, b: { type: t, id: i } })) load();
              };
            });
          }, 250);
        };
      };
      await load();
    },
    /** Interný odkaz (/dashboard?view=…&task=…) otvorí sekciu bez obnovenia stránky; /docs/… v novom okne. */
    go(href) {
      const u = new URL(href, location.origin);
      if (u.pathname !== '/dashboard') { window.open(u.href, '_blank', 'noopener'); return; }
      if (u.searchParams.get('ws')) suite.setWorkspace(u.searchParams.get('ws'));
      window._suiteOpen = Object.fromEntries(u.searchParams.entries());
      document.querySelectorAll('.modal-box').forEach(m => m.parentElement.remove());
      showView(u.searchParams.get('view'));
    },
    /** Parametre, s ktorými bola sekcia otvorená (task=…, note=…), použijú sa raz. */
    takeOpen(key) {
      const v = window._suiteOpen && window._suiteOpen[key];
      if (v) delete window._suiteOpen[key];
      return v || null;
    },
  };
  window.NW = window.NW || {};
  window.NW.suite = suite;

  /* ── Zvonček upozornení v hornej lište ─────────────────────── */
  let unread = 0;
  function bell() {
    let b = document.getElementById('nw-bell');
    if (!b) {
      const bar = document.querySelector('.topbar');
      if (!bar) return null;
      b = document.createElement('button');
      b.id = 'nw-bell';
      b.className = 'btn btn-sm btn-secondary';
      b.style.cssText = 'position:relative;margin-left:0.5rem';
      b.onclick = openBell;
      bar.appendChild(b);
    }
    b.innerHTML = `🔔${unread ? `<span style="position:absolute;top:-6px;right:-6px;background:#ff4060;color:#fff;border-radius:10px;font-size:0.65rem;padding:0 5px;font-weight:700">${unread > 99 ? '99+' : unread}</span>` : ''}`;
    return b;
  }
  async function refreshBell() {
    const r = await apiFetch('/api/realtime/notifications');
    if (!r || !r.ok) return;
    unread = (await r.json()).unread;
    bell();
  }
  async function openBell() {
    const r = await apiFetch('/api/realtime/notifications');
    const d = r && r.ok ? await r.json() : { items: [] };
    suite.modal('🔔 Upozornenia', `${d.items.length ? `<div style="text-align:right;margin-bottom:0.5rem"><button class="btn btn-sm btn-secondary" data-all>Označiť všetko ako prečítané</button></div>` : ''}
      ${d.items.map(n => `<div data-n="${esc(n.id)}" data-url="${esc(n.url)}" style="padding:0.6rem 0.5rem;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;${n.read_at ? 'opacity:0.6' : ''}">
        <div style="font-weight:${n.read_at ? 400 : 700};font-size:0.9rem">${esc(n.title)}</div>${n.body ? `<div style="${muted};white-space:pre-line">${esc(n.body)}</div>` : ''}
        <div style="${muted}">${suite.date(n.created_at, { dateStyle: 'short', timeStyle: 'short' })}</div></div>`).join('') || `<p style="${muted}">Zatiaľ nič.</p>`}`, (el, close) => {
      const all = el.querySelector('[data-all]');
      if (all) all.onclick = async () => { await apiFetch('/api/realtime/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); close(); refreshBell(); };
      el.querySelectorAll('[data-n]').forEach(x => {
        x.onclick = async () => {
          await apiFetch('/api/realtime/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: x.dataset.n }) });
          close();
          refreshBell();
          if (x.dataset.url) suite.go(x.dataset.url);
        };
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(async () => {
      await suite.ready();
      refreshBell();
      if (window.NW && NW.rt) {
        NW.rt.on('notification', n => {
          unread++;
          bell();
          showToast(`🔔 ${n.notification.title}`);
        });
      }
    }, 400);
  });

  /* ── Registrácia sekcií: dashboard.js volá NW_SUITE[view].load() ── */
  window.suiteShow = function (view) {
    Object.keys(S).forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.style.display = v === view ? '' : 'none';
      const nav = document.getElementById(`nav-${v}`);
      if (nav) nav.classList.toggle('active', v === view);
    });
    if (!S[view]) return false;
    document.getElementById('topbar-title').textContent = S[view].title;
    document.getElementById('topbar-actions').innerHTML = '';
    if (window.NW && NW.rt) NW.rt.where(view);
    suite.ready().then(() => S[view].load());
    return true;
  };
})();
