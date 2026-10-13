// Digitálne produkty: súbory, kurzy, členstvá, členská sekcia, platba cez Stripe obchodníka.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp, request, newUser, connectStripe, signedEvent, mails, getDb, wait } = require('./helpers');

describe('digitálne produkty', () => {
  let ctx, owner, other, account, pdf, course, mem, freebie, l1, l2, memberSession;
  const S = '/api/shop';
  const anon = (m, p, b, h) => request(ctx.base, m, S + p, b, h);
  const link = (html, re) => (html.match(re) || [])[0]?.replace(/&amp;/g, '&');
  const upload = async (productId, name, content) => {
    const fd = new FormData();
    fd.append('file', new Blob([content]), name);
    const r = await fetch(`${ctx.base}${S}/products/${productId}/files`, { method: 'POST', headers: { authorization: owner.auth }, body: fd });
    return { status: r.status, body: await r.json() };
  };
  const paySession = (id, pi) => {
    const s = ctx.stripe.checkoutSessions_[id];
    return Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi, amount_total: s.params.line_items[0].price_data.unit_amount });
  };

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx);
    owner.auth = `Bearer ${require('jsonwebtoken').sign({ userId: owner.id }, process.env.JWT_SECRET)}`;
    other = newUser(ctx);
    await owner.api('PUT', `${S}/settings`, { storeName: 'Akadémia Ema', color: '#e11d74', supportEmail: 'help@ema.sk' });
    pdf = (await owner.api('POST', `${S}/products`, { type: 'file', title: 'E-book Zdravie', price: 9.9 })).body;
    course = (await owner.api('POST', `${S}/products`, { type: 'course', title: 'Kurz jogy', price: 49 })).body;
    mem = (await owner.api('POST', `${S}/products`, { type: 'membership', title: 'Klub', price: 19, accessDays: 30 })).body;
    freebie = (await owner.api('POST', `${S}/products`, { type: 'file', title: 'Checklist zdarma' })).body;
  });
  after(() => ctx.close());

  it('nahrá súbor (UTF-8 názov) mimo verejného priečinka; cudzí vlastník nemá prístup', async () => {
    const up = await upload(pdf.id, 'Zdravie čítanie.pdf', '%PDF-1.4 ebook');
    assert.deepEqual([up.status, up.body.original_name], [200, 'Zdravie čítanie.pdf']);
    const stored = getDb().prepare('SELECT stored_name FROM digital_files WHERE id = ?').get(up.body.id).stored_name;
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'data', 'digital', stored)));
    await upload(freebie.id, 'checklist.txt', 'free checklist');
    assert.equal((await other.api('GET', `${S}/products/${pdf.id}`)).status, 404);
  });

  it('kurz: moduly, lekcie s videom (iba https), ukážka zadarmo; členstvo zahŕňa produkty', async () => {
    const m1 = (await owner.api('POST', `${S}/products/${course.id}/modules`, { title: 'Základy' })).body;
    l1 = (await owner.api('POST', `${S}/modules/${m1.id}/lessons`, { title: 'Úvod' })).body;
    l2 = (await owner.api('POST', `${S}/modules/${m1.id}/lessons`, { title: 'Pozdrav slnku' })).body;
    assert.equal((await owner.api('PUT', `${S}/lessons/${l1.id}`, { content: 'Vitajte', videoUrl: 'https://youtu.be/abc123', freePreview: true })).status, 200);
    assert.equal((await owner.api('PUT', `${S}/lessons/${l2.id}`, { content: 'Tajný obsah', videoUrl: 'https://vimeo.com/76979871' })).body.embeddable, true);
    assert.equal((await owner.api('PUT', `${S}/lessons/${l2.id}`, { videoUrl: 'javascript:alert(1)' })).status, 400);
    const full = (await owner.api('PUT', `${S}/products/${mem.id}`, { includes: [course.id, pdf.id, mem.id] })).body;
    assert.deepEqual(full.includes.sort(), [course.id, pdf.id].sort());
    const pub = (await anon('GET', `/public/${course.id}`)).body;
    const flat = JSON.stringify(pub);
    assert.equal(pub.curriculum[0].lessons[0].embed, 'https://www.youtube-nocookie.com/embed/abc123');
    assert.ok(!flat.includes('Tajný obsah') && !flat.includes('76979871'));
    assert.deepEqual([pub.purchasable, pub.store.name], [false, 'Akadémia Ema']);
  });

  it('zadarmo: e-mail s odkazom na stiahnutie a do členskej sekcie; podvrhnutý odkaz neprejde', async () => {
    const res = await anon('POST', `/public/${freebie.id}/checkout`, { email: 'Eva@X.sk', name: 'Eva', consent: true });
    assert.deepEqual(res.body, { free: true });
    const mail = mails.filter((m) => m.to === 'eva@x.sk').at(-1);
    const dl = link(mail.html, /https:\/\/app\.test\/api\/shop\/download\/[^"]+/).replace('https://app.test', ctx.base);
    assert.match(mail.html, /members\/[\w-]+\?login=/);
    const file = await fetch(dl);
    assert.deepEqual([file.status, await file.text()], [200, 'free checklist']);
    assert.match(file.headers.get('content-disposition'), /attachment/);
    assert.equal((await fetch(dl.slice(0, -3) + 'abc')).status, 404);
  });

  it('platený kurz cez Stripe obchodníka; nový kupujúci sa po návrate prihlási', async () => {
    assert.equal((await anon('POST', `/public/${course.id}/checkout`, { email: 'nov@x.sk', consent: true })).status, 503);
    account = await connectStripe(ctx, owner);
    const res = await anon('POST', `/public/${course.id}/checkout`, { email: 'nov@x.sk', name: 'Nová', consent: true });
    const call = ctx.stripe.lastCall('checkout.sessions.create');
    assert.deepEqual([call.account, call.params.line_items[0].price_data.unit_amount, call.params.metadata.kind], [account, 4900, 'order']);
    assert.match(res.body.checkoutUrl, /checkout\.stripe\.test/);
    const sessionId = Object.keys(ctx.stripe.checkoutSessions_).at(-1);
    assert.equal((await anon('POST', `/m/${owner.id}/order`, { sessionId })).body.status, 'pending');
    paySession(sessionId, 'pi_c');
    const ret = (await anon('POST', `/m/${owner.id}/order`, { sessionId })).body;
    assert.equal(ret.status, 'paid');
    assert.ok(ret.session);
    memberSession = ret.session;
    assert.equal(mails.filter((m) => m.to === 'nov@x.sk').length, 1);
  });

  it('člen vidí iba zakúpené; obsah kurzu, pokrok; relácia patrí jednému obchodu', async () => {
    const MH = { 'x-member-token': memberSession };
    const me = (await anon('GET', `/m/${owner.id}/me`, undefined, MH)).body;
    assert.deepEqual(me.products.map((p) => p.id), [course.id]);
    const cv = (await anon('GET', `/m/${owner.id}/products/${course.id}`, undefined, MH)).body;
    assert.equal(cv.modules[0].lessons[1].embed, 'https://player.vimeo.com/video/76979871');
    assert.equal((await anon('GET', `/m/${owner.id}/products/${pdf.id}`, undefined, MH)).status, 403);
    assert.equal((await anon('GET', `/m/${other.id}/me`, undefined, MH)).status, 401);
    await anon('POST', `/m/${owner.id}/lessons/${l1.id}/progress`, {}, MH);
    assert.equal((await anon('GET', `/m/${owner.id}/me`, undefined, MH)).body.products[0].completed, 1);
  });

  it('členstvo cez Connect webhook; existujúci člen sa automaticky neprihlási; zahrnuté produkty sa odomknú', async () => {
    await anon('POST', `/public/${mem.id}/checkout`, { email: 'nov@x.sk', consent: true });
    const sessionId = Object.keys(ctx.stripe.checkoutSessions_).at(-1);
    const { payload, headers } = signedEvent(ctx, { id: 'evt_m', type: 'checkout.session.completed', account, data: { object: paySession(sessionId, 'pi_m') } }, 'whsec_connect');
    assert.equal((await request(ctx.base, 'POST', '/api/webhook/connect', payload, headers)).status, 200);
    const ret = (await anon('POST', `/m/${owner.id}/order`, { sessionId })).body;
    assert.deepEqual([ret.status, ret.session], ['paid', null]);
    const me = (await anon('GET', `/m/${owner.id}/me`, undefined, { 'x-member-token': memberSession })).body;
    assert.ok([course.id, pdf.id, mem.id].every((id) => me.products.some((p) => p.id === id)));
    const cv = (await anon('GET', `/m/${owner.id}/products/${pdf.id}`, undefined, { 'x-member-token': memberSession })).body;
    const file = await fetch(cv.files[0].url.replace('https://app.test', ctx.base));
    assert.ok((await file.text()).startsWith('%PDF'));
  });

  it('prihlásenie odkazom: neznámy e-mail bez e-mailu, odkaz platí iba v jednom obchode', async () => {
    const before = mails.length;
    assert.equal((await anon('POST', `/m/${owner.id}/login-request`, { email: 'nikto@x.sk' })).status, 200);
    assert.equal(mails.length, before);
    await anon('POST', `/m/${owner.id}/login-request`, { email: 'NOV@x.sk' });
    const token = new URL(link(mails.at(-1).html, /https:\/\/app\.test\/members\/[\w-]+\?login=[^"]+/)).searchParams.get('login');
    assert.equal((await anon('POST', `/m/${other.id}/login`, { token })).status, 401);
    assert.ok((await anon('POST', `/m/${owner.id}/login`, { token })).body.session);
  });

  it('vrátenie platby odoberie prístup; ručné pridelenie pošle prístup', async () => {
    const order = getDb().prepare('SELECT id FROM orders WHERE product_id = ? AND email = ?').get(course.id, 'nov@x.sk');
    getDb().prepare("UPDATE product_access SET expires_at = unixepoch() - 10 WHERE product_id = ?").run(mem.id);
    assert.equal((await owner.api('POST', `${S}/orders/${order.id}/refund`, {})).status, 200);
    assert.equal(ctx.stripe.lastCall('refunds.create').params.payment_intent, 'pi_c');
    const me = (await anon('GET', `/m/${owner.id}/me`, undefined, { 'x-member-token': memberSession })).body;
    assert.ok(!me.products.some((p) => p.id === course.id));
    await owner.api('POST', `${S}/members`, { email: 'gift@x.sk', productId: course.id });
    assert.ok(mails.some((m) => m.to === 'gift@x.sk'));
    const status = (await owner.api('GET', '/api/payments/status')).body;
    assert.ok(status.recent.some((r) => r.type === 'order'));
  });

  it('zmazanie produktu zmaže aj súbory', async () => {
    const stored = getDb().prepare('SELECT stored_name FROM digital_files WHERE product_id = ?').get(freebie.id).stored_name;
    await owner.api('DELETE', `${S}/products/${freebie.id}`);
    await wait(50);
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'digital', stored)));
  });
});
