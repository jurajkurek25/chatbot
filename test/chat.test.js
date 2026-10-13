// Tímová sada fáza 2: chat (kanály, témy, súkromné kanály, priame správy, zmienky) a videohovory (Jitsi).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { extraRoutes, startApp, newUser, getDb, mails, wait } = require('./helpers');

extraRoutes.push(
  { path: '/api/chat', module: '../routes/chat' }, { path: '/api/meet', module: '../routes/meet' },
  { path: '/api/tasks', module: '../routes/tasks' },
);

describe('tímový chat a videohovory', () => {
  let ctx, owner, eva, rado, stranger, general;
  const C = '/api/chat';
  const as = (u, m, p, b) => u.api(m, `${p}${p.includes('?') ? '&' : '?'}ws=${owner.id}`, b);
  const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };
  async function listen(u) {
    const ticket = (await u.api('POST', '/api/realtime/ticket')).body.ticket;
    const sock = new WebSocket(`${ctx.base.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const got = [];
    sock.on('message', (m) => got.push(JSON.parse(String(m))));
    await new Promise((r) => sock.on('open', r));
    sock.send(JSON.stringify({ type: 'subscribe', ws: owner.id }));
    await wait(50);
    return { got, close: () => sock.close() };
  }

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema Nováková' });
    eva = newUser(ctx, { name: 'Eva Malá' });
    rado = newUser(ctx, { name: 'Rado' });
    stranger = newUser(ctx);
    const ins = getDb().prepare('INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES (?, ?, ?, ?, 1, ?)');
    ins.run('c1', owner.id, eva.email, 'editor', eva.id);
    ins.run('c2', owner.id, rado.email, 'readonly', rado.id);
  });
  after(() => ctx.close());

  it('prvé otvorenie založí #všeobecné; správy v témach, neprečítané a prečítanie', async () => {
    const streams = (await as(eva, 'GET', `${C}/streams`)).body;
    assert.deepEqual(streams.map((s) => s.name), ['všeobecné']);
    general = streams[0];
    const live = await listen(eva);
    const m = (await as(owner, 'POST', `${C}/streams/${general.id}/messages`, { topic: 'Spustenie webu', content: 'Ahojte, web ide v piatok.' })).body;
    await as(owner, 'POST', `${C}/streams/${general.id}/messages`, { topic: 'Obed', content: 'Kto ide na obed?' });
    assert.equal(m.topic, 'Spustenie webu');
    assert.ok(await until(() => live.got.some((e) => e.type === 'chat' && e.op === 'new' && e.message.id === m.id)));
    live.close();
    assert.equal((await as(eva, 'GET', `${C}/unread`)).body.unread, 2);
    const topics = (await as(eva, 'GET', `${C}/streams/${general.id}/topics`)).body;
    assert.deepEqual(topics.map((t) => [t.topic, t.unread]), [['Obed', 1], ['Spustenie webu', 1]]);
    const msgs = (await as(eva, 'GET', `${C}/streams/${general.id}/messages?topic=${encodeURIComponent('Spustenie webu')}`)).body;
    assert.deepEqual(msgs.messages.map((x) => x.content), ['Ahojte, web ide v piatok.']);
    assert.equal((await as(eva, 'POST', `${C}/streams/${general.id}/read`, { topic: 'Spustenie webu' })).body.unread, 1);
    assert.equal((await as(eva, 'POST', `${C}/streams/${general.id}/read`, {})).body.unread, 0);
    // autor vlastné správy neráta ako neprečítané
    assert.equal((await as(owner, 'GET', `${C}/unread`)).body.unread, 0);
  });

  it('@**zmienka** upozorní (aj e-mailom); readonly píše, ale kanál nezaloží; cudzí nevidí nič', async () => {
    await as(rado, 'POST', `${C}/streams/${general.id}/messages`, { topic: 'Spustenie webu', content: '@**Eva Malá** pozrieš texty?' });
    const n = (await eva.api('GET', '/api/realtime/notifications')).body.items;
    assert.match(n[0].title, /Rado vás spomenul\/a v #všeobecné › Spustenie webu/);
    assert.match(n[0].url, /view=chat/);
    assert.ok(await until(() => mails.some((x) => x.to === eva.email && /spomenul/.test(x.subject))));
    assert.equal((await as(rado, 'POST', `${C}/streams`, { name: 'marketing' })).status, 403);
    assert.equal((await as(stranger, 'GET', `${C}/streams`)).status, 404);
    assert.equal((await stranger.api('GET', `${C}/streams/${general.id}/messages`)).status, 404);
  });

  it('súkromný kanál vidia iba jeho členovia; priame správy', async () => {
    const priv = (await as(owner, 'POST', `${C}/streams`, { name: 'vedenie', private: true, members: [eva.id] })).body;
    assert.deepEqual(priv.members.sort(), [owner.id, eva.id].sort());
    assert.ok((await as(eva, 'GET', `${C}/streams`)).body.some((s) => s.id === priv.id));
    assert.ok(!(await as(rado, 'GET', `${C}/streams`)).body.some((s) => s.id === priv.id));
    assert.equal((await as(rado, 'GET', `${C}/streams/${priv.id}/messages`)).status, 404);
    // @**všetci** v súkromnom kanáli neupozorní Rada
    await as(owner, 'POST', `${C}/streams/${priv.id}/messages`, { topic: 'Rozpočet', content: '@**všetci** porada o 10:00' });
    assert.ok(!(await rado.api('GET', '/api/realtime/notifications')).body.items.some((x) => x.type === 'chat.mention'));
    assert.ok((await eva.api('GET', '/api/realtime/notifications')).body.items.some((x) => /vedenie › Rozpočet/.test(x.title)));

    const dm = (await as(eva, 'POST', `${C}/dm`, { userIds: [rado.id] })).body;
    assert.equal(dm.kind, 'dm');
    assert.equal(dm.name, 'Rado');
    assert.equal((await as(rado, 'POST', `${C}/dm`, { userIds: [eva.id] })).body.id, dm.id); // tá istá konverzácia
    assert.equal((await as(eva, 'POST', `${C}/dm`, { userIds: [stranger.id] })).status, 400);
    await as(eva, 'POST', `${C}/streams/${dm.id}/messages`, { content: 'Ahoj Rado' });
    // Rado nie je pripojený → upozornenie na priamu správu
    assert.ok((await rado.api('GET', '/api/realtime/notifications')).body.items.some((x) => x.type === 'chat.dm' && /Eva Malá/.test(x.title)));
    assert.equal((await as(owner, 'GET', `${C}/streams/${dm.id}/messages`)).status, 404);
  });

  it('úprava, reakcia, mazanie; zo správy úloha s prepojením', async () => {
    const m = (await as(eva, 'POST', `${C}/streams/${general.id}/messages`, { topic: 'Spustenie webu', content: 'Treba objednať doménu @**Ema Nováková**' })).body;
    assert.equal((await as(rado, 'PATCH', `${C}/messages/${m.id}`, { content: 'x' })).status, 403);
    const ed = (await as(eva, 'PATCH', `${C}/messages/${m.id}`, { content: 'Treba objednať doménu .sk @**Ema Nováková**' })).body;
    assert.ok(ed.editedAt);
    const r = (await as(rado, 'POST', `${C}/messages/${m.id}/react`, { emoji: '👍' })).body;
    assert.deepEqual(r.reactions, { '👍': [rado.id] });
    assert.deepEqual((await as(rado, 'POST', `${C}/messages/${m.id}/react`, { emoji: '👍' })).body.reactions, {});
    const t = (await as(owner, 'POST', `${C}/messages/${m.id}/to-task`, {})).body;
    assert.equal(t.title, 'Treba objednať doménu .sk @Ema Nováková');
    assert.deepEqual(t.assignees, [owner.id]);
    const rel = (await as(owner, 'GET', `/api/realtime/links?type=task&id=${t.id}`)).body;
    assert.equal(rel[0].type, 'message');
    assert.match(rel[0].title, /#všeobecné › Spustenie webu/);
    assert.equal((await as(rado, 'DELETE', `${C}/messages/${m.id}`)).status, 403);
    assert.equal((await as(owner, 'DELETE', `${C}/messages/${m.id}`)).status, 200);
    assert.deepEqual((await as(owner, 'GET', `/api/realtime/links?type=task&id=${t.id}`)).body, []);
    const found = (await as(eva, 'GET', `${C}/search?q=obed`)).body;
    assert.deepEqual(found.map((x) => x.topic), ['Obed']);
  });

  it('príloha sa uloží na Disk do priečinka Chat', async () => {
    const fd = new FormData();
    fd.append('files', new Blob(['logo']), 'logo.png');
    const token = jwt.sign({ userId: eva.id }, process.env.JWT_SECRET);
    const files = await (await fetch(`${ctx.base}${C}/streams/${general.id}/files?ws=${owner.id}`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(files.map((f) => f.name), ['logo.png']);
    const m = (await as(eva, 'POST', `${C}/streams/${general.id}/messages`, { topic: 'Logo', content: '', files: [files[0].id, 'cudzie-id'] })).body;
    assert.deepEqual(m.files.map((f) => f.name), ['logo.png']);
    assert.equal(getDb().prepare("SELECT name FROM drive_items WHERE owner_id = ? AND system = 'chat-files'").get(owner.id).name, 'Chat');
  });

  it('videohovor z chatu a z úlohy; pripojiť sa môže iba člen tímu (JWT pre vlastný Jitsi)', async () => {
    const m = (await as(eva, 'POST', `${C}/streams/${general.id}/meet`, { topic: 'Porada' })).body;
    assert.match(m.meeting, /^neoworkly-/);
    assert.equal(m.topic, 'Porada');
    const j = (await rado.api('GET', `/api/meet/${m.meeting}`)).body;
    assert.equal(j.url, `https://meet.jit.si/${m.meeting}`);
    assert.equal(j.embed, false);
    assert.equal((await stranger.api('GET', `/api/meet/${m.meeting}`)).status, 404);
    Object.assign(process.env, { JITSI_DOMAIN: 'meet.firma.sk', JITSI_APP_ID: 'neoworkly', JITSI_APP_SECRET: 'tajne' });
    try {
      const k = (await owner.api('GET', `/api/meet/${m.meeting}`)).body;
      assert.equal(k.embed, true);
      const claims = jwt.verify(k.jwt, 'tajne');
      assert.deepEqual([claims.room, claims.sub, claims.iss, claims.context.user.name, claims.context.user.moderator], [m.meeting, 'meet.firma.sk', 'neoworkly', 'Ema Nováková', true]);
      assert.ok(k.url.startsWith(`https://meet.firma.sk/${m.meeting}?jwt=`));
    } finally {
      delete process.env.JITSI_DOMAIN; delete process.env.JITSI_APP_ID; delete process.env.JITSI_APP_SECRET;
    }
    const task = (await owner.api('POST', '/api/tasks/tasks', { title: 'Návrh loga', assignees: [owner.id] })).body;
    const r = (await owner.api('POST', `/api/tasks/tasks/${task.id}/meet`, {})).body;
    assert.match(r.comment.body, new RegExp(`🎥 Videohovor k úlohe: https://meet.jit.si/${r.room}`));
    assert.equal((await owner.api('GET', `/api/meet/${r.room}`)).status, 200);
  });
});
