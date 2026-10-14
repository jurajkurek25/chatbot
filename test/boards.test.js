// Tímová sada fáza 3: tabule (Excalidraw) – Disk, spolupráca cez Yjs, iba na čítanie, hľadanie, kôš.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const { extraRoutes, startApp, newUser, getDb, wait } = require('./helpers');

extraRoutes.push({ path: '/api/boards', module: '../routes/boards' });

describe('tabule', () => {
  let ctx, owner, eva, rado;
  const as = (u, m, p, b) => u.api(m, `${p}${p.includes('?') ? '&' : '?'}ws=${owner.id}`, b);
  const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };
  async function connect(u, room) {
    const ticket = (await u.api('POST', '/api/realtime/ticket')).body.ticket;
    const ydoc = new Y.Doc();
    const p = new WebsocketProvider(`${ctx.base.replace('http', 'ws')}/yjs`, room, ydoc, { WebSocketPolyfill: WebSocket, params: { ticket }, disableBc: true });
    await new Promise((r) => p.once('sync', r));
    return { ydoc, els: ydoc.getMap('elements'), close: () => { p.destroy(); ydoc.destroy(); } };
  }

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema Nováková' });
    eva = newUser(ctx, { name: 'Eva Malá' });
    rado = newUser(ctx, { name: 'Rado' });
    const ins = getDb().prepare('INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES (?, ?, ?, ?, 1, ?)');
    ins.run('b1', owner.id, eva.email, 'editor', eva.id);
    ins.run('b2', owner.id, rado.email, 'readonly', rado.id);
  });
  after(() => ctx.close());

  it('tabuľa je na Disku v priečinku Tabule; kreslenie sa zdieľa; readonly nemení; text ide do hľadania; kôš ju schová', async () => {
    const b = (await owner.api('POST', '/api/boards', { title: 'Mapa webu' })).body;
    const item = getDb().prepare('SELECT * FROM drive_items WHERE id = ?').get(b.driveItemId);
    assert.deepEqual([item.name, item.ref], ['Mapa webu', `board:${b.id}`]);
    assert.equal(getDb().prepare('SELECT name FROM drive_items WHERE id = ?').get(item.parent_id).name, 'Tabule');
    const meta = (await as(eva, 'GET', `/api/boards/${b.id}`)).body;
    assert.equal(meta.room, `board:${owner.id}:${b.id}`);
    assert.equal(meta.folderId, item.parent_id);

    const e = await connect(eva, meta.room);
    const r = await connect(rado, meta.room);
    e.els.set('t1', { id: 't1', type: 'text', text: 'Domovská stránka', version: 1, isDeleted: false });
    e.els.set('r1', { id: 'r1', type: 'rectangle', version: 1, isDeleted: false });
    assert.ok(await until(() => r.els.size === 2));
    // readonly zmena sa na server nedostane
    r.els.set('x', { id: 'x', type: 'text', text: 'Zakázané', version: 1 });
    await wait(200);
    assert.equal(e.els.has('x'), false);
    e.close(); r.close();
    assert.ok(await until(() => getDb().prepare('SELECT text FROM boards WHERE id = ?').get(b.id).text === 'Domovská stránka'));
    assert.equal((await owner.api('GET', '/api/boards?q=domovská')).body.length, 1);
    const found = (await owner.api('GET', '/api/realtime/search?q=mapa')).body;
    assert.deepEqual(found.map((x) => [x.type, x.title]), [['board', 'Mapa webu']]);

    assert.equal((await as(rado, 'PATCH', `/api/boards/${b.id}`, { title: 'X' })).status, 403);
    assert.equal((await as(eva, 'PATCH', `/api/boards/${b.id}`, { title: 'Mapa webu 2026' })).body.title, 'Mapa webu 2026');
    assert.equal(getDb().prepare('SELECT name FROM drive_items WHERE id = ?').get(item.id).name, 'Mapa webu 2026');

    await owner.api('DELETE', `/api/boards/${b.id}`);
    assert.equal((await owner.api('GET', `/api/boards/${b.id}`)).status, 404);
    await owner.api('DELETE', `/api/drive/trash/${item.id}`);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM boards WHERE id = ?').get(b.id).n, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM yjs_docs WHERE name = ?').get(meta.room).n, 0);
  });
});
