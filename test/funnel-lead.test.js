// Funnel krok „Zadarmo za kontakt“: e-mail za digitálny produkt / lead magnet, kontakt do Kontaktov.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startApp, request, newUser, mails, getDb, funnelDb, wait } = require('./helpers');
const funnelLeads = require('../services/funnelLeads');

describe('funnel: zadarmo za kontakt', () => {
  let ctx, owner, merchant, widgetId, magnetId, product;
  const F = '/api/funnels/api';
  const visitor = (step, action, body) => request(ctx.base, 'POST', `/api/f/${merchant.id}/${step}/${action}`, body);
  const mailTo = async (email, re) => {
    for (let i = 0; i < 50; i++) {
      const m = mails.find((x) => x.to === email && re.test(x.subject));
      if (m) return m;
      await wait(10);
    }
    return null;
  };

  before(async () => {
    ctx = await startApp();
    owner = newUser(ctx);
    widgetId = crypto.randomUUID();
    magnetId = crypto.randomUUID();
    getDb().prepare("INSERT INTO widgets (id, user_id, name) VALUES (?, ?, 'Web')").run(widgetId, owner.id);
    getDb().prepare("INSERT INTO lead_magnets (id, widget_id, name, file_url) VALUES (?, ?, '5 tipov na spánok', 'https://cdn.example/tipy.pdf')")
      .run(magnetId, widgetId);
    product = (await owner.api('POST', '/api/shop/products', { type: 'file', title: 'Checklist zdarma' })).body;
    await owner.api('GET', `${F}/me`); // vytvorí obchodníka funnela – bez prepojeného Stripe
    merchant = await funnelDb.getMerchantByUser(owner.id);
  });
  after(() => ctx.close());

  it('ponúkne iba vlastné produkty, lead magnety a widgety; cudzie odmietne', async () => {
    const opts = (await owner.api('GET', `${F}/lead-options`)).body;
    assert.deepEqual([opts.products.map((p) => p.id), opts.leadMagnets.map((l) => l.id), opts.widgets.map((w) => w.id)],
      [[product.id], [magnetId], [widgetId]]);
    const stranger = newUser(ctx);
    await stranger.api('GET', `${F}/me`);
    const bad = await stranger.api('PUT', `${F}/steps/zadarmo`, { kind: 'lead', onAccept: '/dakujem', deliver: { leadMagnetId: magnetId } });
    assert.deepEqual([bad.status, bad.body.error], [400, 'Neznámy lead magnet.']);
  });

  it('krok funguje bez Stripe: uloží kontakt, pošle lead magnet aj produkt a počíta sa v štatistikách', async () => {
    const saved = await owner.api('PUT', `${F}/steps/zadarmo`, {
      kind: 'lead', onAccept: '/vstup', askName: true, marketing: true,
      deliver: { productId: product.id, leadMagnetId: magnetId },
    });
    assert.equal(saved.status, 200);
    const snippet = (await owner.api('GET', `${F}/snippets/zadarmo`)).body.html;
    assert.match(snippet, /nw-lead/);
    assert.doesNotMatch(snippet, /\{\{/);

    const view = await visitor('zadarmo', 'view', { count: true });
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.kind, view.body.askName, view.body.marketing, view.body.buttonText], ['lead', true, true, 'Chcem to zadarmo']);

    assert.equal((await visitor('zadarmo', 'lead', { email: 'jana@example.sk', name: 'Jana', consent: false })).status, 400);
    assert.equal((await visitor('zadarmo', 'lead', { email: 'jana@example.sk', consent: true })).status, 400); // chýba meno
    const res = await visitor('zadarmo', 'lead', { email: 'Jana@Example.sk', name: 'Jana', consent: true, marketing: true });
    assert.deepEqual([res.status, res.body], [200, { next: '/vstup', email: 'jana@example.sk' }]);

    const lead = getDb().prepare('SELECT * FROM leads WHERE widget_id = ? AND email = ?').get(widgetId, 'jana@example.sk');
    assert.deepEqual([lead.name, lead.source, lead.gdpr_consent, lead.marketing_consent], ['Jana', 'funnel', 1, 1]);
    assert.ok(getDb().prepare('SELECT 1 FROM lead_magnet_leads WHERE lead_magnet_id = ? AND email = ?').get(magnetId, 'jana@example.sk'));
    assert.match((await mailTo('jana@example.sk', /5 tipov na spánok/)).html, /cdn\.example\/tipy\.pdf/);
    const order = getDb().prepare('SELECT * FROM orders WHERE product_id = ? AND email = ?').get(product.id, 'jana@example.sk');
    assert.deepEqual([order.amount, order.status], [0, 'free']);
    assert.ok(await mailTo('jana@example.sk', /Checklist zdarma/));

    // Druhý formulár s tým istým e-mailom nevytvorí duplicitný kontakt a súhlas s novinkami neodoberie
    await visitor('zadarmo', 'lead', { email: 'jana@example.sk', name: 'Jana', consent: true, marketing: false });
    const all = getDb().prepare('SELECT marketing_consent FROM leads WHERE widget_id = ? AND email = ?').all(widgetId, 'jana@example.sk');
    assert.deepEqual(all.map((l) => l.marketing_consent), [1]);

    const stats = (await owner.api('GET', `${F}/stats?days=7`)).body;
    const row = stats.steps.find((r) => r.stepId === 'zadarmo');
    assert.deepEqual([row.kind, row.views, row.leads, row.conversion, row.product], ['lead', 1, 2, 2, 'Zadarmo: Checklist zdarma + 5 tipov na spánok']);
    assert.equal(stats.totals.leads, 2);
  });

  it('bez lead magnetu a widgetu uloží kontakt do prvého widgetu; marketing bez nastavenia ignoruje', async () => {
    await owner.api('PUT', `${F}/steps/kontakt`, { kind: 'lead', onAccept: '/dakujem' });
    await visitor('kontakt', 'lead', { email: 'peter@example.sk', consent: true, marketing: true });
    const lead = getDb().prepare('SELECT * FROM leads WHERE email = ?').get('peter@example.sk');
    assert.deepEqual([lead.widget_id, lead.name, lead.marketing_consent], [widgetId, 'peter', 0]);
  });

  it('platený krok sa bez Stripe nepredáva, krok za kontakt áno', async () => {
    assert.equal((await owner.api('GET', `${F}/me`)).body.chargesEnabled, false);
    assert.equal((await visitor('kontakt', 'view', {})).status, 200);
    assert.equal((await visitor('neexistuje', 'view', {})).status, 404);
  });

  it('testovací režim kontakt neuloží, ale materiál pošle', async () => {
    const step = { id: 'zadarmo', deliver: { leadMagnetId: magnetId } };
    const merchantRow = await funnelDb.getMerchant(merchant.id);
    const delivered = await funnelLeads.captureLead({ merchant: merchantRow, step, email: 'test@example.sk', name: '', marketing: false, mode: 'test' });
    assert.equal(delivered.leadMagnet, '5 tipov na spánok');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM leads WHERE email = ?').get('test@example.sk').n, 0);
    assert.ok(await mailTo('test@example.sk', /5 tipov na spánok/));
  });

  it('A/B test kroku za kontakt počíta kontakty ako konverzie', async () => {
    const ab = await owner.api('PUT', `${F}/steps/zadarmo/ab`, { split: 50, buttonText: 'Pošlite mi to' });
    assert.equal(ab.status, 200, JSON.stringify(ab.body));
    const v = (await visitor('zadarmo', 'view', { count: true })).body.variant;
    await visitor('zadarmo', 'lead', { email: 'ab@example.sk', name: 'A', consent: true, variant: v });
    const row = (await owner.api('GET', `${F}/stats?days=7`)).body.steps.find((r) => r.stepId === 'zadarmo');
    assert.equal(row.ab.currency, 'eur');
    assert.equal(row.ab[v].views + row.ab[v === 'a' ? 'b' : 'a'].views, 1);
    assert.equal(row.ab[v].purchases, 1);
  });
});
