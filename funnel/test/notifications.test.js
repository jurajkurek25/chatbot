// Webhook príjemca beží lokálne => povolíme súkromné adresy; opakovania skrátené
process.env.WEBHOOK_ALLOW_PRIVATE = '1';
process.env.WEBHOOK_RETRY_DELAYS_MS = '30,30';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { startApp, client, activeMerchant, mails, db } = require('./helpers/app');
const notify = require('../src/notify');

const waitFor = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Nedočkal som sa');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('oznámenia o objednávkach', () => {
  let ctx;
  let shop;
  let receiver;
  let received;
  let failNext; // koľko ďalších požiadaviek má príjemca odmietnuť
  let receiverUrl;

  before(async () => {
    ctx = await startApp();
    received = [];
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext -= 1;
          res.writeHead(500).end();
        } else res.writeHead(200).end('ok');
      });
    });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

    shop = await activeMerchant(ctx);
    await shop.browser.post('/api/funnels/api/products', { id: 'kniha', name: 'E-kniha', type: 'one_time', amount: 1900 });
    await shop.browser.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'kniha', maxQuantity: 3, onAccept: '/u' });
  });
  after(async () => {
    receiver.close();
    await ctx.close();
  });
  beforeEach(() => {
    received = [];
    failNext = 0;
  });

  async function buy(quantity = 2) {
    const c = client(ctx.base);
    const start = await c.post(`/api/f/${shop.id}/vstup/start`, { email: 'kupujuci@example.sk', quantity });
    const piId = start.body.clientSecret.split('_secret_')[0];
    ctx.stripe.completePayment(piId);
    ctx.stripe.customers_[ctx.stripe.paymentIntents_[piId].customer].email = 'kupujuci@example.sk';
    const t = Date.now();
    const res = await c.post(`/api/f/${shop.id}/vstup/complete`, {}, { authorization: `Bearer ${start.body.token}` });
    return { res, piId, ms: Date.now() - t };
  }

  it('predvolene pošle obchodníkovi e-mail s objednávkou', async () => {
    const count = mails.length;
    const { piId } = await buy(2);
    await waitFor(() => mails.length > count);
    const mail = mails.at(-1);
    assert.equal(mail.to, shop.email);
    assert.equal(mail.subject, 'Nová objednávka: E-kniha – 38,00 €');
    assert.match(mail.text, /E-kniha × 2/);
    assert.match(mail.text, /Zákazník: kupujuci@example\.sk/);
    assert.match(mail.text, new RegExp(`dashboard\\.stripe\\.com/payments/${piId}`));
  });

  it('výpadok databázy štatistík nezastaví nákup ani oznámenie', async () => {
    const original = db.addEvent;
    db.addEvent = async () => {
      throw new Error('databáza nedostupná');
    };
    try {
      const count = mails.length;
      const { res } = await buy(1);
      assert.equal(res.status, 200);
      assert.equal(res.body.next, '/u');
      await waitFor(() => mails.length > count);
      assert.match(mails.at(-1).subject, /^Nová objednávka: E-kniha/);
    } finally {
      db.addEvent = original;
    }
  });

  it('webhook: podpísaná objednávka so všetkými údajmi; tajomstvo sa vytvorí raz', async () => {
    const saved = await shop.browser.put('/api/funnels/api/notifications', { email: false, webhookUrl: receiverUrl });
    const secret = saved.body.notifications.webhookSecret;
    assert.match(secret, /^nwsec_/);
    const again = await shop.browser.put('/api/funnels/api/notifications', { email: false, webhookUrl: receiverUrl });
    assert.equal(again.body.notifications.webhookSecret, secret);

    const count = mails.length;
    const { piId } = await buy(1);
    await waitFor(() => received.length === 1);
    const { headers, body } = received[0];
    const order = JSON.parse(body);
    assert.deepEqual(
      { ...order, created: undefined },
      {
        type: 'order.completed', id: `ord_${piId}`, created: undefined, mode: 'live', merchantId: shop.id, step: 'vstup',
        product: { id: 'kniha', name: 'E-kniha', type: 'one_time', interval: null }, quantity: 1, amount: 1900,
        currency: 'eur', customer: { email: 'kupujuci@example.sk', stripeCustomerId: ctx.stripe.paymentIntents_[piId].customer },
        fields: {}, shipping: null, stripeAccountId: shop.account, paymentIntentId: piId,
      },
    );
    // Overenie podpisu tak, ako ho má urobiť obchodník
    const [, t, v1] = headers['neoworkly-signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    assert.equal(v1, expected);
    assert.ok(Math.abs(Date.now() / 1000 - Number(t)) < 60);
    assert.equal(mails.length, count); // e-mail vypnutý
  });

  it('pri chybe príjemcu webhook zopakuje; platba na doručenie nečaká', async () => {
    failNext = 2;
    const { res } = await buy(1);
    assert.equal(res.status, 200);
    await waitFor(() => received.length === 3);
    assert.equal(received[0].body, received[2].body);
  });

  it('skúšobný webhook ukáže výsledok; výmena tajomstva', async () => {
    const ok = await shop.browser.post('/api/funnels/api/notifications/test');
    assert.deepEqual(ok.body, { ok: true, status: 200 });
    assert.equal(JSON.parse(received[0].body).test, true);
    failNext = 1;
    const failed = await shop.browser.post('/api/funnels/api/notifications/test');
    assert.deepEqual([failed.status, failed.body.error], [424, 'Webhook sa nepodarilo doručiť: Webhook odpovedal HTTP 500']);

    const before = (await shop.browser.get('/api/funnels/api/me')).body.notifications.webhookSecret;
    const after = (await shop.browser.post('/api/funnels/api/notifications/secret')).body.notifications.webhookSecret;
    assert.notEqual(after, before);
  });

  it('ochrana proti SSRF: iba https a nikdy súkromná sieť (aj cez DNS)', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = '0';
    try {
      const put = (webhookUrl) => shop.browser.put('/api/funnels/api/notifications', { webhookUrl });
      assert.equal((await put('http://hooks.example.com/x')).status, 400);
      assert.equal((await put('https://169.254.169.254/latest/meta-data')).status, 400);
      assert.equal((await put('https://[::1]/x')).status, 400);
      assert.equal((await put('https://localhost/x')).status, 400);
      // Verejne vyzerajúci názov, ktorý DNS preloží na vnútornú adresu (DNS rebinding):
      // kontrolou URL prejde, ale spojenie sa zablokuje podľa skutočnej IP z DNS
      const dns = require('dns');
      const realLookup = dns.lookup;
      dns.lookup = (host, opts, cb) =>
        host === 'hooks.evil.example' ? (opts.all ? cb(null, [{ address: '10.0.0.5', family: 4 }]) : cb(null, '10.0.0.5', 4))
          : realLookup(host, opts, cb);
      try {
        assert.equal(notify.validateWebhookUrl('https://hooks.evil.example/x'), null);
        await assert.rejects(notify.deliver('https://hooks.evil.example/x', 's', {}), /súkromnej siete/);
      } finally {
        dns.lookup = realLookup;
      }
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    }
  });
});
