const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, activeMerchant, db } = require('./helpers/app');
const { getDb } = require('../../db/database');
const { resetRateLimits } = require('../src/ratelimit');

describe('funnel zákazníka', () => {
  let ctx;
  let shop; // obchodník s funnelom vstup (jednorazový) → upsell (opakovaný) → downsell (jednorazový)
  let customer; // HTTP klient bez cookies (snippet na doméne obchodníka)

  before(async () => {
    ctx = await startApp();
    shop = await activeMerchant(ctx);
    const b = shop.browser;
    await b.post('/api/funnels/api/products', { id: 'kniha', name: 'E-kniha', type: 'one_time', amount: 1900 });
    await b.post('/api/funnels/api/products', { id: 'klub', name: 'Klub', type: 'recurring', interval: 'month', amount: 990 });
    await b.post('/api/funnels/api/products', { id: 'mini', name: 'Mini', type: 'one_time', amount: 700 });
    await b.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'kniha', maxQuantity: 3, onAccept: 'https://shop.example/upsell' });
    await b.put('/api/funnels/api/steps/upsell', {
      kind: 'offer', productId: 'klub', onAccept: 'https://shop.example/dakujeme', onDecline: 'https://shop.example/downsell',
    });
    await b.put('/api/funnels/api/steps/downsell', {
      kind: 'offer', productId: 'mini', onAccept: 'https://shop.example/dakujeme', onDecline: 'https://shop.example/dakujeme',
    });
    customer = client(ctx.base);
  });
  after(() => ctx.close());
  beforeEach(async () => {
    await resetRateLimits();
    ctx.stripe.nextPaymentStatus = 'succeeded';
  });

  const funnel = (step, action, body = {}, token) =>
    customer.post(`/api/f/${shop.id}/${step}/${action}`, body, token ? { authorization: `Bearer ${token}` } : {});

  // Prejde vstupným krokom a vráti token zákazníka
  async function enter(quantity = 1) {
    const start = await funnel('vstup', 'start', { email: 'zakaznik@example.sk', quantity });
    assert.equal(start.status, 200);
    const piId = start.body.clientSecret.split('_secret_')[0];
    ctx.stripe.completePayment(piId); // zákazník potvrdil platbu v Payment Element
    const complete = await funnel('vstup', 'complete', {}, start.body.token);
    assert.equal(complete.status, 200);
    return { token: start.body.token, piId, next: complete.body.next };
  }

  it('počet upsellov/downsellov nie je obmedzený: 6 ponúk za sebou jednou kartou', async () => {
    const other = await activeMerchant(ctx);
    const b = other.browser;
    await b.post('/api/funnels/api/products', { id: 'p', name: 'P', type: 'one_time', amount: 500 });
    await b.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'p', maxQuantity: 1, onAccept: '/u1' });
    for (let i = 1; i <= 6; i += 1) {
      const res = await b.put(`/api/funnels/api/steps/u${i}`, { kind: 'offer', productId: 'p', onAccept: `/u${i + 1}`, onDecline: `/u${i + 1}` });
      assert.equal(res.status, 200);
    }
    const c = client(ctx.base);
    const start = await c.post(`/api/f/${other.id}/vstup/start`, { email: 'vela@example.sk' });
    ctx.stripe.completePayment(start.body.clientSecret.split('_secret_')[0]);
    const auth = { authorization: `Bearer ${start.body.token}` };
    await c.post(`/api/f/${other.id}/vstup/complete`, {}, auth);
    for (let i = 1; i <= 6; i += 1) {
      const res = i === 3 ? await c.post(`/api/f/${other.id}/u${i}/decline`, {}, auth) : await c.post(`/api/f/${other.id}/u${i}/accept`, {}, auth);
      assert.deepEqual([res.status, res.body.next], [200, `/u${i + 1}`], `u${i}`);
    }
  });

  it('chyba zo Stripe ukáže skutočný dôvod (nie všeobecnú chybu)', async () => {
    const original = ctx.stripe.customers.create;
    ctx.stripe.customers.create = async () => {
      throw Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError' });
    };
    try {
      const res = await client(ctx.base).post(`/api/f/${shop.id}/vstup/start`, { email: 'chyba@example.sk' });
      assert.equal(res.status, 424);
      assert.equal(res.body.error, 'Platbu sa nepodarilo pripraviť (Stripe: The provided key does not have the required permissions)');
    } finally {
      ctx.stripe.customers.create = original;
    }
  });

  it('odpovie na CORS preflight z akejkoľvek domény', async () => {
    const res = await fetch(`${ctx.base}/api/f/${shop.id}/vstup/start`, { method: 'OPTIONS', headers: { origin: 'https://shop.example' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
  });

  it('neznámy obchod 404, neznámy krok 404', async () => {
    assert.equal((await customer.post('/api/f/m_neexistuje/vstup/start')).status, 404);
    assert.equal((await funnel('neexistuje', 'start')).status, 404);
  });

  it('vstupný krok: zákazník aj platba na účte obchodníka, karta sa uloží, počet sa oreže', async () => {
    const { next, piId } = await enter(99);
    assert.equal(next, 'https://shop.example/upsell');
    assert.equal(ctx.stripe.lastCall('customers.create').account, shop.account);
    const pi = ctx.stripe.lastCall('paymentIntents.create');
    assert.equal(pi.account, shop.account);
    const entry = pi.params;
    assert.equal(entry.amount, 1900 * 3); // max 3 ks
    assert.equal(entry.setup_future_usage, 'off_session');
    assert.equal(entry.application_fee_amount, undefined); // bez PLATFORM_FEE_PERCENT žiadny poplatok
    const update = ctx.stripe.lastCall('customers.update');
    assert.deepEqual(update.params.invoice_settings, { default_payment_method: 'pm_card_visa' });
    assert.equal(update.params.metadata.funnel_vstup, piId);
  });

  it('dokončenie odmietne nezaplatenú platbu', async () => {
    const start = await funnel('vstup', 'start', { email: 'z@example.sk' });
    assert.equal((await funnel('vstup', 'complete', {}, start.body.token)).status, 402);
  });

  it('dokončenie odmietne platbu, ktorá nepatrí zákazníkovi z tokenu', async () => {
    const start = await funnel('vstup', 'start', { email: 'z@example.sk' });
    const piId = start.body.clientSecret.split('_secret_')[0];
    ctx.stripe.completePayment(piId);
    ctx.stripe.paymentIntents_[piId].customer = 'cus_niekto_iny';
    assert.equal((await funnel('vstup', 'complete', {}, start.body.token)).status, 403);
  });

  it('start na kroku typu offer nie je povolený', async () => {
    assert.equal((await funnel('upsell', 'start', { email: 'z@example.sk' })).status, 400);
  });

  it('upsell (opakovaný) vytvorí predplatné uloženou kartou; opakovaný klik nestiahne druhýkrát', async () => {
    const { token } = await enter();
    const res = await funnel('upsell', 'accept', {}, token);
    assert.deepEqual(res.body, { next: 'https://shop.example/dakujeme' });
    const sub = ctx.stripe.lastCall('subscriptions.create');
    assert.equal(sub.account, shop.account);
    assert.equal(sub.params.default_payment_method, 'pm_card_visa');
    assert.match(sub.idempotencyKey, /^cus_\w+:upsell$/);

    const count = ctx.stripe.callsTo('subscriptions.create').length;
    assert.equal((await funnel('upsell', 'accept', {}, token)).status, 200);
    assert.equal(ctx.stripe.callsTo('subscriptions.create').length, count);
  });

  it('downsell (jednorazový) strhne uloženú kartu on-session', async () => {
    const { token } = await enter();
    await funnel('downsell', 'accept', {}, token);
    const pi = ctx.stripe.lastCall('paymentIntents.create');
    assert.equal(pi.account, shop.account);
    assert.deepEqual([pi.params.amount, pi.params.payment_method, pi.params.confirm], [700, 'pm_card_visa', true]);
    assert.equal(pi.params.off_session, undefined);
  });

  it('3D Secure: vráti clientSecret a po overení platbu potvrdí', async () => {
    const { token } = await enter();
    ctx.stripe.nextPaymentStatus = 'requires_action';
    const res = await funnel('downsell', 'accept', {}, token);
    assert.equal(res.body.requiresAction, true);
    const piId = res.body.clientSecret.split('_secret_')[0];

    assert.equal((await funnel('downsell', 'confirm', { paymentIntentId: piId }, token)).status, 402); // ešte neoverené
    ctx.stripe.completePayment(piId);
    assert.equal((await funnel('upsell', 'confirm', { paymentIntentId: piId }, token)).status, 403); // iný krok
    assert.deepEqual((await funnel('downsell', 'confirm', { paymentIntentId: piId }, token)).body, {
      next: 'https://shop.example/dakujeme',
    });
  });

  it('zamietnutá karta vráti 402 s hláškou', async () => {
    const { token } = await enter();
    ctx.stripe.nextPaymentStatus = 'declined';
    const res = await funnel('downsell', 'accept', {}, token);
    assert.deepEqual([res.status, res.body.error], [402, 'Karta bola zamietnutá.']);
  });

  it('bez tokenu, s podvrhnutým tokenom alebo tokenom iného obchodníka 401', async () => {
    const { token } = await enter();
    assert.equal((await funnel('upsell', 'accept')).status, 401);
    assert.equal((await funnel('upsell', 'accept', {}, token.slice(0, -3) + 'abc')).status, 401);

    const other = await activeMerchant(ctx);
    await other.browser.post('/api/funnels/api/products', { id: 'p', name: 'P', type: 'one_time', amount: 100 });
    await other.browser.put('/api/funnels/api/steps/upsell', { kind: 'offer', productId: 'p', onAccept: '/a', onDecline: '/b' });
    const res = await customer.post(`/api/f/${other.id}/upsell/accept`, {}, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 401);
  });

  it('„Nechcem pridať“ vráti ďalší krok bez platby', async () => {
    const count = ctx.stripe.calls.length;
    assert.deepEqual((await funnel('upsell', 'decline')).body, { next: 'https://shop.example/downsell' });
    assert.equal(ctx.stripe.calls.length, count);
  });

  it('obchod bez prístupu k Neoworkly (a bez starého predplatného) alebo bez platieb vráti 503', async () => {
    const userStatus = (status) => getDb().prepare('UPDATE users SET subscription_status = ? WHERE id = ?').run(status, shop.userId);
    await db.updateMerchant(shop.id, { charges_enabled: false });
    assert.equal((await funnel('upsell', 'decline')).status, 503);
    await db.updateMerchant(shop.id, { charges_enabled: true });
    userStatus('canceled'); // skončené predplatné Neoworkly
    assert.equal((await funnel('upsell', 'decline')).status, 503);
    // klient so starým predplatným Funnel 4 € predáva ďalej (aj keď Stripe ešte skúša platbu)
    await db.updateMerchant(shop.id, { subscription_status: 'past_due' });
    assert.equal((await funnel('upsell', 'decline')).status, 200);
    await db.updateMerchant(shop.id, { subscription_status: 'canceled' });
    assert.equal((await funnel('upsell', 'decline')).status, 503);
    userStatus('active');
    assert.equal((await funnel('upsell', 'decline')).status, 200);
  });

  it('obmedzí /start na 10 za 10 minút z jednej IP', async () => {
    for (let i = 0; i < 10; i++) await funnel('vstup', 'start', { email: 'z@example.sk' });
    assert.equal((await funnel('vstup', 'start', { email: 'z@example.sk' })).status, 429);
  });
});
