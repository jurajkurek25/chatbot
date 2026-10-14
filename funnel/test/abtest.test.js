const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, activeMerchant, db } = require('./helpers/app');
const { resetRateLimits } = require('../src/ratelimit');

describe('funnely a A/B testy', () => {
  let ctx;
  let shop;
  const put = (path, body) => shop.browser.put(`/api/funnels/api${path}`, body);
  const f = (step, action, body = {}, headers = {}) => client(ctx.base).post(`/api/f/${shop.id}/${step}/${action}`, body, headers);

  before(async () => {
    ctx = await startApp();
    shop = await activeMerchant(ctx);
    const b = shop.browser;
    await b.post('/api/funnels/api/products', { id: 'kniha', name: 'E-kniha', type: 'one_time', amount: 1900 });
    await b.post('/api/funnels/api/products', { id: 'kniha-lacna', name: 'E-kniha', type: 'one_time', amount: 1500 });
    await b.post('/api/funnels/api/products', { id: 'pro', name: 'Pro', type: 'one_time', amount: 4900 });
    await b.post('/api/funnels/api/products', { id: 'kurz-cz', name: 'Kurz', type: 'one_time', amount: 49000, currency: 'czk' });
  });
  after(() => ctx.close());
  beforeEach(() => resetRateLimits());

  describe('funnely', () => {
    it('vytvorenie, priradenie krokov, filter štatistík a zmazanie', async () => {
      assert.equal((await put('/funnels/Zly Nazov', { name: 'X' })).status, 400);
      assert.equal((await put('/funnels/jar', { name: ' ' })).status, 400);
      assert.equal((await put('/funnels/jar', { name: 'Kurz jar 2027' })).status, 200);
      await put('/funnels/kniha', { name: 'E-kniha' });
      assert.equal((await put('/steps/s1', { kind: 'offer', productId: 'pro', onAccept: '/a', onDecline: '/b', funnelId: 'neexistuje' })).status, 400);
      await put('/steps/s1', { kind: 'offer', productId: 'pro', onAccept: '/a', onDecline: '/b', funnelId: 'jar' });
      await put('/steps/s2', { kind: 'offer', productId: 'pro', onAccept: '/a', onDecline: '/b', funnelId: 'kniha' });

      const stats = (await shop.browser.get('/api/funnels/api/stats?days=7&funnel=jar')).body;
      assert.equal(stats.funnel, 'jar');
      assert.deepEqual(stats.steps.map((s) => s.stepId), ['s1']);

      const del = await shop.browser.del('/api/funnels/api/funnels/jar');
      assert.deepEqual(Object.keys(del.body.funnels), ['kniha']);
      assert.equal(del.body.steps.s1.funnelId, undefined); // krok zostal, iba bez funnela
      await shop.browser.del('/api/funnels/api/steps/s1');
      await shop.browser.del('/api/funnels/api/steps/s2');
    });
  });

  describe('A/B test', () => {
    before(async () => {
      await put('/steps/vstup', { kind: 'entry', productId: 'kniha', maxQuantity: 1, onAccept: '/u' });
      await put('/steps/upsell', { kind: 'offer', productId: 'pro', onAccept: '/t', onDecline: '/t', yesText: 'Chcem Pro' });
    });

    it('validácia: rozdelenie, rozdiel medzi variantmi, rovnaká mena', async () => {
      const ab = (body) => put('/steps/vstup/ab', body);
      assert.equal((await ab({ split: 0, title: 'B' })).status, 400);
      assert.equal((await ab({ split: 100, title: 'B' })).status, 400);
      assert.equal((await ab({ split: 50 })).status, 400); // B sa ničím nelíši
      assert.equal((await ab({ split: 50, productId: 'kniha' })).status, 400); // rovnaký produkt = žiadny rozdiel
      assert.match((await ab({ split: 50, productId: 'kurz-cz' })).body.error, /rovnakej mene/);
      assert.equal((await ab({ split: 50, productId: 'nic' })).status, 400);
    });

    it('rozdelenie návštevníkov podľa nastavenia a trvalý variant v relácii', async () => {
      await put('/steps/vstup/ab', { split: 20, productId: 'kniha-lacna', title: 'Akcia!' });
      let bCount = 0; // limit /view je 300 za 10 min z jednej IP
      for (let i = 0; i < 250; i++) if ((await f('vstup', 'view')).body.variant === 'b') bCount++;
      assert.ok(bCount > 25 && bCount < 80, `B dostalo ${bCount} z 250 (očakávaných ~50)`);
      await resetRateLimits();
      for (let i = 0; i < 20; i++) assert.equal((await f('vstup', 'view', { variant: 'b' })).body.variant, 'b');

      const b = (await f('vstup', 'view', { variant: 'b' })).body;
      assert.deepEqual([b.title, b.price], ['Akcia!', '15,00 €']);
      const a = (await f('vstup', 'view', { variant: 'a' })).body;
      assert.equal(a.price, '19,00 €');
    });

    it('platba vo variante B strhne produkt B; variant sa nedá zameniť pri dokončení', async () => {
      const start = await f('vstup', 'start', { email: 'b@example.sk', variant: 'b' });
      assert.equal(ctx.stripe.lastCall('paymentIntents.create').params.amount, 1500);
      assert.equal(ctx.stripe.lastCall('paymentIntents.create').params.metadata.variant, 'b');
      ctx.stripe.completePayment(start.body.clientSecret.split('_secret_')[0]);
      const auth = { authorization: `Bearer ${start.body.token}` };
      assert.equal((await f('vstup', 'complete', { variant: 'a' }, auth)).status, 400);
      assert.equal((await f('vstup', 'complete', { variant: 'b' }, auth)).status, 200);

      // Upsell s testom textov: 3D Secure platba z variantu B sa nedá potvrdiť ako variant A
      await put('/steps/upsell/ab', { split: 50, yesText: 'Áno, pridaj Pro' });
      ctx.stripe.nextPaymentStatus = 'requires_action';
      const accept = await f('upsell', 'accept', { variant: 'b' }, auth);
      const piId = accept.body.clientSecret.split('_secret_')[0];
      ctx.stripe.completePayment(piId);
      ctx.stripe.nextPaymentStatus = 'succeeded';
      assert.equal((await f('upsell', 'confirm', { paymentIntentId: piId, variant: 'a' }, auth)).status, 403);
      assert.equal((await f('upsell', 'confirm', { paymentIntentId: piId, variant: 'b' }, auth)).status, 200);
    });

    it('výsledky od spustenia testu so štatistickou významnosťou', async () => {
      const step = (await db.getMerchant(shop.id)).funnel.steps.vstup;
      let res = (await shop.browser.get('/api/funnels/api/stats?days=7')).body.steps.find((s) => s.stepId === 'vstup').ab;
      assert.equal(res.verdict, 'not_enough_data');
      assert.equal(res.b.purchases, 1);
      assert.equal(res.b.revenue, 1500);
      assert.equal(res.currency, 'eur');

      // Dosť dát: A 20/1000, B 45/1000 => B lepší
      const add = async (variant, type, n, amount = 0) => {
        for (let i = 0; i < n; i++) await db.addEvent({ merchantId: shop.id, stepId: 'vstup', type, variant, amount, at: step.ab.startedAt + 1 });
      };
      await add('a', 'view', 1000); await add('a', 'purchase', 20, 1900);
      await add('b', 'view', 1000); await add('b', 'purchase', 44, 1500);
      // Udalosti spred spustenia testu sa nepočítajú
      await db.addEvent({ merchantId: shop.id, stepId: 'vstup', type: 'purchase', variant: 'a', amount: 1900, at: step.ab.startedAt - 1000 });
      res = (await shop.browser.get('/api/funnels/api/stats?days=7')).body.steps.find((s) => s.stepId === 'vstup').ab;
      assert.equal(res.verdict, 'b_better');
      assert.ok(res.pValue < 0.05);
      assert.equal(res.a.purchases, 20);
      assert.ok(Math.abs(res.b.revenuePerView - (45 * 1500) / res.b.views) < 1e-9);
    });

    it('úprava kroku test zachová; zmena typu ho zruší; produkt z variantu B sa nedá zmazať', async () => {
      await put('/steps/vstup', { kind: 'entry', productId: 'kniha', maxQuantity: 2, onAccept: '/u2' });
      assert.ok((await db.getMerchant(shop.id)).funnel.steps.vstup.ab);
      assert.match((await shop.browser.del('/api/funnels/api/products/kniha-lacna')).body.error, /vstup/);
      await put('/steps/upsell', { kind: 'entry', productId: 'pro', maxQuantity: 1, onAccept: '/t' });
      assert.equal((await db.getMerchant(shop.id)).funnel.steps.upsell.ab, undefined);
    });

    it('víťaz B sa stane natrvalo podobou kroku a test skončí', async () => {
      const res = await shop.browser.post('/api/funnels/api/steps/vstup/ab/winner', { variant: 'b' });
      const step = res.body.steps.vstup;
      assert.deepEqual([step.productId, step.title, step.ab], ['kniha-lacna', 'Akcia!', undefined]);
      assert.equal((await f('vstup', 'view', { variant: 'b' })).body.variant, 'a'); // bez testu vždy A
      assert.equal((await shop.browser.del('/api/funnels/api/steps/vstup/ab')).status, 400);
    });
  });
});
