const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, activeMerchant, mails, db } = require('./helpers/app');
const { getDb } = require('../../db/database');

describe('testovací režim obchodníka', () => {
  let ctx;
  let shop;
  let testKey;
  let testAccount;
  const f = (step, action, body = {}, headers = {}) =>
    client(ctx.base).post(`/api/f/${shop.id}/${step}/${action}`, body, headers);

  before(async () => {
    ctx = await startApp();
    shop = await activeMerchant(ctx);
    await shop.browser.post('/api/funnels/api/products', { id: 'kniha', name: 'E-kniha', type: 'one_time', amount: 1900 });
    await shop.browser.post('/api/funnels/api/products', { id: 'klub', name: 'Klub', type: 'recurring', interval: 'month', amount: 990 });
    await shop.browser.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'kniha', maxQuantity: 3, onAccept: '/u' });
    await shop.browser.put('/api/funnels/api/steps/upsell', { kind: 'offer', productId: 'klub', onAccept: '/t', onDecline: '/t' });
  });
  after(() => ctx.close());

  it('bez testovacieho účtu testovací režim nefunguje', async () => {
    const me = (await shop.browser.get('/api/funnels/api/me')).body;
    assert.deepEqual([me.testMode.available, me.testMode.accountId, me.testMode.ready], [true, null, false]);
    assert.equal((await f('vstup', 'view', {}, { 'X-Neoworkly-Test': 'nwtest_x' })).status, 503);
  });

  it('vytvorí testovací Stripe účet testovacími kľúčmi a presunie doň opakované produkty', async () => {
    const res = await shop.browser.post('/api/funnels/api/test/connect');
    assert.equal(res.status, 200);
    const created = ctx.stripeTest.lastCall('accounts.create');
    assert.equal(created.params.controller.stripe_dashboard.type, 'full');
    assert.equal(ctx.stripe.callsTo('accounts.create').filter((c) => c.params.metadata.neoworkly_merchant === shop.id).length, 1); // ostrý iba jeden
    const link = ctx.stripeTest.lastCall('accountLinks.create').params;
    assert.equal(link.return_url, 'http://neoworkly.test/dashboard?stripe=test-return');
    // Obnovenie onboardingu: Stripe otvorí odkaz bez prihlásenia => podpísaný odkaz, podvrh neprejde
    const refresh = new URL(link.refresh_url);
    assert.equal(refresh.pathname, '/api/funnels/connect/refresh');
    const again = await client(ctx.base).get(refresh.pathname + refresh.search);
    assert.equal(again.status, 302);
    assert.equal(ctx.stripeTest.lastCall('accountLinks.create').params.account, (await db.getMerchant(shop.id)).test_account_id);
    refresh.searchParams.set('m', 'm_iny');
    assert.match((await client(ctx.base).get(refresh.pathname + refresh.search)).headers.get('location'), /stripe=expired/);

    const merchant = await db.getMerchant(shop.id);
    testAccount = merchant.test_account_id;
    testKey = merchant.test_key;
    assert.match(testKey, /^nwtest_/);
    const klub = merchant.funnel.products.klub;
    assert.equal(klub.test.accountId, testAccount);
    assert.notEqual(klub.test.priceId, klub.stripePriceId);
    assert.equal(ctx.stripeTest.lastCall('prices.create').account, testAccount);

    ctx.stripeTest.accounts_[testAccount].charges_enabled = true;
    const me = (await shop.browser.get('/api/funnels/api/me')).body;
    assert.deepEqual([me.testMode.ready, me.testMode.key], [true, testKey]);
  });

  it('zmena ceny aj nový opakovaný produkt sa premietnu aj do testovacieho účtu', async () => {
    await shop.browser.put('/api/funnels/api/products/klub', { name: 'Klub VIP', amount: 1290 });
    const klub = (await db.getMerchant(shop.id)).funnel.products.klub;
    assert.deepEqual([klub.test.amount, klub.test.name], [1290, 'Klub VIP']);
    assert.equal(ctx.stripeTest.lastCall('prices.update').params.active, false);
    await shop.browser.post('/api/funnels/api/products', { id: 'extra', name: 'Extra', type: 'recurring', interval: 'year', amount: 5000 });
    assert.equal((await db.getMerchant(shop.id)).funnel.products.extra.test.accountId, testAccount);
    await shop.browser.del('/api/funnels/api/products/extra');
    assert.equal(ctx.stripeTest.lastCall('products.update').params.active, false);
  });

  it('nesprávny testovací kľúč odmietne', async () => {
    assert.equal((await f('vstup', 'view', {}, { 'X-Neoworkly-Test': 'nwtest_zly' })).status, 403);
  });

  it('funnel s testovacím kľúčom beží celý v testovacom účte a nemieša sa s ostrým', async () => {
    const T = { 'X-Neoworkly-Test': testKey };
    const view = (await f('vstup', 'view', { count: true }, T)).body;
    assert.deepEqual([view.mode, view.publishableKey, view.stripeAccount], ['test', 'pk_test_testmode', testAccount]);

    const liveCalls = ctx.stripe.calls.length;
    const mailCount = mails.length;
    const start = await f('vstup', 'start', { email: 'tester@example.sk', quantity: 2 }, T);
    const piId = start.body.clientSecret.split('_secret_')[0];
    assert.equal(ctx.stripeTest.lastCall('paymentIntents.create').account, testAccount);
    ctx.stripeTest.completePayment(piId);
    const auth = { ...T, authorization: `Bearer ${start.body.token}` };
    assert.equal((await f('vstup', 'complete', {}, auth)).status, 200);
    assert.equal((await f('upsell', 'accept', {}, auth)).status, 200);
    const sub = ctx.stripeTest.lastCall('subscriptions.create');
    assert.equal(sub.params.items[0].price, (await db.getMerchant(shop.id)).funnel.products.klub.test.priceId);
    assert.equal(ctx.stripe.calls.length, liveCalls); // ostrý Stripe sa nedotkol

    // Token z testu neplatí v ostrom režime
    assert.equal((await f('upsell', 'accept', {}, { authorization: `Bearer ${start.body.token}` })).status, 401);

    // Štatistiky ostrého režimu testovacie nákupy neobsahujú; oznámenie je označené [TEST]
    const stats = (await shop.browser.get('/api/funnels/api/stats?days=7')).body;
    assert.equal(stats.totals.purchases, 0);
    assert.deepEqual((await db.stepStats(shop.id, 0, 'test')).find((r) => r.stepId === 'vstup').purchases, 1);
    const deadline = Date.now() + 1000;
    while (mails.length === mailCount && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.match(mails.at(-1).subject, /^\[TEST\] Nová objednávka/);
    assert.match(mails.at(-1).text, /dashboard\.stripe\.com\/test\/payments\//);
  });

  it('testovací režim funguje aj keď ostrý účet ešte neprijíma platby, ale nie bez predplatného', async () => {
    const T = { 'X-Neoworkly-Test': testKey };
    const userStatus = (status) => getDb().prepare('UPDATE users SET subscription_status = ? WHERE id = ?').run(status, shop.userId);
    await db.updateMerchant(shop.id, { charges_enabled: false });
    assert.equal((await f('vstup', 'view', {}, T)).status, 200);
    assert.equal((await f('vstup', 'view')).status, 503);
    userStatus('canceled');
    assert.equal((await f('vstup', 'view', {}, T)).status, 503);
    userStatus('active');
    await db.updateMerchant(shop.id, { charges_enabled: true });
  });

  it('server bez testovacích kľúčov testovací režim neponúka', async () => {
    const plain = await startApp({ testMode: false });
    try {
      const m = await activeMerchant(plain);
      assert.equal(m.me.testMode.available, false);
      assert.equal((await m.browser.post('/api/funnels/api/test/connect')).status, 400);
    } finally {
      await plain.close();
    }
  });
});
