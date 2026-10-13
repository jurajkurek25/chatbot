// E-mail marketing cez Resend: kontakty so súhlasom, kampane po dávkach, webhooky, série, doména, odhlásenie.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { startApp, request, newUser, getDb } = require('./helpers');
const mk = require('../services/marketing');

const SECRET = `whsec_${Buffer.from('tajny-kluc-webhooku').toString('base64')}`;

// Falošné Resend API: zaznamenáva volania, vie dočasne zlyhať
function fakeResend() {
  const fake = { calls: [], failNext: 0, n: 0 };
  fake.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = body ? JSON.parse(body) : undefined;
      fake.calls.push({ method: req.method, path: req.url, body: data, headers: req.headers });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (fake.failNext > 0) { fake.failNext--; return send(500, { message: 'Internal error' }); }
      if (req.url === '/emails/batch') return send(200, { data: data.map(() => ({ id: `em_${++fake.n}` })) });
      if (req.url === '/emails') return send(200, { id: `em_${++fake.n}` });
      if (req.url === '/domains' && req.method === 'POST') {
        return send(200, { id: 'dom_1', name: data.name, status: 'not_started', records: [{ record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIG', status: 'not_started' }] });
      }
      if (req.url === '/domains/dom_1/verify') return send(200, { object: 'domain', id: 'dom_1' });
      if (req.url === '/domains/dom_1' && req.method === 'GET') return send(200, { id: 'dom_1', status: 'verified', records: [{ record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIG', status: 'verified' }] });
      if (req.url === '/domains/dom_1' && req.method === 'DELETE') return send(200, { deleted: true });
      send(404, { message: 'not found' });
    });
  });
  fake.callsTo = (path) => fake.calls.filter((c) => c.path === path);
  return fake;
}

function signed(event) {
  const payload = JSON.stringify(event);
  const id = `msg_${crypto.randomBytes(4).toString('hex')}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${ts}.${payload}`).digest('base64');
  return { payload, headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' } };
}

describe('e-mail marketing (Resend)', () => {
  let ctx, fake, owner;
  const M = '/api/marketing';

  before(async () => {
    fake = fakeResend();
    await new Promise((r) => fake.server.listen(0, r));
    Object.assign(process.env, {
      RESEND_API_URL: `http://127.0.0.1:${fake.server.address().port}`, RESEND_API_KEY: 're_test', RESEND_WEBHOOK_SECRET: SECRET,
      MARKETING_FROM_DOMAIN: 'mail.neoworkly.test',
    });
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Štúdio Ema' });
    await owner.api('PUT', `${M}/settings`, { fromName: 'Štúdio Ema', address: 'Hlavná 1, Bratislava', replyTo: 'ema@studio.sk' });
  });
  after(async () => {
    await ctx.close();
    fake.server.close();
    for (const k of ['RESEND_API_URL', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'MARKETING_FROM_DOMAIN', 'MARKETING_MONTHLY_LIMIT']) delete process.env[k];
  });

  it('kontakt iba so súhlasom; import; odhlásenie potvrdením a jedným klikom', async () => {
    assert.equal((await owner.api('POST', `${M}/contacts`, { email: 'a@x.sk' })).status, 400);
    const c = (await owner.api('POST', `${M}/contacts`, { email: 'Jana@X.sk', name: 'Jana', tags: 'joga, VIP', consent: true })).body;
    assert.deepEqual([c.email, c.status, c.tags], ['jana@x.sk', 'subscribed', ['joga', 'vip']]);
    const imp = (await owner.api('POST', `${M}/contacts/import`, { csv: 'email,meno\npeter@x.sk,Peter\njana@x.sk,Jana\nzly-email', tags: ['joga'], consent: true })).body;
    assert.deepEqual(imp, { added: 1, skipped: 2 });

    const token = getDb().prepare('SELECT unsubscribe_token FROM email_contacts WHERE email = ?').get('peter@x.sk').unsubscribe_token;
    const page = await fetch(`${ctx.base}${M}/u/${token}`);
    assert.match(await page.text(), /<form method="post">/); // GET sám neodhlási
    assert.equal(getDb().prepare('SELECT status FROM email_contacts WHERE email = ?').get('peter@x.sk').status, 'subscribed');
    const one = await fetch(`${ctx.base}${M}/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(one.status, 200);
    assert.equal(getDb().prepare('SELECT status FROM email_contacts WHERE email = ?').get('peter@x.sk').status, 'unsubscribed');
    const id = getDb().prepare('SELECT id FROM email_contacts WHERE email = ?').get('peter@x.sk').id;
    assert.equal((await owner.api('PATCH', `${M}/contacts/${id}`, { status: 'subscribed' })).status, 400); // bez nového súhlasu nie
  });

  it('nákup so súhlasom pridá kontakt „zákazník“, bez súhlasu nie', async () => {
    const free = (await owner.api('POST', '/api/shop/products', { type: 'file', title: 'Checklist' })).body;
    await request(ctx.base, 'POST', `/api/shop/public/${free.id}/checkout`, { email: 'kupec@x.sk', consent: true, marketing: true });
    await request(ctx.base, 'POST', `/api/shop/public/${free.id}/checkout`, { email: 'tichy@x.sk', consent: true });
    const all = (await owner.api('GET', `${M}/contacts`)).body.map((c) => [c.email, c.source]);
    assert.ok(all.some(([e, s]) => e === 'kupec@x.sk' && s === 'customer'));
    assert.ok(!all.some(([e]) => e === 'tichy@x.sk'));
    assert.equal((await request(ctx.base, 'GET', `/api/shop/public/${free.id}`)).body.newsletter, true);
  });

  it('kampaň: segment podľa štítku, personalizácia, odhlasovacie hlavičky, štatistiky z podpísaných webhookov', async () => {
    const camp = (await owner.api('POST', `${M}/campaigns`, {
      name: 'Október', subject: 'Ahoj {{meno}}', body: 'Nová **joga** séria.\n\nViac na https://studio.sk/joga', buttonText: 'Rezervovať', buttonUrl: 'https://studio.sk/b',
      segment: { tags: ['joga'] },
    })).body;
    assert.equal((await owner.api('POST', `${M}/segment/count`, { segment: { tags: ['joga'] } })).body.count, 1); // Peter je odhlásený
    const sent = await owner.api('POST', `${M}/campaigns/${camp.id}/send`, {});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await mk.processCampaigns();
    const call = fake.callsTo('/emails/batch').at(-1);
    assert.ok(call.headers['idempotency-key']);
    const msg = call.body[0];
    assert.deepEqual([msg.to, msg.subject, msg.from, msg.reply_to], [['jana@x.sk'], 'Ahoj Jana', 'Štúdio Ema <noreply@mail.neoworkly.test>', 'ema@studio.sk']);
    assert.match(msg.html, /<strong>joga<\/strong>/);
    assert.match(msg.html, /href="https:\/\/studio\.sk\/b"/);
    assert.match(msg.html, /Hlavná 1, Bratislava/);
    assert.match(msg.headers['List-Unsubscribe'], /^<http.+\/api\/marketing\/u\/[\w-]+>$/);
    assert.equal(msg.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

    const emailId = getDb().prepare('SELECT resend_id FROM email_sends WHERE campaign_id = ?').get(camp.id).resend_id;
    for (const type of ['email.delivered', 'email.opened', 'email.clicked']) {
      const { payload, headers } = signed({ type, created_at: new Date().toISOString(), data: { email_id: emailId } });
      assert.equal((await request(ctx.base, 'POST', `${M}/webhook`, payload, headers)).status, 200);
    }
    const bad = signed({ type: 'email.complained', data: { email_id: emailId } });
    bad.headers['svix-signature'] = 'v1,AAAA';
    assert.equal((await request(ctx.base, 'POST', `${M}/webhook`, bad.payload, bad.headers)).status, 400);
    const stats = (await owner.api('GET', `${M}/campaigns/${camp.id}`)).body;
    assert.equal(stats.status, 'sent');
    assert.deepEqual([stats.stats.total, stats.stats.delivered, stats.stats.opened, stats.stats.clicked], [1, 1, 1, 1]);
    assert.equal((await owner.api('PUT', `${M}/campaigns/${camp.id}`, { subject: 'x' })).status, 400); // odoslanú nemeniť
  });

  it('trvalé odrazenie a sťažnosť vypnú kontakt', async () => {
    const c1 = mk.upsertContact(owner.id, { email: 'odraz@x.sk', consent: true });
    const c2 = mk.upsertContact(owner.id, { email: 'staznost@x.sk', consent: true });
    const ins = getDb().prepare("INSERT INTO email_sends (id, user_id, contact_id, resend_id, status) VALUES (?, ?, ?, ?, 'sent')");
    ins.run('s_b', owner.id, c1.id, 'em_b');
    ins.run('s_c', owner.id, c2.id, 'em_c');
    for (const evt of [{ type: 'email.bounced', data: { email_id: 'em_b', bounce: { type: 'Permanent' } } }, { type: 'email.complained', data: { email_id: 'em_c' } }]) {
      const { payload, headers } = signed(evt);
      await request(ctx.base, 'POST', `${M}/webhook`, payload, headers);
    }
    const st = (e) => getDb().prepare('SELECT status FROM email_contacts WHERE email = ?').get(e).status;
    assert.deepEqual([st('odraz@x.sk'), st('staznost@x.sk')], ['bounced', 'complained']);
  });

  it('veľká kampaň ide po 100; výpadok Resend nechá zvyšok vo fronte a dokončí sa neskôr', async () => {
    const other = newUser(ctx);
    await other.api('PUT', `${M}/settings`, {});
    for (let i = 0; i < 150; i++) mk.upsertContact(other.id, { email: `k${i}@x.sk`, consent: true });
    const camp = (await other.api('POST', `${M}/campaigns`, { subject: 'Hromadne', body: 'Ahoj' })).body;
    const before = fake.callsTo('/emails/batch').length;
    fake.failNext = 1;
    await other.api('POST', `${M}/campaigns/${camp.id}/send`, {});
    await mk.processCampaigns();
    const mid = (await other.api('GET', `${M}/campaigns/${camp.id}`)).body;
    assert.deepEqual([mid.status, mid.stats.queued], ['sending', 150]);
    await mk.processCampaigns();
    const done = (await other.api('GET', `${M}/campaigns/${camp.id}`)).body;
    assert.deepEqual([done.status, done.stats.sent], ['sent', 150]);
    const batches = fake.callsTo('/emails/batch').slice(before).filter((c) => c.body.length);
    assert.deepEqual(batches.map((c) => c.body.length), [100, 100, 50]); // prvý pokus zlyhal (500), potom 100 + 50
  });

  it('mesačný limit; naplánovaná kampaň sa odošle plánovačom', async () => {
    process.env.MARKETING_MONTHLY_LIMIT = '1';
    const c = (await owner.api('POST', `${M}/campaigns`, { subject: 'Limit', body: 'x' })).body;
    const r = await owner.api('POST', `${M}/campaigns/${c.id}/send`, {});
    assert.match(r.body.error, /mesačný limit/);
    delete process.env.MARKETING_MONTHLY_LIMIT;

    const at = new Date(Date.now() + 3600 * 1000).toISOString();
    const s = (await owner.api('POST', `${M}/campaigns/${c.id}/send`, { scheduledAt: at })).body;
    assert.equal(s.status, 'scheduled');
    getDb().prepare('UPDATE email_campaigns SET scheduled_at = unixepoch() - 1 WHERE id = ?').run(c.id);
    await mk.tick();
    assert.equal((await owner.api('GET', `${M}/campaigns/${c.id}`)).body.status, 'sent');
  });

  it('séria po lead magnete: kroky s oneskorením, odhlásenie ju zastaví', async () => {
    const seq = await owner.api('POST', `${M}/sequences`, {
      name: 'Uvítanie', trigger: 'lead_magnet', triggerRef: 'lm_1', active: true,
      steps: [{ delayHours: 0, subject: 'Vitaj {{meno}}', body: 'Tu je tip 1' }, { delayHours: 24, subject: 'Tip 2', body: 'Tip 2' }, { delayHours: 48, subject: 'Tip 3', body: 'Tip 3' }],
    });
    assert.equal(seq.status, 200, JSON.stringify(seq.body));
    const c = mk.upsertContact(owner.id, { email: 'lead@x.sk', name: 'Lea', consent: true });
    mk.onLeadMagnet(owner.id, 'lead@x.sk', 'lm_other'); // iný lead magnet – nič
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM email_enrollments WHERE contact_id = ?').get(c.id).n, 0);
    mk.onLeadMagnet(owner.id, 'lead@x.sk', 'lm_1');
    await mk.processSequences();
    assert.equal(fake.callsTo('/emails').at(-1).body.subject, 'Vitaj Lea');
    const e = getDb().prepare('SELECT * FROM email_enrollments WHERE contact_id = ?').get(c.id);
    assert.equal(e.step, 1);
    assert.ok(e.next_at > Date.now() / 1000 + 23 * 3600);
    getDb().prepare('UPDATE email_enrollments SET next_at = 0 WHERE id = ?').run(e.id);
    await mk.processSequences();
    assert.equal(fake.callsTo('/emails').at(-1).body.subject, 'Tip 2');
    mk.unsubscribe(c.unsubscribe_token);
    getDb().prepare('UPDATE email_enrollments SET next_at = 0 WHERE id = ?').run(e.id);
    await mk.processSequences();
    assert.equal(fake.callsTo('/emails').at(-1).body.subject, 'Tip 2');
    assert.equal(getDb().prepare('SELECT status FROM email_enrollments WHERE id = ?').get(e.id).status, 'stopped');
    assert.equal((await owner.api('POST', `${M}/sequences`, { trigger: 'tag', active: true, steps: [{ subject: '', body: '' }] })).status, 400);
  });

  it('vlastná doména: DNS záznamy, overenie, potom sa posiela z nej', async () => {
    assert.equal((await owner.api('POST', `${M}/domain`, { domain: 'nie domena' })).status, 400);
    const d = (await owner.api('POST', `${M}/domain`, { domain: 'https://Studio.sk/' })).body;
    assert.deepEqual([d.domain, d.domainStatus, d.domainRecords[0].name], ['studio.sk', 'not_started', 'resend._domainkey']);
    assert.equal(fake.callsTo('/domains').at(-1).body.name, 'studio.sk');
    const v = (await owner.api('POST', `${M}/domain/verify`)).body;
    assert.equal(v.domainStatus, 'verified');
    assert.equal(mk.sender(owner.id).from, 'Štúdio Ema <info@studio.sk>');
    await owner.api('DELETE', `${M}/domain`);
    assert.equal(mk.sender(owner.id).from, 'Štúdio Ema <noreply@mail.neoworkly.test>');
  });
});
