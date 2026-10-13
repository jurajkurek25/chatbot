// Vstupný krok na platobnej stránke Stripe (Checkout) a domény pre Apple Pay / Google Pay
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, activeMerchant, mails, db } = require('./helpers/app');

const SHOP_PAGE = 'https://obchod.example/kniha';

describe('platba na stránke Stripe a peňaženky', () => {
  let ctx;
  let shop;
  before(async () => {
    ctx = await startApp();
    shop = await activeMerchant(ctx);
    const b = shop.browser;
    await b.post('/api/funnels/api/products', { id: 'kniha', name: 'Kniha', type: 'one_time', amount: 1900 });
    await b.post('/api/funnels/api/products', { id: 'klub', name: 'Klub', type: 'recurring', interval: 'month', amount: 990 });
    await b.put('/api/funnels/api/steps/vstup', {
      kind: 'entry', productId: 'kniha', maxQuantity: 3, onAccept: '/upsell', shipping: true,
      fields: [{ label: 'Venovanie', type: 'textarea', required: false, maxLength: 500 }],
    });
    await b.put('/api/funnels/api/steps/upsell', { kind: 'offer', productId: 'klub', onAccept: '/dakujeme', onDecline: '/dakujeme' });
  });
  after(() => ctx.close());

  // Zákazník klikne na tlačidlo na webe obchodníka => presmerovanie na stránku Stripe
  const openCheckout = (step = 'vstup', query = '', headers = { referer: SHOP_PAGE }) =>
    fetch(`${ctx.base}/api/f/${shop.id}/${step}/checkout${query}`, { redirect: 'manual', headers });
  const lastSession = (fake = ctx.stripe) => Object.values(fake.checkoutSessions_).at(-1);

  it('odkaz vytvorí stránku Stripe s uložením karty, poliami, adresou a návratom na upsell', async () => {
    const res = await openCheckout();
    assert.equal(res.status, 303);
    const session = lastSession();
    assert.equal(res.headers.get('location'), session.url);
    const { params } = session;
    assert.equal(session.account, shop.account);
    assert.equal(params.mode, 'payment');
    assert.equal(params.customer_creation, 'always');
    assert.equal(params.payment_intent_data.setup_future_usage, 'off_session');
    assert.deepEqual(params.payment_method_types, ['card']);
    assert.deepEqual(params.line_items[0].price_data, { currency: 'eur', unit_amount: 1900, product_data: { name: 'Kniha' } });
    assert.deepEqual(params.line_items[0].adjustable_quantity, { enabled: true, minimum: 1, maximum: 3 });
    // Stripe vráti zákazníka najprv na Neoworkly (zápis nákupu), odtiaľ na „URL po prijatí“
    // (relatívna sa doplní podľa stránky s tlačidlom); {CHECKOUT_SESSION_ID} doplní Stripe
    assert.equal(params.success_url, `http://neoworkly.test/api/f/${shop.id}/vstup/return?nw_session={CHECKOUT_SESSION_ID}`);
    assert.equal(params.metadata.return_to, 'https://obchod.example/upsell');
    assert.equal(params.cancel_url, SHOP_PAGE);
    assert.ok(params.shipping_address_collection.allowed_countries.includes('SK'));
    assert.deepEqual(params.custom_fields, [
      { key: 'f1', label: { type: 'custom', custom: 'Venovanie' }, type: 'text', optional: true, text: { maximum_length: 255 } },
    ]);
    assert.equal(params.metadata.neoworkly_merchant, shop.id);
  });

  it('chyby sa zákazníkovi ukážu ako stránka, nie JSON', async () => {
    const offer = await openCheckout('upsell');
    assert.equal(offer.status, 400);
    assert.match(offer.headers.get('content-type'), /text\/html/);
    assert.match(await offer.text(), /pre vstupný krok alebo pre ponuku s priamym predajom/);
    const noReferer = await openCheckout('vstup', '', {});
    assert.equal(noReferer.status, 400);
    assert.match(await noReferer.text(), /úplná adresa/);
    await shop.browser.put('/api/funnels/api/steps/vela', {
      kind: 'entry', productId: 'kniha', maxQuantity: 1, onAccept: 'https://obchod.example/u',
      fields: ['A', 'B', 'C', 'D'].map((label) => ({ label, type: 'text', required: false, maxLength: 50 })),
    });
    const many = await openCheckout('vela');
    assert.equal(many.status, 400);
    assert.match(await many.text(), /najviac 3 voľné polia/);
  });

  it('po zaplatení: výmena za token, upsell jedným klikom uloženou kartou; výmena iba raz', async () => {
    await openCheckout();
    const session = lastSession();
    const customer = client(ctx.base);
    const exchange = () => customer.post(`/api/f/${shop.id}/upsell/session`, { sessionId: session.id });
    assert.equal((await exchange()).status, 403); // ešte nezaplatené

    const count = mails.length;
    const shipping = { name: 'Jana', address: { line1: 'Hlavná 1', line2: null, city: 'Bratislava', postal_code: '81101', country: 'SK', state: null } };
    const paid = ctx.stripe.completeCheckout(session.id, { quantity: 2, fields: { f1: 'Pre mamu' }, shipping });
    const res = await exchange();
    assert.equal(res.status, 200);
    assert.ok(res.body.token);

    const stored = ctx.stripe.customers_[paid.customer];
    assert.equal(stored.invoice_settings.default_payment_method, 'pm_card_visa');
    assert.deepEqual(stored.shipping, { name: 'Jana', address: { line1: 'Hlavná 1', city: 'Bratislava', postal_code: '81101', country: 'SK' } });
    assert.equal(ctx.stripe.lastCall('paymentIntents.update').params.metadata.Venovanie, 'Pre mamu');
    const mail = mails.slice(count).find((m) => m.to === shop.email);
    assert.match(mail.text, /Kniha × 2/);
    assert.match(mail.text, /Suma: 38,00/);
    assert.match(mail.text, /Venovanie: Pre mamu/);
    assert.match(mail.text, /Doručenie:\nJana\nHlavná 1\n81101 Bratislava\nSK/);

    const accept = await customer.post(`/api/f/${shop.id}/upsell/accept`, {}, { authorization: `Bearer ${res.body.token}` });
    assert.equal(accept.status, 200);
    const sub = ctx.stripe.lastCall('subscriptions.create');
    assert.deepEqual([sub.account, sub.params.customer, sub.params.default_payment_method], [shop.account, paid.customer, 'pm_card_visa']);

    const again = await exchange();
    assert.equal(again.status, 409); // ten istý odkaz po platbe druhýkrát nefunguje
  });

  it('návrat zo Stripe zapíše nákup hneď (aj bez snippetu na ďalšej stránke) a pošle zákazníka ďalej', async () => {
    await openCheckout();
    const session = lastSession();
    const paid = ctx.stripe.completeCheckout(session.id);
    const count = mails.length;
    const res = await fetch(`${ctx.base}/api/f/${shop.id}/vstup/return?nw_session=${session.id}`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `https://obchod.example/upsell?nw_session=${session.id}`);
    assert.equal(ctx.stripe.customers_[paid.customer].invoice_settings.default_payment_method, 'pm_card_visa');
    assert.equal(mails.slice(count).filter((m) => m.to === shop.email && /Nová objednávka/.test(m.subject)).length, 1);
    // Opakovaný návrat (obnovenie stránky) nákup nezopakuje; snippet si potom vymení platbu za token
    await fetch(`${ctx.base}/api/f/${shop.id}/vstup/return?nw_session=${session.id}`, { redirect: 'manual' });
    const exchange = await client(ctx.base).post(`/api/f/${shop.id}/upsell/session`, { sessionId: session.id });
    assert.equal(exchange.status, 200);
    assert.equal(mails.slice(count).filter((m) => m.to === shop.email && /Nová objednávka/.test(m.subject)).length, 1);
  });

  it('priamy predaj ponuky: bez funnela iný produkt na stránke Stripe, s funnelom „Chcem pridať“', async () => {
    const b = shop.browser;
    await b.post('/api/funnels/api/products', { id: 'klub-plna', name: 'Klub – plná cena', type: 'one_time', amount: 6700 });
    assert.equal((await b.put('/api/funnels/api/steps/ponuka', {
      kind: 'offer', productId: 'kniha', onAccept: 'https://obchod.example/dalej', onDecline: '/nie', directProductId: 'neexistuje',
    })).status, 400);
    const saved = await b.put('/api/funnels/api/steps/ponuka', {
      kind: 'offer', productId: 'kniha', onAccept: 'https://obchod.example/dalej', onDecline: '/nie',
      directProductId: 'klub-plna', directShipping: true,
    });
    assert.deepEqual(saved.body.steps.ponuka.direct, { productId: 'klub-plna', shipping: true });

    // Návštevník bez funnela
    const visitor = client(ctx.base);
    const view = await visitor.post(`/api/f/${shop.id}/ponuka/view`, { count: true });
    assert.deepEqual(view.body.direct, {
      title: 'Klub – plná cena – 67,00\u00a0€', buttonText: 'Kúpiť za 67,00\u00a0€',
      checkoutUrl: `http://neoworkly.test/api/f/${shop.id}/ponuka/checkout`,
    });
    assert.equal((await openCheckout('ponuka')).status, 303);
    const session = lastSession();
    assert.equal(session.params.line_items[0].price_data.unit_amount, 6700);
    assert.equal(session.params.metadata.direct, '1');
    assert.ok(session.params.shipping_address_collection);
    assert.equal(session.params.metadata.return_to, 'https://obchod.example/dalej');
    const paid = ctx.stripe.completeCheckout(session.id);
    const count = mails.length;
    await fetch(`${ctx.base}/api/f/${shop.id}/ponuka/return?nw_session=${session.id}`, { redirect: 'manual' });
    const mail = mails.slice(count).find((m) => m.to === shop.email);
    assert.match(mail.text, /Produkt: Klub – plná cena × 1/);
    assert.match(mail.text, /Krok funnela: ponuka:priamo/);
    assert.equal(ctx.stripe.customers_[paid.customer].metadata['funnel_ponuka:priamo'], paid.pi);

    // Štatistiky: priamy predaj je samostatný riadok hneď za ponukou
    const stats = (await b.get('/api/funnels/api/stats?days=30')).body.steps;
    const i = stats.findIndex((r) => r.stepId === 'ponuka');
    assert.deepEqual(
      [stats[i + 1].stepId, stats[i + 1].kind, stats[i + 1].product, stats[i + 1].views, stats[i + 1].purchases],
      ['ponuka:priamo', 'direct', 'Klub – plná cena', 1, 1],
    );

    // Návštevník, ktorý prišiel cez funnel (má token), vidí bežnú ponuku jedným klikom
    const exchange = await client(ctx.base).post(`/api/f/${shop.id}/ponuka/session`, { sessionId: session.id });
    const inFunnel = await client(ctx.base).post(`/api/f/${shop.id}/ponuka/view`, {}, { authorization: `Bearer ${exchange.body.token}` });
    assert.equal(inFunnel.body.direct, undefined);
    assert.equal(inFunnel.body.kind, 'offer');
  });

  it('cudziu, neplatnú alebo starú platbu neprijme', async () => {
    const customer = client(ctx.base);
    assert.equal((await customer.post(`/api/f/${shop.id}/upsell/session`, { sessionId: 'pi_123' })).status, 403);
    assert.equal((await customer.post(`/api/f/${shop.id}/upsell/session`, { sessionId: 'cs_test_neexistuje' })).status, 403);

    const other = await activeMerchant(ctx);
    await other.browser.post('/api/funnels/api/products', { id: 'p', name: 'P', type: 'one_time', amount: 500 });
    await other.browser.put('/api/funnels/api/steps/vstup', { kind: 'entry', productId: 'p', maxQuantity: 1, onAccept: 'https://iny.example/u' });
    await fetch(`${ctx.base}/api/f/${other.id}/vstup/checkout`, { redirect: 'manual' });
    const foreign = lastSession();
    ctx.stripe.completeCheckout(foreign.id);
    // Platba iného obchodníka (iný Stripe účet) sa u tohto obchodu nedá použiť
    assert.equal((await customer.post(`/api/f/${shop.id}/upsell/session`, { sessionId: foreign.id })).status, 403);

    await openCheckout();
    const old = lastSession();
    ctx.stripe.completeCheckout(old.id);
    old.created -= 4 * 60 * 60;
    assert.equal((await customer.post(`/api/f/${shop.id}/upsell/session`, { sessionId: old.id })).status, 410);
  });

  it('predplatné ako vstupný produkt a testovací režim cez parameter v odkaze', async () => {
    await shop.browser.put('/api/funnels/api/steps/klub-vstup', { kind: 'entry', productId: 'klub', maxQuantity: 1, onAccept: 'https://obchod.example/u' });
    await openCheckout('klub-vstup');
    const session = lastSession();
    assert.equal(session.params.mode, 'subscription');
    assert.equal(session.params.customer_creation, undefined);
    assert.equal(session.params.line_items[0].price, (await db.getMerchant(shop.id)).funnel.products.klub.stripePriceId);
    const paid = ctx.stripe.completeCheckout(session.id);
    const res = await client(ctx.base).post(`/api/f/${shop.id}/upsell/session`, { sessionId: session.id });
    assert.equal(res.status, 200);
    assert.equal(ctx.stripe.customers_[paid.customer].invoice_settings.default_payment_method, 'pm_card_visa');

    // Testovací režim: kľúč v odkaze => testovací Stripe účet; kľúč sa prenesie aj na stránku upsellu
    await shop.browser.post('/api/funnels/api/test/connect');
    const { test_account_id: testAccount, test_key: testKey } = await db.getMerchant(shop.id);
    ctx.stripeTest.accounts_[testAccount].charges_enabled = true;
    assert.equal((await openCheckout('vstup', '?neoworkly_test=zly')).status, 403);
    assert.equal((await openCheckout('vstup', `?neoworkly_test=${testKey}`)).status, 303);
    const testSession = lastSession(ctx.stripeTest);
    assert.equal(testSession.account, testAccount);
    assert.match(testSession.params.success_url, new RegExp(`neoworkly_test=${testKey}`));
  });

  it('dashboard dá odkaz na platbu iba pri vstupnom kroku', async () => {
    const entry = await shop.browser.get('/api/funnels/api/snippets/vstup');
    assert.equal(entry.body.checkoutUrl, `http://neoworkly.test/api/f/${shop.id}/vstup/checkout`);
    assert.equal((await shop.browser.get('/api/funnels/api/snippets/upsell')).body.checkoutUrl, null);
  });

  it('Apple Pay / Google Pay: registrácia domény v ostrom aj testovacom účte, opätovné overenie', async () => {
    const bad = await shop.browser.post('/api/funnels/api/wallets', { domain: 'nie je domena' });
    assert.equal(bad.status, 400);
    const res = await shop.browser.post('/api/funnels/api/wallets', { domain: 'https://Obchod.example/kniha' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.domains, [{ domain: 'obchod.example', applePay: 'active', googlePay: 'active', error: null }]);
    assert.equal(ctx.stripe.lastCall('paymentMethodDomains.create').account, shop.account);
    const testAccount = (await db.getMerchant(shop.id)).test_account_id;
    assert.equal(ctx.stripeTest.lastCall('paymentMethodDomains.create').account, testAccount);

    await shop.browser.post('/api/funnels/api/wallets', { domain: 'obchod.example' });
    assert.equal(ctx.stripe.callsTo('paymentMethodDomains.create').length, 1); // druhýkrát iba overenie
    assert.equal(ctx.stripe.callsTo('paymentMethodDomains.validate').length, 1);
    assert.equal((await shop.browser.get('/api/funnels/api/wallets')).body.domains.length, 1);
  });
});
