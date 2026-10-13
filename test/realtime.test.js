// Spolupráca v reálnom čase: lístky, udalosti priestoru, prítomnosť, zdieľané Yjs dokumenty, prepojenia.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const { startApp, newUser, getDb, wait } = require('./helpers');
const realtime = require('../services/realtime');
const links = require('../services/links');

realtime.registerDocType('test', { exists: (userId, ownerId, id) => id !== 'chyba' });
links.registerType('demo', { label: 'Demo', icon: '•', resolve: (ownerId, id) => (id === 'zmazane' ? null : { title: `Demo ${id}`, url: `/d/${id}` }) });

describe('spolupráca v reálnom čase', () => {
  let ctx, owner, editor, reader, stranger;
  const ticket = async (u) => (await u.api('POST', '/api/realtime/ticket')).body.ticket;
  const wsUrl = (path, t) => `${ctx.base.replace('http', 'ws')}${path}?ticket=${encodeURIComponent(t)}`;
  const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await wait(20); }
    return false;
  };
  function events(u) {
    return ticket(u).then((t) => new Promise((resolve, reject) => {
      const s = new WebSocket(wsUrl('/ws', t));
      s.got = [];
      s.on('message', (m) => s.got.push(JSON.parse(String(m))));
      s.on('open', () => resolve(s));
      s.on('error', reject);
    }));
  }
  async function provider(u, name) {
    const doc = new Y.Doc();
    const p = new WebsocketProvider(`${ctx.base.replace('http', 'ws')}/yjs`, name, doc, { WebSocketPolyfill: WebSocket, params: { ticket: await ticket(u) }, connect: true, disableBc: true });
    await new Promise((r) => p.once('sync', r));
    return { doc, p };
  }

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema' });
    editor = newUser(ctx, { name: 'Eva' });
    reader = newUser(ctx, { name: 'Rado' });
    stranger = newUser(ctx);
    const ins = getDb().prepare("INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES (?, ?, ?, ?, 1, ?)");
    ins.run('tm1', owner.id, editor.email, 'editor', editor.id);
    ins.run('tm2', owner.id, reader.email, 'readonly', reader.id);
  });
  after(() => ctx.close());

  it('bez platného lístka sa nepripojí; cudzí priestor nedostane udalosti', async () => {
    const bad = new WebSocket(wsUrl('/ws', 'zly.listok'));
    const err = await new Promise((r) => { bad.on('unexpected-response', (req, res) => r(res.statusCode)); bad.on('error', () => {}); });
    assert.equal(err, 401);
    const s = await events(stranger);
    s.send(JSON.stringify({ type: 'subscribe', ws: owner.id }));
    await wait(100);
    realtime.publish(owner.id, { type: 'ping' });
    await wait(100);
    assert.ok(!s.got.some((m) => m.type === 'ping'));
    s.close();
  });

  it('udalosti a prítomnosť v priestore; „píše…“ ide ostatným', async () => {
    const a = await events(owner);
    const b = await events(editor);
    a.send(JSON.stringify({ type: 'subscribe', ws: owner.id }));
    b.send(JSON.stringify({ type: 'subscribe', ws: owner.id }));
    b.send(JSON.stringify({ type: 'where', where: 'task:1' }));
    assert.ok(await until(() => a.got.some((m) => m.type === 'presence' && m.users.length === 2 && m.users.some((u) => u.where.includes('task:1')))));
    realtime.publish(owner.id, { type: 'task.updated', id: 't1' });
    assert.ok(await until(() => b.got.some((m) => m.type === 'task.updated')));
    b.send(JSON.stringify({ type: 'typing', ws: owner.id, topic: 'chat:vseobecne' }));
    assert.ok(await until(() => a.got.some((m) => m.type === 'typing' && m.user.name === 'Eva')));
    assert.ok(!b.got.some((m) => m.type === 'typing'));
    b.close();
    assert.ok(await until(() => a.got.filter((m) => m.type === 'presence').at(-1).users.length === 1));
    a.close();
  });

  it('zdieľaný dokument: zmeny sa šíria, ukladajú do DB a čitateľ ich nemôže meniť', async () => {
    const name = `test:${owner.id}:dok1`;
    const one = await provider(owner, name);
    const two = await provider(editor, name);
    one.doc.getText('t').insert(0, 'Ahoj tím');
    assert.ok(await until(() => two.doc.getText('t').toString() === 'Ahoj tím'));
    two.doc.getText('t').insert(8, '!');
    assert.ok(await until(() => one.doc.getText('t').toString() === 'Ahoj tím!'));

    const ro = await provider(reader, name);
    assert.equal(ro.doc.getText('t').toString(), 'Ahoj tím!');
    ro.doc.getText('t').insert(0, 'X');
    await wait(200);
    assert.equal(one.doc.getText('t').toString(), 'Ahoj tím!'); // zmena čitateľa sa neprijala
    for (const x of [one, two, ro]) { x.p.destroy(); x.doc.destroy(); }
    assert.ok(await until(() => !!getDb().prepare('SELECT 1 FROM yjs_docs WHERE name = ?').get(name)));
    assert.equal(realtime.readDoc(name).getText('t').toString(), 'Ahoj tím!');

    const again = await provider(editor, name);
    assert.equal(again.doc.getText('t').toString(), 'Ahoj tím!');
    again.p.destroy();
    again.doc.destroy();
  });

  it('dokument cudzieho priestoru ani neexistujúci sa neotvorí', async () => {
    const t = await ticket(stranger);
    const code = await new Promise((r) => { const s = new WebSocket(wsUrl(`/yjs/test:${owner.id}:dok1`, t)); s.on('unexpected-response', (q, res) => r(res.statusCode)); s.on('error', () => {}); });
    assert.equal(code, 404);
    const t2 = await ticket(owner);
    const code2 = await new Promise((r) => { const s = new WebSocket(wsUrl(`/yjs/test:${owner.id}:chyba`, t2)); s.on('unexpected-response', (q, res) => r(res.statusCode)); s.on('error', () => {}); });
    assert.equal(code2, 404);
  });

  it('prepojenia: obojsmerné, bez duplikátov, zmazaná položka zmizne; čitateľ neprepája', async () => {
    const L = '/api/realtime/links';
    assert.equal((await owner.api('POST', L, { a: { type: 'demo', id: '1' }, b: { type: 'demo', id: '2' } })).status, 200);
    await owner.api('POST', L, { a: { type: 'demo', id: '2' }, b: { type: 'demo', id: '1' } });
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM item_links WHERE owner_id = ?').get(owner.id).n, 1);
    assert.deepEqual((await owner.api('GET', `${L}?type=demo&id=2`)).body.map((x) => x.title), ['Demo 1']);
    assert.equal((await owner.api('POST', L, { a: { type: 'demo', id: '1' }, b: { type: 'demo', id: 'zmazane' } })).status, 400);
    assert.equal((await reader.api('POST', `${L}?ws=${owner.id}`, { a: { type: 'demo', id: '1' }, b: { type: 'demo', id: '3' } })).status, 403);
    assert.deepEqual((await editor.api('GET', `${L}?ws=${owner.id}&type=demo&id=1`)).body.map((x) => x.id), ['2']);
    assert.equal((await stranger.api('GET', `${L}?ws=${owner.id}&type=demo&id=1`)).status, 404);
    const members = (await reader.api('GET', `/api/realtime/members?ws=${owner.id}`)).body;
    assert.deepEqual(members.map((m) => m.role).sort(), ['editor', 'owner', 'readonly']);
  });
});
