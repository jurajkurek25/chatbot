const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, activeMerchant, newUser, db } = require('./helpers/app');
const { getDb } = require('../../db/database');

describe('dashboard obchodníka', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  it('bez prihlásenia 401; bez prístupu k Neoworkly zablokuje produkty aj prepojenie Stripe', async () => {
    assert.equal((await client(ctx.base).get('/api/funnels/api/me')).status, 401);
    const { browser } = newUser(ctx, { status: 'inactive' });
    assert.equal((await browser.get('/api/funnels/api/me')).body.active, false);
    assert.equal((await browser.post('/api/funnels/api/connect')).status, 402);
    const product = { id: 'a', name: 'A', type: 'one_time', amount: 100 };
    assert.equal((await browser.post('/api/funnels/api/products', product)).status, 402);
  });

  it('funnely sú v cene Neoworkly aj v skúšobnom období', async () => {
    const { browser, userId } = newUser(ctx, { status: 'inactive' });
    getDb().prepare('UPDATE users SET trial_until = unixepoch() + 86400 WHERE id = ?').run(userId);
    assert.equal((await browser.get('/api/funnels/api/me')).body.active, true);
    assert.equal((await browser.post('/api/funnels/api/products', { id: 'a', name: 'A', type: 'one_time', amount: 100 })).status, 200);
  });

  it('klient so starým predplatným Funnel 4 € pracuje ďalej bez predplatného Neoworkly a spravuje ho cez portál', async () => {
    const { browser, userId } = newUser(ctx, { status: 'inactive' });
    await browser.get('/api/funnels/api/me');
    const merchant = await db.getMerchantByUser(userId);
    getDb().prepare("UPDATE funnel_merchants SET platform_customer_id = 'cus_legacy', subscription_status = 'active' WHERE id = ?").run(merchant.id);
    ctx.stripe.subscriptionStatus.cus_legacy = 'active';
    const me = (await browser.get('/api/funnels/api/me')).body;
    assert.deepEqual([me.active, me.legacySubscription], [true, { status: 'active', active: true }]);
    assert.equal((await browser.post('/api/funnels/api/products', { id: 'a', name: 'A', type: 'one_time', amount: 100 })).status, 200);
    const portal = await browser.post('/api/funnels/api/billing-portal');
    assert.equal(portal.status, 200);
    assert.equal(ctx.stripe.lastCall('billingPortal.sessions.create').params.customer, 'cus_legacy');

    ctx.stripe.subscriptionStatus.cus_legacy = 'canceled'; // zrušené cez portál
    assert.equal((await browser.get('/api/funnels/api/me')).body.active, false);
    assert.equal((await browser.post('/api/funnels/api/products', { id: 'b', name: 'B', type: 'one_time', amount: 100 })).status, 402);
  });

  it('nový používateľ bez starého predplatného portál Funnel nemá', async () => {
    const { browser } = newUser(ctx);
    await browser.get('/api/funnels/api/me');
    assert.equal((await browser.post('/api/funnels/api/billing-portal')).status, 400);
  });

  it('prepojenie Stripe vytvorí ekvivalent Standard účtu a onboarding odkaz', async () => {
    const m = await activeMerchant(ctx);
    const account = ctx.stripe.lastCall('accounts.create').params;
    assert.deepEqual(account.controller, {
      stripe_dashboard: { type: 'full' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    });
    const link = ctx.stripe.lastCall('accountLinks.create').params;
    assert.equal(link.type, 'account_onboarding');
    assert.equal(link.return_url, 'http://neoworkly.test/dashboard?stripe=return');
    assert.equal(m.me.chargesEnabled, true);

    // Druhé kliknutie nevytvára nový účet, iba nový odkaz
    const accounts = ctx.stripe.callsTo('accounts.create').length;
    await m.browser.post('/api/funnels/api/connect');
    assert.equal(ctx.stripe.callsTo('accounts.create').length, accounts);
  });

  it('opakovaný produkt vytvorí Price na účte obchodníka; zmena ceny archivuje starú', async () => {
    const m = await activeMerchant(ctx);
    const res = await m.browser.post('/api/funnels/api/products', {
      id: 'klub', name: 'Klub', type: 'recurring', interval: 'month', amount: 990,
    });
    assert.equal(res.status, 200);
    const created = ctx.stripe.lastCall('prices.create');
    assert.equal(created.account, m.account);
    assert.deepEqual(created.params.recurring, { interval: 'month' });
    const oldPrice = res.body.products.klub.stripePriceId;
    assert.equal(res.body.products.klub.label, '9,90\u00a0€ mesačne'); // Intl: nezalomiteľná medzera

    const updated = await m.browser.put('/api/funnels/api/products/klub', { name: 'Klub', amount: 1290 });
    assert.notEqual(updated.body.products.klub.stripePriceId, oldPrice);
    assert.deepEqual(ctx.stripe.lastCall('prices.update').params, { id: oldPrice, active: false });
    assert.equal(ctx.stripe.lastCall('prices.update').account, m.account);
  });

  it('validuje produkty a kroky', async () => {
    const m = await activeMerchant(ctx);
    const post = (body) => m.browser.post('/api/funnels/api/products', body);
    assert.equal((await post({ id: 'X Y', name: 'A', type: 'one_time', amount: 100 })).status, 400);
    assert.equal((await post({ id: 'lacny', name: 'A', type: 'one_time', amount: 49 })).status, 400);
    assert.equal((await post({ id: 'ok', name: 'A', type: 'one_time', amount: 100 })).status, 200);
    assert.equal((await post({ id: 'ok', name: 'B', type: 'one_time', amount: 100 })).status, 400);

    const step = (body) => m.browser.put('/api/funnels/api/steps/s1', { kind: 'offer', productId: 'ok', onDecline: '/n', ...body });
    assert.equal((await step({ onAccept: '//evil.example' })).status, 400);
    assert.equal((await step({ onAccept: 'javascript:alert(1)' })).status, 400);
    assert.equal((await step({ onAccept: 'https://shop.example/dakujeme' })).status, 200);

    assert.equal((await m.browser.del('/api/funnels/api/products/ok')).status, 400); // používa ho krok s1
    assert.equal((await m.browser.del('/api/funnels/api/steps/s1')).status, 200);
    assert.equal((await m.browser.del('/api/funnels/api/products/ok')).status, 200);
  });

  it('snippet obsahuje obchodníka a escapované texty; Stripe účet a kľúč dostane z API', async () => {
    const m = await activeMerchant(ctx);
    await m.browser.post('/api/funnels/api/products', { id: 'xss', name: '<script>alert(1)</script>', type: 'one_time', amount: 100 });
    await m.browser.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'xss', maxQuantity: 3, onAccept: '/u' });
    const { html } = (await m.browser.get('/api/funnels/api/snippets/vstup')).body;
    assert.match(html, new RegExp(`NW_MERCHANT = '${m.id}'`));
    assert.doesNotMatch(html, /acct_|pk_test/); // žiadne ID účtu ani kľúč => prežije nové prepojenie Stripe
    const view = await client(ctx.base).post(`/api/f/${m.id}/vstup/view`);
    assert.deepEqual([view.body.stripeAccount, view.body.publishableKey, view.body.mode], [m.account, 'pk_test_platform', 'live']);
    assert.match(html, /NW_API = 'http:\/\/neoworkly\.test'/);
    assert.match(html, /max="3"/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /\{\{/);
  });

  it('snippety vstupu aj ponuky ukazujú Powered by Stripe a Neoworkly Funnel', async () => {
    const m = await activeMerchant(ctx);
    await m.browser.post('/api/funnels/api/products', { id: 'p', name: 'P', type: 'one_time', amount: 500 });
    await m.browser.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'p', maxQuantity: 1, onAccept: '/u' });
    await m.browser.put('/api/funnels/api/steps/ponuka', { kind: 'offer', productId: 'p', onAccept: '/a', onDecline: '/b' });
    for (const step of ['vstup', 'ponuka']) {
      const { html } = (await m.browser.get(`/api/funnels/api/snippets/${step}`)).body;
      assert.match(html, /Powered by <a href="https:\/\/stripe\.com" target="_blank" rel="noopener">Stripe<\/a>/, step);
      assert.match(html, /<a href="http:\/\/neoworkly\.test\/" target="_blank" rel="noopener">Neoworkly Funnel<\/a>/, step);
    }
  });

  it('súbežná úprava z dvoch okien skončí 409 namiesto prepísania', async () => {
    const m = await activeMerchant(ctx);
    const original = ctx.stripe.prices.create;
    ctx.stripe.prices.create = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return original(...args);
    };
    const [slow, fast] = await Promise.all([
      m.browser.post('/api/funnels/api/products', { id: 'pomaly', name: 'P', type: 'recurring', interval: 'month', amount: 500 }),
      new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
        m.browser.post('/api/funnels/api/products', { id: 'rychly', name: 'R', type: 'one_time', amount: 700 }),
      ),
    ]);
    ctx.stripe.prices.create = original;
    assert.equal(fast.status, 200);
    assert.equal(slow.status, 409);
    assert.deepEqual(Object.keys((await m.browser.get('/api/funnels/api/me')).body.products), ['rychly']);
  });
});
