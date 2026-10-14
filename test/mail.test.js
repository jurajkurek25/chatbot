// E-mailové schránky (Stalwart) a webmail: domény, DNS overenie, schránky, prístup, odosielanie, e-mail → úloha / Disk.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dns = require('dns').promises;
const { extraRoutes, startApp, newUser, getDb } = require('./helpers');

extraRoutes.push({ path: '/api/mail', module: '../routes/mail' });
const mc = require('../services/mailClient');

describe('e-mail: schránky na vlastnom serveri a webmail', () => {
  let ctx, owner, eva, rado, stalwartSrv, calls = [], domain, info, evaBox;
  const M = '/api/mail';
  const as = (u, m, p, b) => u.api(m, `${p}${p.includes('?') ? '&' : '?'}ws=${owner.id}`, b);
  const sent = [];
  const realDns = { resolveMx: dns.resolveMx, resolveTxt: dns.resolveTxt };

  before(async () => {
    // falošné správcovské API Stalwartu
    stalwartSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/api/dns/records/')) return res.end(JSON.stringify({ data: [
          { type: 'MX', name: 'firma.sk.', content: '10 mail.neoworkly.test.' },
          { type: 'TXT', name: '202610e._domainkey.firma.sk.', content: 'v=DKIM1; k=ed25519; p=abc' },
        ] }));
        res.end(JSON.stringify({ data: null }));
      });
    });
    await new Promise(r => stalwartSrv.listen(0, r));
    Object.assign(process.env, { STALWART_URL: `http://127.0.0.1:${stalwartSrv.address().port}`, STALWART_API_KEY: 'tajny', MAIL_HOST: 'mail.neoworkly.test' });
    // IMAP/SMTP bez skutočného servera
    Object.assign(mc, {
      folders: async () => [{ path: 'INBOX', name: 'Doručená pošta', special: '\\Inbox', unseen: 1, total: 2 }],
      list: async (box, folder) => ({ total: 1, page: 1, items: [{ uid: 7, subject: `Dopyt pre ${box.address}`, from: [{ name: 'Jana', address: 'jana@klient.sk' }], seen: false, folder }] }),
      get: async () => ({ uid: 7, subject: 'Cenová ponuka na web', date: new Date('2026-10-10T08:00:00Z'), from: [{ name: 'Jana', address: 'jana@klient.sk' }], to: [], cc: [], text: 'Dobrý deň, prosím o ponuku.', html: '', attachments: [{ idx: 0, filename: 'zadanie.pdf', contentType: 'application/pdf', size: 6 }] }),
      attachment: async () => ({ filename: 'zadanie.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1') }),
      send: async (box, mail) => { sent.push({ box, mail }); return { messageId: '<x@firma.sk>' }; },
      unread: async () => 3,
      close: () => {},
    });
    ctx = await startApp();
    owner = newUser(ctx, { name: 'Ema Nováková' });
    eva = newUser(ctx, { name: 'Eva Malá' });
    rado = newUser(ctx, { name: 'Rado' });
    const ins = getDb().prepare('INSERT INTO team_members (id, owner_user_id, email, role, accepted, member_user_id) VALUES (?, ?, ?, ?, 1, ?)');
    ins.run('m1', owner.id, eva.email, 'editor', eva.id);
    ins.run('m2', owner.id, rado.email, 'readonly', rado.id);
  });
  after(() => {
    Object.assign(dns, realDns);
    ['STALWART_URL', 'STALWART_API_KEY', 'MAIL_HOST'].forEach(k => delete process.env[k]);
    stalwartSrv.close();
    return ctx.close();
  });

  it('pridanie domény založí doménu a DKIM na serveri a vráti DNS záznamy; iba majiteľ', async () => {
    assert.equal((await as(eva, 'POST', `${M}/domains`, { domain: 'firma.sk' })).status, 403);
    assert.equal((await owner.api('POST', `${M}/domains`, { domain: 'nie je doména' })).status, 400);
    domain = (await owner.api('POST', `${M}/domains`, { domain: 'https://www.Firma.sk/' })).body;
    assert.equal(domain.domain, 'firma.sk');
    assert.equal(domain.status, 'pending');
    assert.deepEqual(domain.records.map(r => r.type), ['MX', 'TXT']);
    assert.deepEqual(calls.slice(0, 3).map(c => [c.method, c.url, c.body?.type || c.body?.algorithm]), [['POST', '/api/principal', 'domain'], ['POST', '/api/dkim', 'Ed25519'], ['POST', '/api/dkim', 'Rsa']]);
    assert.equal(calls[0].auth, 'Bearer tajny');
    assert.equal((await owner.api('POST', `${M}/domains`, { domain: 'firma.sk' })).status, 409);
  });

  it('overenie DNS: aktívna až keď MX smeruje na náš server a SPF ho povoľuje', async () => {
    dns.resolveMx = async () => [{ exchange: 'mx.ine.sk', priority: 10 }];
    dns.resolveTxt = async () => [];
    let d = (await owner.api('POST', `${M}/domains/${domain.id}/verify`, {})).body;
    assert.equal(d.status, 'pending');
    assert.deepEqual(d.checks, { mx: false, spf: false, dkim: false, dmarc: false });
    dns.resolveMx = async () => [{ exchange: 'mail.neoworkly.test.', priority: 10 }];
    dns.resolveTxt = async name => ({ 'firma.sk': [['v=spf1 mx ~all']], '_dmarc.firma.sk': [['v=DMARC1; p=none']], '202610e._domainkey.firma.sk': [['v=DKIM1; k=ed25519; p=abc']] }[name] || []);
    d = (await owner.api('POST', `${M}/domains/${domain.id}/verify`, {})).body;
    assert.equal(d.status, 'active');
    assert.deepEqual(d.checks, { mx: true, spf: true, dkim: true, dmarc: true });
  });

  it('schránky: heslo raz, šifrované v DB; pridelená iba kolegovi, spoločná pre editorov', async () => {
    info = (await owner.api('POST', `${M}/mailboxes`, { domainId: domain.id, local: 'info', name: 'Firma s.r.o.' })).body;
    assert.equal(info.address, 'info@firma.sk');
    assert.ok(info.password.length >= 16);
    const row = getDb().prepare('SELECT secret FROM mailboxes WHERE id = ?').get(info.id);
    assert.ok(!row.secret.includes(info.password));
    assert.equal(require('../routes/mail')._seal.unseal(row.secret), info.password);
    const created = calls.find(c => c.body?.type === 'individual');
    assert.deepEqual([created.body.name, created.body.emails, created.body.secrets], ['info@firma.sk', ['info@firma.sk'], [info.password]]);
    evaBox = (await owner.api('POST', `${M}/mailboxes`, { domainId: domain.id, local: 'eva', name: 'Eva Malá', userId: eva.id })).body;
    assert.equal((await owner.api('POST', `${M}/mailboxes`, { domainId: domain.id, local: 'Eva Malá' })).status, 400);
    assert.equal((await owner.api('POST', `${M}/mailboxes`, { domainId: domain.id, local: 'info' })).status, 409);

    // Eva vidí spoločnú aj svoju, Rado (čítanie) nevidí nič; majiteľ nečíta Evinu
    assert.deepEqual((await as(eva, 'GET', `${M}/mailboxes`)).body.map(b => b.address), ['eva@firma.sk', 'info@firma.sk']);
    assert.deepEqual((await as(rado, 'GET', `${M}/mailboxes`)).body, []);
    assert.equal((await owner.api('GET', `${M}/mailboxes/${evaBox.id}/messages`)).status, 403);
    assert.equal((await as(eva, 'GET', `${M}/mailboxes/${evaBox.id}/messages`)).body.items[0].subject, 'Dopyt pre eva@firma.sk');
    assert.equal((await as(rado, 'GET', `${M}/mailboxes/${info.id}/folders`)).status, 403);
    assert.deepEqual((await as(eva, 'GET', `${M}/unread`)).body, { [evaBox.id]: 3, [info.id]: 3 });

    const reset = (await owner.api('PATCH', `${M}/mailboxes/${info.id}`, { resetPassword: true })).body;
    assert.notEqual(reset.password, info.password);
    assert.equal(calls.at(-1).method, 'PATCH');
  });

  it('odoslanie s prílohou z Disku; e-mail → úloha; príloha → Disk', async () => {
    const r = await as(eva, 'POST', `${M}/mailboxes/${evaBox.id}/send`, { to: 'jana@klient.sk, peter@klient.sk', subject: 'Ponuka', text: 'Dobrý deň' });
    assert.equal(r.status, 200);
    assert.deepEqual(sent[0].mail.to, ['jana@klient.sk', 'peter@klient.sk']);
    assert.equal(sent[0].box.address, 'eva@firma.sk');
    assert.equal((await as(eva, 'POST', `${M}/mailboxes/${evaBox.id}/send`, { to: 'zle', subject: 'x' })).status, 400);

    const t = (await as(eva, 'POST', `${M}/mailboxes/${evaBox.id}/messages/7/to-task`, {})).body;
    assert.equal(t.title, 'Cenová ponuka na web');
    assert.deepEqual(t.assignees, [eva.id]);
    assert.match(getDb().prepare('SELECT description FROM tasks WHERE id = ?').get(t.id).description, /Jana <jana@klient.sk>.*\n\nDobrý deň, prosím o ponuku./s);

    const f = (await as(eva, 'POST', `${M}/mailboxes/${evaBox.id}/messages/7/attachments/0/to-drive`, {})).body;
    assert.equal(f.name, 'zadanie.pdf');
    const item = getDb().prepare('SELECT * FROM drive_items WHERE id = ?').get(f.id);
    assert.equal(getDb().prepare('SELECT name FROM drive_items WHERE id = ?').get(item.parent_id).name, 'Prílohy z e-mailov');
  });

  it('zmazanie: najprv schránky, potom doména; HTML e-mailu bez skriptov a sledovacích obrázkov', async () => {
    assert.equal((await owner.api('DELETE', `${M}/domains/${domain.id}`)).status, 400);
    await owner.api('DELETE', `${M}/mailboxes/${info.id}`);
    await owner.api('DELETE', `${M}/mailboxes/${evaBox.id}`);
    assert.equal((await owner.api('DELETE', `${M}/domains/${domain.id}`)).status, 200);
    assert.ok(calls.some(c => c.method === 'DELETE' && c.url === '/api/principal/info%40firma.sk'));

    const clean = require('../services/mailClient').cleanHtml;
    const r = clean('<p onclick="x()">Ahoj<script>alert(1)</script><img src="https://track.er/p.gif"><img src="cid:logo"><a href="https://x.sk">x</a></p>', { logo: 'data:image/png;base64,AA' }, false);
    assert.ok(!/script|onclick|track\.er/.test(r.html));
    assert.equal(r.blockedImages, 1);
    assert.match(r.html, /src="data:image\/png;base64,AA"/);
    assert.match(r.html, /target="_blank" rel="noopener noreferrer"/);
    assert.match(clean('<img src="https://x.sk/a.png">', {}, true).html, /x\.sk\/a\.png/);
  });
});
