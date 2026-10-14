// Tímová sada fáza 1: úlohy, kalendár, poznámky, dokumenty – tím, prepojenia, upozornenia, reálny čas.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const { extraRoutes, startApp, newUser, getDb, mails, wait } = require('./helpers');

extraRoutes.push(
  { path: '/api/tasks', module: '../routes/tasks' }, { path: '/api/calendar', module: '../routes/calendar' },
  { path: '/api/notes', module: '../routes/notes' }, { path: '/api/docs', module: '../routes/docs' },
);
const tasks = require('../services/tasks');
const { zonedToUtc, todayInTz, addDays } = require('../services/bookingCore');

describe('tímová sada: úlohy, kalendár, poznámky, dokumenty', () => {
  let ctx, owner, eva, rado, stranger, project;
  const T = '/api/tasks';
  const as = (u, m, p, b) => u.api(m, `${p}${p.includes('?') ? '&' : '?'}ws=${owner.id}`, b);
  const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema Nováková' });
    eva = newUser(ctx, { name: 'Eva Malá' });
    rado = newUser(ctx, { name: 'Rado' });
    stranger = newUser(ctx);
    const ins = getDb().prepare('INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES (?, ?, ?, ?, 1, ?)');
    ins.run('s1', owner.id, eva.email, 'editor', eva.id);
    ins.run('s2', owner.id, rado.email, 'readonly', rado.id);
  });
  after(() => ctx.close());

  it('projekt má stĺpce kanbanu; rýchle zadanie rozpozná termín, prioritu, štítok a riešiteľa', async () => {
    project = (await owner.api('POST', `${T}/projects`, { name: 'Web', color: '#22c55e' })).body;
    const full = (await owner.api('GET', `${T}/projects/${project.id}`)).body;
    assert.deepEqual(full.buckets.map((b) => [b.name, b.isDone]), [['Na spracovanie', false], ['Robí sa', false], ['Hotovo', true]]);
    const t = (await owner.api('POST', `${T}/tasks`, { projectId: project.id, title: 'Zavolať Jane zajtra o 14:30 !3 #klient @eva', quick: true })).body;
    assert.equal(t.title, 'Zavolať Jane');
    assert.equal(t.priority, 3);
    assert.deepEqual(t.assignees, [eva.id]);
    assert.equal(t.dueAt, zonedToUtc(addDays(todayInTz('Europe/Bratislava'), 1), '14:30', 'Europe/Bratislava'));
    const labels = (await owner.api('GET', `${T}/labels`)).body;
    assert.deepEqual(labels.map((l) => l.name), ['klient']);
    assert.deepEqual(t.labels, [labels[0].id]);
    // pridelenie => upozornenie aj e-mail
    const n = (await eva.api('GET', '/api/realtime/notifications')).body;
    assert.equal(n.unread, 1);
    assert.match(n.items[0].title, /Nová úloha: Zavolať Jane/);
    assert.ok(await until(() => mails.some((m) => m.to === eva.email && /Nová úloha/.test(m.subject))));
    const p = tasks.parseQuickAdd(owner.id, 'Faktúra do 15.11. #účtovníctvo');
    assert.deepEqual([p.title, p.labels], ['Faktúra', ['účtovníctvo']]);
  });

  it('hotovo ↔ stĺpec „Hotovo“; opakovaná úloha sa posunie; podúlohy a mazanie', async () => {
    const full = (await owner.api('GET', `${T}/projects/${project.id}`)).body;
    const [open, , done] = full.buckets;
    const t = (await owner.api('POST', `${T}/tasks`, { projectId: project.id, title: 'Napísať text' })).body;
    assert.equal(t.bucketId, open.id);
    const moved = (await owner.api('PATCH', `${T}/tasks/${t.id}`, { bucketId: done.id })).body;
    assert.equal(moved.done, true);
    const back = (await owner.api('PATCH', `${T}/tasks/${t.id}`, { done: false })).body;
    assert.deepEqual([back.done, back.bucketId], [false, open.id]);

    const due = Math.floor(Date.now() / 1000) + 3600;
    const rep = (await owner.api('POST', `${T}/tasks`, { projectId: project.id, title: 'Týždenný report', dueAt: due })).body;
    await owner.api('PATCH', `${T}/tasks/${rep.id}`, { repeatDays: 7 });
    const r2 = (await owner.api('PATCH', `${T}/tasks/${rep.id}`, { bucketId: done.id })).body;
    assert.deepEqual([r2.done, r2.dueAt, r2.bucketId], [false, due + 7 * 86400, open.id]);
    assert.match((await owner.api('GET', `${T}/tasks/${rep.id}`)).body.comments[0].body, /Opakovaná úloha/);

    const sub = (await owner.api('POST', `${T}/tasks`, { projectId: project.id, parentId: t.id, title: 'Podúloha' })).body;
    assert.deepEqual((await owner.api('GET', `${T}/tasks/${t.id}`)).body.subtaskList.map((x) => x.id), [sub.id]);
    await owner.api('DELETE', `${T}/tasks/${t.id}`);
    assert.equal((await owner.api('GET', `${T}/tasks/${sub.id}`)).status, 404);
  });

  it('tím: editor pracuje, čitateľ iba číta, cudzí nič; zmeny idú cez WebSocket', async () => {
    const t = (await as(eva, 'POST', `${T}/tasks`, { projectId: project.id, title: 'Od Evy' })).body;
    assert.ok(t.id);
    assert.equal((await as(rado, 'GET', `${T}/projects/${project.id}`)).status, 200);
    assert.equal((await as(rado, 'PATCH', `${T}/tasks/${t.id}`, { title: 'X' })).status, 403);
    assert.equal((await as(stranger, 'GET', `${T}/projects`)).status, 404);

    const ticket = (await owner.api('POST', '/api/realtime/ticket')).body.ticket;
    const sock = new WebSocket(`${ctx.base.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const got = [];
    sock.on('message', (m) => got.push(JSON.parse(String(m))));
    await new Promise((r) => sock.on('open', r));
    sock.send(JSON.stringify({ type: 'subscribe', ws: owner.id }));
    await wait(50);
    await as(eva, 'POST', `${T}/tasks/${t.id}/comments`, { body: 'Hotovo do piatku' });
    assert.ok(await until(() => got.some((m) => m.type === 'task' && m.id === t.id && m.action === 'comment')));
    sock.close();
    // komentár upozorní autora úlohy (Evu nie – je autorkou komentára)
    assert.ok(!(await eva.api('GET', '/api/realtime/notifications')).body.items.some((x) => x.type === 'task.comment'));
  });

  it('príloha úlohy sa uloží na Disk a prepojí; moje úlohy a pripomienka', async () => {
    const t = (await owner.api('POST', `${T}/tasks`, { projectId: project.id, title: 'Zmluva', assignees: [owner.id], dueAt: Math.floor(Date.now() / 1000) + 600 })).body;
    const fd = new FormData();
    fd.append('files', new Blob(['zmluva']), 'zmluva.pdf');
    const token = require('jsonwebtoken').sign({ userId: owner.id }, process.env.JWT_SECRET);
    const up = await fetch(`${ctx.base}${T}/tasks/${t.id}/files`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${token}` } });
    const rel = await up.json();
    assert.deepEqual(rel.map((x) => [x.type, x.title]), [['file', 'zmluva.pdf']]);
    const folder = getDb().prepare("SELECT name FROM drive_items WHERE owner_id = ? AND system = 'task-files'").get(owner.id);
    assert.equal(folder.name, 'Prílohy úloh');
    const ov = (await owner.api('GET', `${T}/overview`)).body;
    assert.ok(ov.mine.some((x) => x.id === t.id));
    assert.ok(ov.upcoming.some((x) => x.id === t.id));

    await owner.api('PATCH', `${T}/tasks/${t.id}`, { remindAt: Math.floor(Date.now() / 1000) - 1 });
    assert.equal(tasks.remindDue(), 1);
    assert.equal(tasks.remindDue(), 0); // iba raz
    assert.ok((await owner.api('GET', '/api/realtime/notifications')).body.items.some((x) => /Pripomienka: Zmluva/.test(x.title)));
  });

  it('kalendár: udalosť s účastníkom a videohovorom, týždenné opakovanie, úlohy a rezervácie v jednom pohľade, ICS', async () => {
    const start = zonedToUtc(addDays(todayInTz('Europe/Bratislava'), 1), '09:00', 'Europe/Bratislava');
    const e = (await owner.api('POST', '/api/calendar/events', {
      title: 'Porada', start: new Date(start * 1000).toISOString(), end: new Date((start + 3600) * 1000).toISOString(),
      repeat: 'weekly', attendees: [eva.id, stranger.id], meeting: true,
    })).body;
    assert.deepEqual(e.attendees, [eva.id]); // cudzí nie je člen tímu
    assert.match(e.meeting, /^https:\/\/meet\.jit\.si\/neoworkly-/);
    assert.ok((await eva.api('GET', '/api/realtime/notifications')).body.items.some((x) => x.title === 'Pozvánka: Porada'));

    const from = new Date((start - 86400) * 1000).toISOString();
    const to = new Date((start + 27 * 86400) * 1000).toISOString();
    const feed = (await owner.api('GET', `/api/calendar/events?start=${from}&end=${to}`)).body;
    const meetings = feed.filter((x) => x.extendedProps.kind === 'event');
    assert.equal(meetings.length, 4); // 4 týždne
    assert.ok(feed.some((x) => x.extendedProps.kind === 'task'));
    // presun jedného výskytu posunie celú sériu o hodinu
    const occ = meetings[1];
    await owner.api('PATCH', `/api/calendar/events/${e.id}`, { occurrence: occ.start, start: new Date(Date.parse(occ.start) + 3600000).toISOString(), end: new Date(Date.parse(occ.end) + 3600000).toISOString() });
    assert.equal(getDb().prepare('SELECT start_at FROM calendar_events WHERE id = ?').get(e.id).start_at, start + 3600);
    assert.equal((await as(rado, 'POST', '/api/calendar/events', { title: 'x', start: from })).status, 403);

    const { url } = (await eva.api('GET', '/api/calendar/feed')).body;
    const ics = await (await fetch(url.replace(/^https?:\/\/[^/]+/, ctx.base))).text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Porada/);
    assert.match(ics, /RRULE:FREQ=WEEKLY/);
    assert.match(ics, /Videohovor: https:\/\/meet\.jit\.si/);
    assert.equal((await fetch(`${ctx.base}/api/calendar/ics/zly.ics`)).status, 404);
  });

  it('poznámky: #štítky, súkromné, pripnutie, iba autor upravuje text, z poznámky úloha s prepojením', async () => {
    const n1 = (await owner.api('POST', '/api/notes', { content: 'Nápad na #kampan pre jeseň\nViac fotiek z ateliéru' })).body;
    await eva.api('POST', `/api/notes?ws=${owner.id}`, { content: 'Moje súkromné #tajne', visibility: 'private' });
    assert.deepEqual(n1.tags, ['kampan']);
    assert.ok(!(await owner.api('GET', '/api/notes')).body.some((n) => n.visibility === 'private'));
    assert.deepEqual((await as(eva, 'GET', '/api/notes?tag=tajne')).body.length, 1);
    assert.equal((await as(eva, 'PATCH', `/api/notes/${n1.id}`, { content: 'zmena' })).status, 403);
    await owner.api('PATCH', `/api/notes/${n1.id}`, { pinned: true });
    const task = (await owner.api('POST', `/api/notes/${n1.id}/to-task`, { projectId: project.id })).body;
    assert.deepEqual([task.title, task.description], ['Nápad na kampan pre jeseň', 'Viac fotiek z ateliéru']);
    const rel = (await owner.api('GET', `/api/realtime/links?type=task&id=${task.id}`)).body;
    assert.deepEqual(rel.map((r) => r.type), ['note']);
    assert.deepEqual((await owner.api('GET', '/api/notes/tags')).body.map((t) => t.tag), ['kampan']);
  });

  it('dokument: na Disku ako položka, spolupráca cez Yjs, text do vyhľadávania, kôš ho schová, trvalé zmazanie vyčistí', async () => {
    const d = (await owner.api('POST', '/api/docs', { title: 'Plán kampane' })).body;
    const item = getDb().prepare('SELECT * FROM drive_items WHERE id = ?').get(d.driveItemId);
    assert.deepEqual([item.name, item.ref], ['Plán kampane', `doc:${d.id}`]);
    const listed = (await owner.api('GET', `/api/drive/items?parent=${item.parent_id}`)).body.items[0];
    assert.equal(listed.openUrl, `/docs/${d.id}?ws=${owner.id}`);
    const meta = (await as(eva, 'GET', `/api/docs/${d.id}`)).body;
    assert.equal(meta.room, `doc:${owner.id}:${d.id}`);

    const ticket = (await eva.api('POST', '/api/realtime/ticket')).body.ticket;
    const ydoc = new Y.Doc();
    const p = new WebsocketProvider(`${ctx.base.replace('http', 'ws')}/yjs`, meta.room, ydoc, { WebSocketPolyfill: WebSocket, params: { ticket }, disableBc: true });
    await new Promise((r) => p.once('sync', r));
    const frag = ydoc.getXmlFragment('document-store');
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Rozpočet 500 eur na reklamu');
    para.insert(0, [text]);
    frag.insert(0, [para]);
    p.destroy();
    ydoc.destroy();
    assert.ok(await until(() => getDb().prepare('SELECT text FROM docs WHERE id = ?').get(d.id).text.includes('500 eur'), 4000));
    assert.equal((await owner.api('GET', '/api/docs?q=rozpocet')).body.length, 0);
    assert.equal((await owner.api('GET', '/api/docs?q=rozpočet')).body.length, 1);

    // do znalostí chatbota z Disku
    const widgetId = require('crypto').randomUUID();
    getDb().prepare("INSERT INTO widgets (id, user_id, name) VALUES (?, ?, 'Web')").run(widgetId, owner.id);
    assert.equal((await owner.api('POST', `/api/drive/items/${item.id}/to-knowledge`, { widgetId })).status, 200);
    assert.equal((await owner.api('POST', `/api/drive/items/${item.id}/to-lead-magnet`, { leadMagnetId: 'x' })).status, 400);

    await owner.api('DELETE', `/api/docs/${d.id}`);
    assert.equal((await owner.api('GET', `/api/docs/${d.id}`)).status, 404);
    await owner.api('POST', `/api/drive/trash/${item.id}/restore`);
    assert.equal((await owner.api('GET', `/api/docs/${d.id}`)).status, 200);
    await owner.api('DELETE', `/api/drive/items/${item.id}`);
    await owner.api('DELETE', `/api/drive/trash/${item.id}`);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM docs WHERE id = ?').get(d.id).n, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM yjs_docs WHERE name = ?').get(meta.room).n, 0);
  });
});
