// Tímová sada fáza 3: tabuľky – Disk, bunky cez Yjs, iba na čítanie, hľadanie, kôš.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const { extraRoutes, startApp, newUser, getDb, wait } = require('./helpers');

extraRoutes.push({ path: '/api/sheets', module: '../routes/sheets' });

describe('tabuľky', () => {
  let ctx, owner, eva, rado;
  const as = (u, m, p, b) => u.api(m, `${p}${p.includes('?') ? '&' : '?'}ws=${owner.id}`, b);
  const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };
  async function connect(u, room) {
    const ticket = (await u.api('POST', '/api/realtime/ticket')).body.ticket;
    const ydoc = new Y.Doc();
    const p = new WebsocketProvider(`${ctx.base.replace('http', 'ws')}/yjs`, room, ydoc, { WebSocketPolyfill: WebSocket, params: { ticket }, disableBc: true });
    await new Promise((r) => p.once('sync', r));
    return { ydoc, els: ydoc.getMap('cells'), close: () => { p.destroy(); ydoc.destroy(); } };
  }

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema Nováková' });
    eva = newUser(ctx, { name: 'Eva Malá' });
    rado = newUser(ctx, { name: 'Rado' });
    const ins = getDb().prepare('INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES (?, ?, ?, ?, 1, ?)');
    ins.run('h1', owner.id, eva.email, 'editor', eva.id);
    ins.run('h2', owner.id, rado.email, 'readonly', rado.id);
  });
  after(() => ctx.close());

  it('tabuľka je na Disku v priečinku Tabuľky; bunky sa zdieľajú; readonly nemení; text ide do hľadania; kôš ju schová', async () => {
    const b = (await owner.api('POST', '/api/sheets', { title: 'Rozpočet 2027' })).body;
    const item = getDb().prepare('SELECT * FROM drive_items WHERE id = ?').get(b.driveItemId);
    assert.deepEqual([item.name, item.ref], ['Rozpočet 2027', `sheet:${b.id}`]);
    assert.equal(getDb().prepare('SELECT name FROM drive_items WHERE id = ?').get(item.parent_id).name, 'Tabuľky');
    const meta = (await as(eva, 'GET', `/api/sheets/${b.id}`)).body;
    assert.equal(meta.room, `sheet:${owner.id}:${b.id}`);

    const e = await connect(eva, meta.room);
    const r = await connect(rado, meta.room);
    e.els.set('s1:0:0', { v: 'Reklama' });
    e.els.set('s1:0:1', { v: '1200' });
    e.els.set('s1:1:1', { v: '=SUM(B1:B1)' });
    assert.ok(await until(() => r.els.size === 3));
    r.els.set('s1:5:5', { v: 'Zakázané' });
    await wait(200);
    assert.equal(e.els.has('s1:5:5'), false);
    e.close(); r.close();
    assert.ok(await until(() => getDb().prepare('SELECT text FROM sheets WHERE id = ?').get(b.id).text === 'Reklama 1200'));
    assert.equal((await owner.api('GET', '/api/sheets?q=reklama')).body.length, 1);
    const found = (await owner.api('GET', '/api/realtime/search?q=rozpočet')).body;
    assert.deepEqual(found.map((x) => [x.type, x.title]), [['sheet', 'Rozpočet 2027']]);
    assert.equal((await as(rado, 'PATCH', `/api/sheets/${b.id}`, { title: 'X' })).status, 403);

    await owner.api('DELETE', `/api/sheets/${b.id}`);
    assert.equal((await owner.api('GET', `/api/sheets/${b.id}`)).status, 404);
    await owner.api('DELETE', `/api/drive/trash/${item.id}`);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sheets WHERE id = ?').get(b.id).n, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM yjs_docs WHERE name = ?').get(meta.room).n, 0);
  });
});
