/* Spolupráca v reálnom čase v dashboarde: udalosti priestoru, kto je online, „píše…“.
   NW.rt.on('task.updated', fn), NW.rt.workspace(ownerId), NW.rt.where('task:123'), NW.rt.typing(topic).
   Používa apiFetch z dashboard.js. */
(function () {
  'use strict';
  const handlers = new Map();
  let socket = null;
  let ws = null;        // priestor, ktorého udalosti chceme
  let where = '';
  let retry = 0;
  let presence = [];

  function emit(type, data) { (handlers.get(type) || []).concat(handlers.get('*') || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

  async function connect() {
    if (socket && socket.readyState <= 1) return;
    let t;
    try {
      const r = await apiFetch('/api/realtime/ticket', { method: 'POST' });
      if (!r || !r.ok) throw new Error('ticket');
      t = (await r.json()).ticket;
    } catch { return schedule(); }
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?ticket=${encodeURIComponent(t)}`);
    socket.onopen = () => {
      retry = 0;
      if (ws) socket.send(JSON.stringify({ type: 'subscribe', ws }));
      if (where) socket.send(JSON.stringify({ type: 'where', where }));
      emit('connected', {});
    };
    socket.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'presence') presence = m.users;
      emit(m.type, m);
    };
    socket.onclose = () => { emit('disconnected', {}); schedule(); };
  }
  function schedule() { setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++)); }
  const send = obj => { if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj)); };

  window.NW = window.NW || {};
  window.NW.rt = {
    on(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); return () => handlers.set(type, handlers.get(type).filter(f => f !== fn)); },
    workspace(ownerId) { if (ws === ownerId) return; ws = ownerId; send({ type: 'subscribe', ws }); connect(); },
    where(w) { where = w || ''; send({ type: 'where', where }); },
    typing(topic) { send({ type: 'typing', ws, topic }); },
    presence: () => presence,
    async ticket() { const r = await apiFetch('/api/realtime/ticket', { method: 'POST' }); return r && r.ok ? (await r.json()).ticket : null; },
    connect,
  };
})();
