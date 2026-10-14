// Adresa doručenia a voľné polia (napr. venovanie) vo vstupnom kroku aj v ponukách
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, activeMerchant, mails } = require('./helpers/app');

const ADDRESS = {
  name: 'Jana Nováková',
  phone: '+421900111222',
  address: { line1: 'Hlavná 1', line2: '', city: 'Bratislava', postal_code: '81101', country: 'SK' },
};
const VENOVANIE = { label: 'Venovanie', type: 'textarea', required: true, maxLength: 200 };

describe('adresa doručenia a voľné polia', () => {
  let ctx;
  let shop;
  before(async () => {
    ctx = await startApp();
    shop = await activeMerchant(ctx);
    const b = shop.browser;
    await b.post('/api/funnels/api/products', { id: 'kniha', name: 'Kniha', type: 'one_time', amount: 1900 });
    await b.post('/api/funnels/api/products', { id: 'obal', name: 'Darčekový obal', type: 'one_time', amount: 300 });
    await b.post('/api/funnels/api/products', { id: 'klub', name: 'Klub', type: 'recurring', interval: 'month', amount: 990 });
    const entry = await b.put('/api/funnels/api/steps/vstup', {
      kind: 'entry', productId: 'kniha', maxQuantity: 1, onAccept: '/u', shipping: true,
      fields: [VENOVANIE, { label: 'Poznámka', type: 'text', required: false, maxLength: 50 }],
    });
    assert.equal(entry.status, 200);
    await b.put('/api/funnels/api/steps/obal', {
      kind: 'offer', productId: 'obal', onAccept: '/k', onDecline: '/k',
      fields: [{ label: 'Text na obale', type: 'text', required: true, maxLength: 30 }],
    });
    await b.put('/api/funnels/api/steps/klub', {
      kind: 'offer', productId: 'klub', onAccept: '/t', onDecline: '/t',
      fields: [{ label: 'Prezývka', type: 'text', required: false, maxLength: 30 }],
    });
  });
  after(() => ctx.close());

  const start = (c, body) => c.post(`/api/f/${shop.id}/vstup/start`, { email: 'jana@example.sk', ...body });

  async function buyEntry(fields = { f1: 'Pre mamu k narodeninám' }) {
    const c = client(ctx.base);
    const res = await start(c, { shipping: ADDRESS, fields });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    ctx.stripe.completePayment(res.body.clientSecret.split('_secret_')[0]);
    const auth = { authorization: `Bearer ${res.body.token}` };
    assert.equal((await c.post(`/api/f/${shop.id}/vstup/complete`, {}, auth)).status, 200);
    return { c, auth };
  }

  it('nastavenie kroku: validácia polí, adresa iba vo vstupnom kroku, snippet dostane nastavenie', async () => {
    const put = (body) => shop.browser.put('/api/funnels/api/steps/x', { kind: 'offer', productId: 'obal', onAccept: '/a', onDecline: '/b', ...body });
    const field = (f) => put({ fields: [{ ...VENOVANIE, ...f }] });
    assert.equal((await put({ fields: Array(6).fill(VENOVANIE).map((f, i) => ({ ...f, label: `P${i}` })) })).status, 400);
    assert.equal((await field({ label: '' })).status, 400);
    assert.equal((await field({ label: 'x'.repeat(41) })).status, 400);
    assert.equal((await field({ label: 'Pole [1]' })).status, 400);
    assert.equal((await field({ label: 'quantity' })).status, 400);
    assert.equal((await field({ type: 'select' })).status, 400);
    assert.equal((await field({ maxLength: 501 })).status, 400);
    assert.equal((await put({ fields: [VENOVANIE, { ...VENOVANIE, label: 'venovanie' }] })).status, 400);
    const offer = await put({ shipping: true, fields: [VENOVANIE] });
    assert.equal(offer.status, 200);
    assert.equal(offer.body.steps.x.shipping, undefined); // adresa iba vo vstupnom kroku

    const view = await client(ctx.base).post(`/api/f/${shop.id}/vstup/view`, {});
    assert.equal(view.body.shipping, true);
    assert.deepEqual(view.body.fields, [
      { id: 'f1', ...VENOVANIE },
      { id: 'f2', label: 'Poznámka', type: 'text', required: false, maxLength: 50 },
    ]);
  });

  it('vstupný krok: povinné pole, dĺžka a adresa sa overia skôr, než vznikne zákazník', async () => {
    const c = client(ctx.base);
    const before = ctx.stripe.callsTo('customers.create').length;
    const missing = await start(c, { shipping: ADDRESS, fields: { f1: '  ' } });
    assert.deepEqual([missing.status, missing.body.error], [400, 'Vyplň prosím pole „Venovanie“.']);
    const long = await start(c, { shipping: ADDRESS, fields: { f1: 'x'.repeat(201) } });
    assert.deepEqual([long.status, long.body.error], [400, 'Pole „Venovanie“ môže mať najviac 200 znakov.']);
    const noAddress = await start(c, { fields: { f1: 'Ahoj' } });
    assert.deepEqual([noAddress.status, noAddress.body.error], [400, 'Vyplň prosím celú adresu doručenia.']);
    const badCountry = await start(c, { fields: { f1: 'Ahoj' }, shipping: { ...ADDRESS, address: { ...ADDRESS.address, country: 'Slovensko' } } });
    assert.equal(badCountry.status, 400);
    assert.equal(ctx.stripe.callsTo('customers.create').length, before);
  });

  it('vstupný krok: adresa k zákazníkovi aj platbe, polia v metadátach a v e-maile obchodníkovi', async () => {
    const count = mails.length;
    await buyEntry();
    const customer = ctx.stripe.lastCall('customers.create').params;
    const expectedShipping = { name: ADDRESS.name, phone: ADDRESS.phone, address: { line1: 'Hlavná 1', city: 'Bratislava', postal_code: '81101', country: 'SK' } };
    assert.deepEqual(customer.shipping, expectedShipping); // prázdne line2 sa neposiela
    const pi = ctx.stripe.lastCall('paymentIntents.create').params;
    assert.deepEqual(pi.shipping, expectedShipping);
    assert.equal(pi.metadata.Venovanie, 'Pre mamu k narodeninám');
    assert.equal('Poznámka' in pi.metadata, false); // nevyplnené nepovinné pole

    const mail = mails.slice(count).find((m) => m.to === shop.email);
    assert.match(mail.text, /Venovanie: Pre mamu k narodeninám/);
    assert.match(mail.text, /Doručenie:\nJana Nováková\nHlavná 1\n81101 Bratislava\nSK\n\+421900111222/);
  });

  it('ponuka: povinné pole pred platbou; jednorazová dostane adresu, predplatné polia v metadátach', async () => {
    const { c, auth } = await buyEntry();
    const before = ctx.stripe.callsTo('paymentIntents.create').length;
    const missing = await c.post(`/api/f/${shop.id}/obal/accept`, {}, auth);
    assert.deepEqual([missing.status, missing.body.error], [400, 'Vyplň prosím pole „Text na obale“.']);
    assert.equal(ctx.stripe.callsTo('paymentIntents.create').length, before); // nič sa nestiahlo

    assert.equal((await c.post(`/api/f/${shop.id}/obal/accept`, { fields: { f1: 'Všetko najlepšie' } }, auth)).status, 200);
    const pi = ctx.stripe.lastCall('paymentIntents.create').params;
    assert.equal(pi.metadata['Text na obale'], 'Všetko najlepšie');
    assert.equal(pi.shipping.address.city, 'Bratislava');

    assert.equal((await c.post(`/api/f/${shop.id}/klub/accept`, { fields: { f1: 'Janka' } }, auth)).status, 200);
    assert.equal(ctx.stripe.lastCall('subscriptions.create').params.metadata['Prezývka'], 'Janka');
    assert.equal(ctx.stripe.lastCall('paymentIntents.update').params.metadata['Prezývka'], 'Janka');
  });

  it('vstupný krok s predplatným: polia sa zapíšu aj k platbe prvej faktúry', async () => {
    await shop.browser.put('/api/funnels/api/steps/vstup-klub', {
      kind: 'entry', productId: 'klub', maxQuantity: 1, onAccept: '/t', fields: [VENOVANIE],
    });
    const res = await client(ctx.base).post(`/api/f/${shop.id}/vstup-klub/start`, { email: 'k@example.sk', fields: { f1: 'Pre brata' } });
    assert.equal(res.status, 200);
    const update = ctx.stripe.lastCall('paymentIntents.update');
    assert.equal(update.params.id, res.body.clientSecret.split('_secret_')[0]);
    assert.equal(update.params.metadata.Venovanie, 'Pre brata');
  });
});
