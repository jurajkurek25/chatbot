// Spoplatnené rezervácie: záloha / plná platba cez Stripe Checkout na účte obchodníka,
// držanie termínu, potvrdenie webhookom alebo pri návrate, uvoľnenie a vrátenie platby.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, request, newUser, connectStripe, signedEvent, mails, keyClients, getDb, wait } = require('./helpers');
const core = require('../services/bookingCore');
const bookingPayments = require('../services/bookingPayments');

describe('spoplatnené rezervácie', () => {
  let ctx, owner, account, widgetId, deposit, full, day;
  const pub = (m, p, b) => request(ctx.base, m, `/api/booking/${widgetId}${p}`, b);
  const book = (startTime, serviceId, extra = {}) =>
    pub('POST', '/public/book', { customerName: 'Eva', customerEmail: `eva${startTime.replace(':', '')}@x.sk`, date: day, startTime, serviceId, ...extra });
  const row = (id) => getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  const sessionOf = (id) => ctx.stripe.checkoutSessions_[row(id).stripe_session_id];
  const connectWebhook = (event) => {
    const { payload, headers } = signedEvent(ctx, event, 'whsec_connect');
    return request(ctx.base, 'POST', '/api/webhook/connect', payload, headers);
  };
  const pay = (id, pi) => {
    const s = sessionOf(id);
    Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi, amount_total: s.params.line_items[0].price_data.unit_amount });
    return s;
  };

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx);
    widgetId = 'w-' + owner.id;
    getDb().prepare("INSERT INTO widgets (id, user_id, name, bot_name) VALUES (?, ?, 'Salón', 'Salón Ema')").run(widgetId, owner.id);
    await pub('GET', '/public/config');
    deposit = (await owner.api('POST', `/api/booking/${widgetId}/services`, { name: 'Masáž', durationMins: 60, price: 40, paymentMode: 'deposit', depositAmount: 10 })).body;
    full = (await owner.api('POST', `/api/booking/${widgetId}/services`, { name: 'Strih', durationMins: 60, price: 25, paymentMode: 'full' })).body;
    day = core.addDays(core.todayInTz('Europe/Bratislava'), 7);
    while ([0, 6].includes(core.dayOfWeek(day))) day = core.addDays(day, 1);
  });
  after(() => ctx.close());

  it('bez prepojeného Stripe sa rezervuje bez platby online', async () => {
    const res = await book('09:00', full.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.checkoutUrl, undefined);
    assert.equal(row(res.body.id).status, 'confirmed');
    const cfg = (await pub('GET', '/public/config')).body;
    assert.ok(cfg.services.every((s) => s.payment_mode === 'none'));
  });

  it('po prepojení cez Connect: záloha 10 € na účte obchodníka, termín je držaný', async () => {
    account = await connectStripe(ctx, owner);
    const svc = (await pub('GET', '/public/config')).body.services.find((s) => s.id === deposit.id);
    assert.deepEqual([svc.payment_mode, svc.pay_now], ['deposit', 10]);
    const res = await book('11:00', deposit.id);
    assert.match(res.body.checkoutUrl, /checkout\.stripe\.test/);
    const call = ctx.stripe.lastCall('checkout.sessions.create');
    assert.equal(call.account, account);
    assert.equal(call.params.line_items[0].price_data.unit_amount, 1000);
    assert.deepEqual(call.params.metadata.kind, 'booking');
    assert.equal(call.params.application_fee_amount, undefined); // 0 % provízia
    assert.equal(row(res.body.id).status, 'pending_payment');
    const slots = (await pub('GET', `/public/slots?date=${day}&serviceId=${deposit.id}`)).body;
    assert.ok(!slots.some((s) => s.start_time === '11:00'));
    assert.ok(!mails.some((m) => m.to === 'eva1100@x.sk'));
  });

  it('Connect webhook (podpísaný) potvrdí rezerváciu raz; zlý podpis 400', async () => {
    const id = (await book('12:00', deposit.id)).body.id;
    const event = { id: 'evt_1', type: 'checkout.session.completed', account, data: { object: pay(id, 'pi_1') } };
    const bad = await request(ctx.base, 'POST', '/api/webhook/connect', JSON.stringify(event), { 'stripe-signature': 't=1,v1=zly' });
    assert.equal(bad.status, 400);
    assert.equal((await connectWebhook(event)).status, 200);
    await wait(200);
    const b = row(id);
    assert.deepEqual([b.status, b.payment_status, b.amount_paid, b.stripe_payment_intent], ['confirmed', 'paid', 1000, 'pi_1']);
    const mail = mails.find((m) => m.to === 'eva1200@x.sk');
    assert.match(mail.html, /Zaplatené online 10,00 EUR/);
    await connectWebhook(event);
    await wait(100);
    assert.equal(mails.filter((m) => m.to === 'eva1200@x.sk').length, 1);
  });

  it('zrušenie zákazníkom vráti zálohu (pravidlo „vrátiť“), e-mail o tom informuje', async () => {
    const id = (await book('13:00', deposit.id)).body.id;
    await connectWebhook({ id: 'evt_2', type: 'checkout.session.completed', account, data: { object: pay(id, 'pi_2') } });
    await wait(100);
    const res = await request(ctx.base, 'POST', `/api/booking/manage/${row(id).manage_token}/cancel`, {});
    await wait(100);
    assert.deepEqual([res.status, res.body.refunded], [200, 10]);
    const refund = ctx.stripe.lastCall('refunds.create');
    assert.deepEqual([refund.params.payment_intent, refund.params.amount, refund.account], ['pi_2', 1000, account]);
    assert.equal(row(id).payment_status, 'refunded');
    assert.match(mails.filter((m) => m.to === 'eva1300@x.sk').at(-1).html, /sme vám vrátili/);
  });

  it('pravidlo „nevracať“: zákazník nedostane späť; zrušenie firmou vráti vždy', async () => {
    await owner.api('PUT', `/api/booking/${widgetId}/config`, { refundPolicy: 'none' });
    const a = (await book('14:00', full.id)).body.id;
    // návrat zo Stripe bez webhooku: stránka správy si platbu overí sama
    pay(a, 'pi_3');
    const view = await request(ctx.base, 'GET', `/api/booking/manage/${row(a).manage_token}`);
    assert.deepEqual([view.body.booking.status, view.body.booking.amountPaid], ['confirmed', 25]);
    const refunds = ctx.stripe.callsTo('refunds.create').length;
    await request(ctx.base, 'POST', `/api/booking/manage/${row(a).manage_token}/cancel`, {});
    assert.equal(ctx.stripe.callsTo('refunds.create').length, refunds);

    const b = (await book('15:00', full.id)).body.id;
    await connectWebhook({ id: 'evt_3', type: 'checkout.session.completed', account, data: { object: pay(b, 'pi_4') } });
    await owner.api('PATCH', `/api/booking/${widgetId}/bookings/${b}`, { status: 'cancelled', reason: 'Choroba' });
    assert.equal(ctx.stripe.lastCall('refunds.create').params.payment_intent, 'pi_4');
  });

  it('opustená platba uvoľní termín: tlačidlo späť, webhook expired aj upratovanie', async () => {
    const a = (await book('16:00', full.id)).body.id;
    const back = await request(ctx.base, 'GET', `/api/booking/pay/cancel/${row(a).manage_token}`);
    assert.equal(back.status, 302);
    assert.match(back.headers.get('location'), new RegExp(`/book/${widgetId}\\?payment=cancelled`));
    assert.equal(row(a).status, 'expired');

    const b = (await book('16:00', full.id)).body.id;
    await connectWebhook({ id: 'evt_4', type: 'checkout.session.expired', account, data: { object: sessionOf(b) } });
    assert.equal(row(b).status, 'expired');

    const c = (await book('16:00', full.id)).body.id;
    getDb().prepare('UPDATE bookings SET created_at = unixepoch() - 3600 WHERE id = ?').run(c);
    bookingPayments.expireStaleHolds();
    assert.equal(row(c).status, 'expired');
  });

  it('vrátenie v Stripe (charge.refunded) sa premietne', async () => {
    await connectWebhook({ id: 'evt_5', type: 'charge.refunded', account, data: { object: { payment_intent: 'pi_3', amount_refunded: 1000 } } });
    assert.equal(getDb().prepare("SELECT payment_status FROM bookings WHERE stripe_payment_intent = 'pi_3'").get().payment_status, 'partially_refunded');
  });

  it('vlastné kľúče: platba ide priamo na účet obchodníka a webhook má vlastný podpis', async () => {
    const shop = newUser(ctx);
    const wid = 'w-' + shop.id;
    getDb().prepare("INSERT INTO widgets (id, user_id, name) VALUES (?, ?, 'Shop')").run(wid, shop.id);
    await request(ctx.base, 'GET', `/api/booking/${wid}/public/config`);
    const svc = (await shop.api('POST', `/api/booking/${wid}/services`, { name: 'Kurz', durationMins: 60, price: 30, paymentMode: 'full' })).body;
    getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(require('bcrypt').hashSync('heslo1234', 4), shop.id);
    await shop.api('GET', '/api/funnels/api/me');
    const keys = await shop.api('POST', '/api/funnels/api/connect/keys', { secretKey: 'sk_test_vlastny1abcd', publishableKey: 'pk_test_vlastny1', password: 'heslo1234' });
    assert.equal(keys.status, 200);
    const own = keyClients.sk_test_vlastny1abcd;
    const res = await request(ctx.base, 'POST', `/api/booking/${wid}/public/book`, { customerName: 'Jo', customerEmail: 'jo@x.sk', date: day, startTime: '10:00', serviceId: svc.id });
    assert.match(String(res.body.checkoutUrl), /checkout/, JSON.stringify([keys.body.chargesEnabled, res.status, res.body]));
    const call = own.lastCall('checkout.sessions.create');
    assert.equal(call.account, null);
    const session = Object.values(own.checkoutSessions_).at(-1);
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_own', amount_total: 3000 });
    const hook = own.lastCall('webhookEndpoints.create').params;
    assert.equal(hook.url, `https://app.test/api/payments/webhook/u/${shop.id}`);
    const { payload, headers } = signedEvent(ctx, { id: 'evt_o', type: 'checkout.session.completed', data: { object: session } }, 'whsec_we_1');
    assert.equal((await request(ctx.base, 'POST', `/api/payments/webhook/u/${shop.id}`, payload, headers)).status, 200);
    assert.equal(getDb().prepare('SELECT status FROM bookings WHERE id = ?').get(res.body.id).status, 'confirmed');
    const status = (await shop.api('GET', '/api/payments/status')).body;
    assert.deepEqual([status.ready, status.mode, status.webhook], [true, 'keys', true]);
    assert.equal(status.recent[0].amount_paid, 3000);
  });
});
