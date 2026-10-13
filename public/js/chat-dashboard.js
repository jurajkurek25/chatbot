/* Tímový chat (podľa Zulipu): kanály s témami, súkromné kanály, priame správy, @zmienky, reakcie,
   prílohy na Disk, správa → úloha, prepojenia a videohovor (Jitsi). Používa NW.suite, NW.rt, esc, showToast. */
(function () {
  'use strict';
  const C = '/api/chat';
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;
  const qs = (path, params) => { const p = new URLSearchParams(params).toString(); return p ? `${path}?${p}` : path; };
  const me = () => (JSON.parse(localStorage.getItem('nd_user') || '{}') || {}).id;
  const EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏', '🔥'];
  let streams = [];
  let cur = { streamId: null, topic: null }; // topic null = celý kanál
  let messages = [];
  let more = false;
  let pending = []; // nahraté prílohy pred odoslaním
  let topics = [];
  let typingTimer = null;
  let lastTyping = 0;

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.chat = { title: 'Chat', load };

  const visible = () => $('view-chat') && $('view-chat').style.display !== 'none';
  const stream = () => streams.find(s => s.id === cur.streamId);
  const typingKey = () => `chat:${cur.streamId}:${cur.topic || ''}`;

  /* ── Odznak neprečítaných v bočnom menu ── */
  let badgeT;
  function refreshBadge() {
    clearTimeout(badgeT);
    badgeT = setTimeout(async () => {
      const s = su();
      if (!s || !s.ws) return;
      const r = await apiFetch(s.url(`${C}/unread`));
      const n = r && r.ok ? (await r.json()).unread : 0;
      const b = $('nav-chat-badge');
      if (b) { b.textContent = n > 99 ? '99+' : n; b.style.display = n ? '' : 'none'; }
    }, 300);
  }
  document.addEventListener('DOMContentLoaded', () => setTimeout(async () => { await su().ready(); refreshBadge(); }, 900));

  if (window.NW && NW.rt) {
    let sideT;
    NW.rt.on('chat', e => {
      refreshBadge();
      if (!visible()) return;
      if (e.op === 'new' && e.message.streamId === cur.streamId && (cur.topic === null || e.message.topic === cur.topic)) {
        if (!messages.some(m => m.id === e.message.id)) { messages.push(e.message); renderMessages(true); }
        if (document.hasFocus()) markRead();
      } else if (e.op === 'edit' && messages.some(m => m.id === e.message.id)) {
        messages = messages.map(m => (m.id === e.message.id ? e.message : m)).filter(m => cur.topic === null || m.topic === cur.topic);
        renderMessages();
      } else if (e.op === 'delete' && messages.some(m => m.id === e.id)) {
        messages = messages.filter(m => m.id !== e.id);
        renderMessages();
      }
      clearTimeout(sideT);
      sideT = setTimeout(sidebar, 250);
    });
    NW.rt.on('typing', e => {
      if (!visible() || e.topic !== typingKey()) return;
      const el = $('ch-typing');
      if (!el) return;
      el.textContent = `${e.user.name} píše…`;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { el.textContent = ''; }, 4000);
    });
  }

  /* ── Formátovanie správy: **tučné**, *kurzíva*, `kód`, ```blok```, [text](url), odkazy, @**zmienky** ── */
  function render(text) {
    const blocks = [];
    let h = esc(text).replace(/```\n?([\s\S]*?)```/g, (a, code) => { blocks.push(code); return `\u0000${blocks.length - 1}\u0000`; });
    h = h.replace(/`([^`\n]+)`/g, '<code style="background:#111120;padding:0 4px;border-radius:4px">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, (a, x) => `<strong>${x}</strong>`)
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, (a, t, u) => `<a href="${u}" ${u.startsWith('/') ? 'data-go' : 'target="_blank" rel="noopener"'} style="color:#c4bcff">${t}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener" style="color:#c4bcff">$2</a>')
      .replace(/@<strong>([^<]{1,80})<\/strong>/g, (a, name) => {
        const mine = (su().member(me()) || {}).name === name;
        return `<span style="background:${mine ? 'rgba(245,158,11,0.25)' : 'rgba(91,79,255,0.22)'};color:${mine ? '#fcd34d' : '#c4bcff'};padding:0 4px;border-radius:4px;font-weight:600">@${name}</span>`;
      })
      .replace(/\n/g, '<br>');
    return h.replace(/\u0000(\d+)\u0000/g, (a, i) => `<pre style="background:#111120;padding:0.5rem 0.7rem;border-radius:8px;overflow:auto;font-size:0.82rem;margin:0.3rem 0">${blocks[i]}</pre>`);
  }
  const size = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
  const time = sec => new Date(sec * 1000).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
  const day = sec => new Date(sec * 1000).toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' });

  /* ── Hlavné rozloženie ── */
  async function load() {
    const s = su();
    const openStream = s.takeOpen('stream'), openTopic = s.takeOpen('topic'), openMsg = s.takeOpen('msg');
    $('chat-body').innerHTML = `<div class="nw-chat" style="display:grid;grid-template-columns:250px minmax(0,1fr);gap:1rem;height:calc(100vh - 130px);min-height:480px">
      <aside class="panel" style="padding:0.75rem;overflow:auto;margin:0;display:flex;flex-direction:column;gap:0.25rem">
        <input class="form-control" id="ch-q" placeholder="🔍 Hľadať v chate" style="font-size:0.85rem">
        <div style="display:flex;align-items:center;margin-top:0.6rem"><span style="${s.muted};text-transform:uppercase;letter-spacing:0.05em">Kanály</span>
          ${s.canWrite ? '<button class="btn btn-sm btn-secondary" id="ch-new" style="margin-left:auto;padding:0 0.45rem" title="Nový kanál">+</button>' : ''}</div>
        <div id="ch-streams"></div>
        <div style="display:flex;align-items:center;margin-top:0.6rem"><span style="${s.muted};text-transform:uppercase;letter-spacing:0.05em">Priame správy</span>
          <button class="btn btn-sm btn-secondary" id="ch-dm" style="margin-left:auto;padding:0 0.45rem" title="Nová správa">+</button></div>
        <div id="ch-dms"></div>
        <div style="margin-top:auto;padding-top:0.6rem">${s.wsPicker(() => { cur = { streamId: null, topic: null }; load(); })}</div>
      </aside>
      <section class="panel" style="padding:0;margin:0;display:flex;flex-direction:column;min-height:0">
        <div id="ch-head" style="display:flex;align-items:center;gap:0.5rem;padding:0.7rem 1rem;border-bottom:1px solid rgba(255,255,255,0.08);flex-wrap:wrap"></div>
        <div id="ch-msgs" style="flex:1;overflow:auto;padding:0.5rem 1rem"></div>
        <div id="ch-typing" style="${s.muted};padding:0 1rem;min-height:1.1rem"></div>
        <div id="ch-compose" style="padding:0.6rem 1rem 0.9rem;border-top:1px solid rgba(255,255,255,0.08)"></div>
      </section></div>
      <style>@media (max-width:860px){.nw-chat{grid-template-columns:1fr !important;height:auto !important}.nw-chat aside{max-height:260px}}
        .nw-msg:hover{background:rgba(255,255,255,0.025)} .nw-msg .nw-acts{visibility:hidden} .nw-msg:hover .nw-acts{visibility:visible}
        .nw-chip{display:inline-flex;align-items:center;gap:0.25rem;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:0 0.45rem;font-size:0.8rem;cursor:pointer;background:#111120;color:#eeeef5}
        .nw-chip.mine{border-color:#5b4fff;background:rgba(91,79,255,0.18)}</style>`;
    if ($('ch-new')) $('ch-new').onclick = () => streamDialog();
    $('ch-dm').onclick = dmDialog;
    let qt;
    $('ch-q').oninput = e => { clearTimeout(qt); qt = setTimeout(() => search(e.target.value.trim()), 300); };
    await sidebar();
    const first = streams.find(x => x.id === openStream) || stream() || streams.find(x => x.kind === 'stream' && !x.archived) || streams[0];
    if (first) await open(first.id, openStream ? openTopic : cur.topic, openMsg);
  }

  async function sidebar() {
    const s = su();
    streams = (await s.api('GET', `${C}/streams`)) || [];
    if (!$('ch-streams')) return;
    const badge = n => (n ? `<span style="margin-left:auto;background:#5b4fff;color:#fff;border-radius:10px;font-size:0.7rem;padding:0 6px;font-weight:700">${n}</span>` : '');
    const chans = streams.filter(x => x.kind === 'stream');
    $('ch-streams').innerHTML = chans.map(x => `<button class="nav-item ${x.id === cur.streamId ? 'active' : ''}" data-s="${esc(x.id)}" style="width:100%;${x.archived ? 'opacity:0.5' : ''}">
        <span style="opacity:0.7">${x.private ? '🔒' : '#'}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name)}</span>${badge(x.unread)}</button>
      ${x.id === cur.streamId ? `<div id="ch-topics" style="margin:0 0 0.3rem 1.3rem"></div>` : ''}`).join('');
    $('ch-dms').innerHTML = streams.filter(x => x.kind === 'dm').map(x => `<button class="nav-item ${x.id === cur.streamId ? 'active' : ''}" data-s="${esc(x.id)}" style="width:100%">
        ${s.avatar((x.members || []).find(id => id !== me()) || me(), 20)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name)}</span>${badge(x.unread)}</button>`).join('') || `<div style="${s.muted};padding:0.2rem 0.4rem">Zatiaľ žiadne.</div>`;
    document.querySelectorAll('.nw-chat [data-s]').forEach(b => { b.onclick = () => open(b.dataset.s, null); });
    if (stream() && stream().kind === 'stream') renderTopics();
  }

  async function loadTopics() {
    topics = (await su().api('GET', `${C}/streams/${cur.streamId}/topics`)) || [];
    renderTopics();
  }
  function renderTopics() {
    const el = $('ch-topics');
    if (!el) return;
    el.innerHTML = topics.slice(0, 30).map(t => `<a href="#" data-t="${esc(t.topic)}" style="display:flex;gap:0.3rem;align-items:center;padding:0.15rem 0.3rem;border-radius:6px;font-size:0.82rem;color:${cur.topic === t.topic ? '#fff' : '#9898b8'};${cur.topic === t.topic ? 'background:rgba(91,79,255,0.2)' : ''}">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${t.unread ? 'font-weight:700;color:#eeeef5' : ''}">${esc(t.topic)}</span>${t.unread ? `<span style="margin-left:auto;color:#9b8cff;font-size:0.72rem">${t.unread}</span>` : ''}</a>`).join('');
    el.querySelectorAll('[data-t]').forEach(a => { a.onclick = e => { e.preventDefault(); open(cur.streamId, a.dataset.t); }; });
  }

  /* ── Otvorenie kanála / témy ── */
  async function open(streamId, topic, highlight) {
    const s = su();
    const changed = cur.streamId !== streamId;
    cur = { streamId, topic: topic || null };
    const st = stream();
    if (!st) return;
    if (changed) await sidebar();
    if (st.kind === 'stream') await loadTopics(); else topics = [];
    document.querySelectorAll('.nw-chat [data-s]').forEach(b => b.classList.toggle('active', b.dataset.s === streamId));
    const owner = s.role === 'owner';
    $('ch-head').innerHTML = `<div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${st.kind === 'dm' ? '💬 ' : st.private ? '🔒 ' : '# '}${esc(st.name)}${cur.topic ? ` <span style="color:#7e7ea0">›</span> ${esc(cur.topic)}` : ''}</div>
        ${st.description && !cur.topic ? `<div style="${s.muted}">${esc(st.description)}</div>` : ''}
        ${cur.topic ? `<a href="#" id="ch-all" style="${s.muted};color:#9b8cff">← všetky témy</a>` : ''}</div>
      <button class="btn btn-sm btn-secondary" id="ch-meet" title="Začať videohovor v tejto konverzácii">🎥 Videohovor</button>
      ${st.kind === 'stream' && s.canWrite && (owner || st.createdBy === me()) ? '<button class="btn btn-sm btn-secondary" id="ch-edit" title="Nastavenia kanála">⚙</button>' : ''}`;
    if ($('ch-all')) $('ch-all').onclick = e => { e.preventDefault(); open(cur.streamId, null); };
    if ($('ch-edit')) $('ch-edit').onclick = () => streamDialog(st);
    $('ch-meet').onclick = async () => {
      const topicName = st.kind === 'dm' ? '' : (cur.topic || ($('ch-topic') && $('ch-topic').value.trim()) || 'videohovor');
      const m = await s.api('POST', `${C}/streams/${st.id}/meet`, { topic: topicName });
      if (m) s.meet(m.meeting);
    };
    composer();
    const d = await s.api('GET', qs(`${C}/streams/${streamId}/messages`, cur.topic !== null ? { topic: cur.topic } : {}));
    messages = d ? d.messages : [];
    more = d ? d.more : false;
    renderMessages(true);
    if (highlight) {
      const el = document.querySelector(`[data-m="${CSS.escape(String(highlight))}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.style.boxShadow = 'inset 3px 0 0 #9b8cff'; }
    }
    markRead();
  }

  let readT;
  function markRead() {
    clearTimeout(readT);
    readT = setTimeout(async () => {
      const st = stream();
      if (!st || !(st.unread || topics.some(t => t.unread) || messages.length)) return;
      await su().api('POST', `${C}/streams/${st.id}/read`, cur.topic !== null ? { topic: cur.topic } : {});
      st.unread = 0;
      refreshBadge();
      sidebar();
    }, 400);
  }

  /* ── Správy ── */
  function renderMessages(toBottom) {
    const s = su();
    const box = $('ch-msgs');
    if (!box) return;
    const st = stream();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let lastTopic = null, lastDay = null, lastAuthor = null, lastAt = 0;
    const rows = messages.map(m => {
      let head = '';
      const d = day(m.createdAt);
      if (d !== lastDay) { head += `<div style="text-align:center;${s.muted};margin:0.8rem 0 0.4rem">${esc(d)}</div>`; lastDay = d; lastAuthor = null; }
      if (st.kind === 'stream' && cur.topic === null && m.topic !== lastTopic) {
        head += `<a href="#" data-topic="${esc(m.topic)}" style="display:block;margin:0.7rem 0 0.2rem;padding:0.25rem 0.6rem;border-radius:6px;background:rgba(91,79,255,0.12);color:#c4bcff;font-size:0.82rem;font-weight:600"># ${esc(st.name)} › ${esc(m.topic)}</a>`;
        lastTopic = m.topic; lastAuthor = null;
      }
      const grouped = lastAuthor === m.author.id && m.createdAt - lastAt < 300;
      lastAuthor = m.author.id; lastAt = m.createdAt;
      const mine = m.author.id === me();
      const reactions = Object.entries(m.reactions || {}).map(([e, ids]) => `<button class="nw-chip ${ids.includes(me()) ? 'mine' : ''}" data-react="${e}" title="${esc(ids.map(id => (s.member(id) || {}).name || '').join(', '))}">${e} ${ids.length}</button>`).join(' ');
      return `${head}<div class="nw-msg" data-m="${m.id}" style="display:flex;gap:0.6rem;padding:${grouped ? '0.1rem' : '0.45rem'} 0.4rem 0.1rem;border-radius:6px;position:relative">
        <div style="width:32px;flex-shrink:0">${grouped ? '' : s.avatar(m.author.id, 32)}</div>
        <div style="min-width:0;flex:1">
          ${grouped ? '' : `<div style="display:flex;gap:0.5rem;align-items:baseline"><strong style="font-size:0.9rem">${esc(m.author.name)}</strong><span style="${s.muted}">${time(m.createdAt)}</span></div>`}
          <div data-body style="font-size:0.9rem;line-height:1.55;word-break:break-word">${render(m.content)}${m.editedAt ? ` <span style="${s.muted}">(upravené)</span>` : ''}</div>
          ${m.meeting ? `<div style="display:inline-flex;gap:0.6rem;align-items:center;margin-top:0.35rem;padding:0.5rem 0.75rem;border:1px solid rgba(91,79,255,0.4);border-radius:10px;background:rgba(91,79,255,0.1)">🎥 <span style="font-size:0.86rem">Videohovor</span><button class="btn btn-sm btn-primary" data-join="${esc(m.meeting)}">Pripojiť sa</button></div>` : ''}
          ${m.files.length ? `<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.35rem">${m.files.map(f => `<a href="#" data-file="${esc(f.id)}" style="display:flex;flex-direction:column;gap:0.2rem;padding:0.35rem 0.55rem;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:#111120;font-size:0.82rem;color:#eeeef5;max-width:240px">
              ${/^image\//.test(f.mime || '') ? `<img data-img="${esc(f.id)}" alt="" style="max-width:220px;max-height:160px;border-radius:6px;display:none">` : ''}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📎 ${esc(f.name)} <span style="${s.muted}">${size(f.size)}</span></span></a>`).join('')}</div>` : ''}
          ${reactions || m.links ? `<div style="display:flex;gap:0.3rem;flex-wrap:wrap;align-items:center;margin-top:0.3rem">${reactions}${m.links ? `<button class="nw-chip" data-act="link">🔗 ${m.links}</button>` : ''}</div>` : ''}
        </div>
        <div class="nw-acts" style="position:absolute;right:0.4rem;top:0.2rem;display:flex;gap:0.2rem;background:#18182a;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.15rem">
          <button class="btn btn-sm btn-secondary" data-act="react" title="Reagovať" style="padding:0 0.35rem">😊</button>
          ${mine ? '<button class="btn btn-sm btn-secondary" data-act="edit" title="Upraviť" style="padding:0 0.35rem">✏️</button>' : ''}
          ${s.canWrite ? '<button class="btn btn-sm btn-secondary" data-act="task" title="Urobiť zo správy úlohu" style="padding:0 0.35rem">✅</button>' : ''}
          <button class="btn btn-sm btn-secondary" data-act="link" title="Prepojenia" style="padding:0 0.35rem">🔗</button>
          ${mine || s.role === 'owner' ? '<button class="btn btn-sm btn-danger" data-act="del" title="Zmazať" style="padding:0 0.35rem">✕</button>' : ''}
        </div></div>`;
    }).join('');
    box.innerHTML = `${more ? '<div style="text-align:center;margin:0.4rem 0"><button class="btn btn-sm btn-secondary" id="ch-more">Načítať staršie</button></div>' : ''}${rows || `<div class="empty-state"><div class="empty-state-icon">💬</div><p>${st.kind === 'dm' ? 'Napíšte prvú správu.' : 'Zatiaľ ticho. Začnite novú tému nižšie.'}</p></div>`}`;
    if (toBottom || atBottom) box.scrollTop = box.scrollHeight;
    bindMessages(box);
  }

  function bindMessages(box) {
    const s = su();
    if ($('ch-more')) $('ch-more').onclick = async () => {
      const params = { before: messages[0].id };
      if (cur.topic !== null) params.topic = cur.topic;
      const d = await s.api('GET', qs(`${C}/streams/${cur.streamId}/messages`, params));
      if (!d) return;
      const h = box.scrollHeight;
      messages = d.messages.concat(messages);
      more = d.more;
      renderMessages();
      box.scrollTop = box.scrollHeight - h;
    };
    box.querySelectorAll('[data-topic]').forEach(a => { a.onclick = e => { e.preventDefault(); open(cur.streamId, a.dataset.topic); }; });
    box.querySelectorAll('[data-go]').forEach(a => { a.onclick = e => { e.preventDefault(); s.go(a.getAttribute('href')); }; });
    box.querySelectorAll('[data-join]').forEach(b => { b.onclick = () => s.meet(b.dataset.join); });
    box.querySelectorAll('[data-file]').forEach(a => {
      a.onclick = async e => {
        e.preventDefault();
        const w = window.open('about:blank', '_blank');
        const d = await s.api('GET', `/api/drive/items/${encodeURIComponent(a.dataset.file)}/url`);
        if (d && w) w.location.href = d.url; else if (w) w.close();
      };
    });
    box.querySelectorAll('[data-img]').forEach(async img => {
      const d = await apiFetch(s.url(`/api/drive/items/${encodeURIComponent(img.dataset.img)}/url`, { inline: 1 })).then(r => (r && r.ok ? r.json() : null));
      if (d) { img.src = d.url; img.style.display = 'block'; }
    });
    box.querySelectorAll('[data-m]').forEach(row => {
      const m = messages.find(x => String(x.id) === row.dataset.m);
      row.querySelectorAll('[data-react]').forEach(b => { b.onclick = () => s.api('POST', `${C}/messages/${m.id}/react`, { emoji: b.dataset.react }).then(v => v && replace(v)); });
      row.querySelectorAll('[data-act]').forEach(b => {
        b.onclick = async () => {
          const act = b.dataset.act;
          if (act === 'react') return emojiPicker(b, e => s.api('POST', `${C}/messages/${m.id}/react`, { emoji: e }).then(v => v && replace(v)));
          if (act === 'del' && confirm('Zmazať správu?') && await s.api('DELETE', `${C}/messages/${m.id}`)) { messages = messages.filter(x => x.id !== m.id); renderMessages(); }
          if (act === 'link') s.modal('🔗 Prepojenia správy', '<div data-l></div>', el => s.linksPanel(el.querySelector('[data-l]'), 'message', String(m.id)));
          if (act === 'task') {
            const t = await s.api('POST', `${C}/messages/${m.id}/to-task`, {}, 'Úloha vytvorená v projekte Doručené.');
            if (t) s.modal('✅ Úloha vytvorená', `<p style="margin-bottom:0.8rem">${esc(t.title)}</p><button class="btn btn-primary" data-open>Otvoriť úlohu</button>`, el => { el.querySelector('[data-open]').onclick = () => s.go(`/dashboard?view=tasks&task=${t.id}&ws=${s.ws}`); });
          }
          if (act === 'edit') {
            const body = row.querySelector('[data-body]');
            const st = stream();
            body.innerHTML = `${st.kind === 'stream' ? `<input class="form-control" data-etopic value="${esc(m.topic)}" style="margin-bottom:0.3rem;font-size:0.82rem" placeholder="Téma">` : ''}
              <textarea class="form-control" data-etext rows="3">${esc(m.content)}</textarea>
              <div style="display:flex;gap:0.4rem;margin-top:0.3rem"><button class="btn btn-sm btn-primary" data-save>Uložiť</button><button class="btn btn-sm btn-secondary" data-cancel>Zrušiť</button></div>`;
            body.querySelector('[data-cancel]').onclick = () => renderMessages();
            body.querySelector('[data-save]').onclick = async () => {
              const payload = { content: body.querySelector('[data-etext]').value };
              if (body.querySelector('[data-etopic]')) payload.topic = body.querySelector('[data-etopic]').value;
              const v = await s.api('PATCH', `${C}/messages/${m.id}`, payload);
              if (v) { if (cur.topic !== null && v.topic !== cur.topic) messages = messages.filter(x => x.id !== v.id); else replace(v); renderMessages(); loadTopics(); }
            };
          }
        };
      });
    });
  }
  function replace(v) { messages = messages.map(x => (x.id === v.id ? v : x)); renderMessages(); }

  function emojiPicker(anchor, pick) {
    document.querySelectorAll('.nw-emoji').forEach(x => x.remove());
    const p = document.createElement('div');
    p.className = 'nw-emoji';
    const r = anchor.getBoundingClientRect();
    p.style.cssText = `position:fixed;top:${r.bottom + 4}px;left:${Math.max(8, r.right - 260)}px;z-index:1300;background:#18182a;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:0.3rem;display:flex;gap:0.15rem;box-shadow:0 8px 24px rgba(0,0,0,0.5)`;
    p.innerHTML = EMOJI.map(e => `<button class="btn btn-sm btn-secondary" style="padding:0.1rem 0.35rem;font-size:1rem" data-e="${e}">${e}</button>`).join('');
    document.body.appendChild(p);
    p.querySelectorAll('[data-e]').forEach(b => { b.onclick = () => { p.remove(); pick(b.dataset.e); }; });
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!p.contains(e.target)) { p.remove(); document.removeEventListener('mousedown', off); } }));
  }

  /* ── Písanie správy ── */
  function composer() {
    const s = su();
    const st = stream();
    pending = [];
    if (st.archived) { $('ch-compose').innerHTML = `<div style="${s.muted}">Kanál je archivovaný – nové správy sa doň nepíšu.</div>`; return; }
    $('ch-compose').innerHTML = `${st.kind === 'stream' ? `<input class="form-control" id="ch-topic" list="ch-topic-list" placeholder="Téma (napr. Spustenie webu)" value="${esc(cur.topic || '')}" style="margin-bottom:0.4rem;font-size:0.85rem;max-width:360px">
        <datalist id="ch-topic-list">${topics.map(t => `<option value="${esc(t.topic)}">`).join('')}</datalist>` : ''}
      <div style="position:relative"><div id="ch-suggest" style="position:absolute;bottom:100%;left:0;z-index:20;background:#18182a;border:1px solid rgba(255,255,255,0.1);border-radius:8px;min-width:220px;display:none"></div>
        <textarea class="form-control" id="ch-text" rows="2" placeholder="${st.kind === 'dm' ? `Správa pre ${esc(st.name)}` : `Správa do #${esc(st.name)}`} – Enter odošle, Shift+Enter nový riadok, @ spomenie kolegu" style="min-height:58px;resize:vertical;font-family:inherit"></textarea></div>
      <div id="ch-files" style="display:flex;gap:0.3rem;flex-wrap:wrap;margin-top:0.3rem"></div>
      <div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.4rem">
        <label class="btn btn-sm btn-secondary" style="cursor:pointer" title="Priložiť súbor (uloží sa na Disk)">📎<input type="file" id="ch-file" multiple hidden></label>
        <button class="btn btn-sm btn-secondary" id="ch-ref" title="Vložiť odkaz na úlohu, dokument, súbor…">🔗</button>
        <button class="btn btn-sm btn-secondary" id="ch-emo" title="Emoji">😊</button>
        <span style="${s.muted};margin-left:0.3rem">**tučné** *kurzíva* \`kód\`</span>
        <button class="btn btn-primary btn-sm" id="ch-send" style="margin-left:auto">Odoslať</button></div>`;
    const text = $('ch-text');
    const send = async () => {
      const content = text.value.trim();
      if (!content && !pending.length) return;
      const topic = $('ch-topic') ? $('ch-topic').value.trim() : '';
      if (st.kind === 'stream' && !topic) { showToast('Zadajte tému správy.', 'error'); $('ch-topic').focus(); return; }
      $('ch-send').disabled = true;
      const m = await s.api('POST', `${C}/streams/${st.id}/messages`, { topic, content, files: pending.map(f => f.id) });
      $('ch-send').disabled = false;
      if (!m) return;
      text.value = '';
      pending = [];
      renderPending();
      if (cur.topic === null || cur.topic === m.topic) { if (!messages.some(x => x.id === m.id)) messages.push(m); renderMessages(true); }
      else open(cur.streamId, m.topic);
      if (!topics.some(t => t.topic === m.topic)) loadTopics();
    };
    $('ch-send').onclick = send;
    text.onkeydown = e => {
      const sug = $('ch-suggest');
      if (sug.style.display !== 'none' && (e.key === 'Enter' || e.key === 'Tab')) { const f = sug.querySelector('[data-pick]'); if (f) { e.preventDefault(); f.click(); return; } }
      if (e.key === 'Escape') sug.style.display = 'none';
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    text.oninput = () => {
      if (Date.now() - lastTyping > 3000) { lastTyping = Date.now(); if (window.NW && NW.rt) NW.rt.typing(typingKey()); }
      mentionSuggest(text);
    };
    $('ch-file').onchange = async e => {
      const fd = new FormData();
      [...e.target.files].forEach(f => fd.append('files', f));
      e.target.value = '';
      const up = await s.api('POST', `${C}/streams/${st.id}/files`, fd);
      if (up) { pending = pending.concat(up); renderPending(); }
    };
    $('ch-emo').onclick = () => emojiPicker($('ch-emo'), e => insert(text, e));
    $('ch-ref').onclick = () => refDialog(text);
  }

  function renderPending() {
    const el = $('ch-files');
    if (!el) return;
    el.innerHTML = pending.map((f, i) => `<span class="nw-chip">📎 ${esc(f.name)} <a href="#" data-rm="${i}" style="color:#ff6080">×</a></span>`).join('');
    el.querySelectorAll('[data-rm]').forEach(a => { a.onclick = e => { e.preventDefault(); pending.splice(Number(a.dataset.rm), 1); renderPending(); }; });
  }

  function insert(text, str) {
    const p = text.selectionStart ?? text.value.length;
    text.value = text.value.slice(0, p) + str + text.value.slice(text.selectionEnd ?? p);
    text.focus();
    text.selectionStart = text.selectionEnd = p + str.length;
  }

  /** @ + písmená → návrh kolegov z kanála (vloží @**Meno**). */
  function mentionSuggest(text) {
    const s = su();
    const sug = $('ch-suggest');
    const before = text.value.slice(0, text.selectionStart);
    const m = before.match(/(^|\s)@([\p{L}\s]{0,30})$/u);
    const st = stream();
    const pool = st.members ? s.members.filter(x => st.members.includes(x.id)) : s.members;
    const q = m ? m[2].toLowerCase() : null;
    const found = q === null ? [] : [{ id: '*', name: 'všetci' }, ...pool].filter(x => x.id !== me() && x.name.toLowerCase().includes(q)).slice(0, 6);
    if (!found.length) { sug.style.display = 'none'; return; }
    sug.innerHTML = found.map(x => `<div data-pick="${esc(x.name)}" style="display:flex;gap:0.4rem;align-items:center;padding:0.35rem 0.55rem;cursor:pointer;font-size:0.86rem">${x.id === '*' ? '📣' : s.avatar(x.id, 20)} ${esc(x.name)}</div>`).join('');
    sug.style.display = '';
    sug.querySelectorAll('[data-pick]').forEach(d => {
      d.onmouseenter = () => { d.style.background = 'rgba(91,79,255,0.18)'; };
      d.onmouseleave = () => { d.style.background = ''; };
      d.onclick = () => {
        const start = text.selectionStart - m[2].length - 1;
        text.value = `${text.value.slice(0, start)}@**${d.dataset.pick}** ${text.value.slice(text.selectionStart)}`;
        sug.style.display = 'none';
        text.focus();
        text.selectionStart = text.selectionEnd = start + d.dataset.pick.length + 6; // za „@**Meno** “
      };
    });
  }

  /** Vloží do správy odkaz na položku z iného modulu: [✅ Názov](/dashboard?view=…). */
  function refDialog(text) {
    const s = su();
    s.modal('🔗 Vložiť odkaz', `<input class="form-control" data-q placeholder="Hľadať úlohu, poznámku, dokument, súbor, udalosť…"><div data-r style="margin-top:0.5rem"></div>`, (el, close) => {
      const q = el.querySelector('[data-q]');
      q.focus();
      let t;
      q.oninput = () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          if (q.value.trim().length < 2) { el.querySelector('[data-r]').innerHTML = ''; return; }
          const found = (await s.api('GET', qs('/api/realtime/search', { q: q.value.trim() }))) || [];
          el.querySelector('[data-r]').innerHTML = found.map((x, i) => `<div data-i="${i}" style="cursor:pointer;padding:0.35rem 0.4rem;border-radius:6px;font-size:0.86rem">${x.icon} ${esc(x.title)} <span style="${s.muted}">${esc(x.label)}</span></div>`).join('') || `<div style="${s.muted}">Nič sa nenašlo.</div>`;
          el.querySelectorAll('[data-i]').forEach(d => {
            d.onmouseenter = () => { d.style.background = 'rgba(91,79,255,0.15)'; };
            d.onmouseleave = () => { d.style.background = ''; };
            d.onclick = () => { const x = found[Number(d.dataset.i)]; close(); insert(text, `[${x.icon} ${x.title.replace(/[[\]]/g, '')}](${x.url}) `); };
          });
        }, 250);
      };
    });
  }

  /* ── Hľadanie ── */
  async function search(q) {
    if (q.length < 2) { if (cur.streamId) open(cur.streamId, cur.topic); return; }
    const s = su();
    const found = (await s.api('GET', qs(`${C}/search`, { q }))) || [];
    $('ch-head').innerHTML = `<div style="font-weight:700">🔍 Výsledky pre „${esc(q)}“</div>`;
    $('ch-compose').innerHTML = '';
    $('ch-msgs').innerHTML = found.map(m => {
      const st = streams.find(x => x.id === m.streamId) || { name: '', kind: 'stream' };
      return `<a href="#" data-hit="${m.id}" style="display:block;padding:0.55rem 0.6rem;border-bottom:1px solid rgba(255,255,255,0.06);color:#eeeef5">
        <div style="${s.muted}">${st.kind === 'dm' ? `💬 ${esc(st.name)}` : `# ${esc(st.name)} › ${esc(m.topic)}`} · ${esc(m.author.name)} · ${s.date(m.createdAt, { dateStyle: 'short', timeStyle: 'short' })}</div>
        <div style="font-size:0.88rem">${render(m.content)}</div></a>`;
    }).join('') || `<p style="${s.muted};padding:1rem 0">Nič sa nenašlo.</p>`;
    $('ch-msgs').querySelectorAll('[data-hit]').forEach(a => {
      a.onclick = e => { e.preventDefault(); const m = found.find(x => String(x.id) === a.dataset.hit); $('ch-q').value = ''; open(m.streamId, (streams.find(x => x.id === m.streamId) || {}).kind === 'dm' ? null : m.topic, m.id); };
    });
  }

  /* ── Kanály a priame správy ── */
  function streamDialog(st) {
    const s = su();
    const isNew = !st;
    const priv = st ? st.private : false;
    s.modal(isNew ? '# Nový kanál' : `⚙ #${esc(st.name)}`, `
      <div class="form-group"><label>Názov</label><input class="form-control" id="sd-name" value="${esc(st ? st.name : '')}" placeholder="napr. marketing"></div>
      <div class="form-group"><label>Popis</label><input class="form-control" id="sd-desc" value="${esc(st ? st.description : '')}" placeholder="O čom sa tu píše"></div>
      ${isNew ? '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:0.6rem"><input type="checkbox" id="sd-priv"> 🔒 Súkromný kanál (iba vybraní ľudia)</label>' : ''}
      <div class="form-group" id="sd-members" style="${priv ? '' : 'display:none'}"><label>Členovia</label>${s.members.filter(m => m.id !== me()).map(m => `<label style="display:flex;gap:0.4rem;align-items:center;font-size:0.86rem;padding:0.1rem 0"><input type="checkbox" data-mem="${esc(m.id)}" ${st && (st.members || []).includes(m.id) ? 'checked' : ''}> ${s.avatar(m.id, 20)} ${esc(m.name)}</label>`).join('') || `<div style="${s.muted}">Pozvite najprv kolegov do tímu (Nastavenia → Tím).</div>`}</div>
      <div style="display:flex;gap:0.5rem;align-items:center"><button class="btn btn-primary" id="sd-save">${isNew ? 'Vytvoriť' : 'Uložiť'}</button>
        ${isNew ? '' : `<button class="btn btn-secondary" id="sd-arch">${st.archived ? 'Obnoviť' : 'Archivovať'}</button>${s.role === 'owner' ? '<button class="btn btn-danger" id="sd-del" style="margin-left:auto">Zmazať</button>' : ''}`}</div>`, (el, close) => {
      if (el.querySelector('#sd-priv')) el.querySelector('#sd-priv').onchange = e => { el.querySelector('#sd-members').style.display = e.target.checked ? '' : 'none'; };
      const mem = () => [...el.querySelectorAll('[data-mem]')].filter(x => x.checked).map(x => x.dataset.mem);
      el.querySelector('#sd-save').onclick = async () => {
        const body = { name: el.querySelector('#sd-name').value, description: el.querySelector('#sd-desc').value };
        if (isNew) Object.assign(body, { private: el.querySelector('#sd-priv').checked, members: mem() });
        else if (priv) body.members = mem();
        const r = await s.api(isNew ? 'POST' : 'PATCH', isNew ? `${C}/streams` : `${C}/streams/${st.id}`, body, isNew ? 'Kanál vytvorený.' : 'Uložené.');
        if (r) { close(); await sidebar(); open(r.id, isNew ? null : cur.topic); }
      };
      if (el.querySelector('#sd-arch')) el.querySelector('#sd-arch').onclick = async () => { if (await s.api('PATCH', `${C}/streams/${st.id}`, { archived: !st.archived })) { close(); await sidebar(); open(st.id, null); } };
      if (el.querySelector('#sd-del')) el.querySelector('#sd-del').onclick = async () => {
        if (confirm(`Zmazať kanál #${st.name} so všetkými správami?`) && await s.api('DELETE', `${C}/streams/${st.id}`, undefined, 'Kanál zmazaný.')) { close(); cur = { streamId: null, topic: null }; load(); }
      };
    });
  }

  function dmDialog() {
    const s = su();
    const others = s.members.filter(m => m.id !== me());
    s.modal('💬 Nová priama správa', others.length ? `<div class="form-group">${others.map(m => `<label style="display:flex;gap:0.4rem;align-items:center;font-size:0.88rem;padding:0.15rem 0"><input type="checkbox" data-u="${esc(m.id)}"> ${s.avatar(m.id, 22)} ${esc(m.name)}</label>`).join('')}</div>
      <p style="${s.muted};margin-bottom:0.6rem">Vyberte jedného kolegu alebo viacerých (skupinová konverzácia).</p><button class="btn btn-primary" id="dm-go">Otvoriť konverzáciu</button>`
      : `<p style="${s.muted}">V tíme zatiaľ nikto nie je. Kolegov pozvete v Nastaveniach → Tím.</p>`, (el, close) => {
      if (!el.querySelector('#dm-go')) return;
      el.querySelector('#dm-go').onclick = async () => {
        const ids = [...el.querySelectorAll('[data-u]')].filter(x => x.checked).map(x => x.dataset.u);
        if (!ids.length) return showToast('Vyberte kolegu.', 'error');
        const d = await s.api('POST', `${C}/dm`, { userIds: ids });
        if (d) { close(); await sidebar(); open(d.id, null); }
      };
    });
  }
})();
