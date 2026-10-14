// Tímová sada fáza 3: formuláre – stavba, verejné vyplnenie, podmienky, napojenie na marketing, úlohy, Disk.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { extraRoutes, startApp, newUser, getDb, mails, wait } = require('./helpers');

extraRoutes.push({ path: '/api/forms', module: '../routes/forms' }, { path: '/api/tasks', module: '../routes/tasks' });

describe('formuláre', () => {
  let ctx, owner, rado, stranger, form;
  const F = '/api/forms';
  const as = (u, m, p, b) => u.api(m, `${p}${p.includes('?') ? '&' : '?'}ws=${owner.id}`, b);
  const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };
  const token = () => form.url.split('/form/')[1];
  const send = (body) => fetch(`${ctx.base}${F}/public/${token()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema Nováková' });
    rado = newUser(ctx, { name: 'Rado' });
    stranger = newUser(ctx);
    getDb().prepare("INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES ('f1', ?, ?, 'readonly', 1, ?)").run(owner.id, rado.email, rado.id);
  });
  after(() => ctx.close());

  it('zo šablóny; úprava polí s podmienkou; readonly a cudzí nemôžu upravovať', async () => {
    form = (await owner.api('POST', F, { template: 'contact' })).body;
    assert.equal(form.title, 'Kontaktný formulár');
    assert.deepEqual(form.fields.map((f) => f.type), ['text', 'email', 'textarea', 'consent']);
    const fields = [
      ...form.fields,
      { id: 'kind', type: 'choice', label: 'Typ dopytu', options: ['Web', 'Logo', 'Web'], required: true },
      { id: 'pages', type: 'number', label: 'Počet stránok', required: true, showIf: { field: 'kind', value: 'Web' } },
      { type: 'nezmysel', label: 'x' },
    ];
    const tasks = (await owner.api('POST', '/api/tasks/projects', { name: 'Dopyty' })).body;
    form = (await owner.api('PATCH', `${F}/${form.id}`, { fields, settings: { layout: 'steps', color: '#ff0000', redirect: 'javascript:alert(1)', marketing: { enabled: true, tags: ['Dopyt'] }, task: { enabled: true, projectId: tasks.id } } })).body;
    assert.deepEqual(form.fields.map((f) => f.id).slice(-2), ['kind', 'pages']);
    assert.deepEqual(form.fields[4].options, ['Web', 'Logo']);
    assert.equal(form.settings.layout, 'steps');
    assert.equal(form.settings.redirect, '');
    assert.deepEqual(form.settings.marketing.tags, ['dopyt']);
    assert.equal((await as(rado, 'PATCH', `${F}/${form.id}`, { title: 'x' })).status, 403);
    assert.equal((await as(rado, 'GET', `${F}/${form.id}/responses`)).status, 200);
    assert.equal((await as(stranger, 'GET', `${F}/${form.id}`)).status, 404);
  });

  it('verejný formulár: overenie polí, podmienené pole, pasca na roboty', async () => {
    const pub = await (await fetch(`${ctx.base}${F}/public/${token()}`)).json();
    assert.equal(pub.title, 'Kontaktný formulár');
    assert.equal(pub.settings.color, '#ff0000');
    assert.equal(pub.settings.marketing, undefined); // nastavenia napojení nie sú verejné
    const [name, email, msg, consent] = form.fields.map((f) => f.id);
    const bad = await send({ [name]: 'Jana', [email]: 'zly-email', kind: 'Web' });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.body.fields).sort(), [email, msg, 'pages'].sort());
    // pri „Logo“ sa počet stránok nepýta
    const ok = await send({ [name]: 'Jana Kováčová', [email]: 'Jana@Firma.sk', [msg]: 'Chcem logo', [consent]: true, kind: 'Logo', pages: 'nič' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.thankYou, 'Ďakujeme, odpoveď sme prijali.');
    const hp = await send({ _hp: 'spam', [name]: 'Bot' });
    assert.equal(hp.status, 200);
    const rows = (await owner.api('GET', `${F}/${form.id}/responses`)).body;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, 'jana@firma.sk');
    assert.equal(rows[0].data.pages, undefined);
  });

  it('odpoveď: upozornenie + e-mail, kontakt do marketingu so súhlasom, úloha prepojená s formulárom', async () => {
    const n = (await owner.api('GET', '/api/realtime/notifications')).body.items;
    assert.match(n[0].title, /Nová odpoveď: Kontaktný formulár/);
    assert.match(n[0].body, /Typ dopytu: Logo/);
    assert.ok(await until(() => mails.some((m) => m.to === owner.email && /Nová odpoveď/.test(m.subject))));
    const c = getDb().prepare('SELECT * FROM email_contacts WHERE user_id = ? AND email = ?').get(owner.id, 'jana@firma.sk');
    assert.equal(c.source, 'form');
    assert.deepEqual(JSON.parse(c.tags), ['formular', 'dopyt']);
    const t = getDb().prepare("SELECT * FROM tasks WHERE owner_id = ? AND title LIKE 'Kontaktný formulár:%'").get(owner.id);
    assert.equal(t.title, 'Kontaktný formulár: Jana Kováčová');
    assert.match(t.description, /Správa: Chcem logo/);
    const rel = (await owner.api('GET', `/api/realtime/links?type=task&id=${t.id}`)).body;
    assert.deepEqual(rel.map((x) => [x.type, x.title]), [['form', 'Kontaktný formulár']]);
    // bez súhlasu sa nový kontakt nevytvorí
    const [name, email, msg] = form.fields.map((f) => f.id);
    await send({ [name]: 'Peter', [email]: 'peter@x.sk', [msg]: 'Ahoj', kind: 'Web', pages: '5' });
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM email_contacts WHERE email = ?').get('peter@x.sk').n, 0);
  });

  it('prehľad, CSV export, nahratý súbor na Disk, uzavretie formulára', async () => {
    const st = (await owner.api('GET', `${F}/${form.id}/stats`)).body;
    assert.equal(st.total, 2);
    const kind = st.fields.find((f) => f.id === 'kind');
    assert.deepEqual(kind.counts, { Web: 1, Logo: 1 });
    assert.equal(st.fields.find((f) => f.id === 'pages').avg, 5);
    const csv = await (await fetch(`${ctx.base}${F}/${form.id}/export.csv?ws=${owner.id}`, { headers: { authorization: `Bearer ${require('jsonwebtoken').sign({ userId: owner.id }, process.env.JWT_SECRET)}` } })).text();
    assert.match(csv, /"Meno";"E-mail";"Správa"/);
    assert.match(csv, /"Jana Kováčová";"Jana@Firma.sk";"Chcem logo";"Áno";"Logo";""/);

    const order = (await owner.api('POST', F, { template: 'order' })).body;
    const fileField = order.fields.find((f) => f.type === 'file');
    const [nm, em] = order.fields.map((f) => f.id);
    const fd = new FormData();
    fd.append('_json', JSON.stringify({ [nm]: 'Firma s.r.o.', [em]: 'info@firma.sk' }));
    fd.append(fileField.id, new Blob(['zadanie']), 'zadanie.pdf');
    fd.append('iny', new Blob(['x']), 'x.exe');
    const r = await fetch(`${ctx.base}${F}/public/${order.url.split('/form/')[1]}`, { method: 'POST', body: fd });
    assert.equal(r.status, 200);
    const resp = (await owner.api('GET', `${F}/${order.id}/responses`)).body[0];
    assert.deepEqual(resp.data[fileField.id].map((x) => x.name), ['zadanie.pdf']);
    const folder = getDb().prepare("SELECT id, name FROM drive_items WHERE owner_id = ? AND system = 'form-files'").get(owner.id);
    assert.equal(folder.name, 'Odpovede z formulárov');
    assert.deepEqual(getDb().prepare('SELECT name FROM drive_items WHERE parent_id = ?').all(folder.id).map((x) => x.name), ['zadanie.pdf']);

    await owner.api('PATCH', `${F}/${order.id}`, { status: 'closed' });
    const closed = await fetch(`${ctx.base}${F}/public/${order.url.split('/form/')[1]}`, { method: 'POST', body: fd });
    assert.equal(closed.status, 400);
    assert.equal((await (await fetch(`${ctx.base}${F}/public/${order.url.split('/form/')[1]}`)).json()).closed, true);
    assert.equal((await owner.api('DELETE', `${F}/${order.id}`)).status, 200);
    assert.equal((await fetch(`${ctx.base}${F}/public/${order.url.split('/form/')[1]}`)).status, 404);
  });
});
