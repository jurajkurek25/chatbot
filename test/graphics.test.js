// Tímová sada fáza 3: grafika zo šablón – značka tímu, šablóny, návrhy na Disku.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { extraRoutes, startApp, newUser, getDb } = require('./helpers');

extraRoutes.push({ path: '/api/graphics', module: '../routes/graphics' });

describe('grafika zo šablón', () => {
  let ctx, owner, rado, stranger;
  const G = '/api/graphics';
  const as = (u, m, p, b) => u.api(m, `${p}${p.includes('?') ? '&' : '?'}ws=${owner.id}`, b);
  const LOGO = `data:image/png;base64,${Buffer.from('logo').toString('base64')}`;

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema Nováková' });
    rado = newUser(ctx, { name: 'Rado' });
    stranger = newUser(ctx);
    getDb().prepare("INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES ('g1', ?, ?, 'readonly', 1, ?)").run(owner.id, rado.email, rado.id);
  });
  after(() => ctx.close());

  it('značka: predvolené hodnoty, uloženie s kontrolou farieb, písem a lôg; readonly ju nezmení', async () => {
    const b = (await owner.api('GET', `${G}/brand`)).body;
    assert.equal(b.colors.primary, '#5b4fff');
    assert.ok(b.fontsAvailable.includes('Montserrat'));
    const saved = (await owner.api('PUT', `${G}/brand`, { colors: { primary: '#FF0066', accent: 'red' }, fonts: { heading: 'Bebas Neue', body: 'Comic Sans' }, logos: [{ name: 'Logo', dataURL: LOGO }, { name: 'zlé', dataURL: 'javascript:1' }] })).body;
    assert.equal(saved.colors.primary, '#ff0066');
    assert.equal(saved.colors.accent, '#f59e0b');
    assert.deepEqual(saved.fonts, { heading: 'Bebas Neue', body: 'Inter' });
    assert.deepEqual(saved.logos.map((l) => l.name), ['Logo']);
    assert.equal((await as(rado, 'PUT', `${G}/brand`, { colors: { primary: '#000000' } })).status, 403);
    assert.equal((await as(rado, 'GET', `${G}/brand`)).body.colors.primary, '#ff0066');
    assert.equal((await as(stranger, 'GET', `${G}/brand`)).status, 404);
  });

  it('šablóny: vstavané + tímové; návrh na Disku v priečinku Grafika; úprava, kópia, kôš', async () => {
    const list = (await owner.api('GET', `${G}/templates`)).body;
    assert.ok(list.some((t) => t.id === 'builtin:quote' && t.width === 1080));
    const quote = (await owner.api('GET', `${G}/templates/builtin:quote`)).body;
    assert.ok(quote.layers.some((l) => l.type === 'logo'));

    const data = JSON.stringify({ version: '7.4.0', objects: [{ type: 'Textbox', text: 'Letný výpredaj' }], background: '#fff' });
    const d = (await owner.api('POST', `${G}/designs`, { title: 'Výpredaj IG', width: 1080, height: 1080, data, templateId: 'builtin:sale', thumb: 'data:image/jpeg;base64,AAAA' })).body;
    const item = getDb().prepare('SELECT * FROM drive_items WHERE id = ?').get(d.driveItemId);
    assert.deepEqual([item.name, item.ref], ['Výpredaj IG', `design:${d.id}`]);
    assert.equal(getDb().prepare('SELECT name FROM drive_items WHERE id = ?').get(item.parent_id).name, 'Grafika');
    const full = (await as(rado, 'GET', `${G}/designs/${d.id}`)).body;
    assert.equal(full.data, data);
    assert.equal(full.brand.colors.primary, '#ff0066');
    assert.equal((await as(rado, 'PATCH', `${G}/designs/${d.id}`, { title: 'x' })).status, 403);
    const up = (await owner.api('PATCH', `${G}/designs/${d.id}`, { title: 'Výpredaj leto', thumb: 'javascript:alert(1)' })).body;
    assert.equal(up.title, 'Výpredaj leto');
    assert.equal(up.thumb, 'data:image/jpeg;base64,AAAA');
    assert.equal(getDb().prepare('SELECT name FROM drive_items WHERE id = ?').get(item.id).name, 'Výpredaj leto');

    const tpl = (await owner.api('POST', `${G}/templates`, { title: 'Naša akcia', width: 1080, height: 1080, data })).body;
    assert.ok((await as(rado, 'GET', `${G}/templates`)).body.some((t) => t.id === tpl.id && t.team));
    assert.equal((await as(rado, 'DELETE', `${G}/templates/${tpl.id}`)).status, 403);

    const copy = (await owner.api('POST', `${G}/designs/${d.id}/duplicate`, {})).body;
    assert.equal(copy.title, 'Výpredaj leto (kópia)');
    assert.equal((await owner.api('GET', `${G}/designs`)).body.length, 2);
    const found = (await owner.api('GET', '/api/realtime/search?q=výpredaj')).body.filter((x) => x.type === 'design');
    assert.equal(found.length, 2);
    await owner.api('DELETE', `${G}/designs/${d.id}`);
    assert.equal((await owner.api('GET', `${G}/designs/${d.id}`)).status, 404);
    await owner.api('DELETE', `/api/drive/trash/${item.id}`);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM designs WHERE id = ?').get(d.id).n, 0);
  });

  it('prezentácia: šablóna so snímkami, priečinok Prezentácie, oddelený zoznam, text zo všetkých snímok', async () => {
    const t = (await owner.api('GET', `${G}/templates/builtin:deck`)).body;
    assert.equal(t.kind, 'deck');
    assert.equal(t.pages.length, 4);
    const data = JSON.stringify({ nwDeck: 1, pages: [{ objects: [{ type: 'Textbox', text: 'Úvod' }] }, { objects: [{ type: 'Textbox', text: 'Ďakujem' }] }] });
    const d = (await owner.api('POST', `${G}/designs`, { title: 'Kvartál', kind: 'deck', width: 1920, height: 1080, data })).body;
    assert.equal(d.kind, 'deck');
    const item = getDb().prepare('SELECT parent_id FROM drive_items WHERE id = ?').get(d.driveItemId);
    assert.equal(getDb().prepare('SELECT name FROM drive_items WHERE id = ?').get(item.parent_id).name, 'Prezentácie');
    assert.deepEqual((await owner.api('GET', `${G}/designs?kind=deck`)).body.map((x) => x.title), ['Kvartál']);
    assert.ok(!(await owner.api('GET', `${G}/designs`)).body.some((x) => x.kind === 'deck'));
    assert.equal(require('../services/graphics').textOf(data), 'Úvod Ďakujem');
    assert.equal((await owner.api('POST', `${G}/designs/${d.id}/duplicate`, {})).body.kind, 'deck');
  });
});
