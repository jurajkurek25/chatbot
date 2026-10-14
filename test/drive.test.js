// Disk: súbory, kôš, kvóta, tím, zdieľanie odkazom, priečinky klientov, prepojenie s modulmi.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { startApp, request, newUser, mails, getDb, wait } = require('./helpers');
const shop = require('../services/shop');
const drive = require('../services/drive');

describe('Disk', () => {
  let ctx, owner, other, folder, sub, file;
  const D = '/api/drive';
  const bearer = (u) => ({ authorization: `Bearer ${jwt.sign({ userId: u.id }, process.env.JWT_SECRET)}` });
  async function upload(url, files, headers = {}) {
    const fd = new FormData();
    for (const [name, content, type] of files) fd.append('files', new Blob([content], { type: type || 'application/octet-stream' }), name);
    const r = await fetch(ctx.base + url, { method: 'POST', body: fd, headers });
    return { status: r.status, body: await r.json() };
  }
  const get = async (url, headers) => {
    const r = await fetch(ctx.base + url, { headers });
    return { status: r.status, text: await r.text(), headers: r.headers };
  };
  const pub = (m, p, b, h) => request(ctx.base, m, `${D}/public${p}`, b, h);
  const mailTo = async (to, re) => {
    for (let i = 0; i < 50; i++) {
      const m = mails.find((x) => x.to === to && re.test(x.subject));
      if (m) return m;
      await wait(10);
    }
    return null;
  };

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Štúdio Ema' });
    other = newUser(ctx);
  });
  after(() => ctx.close());

  it('priečinky, nahrávanie (UTF-8 názvy), premenovanie, presun, hľadanie, stiahnutie', async () => {
    folder = (await owner.api('POST', `${D}/folders`, { name: 'Zmluvy 2026' })).body;
    sub = (await owner.api('POST', `${D}/folders`, { name: 'Podpísané', parentId: folder.id })).body;
    const up = await upload(`${D}/files?parentId=${sub.id}`, [['Zmluva č. 1.pdf', '%PDF zmluva'], ['poznámky.txt', 'ahoj', 'text/plain']], bearer(owner));
    assert.equal(up.status, 200);
    file = up.body[0];
    assert.equal(file.name, 'Zmluva č. 1.pdf');
    const list = (await owner.api('GET', `${D}/items?parent=${sub.id}`)).body;
    assert.deepEqual(list.path.map((p) => p.name), ['Zmluvy 2026', 'Podpísané']);
    assert.equal(list.items.length, 2);
    assert.equal(list.usage, '%PDF zmluva'.length + 'ahoj'.length);

    assert.equal((await owner.api('PATCH', `${D}/items/${folder.id}`, { parentId: sub.id })).status, 400); // do seba samého
    assert.equal((await owner.api('PATCH', `${D}/items/${file.id}`, { name: 'Zmluva Novák.pdf', parentId: folder.id })).status, 200);
    const found = (await owner.api('GET', `${D}/search?q=nov`)).body;
    assert.deepEqual(found.map((f) => [f.name, f.path]), [['Zmluva Novák.pdf', 'Zmluvy 2026']]);

    const { url } = (await owner.api('GET', `${D}/items/${file.id}/url`)).body;
    const dl = await get(url);
    assert.equal(dl.text, '%PDF zmluva');
    assert.match(dl.headers.get('content-disposition'), /attachment; filename\*=UTF-8''Zmluva%20Nov%C3%A1k\.pdf/);
    assert.equal((await get(url.slice(0, -2) + 'xx')).status, 410);
    // Cudzí účet nevidí nič
    assert.equal((await other.api('GET', `${D}/items?parent=${folder.id}`)).status, 404);
    assert.equal((await other.api('GET', `${D}/items?ws=${owner.id}`)).status, 404);
  });

  it('náhľad iba pre bezpečné typy; HTML sa vždy stiahne a je v sandboxe', async () => {
    const [img, html] = (await upload(`${D}/files`, [['foto.png', 'png', 'image/png'], ['x.html', '<script>alert(1)</script>', 'text/html']], bearer(owner))).body;
    const png = await get((await owner.api('GET', `${D}/items/${img.id}/url?inline=1`)).body.url);
    assert.deepEqual([png.headers.get('content-type'), png.headers.get('content-disposition').split(';')[0]], ['image/png', 'inline']);
    const h = await get((await owner.api('GET', `${D}/items/${html.id}/url?inline=1`)).body.url);
    assert.deepEqual([h.headers.get('content-type'), h.headers.get('content-disposition').split(';')[0], h.headers.get('content-security-policy')],
      ['application/octet-stream', 'attachment', 'sandbox']);
  });

  it('kvóta: súbor, ktorý sa nezmestí, sa odmietne a zmaže z disku', async () => {
    const before = fs.readdirSync(drive.DIR).length;
    process.env.DRIVE_QUOTA_MB = '0.0001';
    try {
      const r = await upload(`${D}/files`, [['velky.bin', 'x'.repeat(500)]], bearer(owner));
      assert.equal(r.status, 413);
    } finally {
      delete process.env.DRIVE_QUOTA_MB;
    }
    assert.equal(fs.readdirSync(drive.DIR).length, before);
  });

  it('kôš: priečinok aj s obsahom, obnovenie, trvalé zmazanie odstráni súbory z disku', async () => {
    const tmp = (await owner.api('POST', `${D}/folders`, { name: 'Staré' })).body;
    const [f] = (await upload(`${D}/files?parentId=${tmp.id}`, [['old.txt', 'old']], bearer(owner))).body;
    await owner.api('DELETE', `${D}/items/${tmp.id}`);
    assert.ok(!(await owner.api('GET', `${D}/items`)).body.items.some((i) => i.id === tmp.id));
    assert.deepEqual((await owner.api('GET', `${D}/trash`)).body.map((i) => i.id), [tmp.id]); // iba vrchol, nie obsah
    await owner.api('POST', `${D}/trash/${tmp.id}/restore`);
    assert.equal((await owner.api('GET', `${D}/items?parent=${tmp.id}`)).body.items[0].id, f.id);
    await owner.api('DELETE', `${D}/items/${tmp.id}`);
    const stored = getDb().prepare('SELECT stored_name FROM drive_items WHERE id = ?').get(f.id).stored_name;
    await owner.api('DELETE', `${D}/trash/${tmp.id}`);
    assert.equal(fs.existsSync(path.join(drive.DIR, stored)), false);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM drive_items WHERE id IN (?, ?)').get(tmp.id, f.id).n, 0);
  });

  it('tím: pozvánka sa prijme po prihlásení; čitateľ vidí, editor aj nahráva', async () => {
    const reader = newUser(ctx), editor = newUser(ctx);
    for (const [u, role] of [[reader, 'readonly'], [editor, 'editor']]) {
      await owner.api('POST', '/api/team/invite', { email: u.email, role });
      const token = getDb().prepare('SELECT invite_token FROM team_members WHERE email = ?').get(u.email).invite_token;
      const link = await fetch(`${ctx.base}/api/team/accept/${token}`, { redirect: 'manual' });
      assert.equal(link.headers.get('location'), `/dashboard?team_invite=${token}`);
      assert.equal((await owner.api('POST', '/api/team/accept', { token })).status, 400); // vlastný tím nie
      assert.equal((await u.api('POST', '/api/team/accept', { token })).status, 200);
      assert.equal((await u.api('POST', '/api/team/accept', { token })).status, 404); // iba raz
    }
    assert.deepEqual((await reader.api('GET', `${D}/workspaces`)).body.map((w) => w.role), ['owner', 'readonly']);
    const ws = `ws=${owner.id}`;
    assert.equal((await reader.api('GET', `${D}/items?${ws}&parent=${folder.id}`)).status, 200);
    assert.equal((await reader.api('POST', `${D}/folders?${ws}`, { name: 'X' })).status, 403);
    assert.equal((await upload(`${D}/files?${ws}`, [['a.txt', 'a']], bearer(reader))).status, 403);
    const up = await upload(`${D}/files?${ws}&parentId=${folder.id}`, [['od editora.txt', 'e']], bearer(editor));
    assert.equal(up.status, 200);
    assert.equal(getDb().prepare('SELECT owner_id FROM drive_items WHERE id = ?').get(up.body[0].id).owner_id, owner.id);
    assert.equal((await reader.api('GET', `/api/team/memberships`)).body[0].ownerId, owner.id);
  });

  it('zdieľanie odkazom: heslo, podstrom, nahrávanie klienta s upozornením, zrušenie', async () => {
    const s = (await owner.api('POST', `${D}/items/${folder.id}/shares`, { password: 'tajne123', allowUpload: true, expiresDays: 7 })).body;
    assert.match(s.url, /\/s\/[\w-]{20,}$/);
    const token = s.url.split('/').pop();
    const info = (await pub('GET', `/${token}`)).body;
    assert.deepEqual([info.name, info.locked, info.allowUpload, info.owner.name], ['Zmluvy 2026', true, true, 'Štúdio Ema']);
    assert.equal((await pub('GET', `/${token}/items`)).status, 401);
    assert.equal((await pub('POST', `/${token}/unlock`, { password: 'zle' })).status, 401);
    const { key } = (await pub('POST', `/${token}/unlock`, { password: 'tajne123' })).body;
    const K = { 'x-share-key': key };
    const root = (await pub('GET', `/${token}/items`, undefined, K)).body;
    assert.ok(root.items.some((i) => i.id === sub.id));
    assert.deepEqual((await pub('GET', `/${token}/items?parent=${sub.id}`, undefined, K)).body.path.map((p) => p.name), ['Zmluvy 2026', 'Podpísané']);
    // Mimo zdieľaného priečinka nič
    const outside = (await owner.api('POST', `${D}/folders`, { name: 'Súkromné' })).body;
    assert.equal((await pub('GET', `/${token}/items?parent=${outside.id}`, undefined, K)).status, 404);
    const fileUrl = (await pub('GET', `/${token}/file/${file.id}`, undefined, K)).body.url;
    assert.equal((await get(fileUrl)).text, '%PDF zmluva');

    const up = await upload(`${D}/public/${token}/upload?parent=${sub.id}`, [['podklady.pdf', 'podklady']], K);
    assert.equal(up.status, 200);
    assert.ok(await mailTo(owner.email, /Nové súbory na Disku/));
    assert.equal((await upload(`${D}/public/${token}/upload`, [['bez.pdf', 'x']])).status, 401); // bez hesla nie

    await owner.api('DELETE', `${D}/shares/${s.id}`);
    assert.equal((await pub('GET', `/${token}`)).status, 404);
    assert.equal((await get(fileUrl)).status, 403); // aj vydaný odkaz na súbor prestane platiť
  });

  it('zdieľanie jedného súboru bez hesla; vypršaný odkaz neplatí', async () => {
    const s = (await owner.api('POST', `${D}/items/${file.id}/shares`, {})).body;
    const token = s.url.split('/').pop();
    const info = (await pub('GET', `/${token}`)).body;
    assert.deepEqual([info.kind, info.locked, info.file.name], ['file', false, 'Zmluva Novák.pdf']);
    assert.equal((await owner.api('POST', `${D}/items/${file.id}/shares`, { allowUpload: true })).status, 400);
    getDb().prepare('UPDATE drive_shares SET expires_at = unixepoch() - 1 WHERE id = ?').run(s.id);
    assert.equal((await pub('GET', `/${token}`)).status, 404);
  });

  it('priečinok klienta v členskej sekcii: vidí iba svoj, nahráva iba ak je povolené', async () => {
    const cf = (await owner.api('POST', `${D}/client-folders`, { email: 'Klient@Example.sk', name: 'Jana', notify: true })).body;
    assert.equal(cf.name, 'Jana (klient@example.sk)');
    assert.ok(await mailTo('klient@example.sk', /Máte nové dokumenty/));
    const root = (await owner.api('GET', `${D}/items`)).body.items.find((i) => i.system === 'clients');
    assert.equal(root.name, 'Klienti');
    await upload(`${D}/files?parentId=${cf.id}`, [['faktura.pdf', 'faktura']], bearer(owner));

    const jana = getDb().prepare('SELECT * FROM members WHERE email = ? AND user_id = ?').get('klient@example.sk', owner.id);
    const M = { 'x-member-token': shop.sessionFor(jana) };
    const mp = (m, p, b) => request(ctx.base, m, `${D}/m/${owner.id}${p}`, b, M);
    assert.deepEqual((await mp('GET', '/folders')).body.map((f) => [f.id, f.canUpload]), [[cf.id, false]]);
    const items = (await mp('GET', `/items?parent=${cf.id}`)).body.items;
    assert.equal((await get((await mp('GET', `/file/${items[0].id}`)).body.url)).text, 'faktura');
    assert.equal((await mp('GET', `/file/${file.id}`)).status, 404); // súbor majiteľa mimo jej priečinka
    assert.equal((await upload(`${D}/m/${owner.id}/upload?parent=${cf.id}`, [['scan.jpg', 'x']], M)).status, 403);
    await owner.api('PATCH', `${D}/items/${cf.id}`, { memberUpload: true });
    assert.equal((await upload(`${D}/m/${owner.id}/upload?parent=${cf.id}`, [['scan.jpg', 'x']], M)).status, 200);

    const peter = shop.upsertMember(owner.id, 'peter@example.sk', 'Peter');
    const P = { 'x-member-token': shop.sessionFor(peter) };
    assert.deepEqual((await request(ctx.base, 'GET', `${D}/m/${owner.id}/folders`, undefined, P)).body, []);
    assert.equal((await request(ctx.base, 'GET', `${D}/m/${owner.id}/items?parent=${cf.id}`, undefined, P)).status, 404);
  });

  it('súbor z Disku do digitálneho produktu, lead magnetu a znalostí chatbota', async () => {
    const [txt] = (await upload(`${D}/files`, [['cennik.txt', 'Strih stojí 25 eur.', 'text/plain']], bearer(owner))).body;
    const product = (await owner.api('POST', '/api/shop/products', { type: 'file', title: 'Cenník' })).body;
    assert.equal((await owner.api('POST', `${D}/items/${txt.id}/to-product`, { productId: product.id })).status, 200);
    assert.equal((await owner.api('GET', `/api/shop/products/${product.id}`)).body.files[0].original_name, 'cennik.txt');

    const widgetId = require('crypto').randomUUID();
    getDb().prepare("INSERT INTO widgets (id, user_id, name) VALUES (?, ?, 'Web')").run(widgetId, owner.id);
    const lmId = require('crypto').randomUUID();
    getDb().prepare("INSERT INTO lead_magnets (id, widget_id, name) VALUES (?, ?, 'Cenník zdarma')").run(lmId, widgetId);
    assert.equal((await owner.api('POST', `${D}/items/${txt.id}/to-lead-magnet`, { leadMagnetId: lmId })).status, 200);
    const lm = getDb().prepare('SELECT file_path, file_url FROM lead_magnets WHERE id = ?').get(lmId);
    assert.equal(fs.readFileSync(lm.file_path, 'utf8'), 'Strih stojí 25 eur.');
    assert.match(lm.file_url, /\/uploads\/lead-magnets\/.+\.txt$/);
    fs.unlinkSync(lm.file_path);

    assert.equal((await owner.api('POST', `${D}/items/${txt.id}/to-knowledge`, { widgetId })).status, 200);
    assert.match(getDb().prepare('SELECT content FROM knowledge_items WHERE widget_id = ?').get(widgetId).content, /25 eur/);
    assert.equal((await other.api('POST', `${D}/items/${txt.id}/to-knowledge?ws=${owner.id}`, { widgetId })).status, 404);
  });
});
