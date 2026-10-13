// Prepojenie Stripe vlastnými API kľúčmi obchodníka (voliteľná alternatíva k Connect)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, activeMerchant, newUser, db } = require('./helpers/app');
const FakeStripe = require('./helpers/fake-stripe');
const { merchantKeys } = require('../src/merchants');
const totp = require('../src/totp');
const { rotate } = require('../scripts/rotate-totp-key');

// Každý tajný kľúč = vlastný falošný Stripe účet; kľúč s "zly" Stripe odmietne
const keyClients = {};
merchantKeys.client = (key) => {
  if (!keyClients[key]) {
    const fake = new FakeStripe();
    const own = { id: `acct_own_${Object.keys(keyClients).length}`, charges_enabled: true };
    fake.accounts.retrieve = async (id) => {
      if (key.includes('zly')) throw new Error('Invalid API Key provided');
      assert.equal(id, undefined); // vlastný účet, bez ID
      return own;
    };
    keyClients[key] = fake;
  }
  return keyClients[key];
};

describe('prepojenie Stripe vlastnými API kľúčmi', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  // Používateľ Neoworkly s predplatným, bez prepojeného Stripe
  async function subscribed() {
    const user = newUser(ctx);
    await user.browser.get('/api/funnels/api/me');
    return { browser: user.browser, id: (await db.getMerchantByUser(user.userId)).id, userId: user.userId };
  }
  const keys = (n, extra = {}) => ({
    secretKey: `sk_test_kluc${n}abcd`,
    publishableKey: `pk_test_verejny${n}`,
    password: 'heslo1234',
    ...extra,
  });

  it('overí heslo, tvar a režim kľúčov aj kľúč samotný v Stripe', async () => {
    const { browser } = await subscribed();
    const post = (body) => browser.post('/api/funnels/api/connect/keys', body);
    assert.equal((await post(keys(1, { password: 'zle' }))).status, 403);
    assert.equal((await post(keys(1, { secretKey: 'pk_test_x' }))).status, 400);
    assert.equal((await post(keys(1, { publishableKey: 'sk_test_x' }))).status, 400);
    const mixed = await post(keys(1, { publishableKey: 'pk_live_x' }));
    assert.deepEqual([mixed.status, mixed.body.error], [400, 'Tajný aj verejný kľúč musia byť z rovnakého režimu (oba live alebo oba test).']);
    const bad = await post(keys(1, { secretKey: 'sk_test_zly' }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Kľúč sa nepodarilo overiť v Stripe: Invalid API Key/);
    assert.equal((await browser.get('/api/funnels/api/me')).body.stripeAccountId, null);
  });

  it('uloží kľúč šifrovane, ukáže iba jeho skrátenú podobu a Connect je zablokovaný', async () => {
    const { browser, id } = await subscribed();
    const res = await browser.post('/api/funnels/api/connect/keys', keys(2));
    assert.equal(res.status, 200);
    assert.equal(res.body.stripeKeyHint, 'sk_test_…abcd');
    assert.equal(res.body.chargesEnabled, true);
    assert.match(res.body.stripeAccountId, /^acct_own_/);

    const stored = await db.getMerchant(id);
    assert.doesNotMatch(stored.stripe_api_key, /kluc2/);
    assert.equal(totp.decrypt(stored.stripe_api_key), 'sk_test_kluc2abcd');
    assert.doesNotMatch(JSON.stringify((await browser.get('/api/funnels/api/me')).body), /kluc2/);

    const connect = await browser.post('/api/funnels/api/connect');
    assert.equal(connect.status, 400);
    assert.equal(ctx.stripe.callsTo('accounts.create').length, 0);

    // Výmena šifrovacieho kľúča prešifruje aj Stripe kľúč
    process.env.TOTP_ENCRYPTION_KEYS = 'novy-kluc-na-sifrovanie-'.padEnd(40, 'z');
    try {
      assert.ok((await rotate(db)) >= 1);
      const rotated = (await db.getMerchant(id)).stripe_api_key;
      assert.match(rotated, /^v2:/);
      assert.equal(totp.decrypt(rotated), 'sk_test_kluc2abcd');
    } finally {
      delete process.env.TOTP_ENCRYPTION_KEYS;
    }
  });

  it('funnel platí priamo na účte obchodníka: jeho verejný kľúč, bez stripeAccount a bez klienta platformy', async () => {
    const { browser, id } = await subscribed();
    await browser.post('/api/funnels/api/connect/keys', keys(3));
    const own = keyClients.sk_test_kluc3abcd;
    await browser.post('/api/funnels/api/products', { id: 'kniha', name: 'Kniha', type: 'one_time', amount: 1900 });
    await browser.post('/api/funnels/api/products', { id: 'klub', name: 'Klub', type: 'recurring', interval: 'month', amount: 990 });
    assert.equal(own.lastCall('prices.create').account, null);
    await browser.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'kniha', maxQuantity: 1, onAccept: '/u' });
    await browser.put('/api/funnels/api/steps/upsell', { kind: 'offer', productId: 'klub', onAccept: '/t', onDecline: '/t' });

    const customer = client(ctx.base);
    const view = await customer.post(`/api/f/${id}/vstup/view`, {});
    assert.equal(view.body.publishableKey, 'pk_test_verejny3');
    assert.equal('stripeAccount' in view.body, false);

    const before = ctx.stripe.calls.length;
    const start = await customer.post(`/api/f/${id}/vstup/start`, { email: 'z@example.sk' });
    assert.equal(start.status, 200);
    const pi = own.lastCall('paymentIntents.create');
    assert.equal(pi.account, null);
    assert.equal(pi.params.application_fee_amount, undefined);
    own.completePayment(start.body.clientSecret.split('_secret_')[0]);
    const auth = { authorization: `Bearer ${start.body.token}` };
    assert.equal((await customer.post(`/api/f/${id}/vstup/complete`, {}, auth)).status, 200);
    assert.equal((await customer.post(`/api/f/${id}/upsell/accept`, {}, auth)).status, 200);
    assert.equal(own.lastCall('subscriptions.create').account, null);
    assert.equal(ctx.stripe.calls.slice(before).filter((c) => !c.name.startsWith('subscriptions.list')).length, 0);
  });

  it('prechod z Connect na kľúče presunie opakované produkty; odpojenie zastaví predaj', async () => {
    const shop = await activeMerchant(ctx);
    await shop.browser.post('/api/funnels/api/products', { id: 'klub', name: 'Klub', type: 'recurring', interval: 'month', amount: 990 });
    await shop.browser.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'klub', maxQuantity: 1, onAccept: '/t' });
    const res = await shop.browser.post('/api/funnels/api/connect/keys', keys(4));
    assert.equal(res.status, 200);
    const product = res.body.products.klub;
    assert.equal(product.stripeAccountId, res.body.stripeAccountId);
    assert.equal(keyClients.sk_test_kluc4abcd.callsTo('prices.create').length, 1);

    const off = await shop.browser.del('/api/funnels/api/connect/keys');
    assert.equal(off.status, 200);
    assert.deepEqual([off.body.stripeAccountId, off.body.chargesEnabled, off.body.stripeKeyHint], [null, false, null]);
    assert.equal((await db.getMerchant(shop.id)).stripe_api_key, null);
    assert.equal((await client(ctx.base).post(`/api/f/${shop.id}/vstup/view`, {})).status, 503);
  });

  it('jeden Stripe účet nemôžu mať prepojený dva účty Neoworkly', async () => {
    const first = await subscribed();
    const second = await subscribed();
    assert.equal((await first.browser.post('/api/funnels/api/connect/keys', keys(5))).status, 200);
    keyClients.rk_test_kluc6 = keyClients.sk_test_kluc5abcd; // iný (obmedzený) kľúč k tomu istému účtu
    const same = await second.browser.post('/api/funnels/api/connect/keys', keys(6, { secretKey: 'rk_test_kluc6' }));
    assert.deepEqual([same.status, same.body.error], [409, 'Tento Stripe účet už používa iný účet Neoworkly.']);
  });

  it('vytvorí webhook pre platby rezervácií a produktov a pri odpojení ho zmaže', async () => {
    const { browser, id, userId } = await subscribed();
    const res = await browser.post('/api/funnels/api/connect/keys', keys(8));
    assert.equal(res.body.paymentsWebhook, true);
    const own = keyClients.sk_test_kluc8abcd;
    const created = own.lastCall('webhookEndpoints.create').params;
    assert.equal(created.url, `http://neoworkly.test/api/payments/webhook/u/${userId}`);
    assert.ok(created.enabled_events.includes('checkout.session.completed'));
    const stored = await db.getMerchant(id);
    assert.equal(totp.decrypt(stored.stripe_webhook_secret), 'whsec_we_1');
    await browser.del('/api/funnels/api/connect/keys');
    assert.equal(own.lastCall('webhookEndpoints.del').params.id, 'we_1');
    assert.equal((await db.getMerchant(id)).stripe_webhook_id, null);
  });
});
