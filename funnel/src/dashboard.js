// API sekcie Funnely v dashboarde Neoworkly (/api/funnels): prepojenie Stripe (Connect alebo
// vlastné kľúče), produkty a kroky funnela, štatistiky, A/B testy, generovanie snippetov.
// Prihlásenie rieši Neoworkly (JWT); funnel účet vznikne pri prvom otvorení sekcie.
const crypto = require('crypto');
const express = require('express5');
const jwt = require('jsonwebtoken');
const db = require('./db');
const {
  isActive,
  legacyActive,
  refreshSubscription,
  refreshAccount,
  liveStripe,
  merchantKeys,
} = require('./merchants');
const snippets = require('./snippets');
const notify = require('./notify');
const { CURRENCIES, DEFAULT_CURRENCY, currencyOf, validateAmount } = require('./currency');
const ab = require('./abtest');
const { rateLimit, MINUTE } = require('./ratelimit');
const totp = require('./totp');
const { getDb } = require('../../db/database');
const passwords = require('../../services/passwords');

const SLUG = /^[a-z0-9-]{1,40}$/;
const INTERVALS = ['month', 'year'];
const BLOCKED = 'Účet je zablokovaný. Kontaktuj podporu Neoworkly.';
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT) || 0;

const normEmail = (e) => String(e || '').trim().toLowerCase();

// Relatívna cesta ("/..." ale nie "//...") alebo absolútna http(s) URL na webe obchodníka
const isUrl = (u) => typeof u === 'string' && (/^\/(?!\/)/.test(u) || /^https?:\/\/\S+$/.test(u));

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
function check(ok, message, status) {
  if (!ok) throw new BadRequest(message, status);
}

// Návrat do dashboardu Neoworkly (sekcia Platby) a podpísaný odkaz na obnovenie onboardingu
// (Stripe ho otvorí bez prihlásenia, preto nesie HMAC podpis s platnosťou 7 dní)
const dashboardUrl = (query) => new URL(`/dashboard?${query}`, process.env.APP_URL || process.env.PUBLIC_URL).href;
const refreshSig = (merchantId, mode, exp) =>
  crypto.createHmac('sha256', process.env.COOKIE_SECRET).update(`refresh:${merchantId}:${mode}:${exp}`).digest('base64url');
function refreshUrl(merchantId, mode = 'live') {
  const exp = Date.now() + 7 * 24 * 60 * MINUTE;
  const q = new URLSearchParams({ m: merchantId, mode, exp: String(exp), sig: refreshSig(merchantId, mode, exp) });
  return new URL(`/api/funnels/connect/refresh?${q}`, process.env.APP_URL || process.env.PUBLIC_URL).href;
}

// Ekvivalent Standard účtu: plný Stripe Dashboard, poplatky platí obchodník,
// overenie (KYC) a straty zo záporných zostatkov rieši Stripe
const STANDARD_CONTROLLER = {
  stripe_dashboard: { type: 'full' },
  fees: { payer: 'account' },
  losses: { payments: 'stripe' },
  requirement_collection: 'stripe',
};

const keyHint = (key) => `${key.slice(0, 8)}…${key.slice(-4)}`;

function view(merchant, testMode = { available: false }) {
  const { products, steps } = merchant.funnel;
  return {
    email: merchant.email,
    merchantId: merchant.id,
    platformFeePercent: PLATFORM_FEE_PERCENT,
    blocked: merchant.blocked,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    // Staré samostatné predplatné Funnel 4 € (iba klienti presunutí z funnel.neoworkly.com)
    legacySubscription: merchant.platform_customer_id ? { status: merchant.subscription_status, active: legacyActive(merchant) } : null,
    active: isActive(merchant),
    stripeAccountId: merchant.stripe_account_id,
    chargesEnabled: merchant.charges_enabled,
    // Prepojené vlastnými kľúčmi: ukáže sa iba začiatok a koniec tajného kľúča
    stripeKeyHint: merchant.stripe_api_key ? keyHint(totp.decrypt(merchant.stripe_api_key)) : null,
    paymentsWebhook: merchant.stripe_api_key ? Boolean(merchant.stripe_webhook_id) : null,
    products: Object.fromEntries(
      Object.entries(products).map(([id, p]) => [id, { ...p, label: snippets.priceLabel(p) }]),
    ),
    steps,
    funnels: merchant.funnel.funnels || {},
    appearance: { ...snippets.DEFAULT_APPEARANCE, ...merchant.funnel.appearance },
    notifications: { email: true, webhookUrl: '', webhookSecret: '', ...merchant.funnel.notifications },
    testMode,
    defaultTexts: snippets.DEFAULT_TEXTS,
    currencies: Object.keys(CURRENCIES),
  };
}

// stripeTest = klient s testovacími kľúčmi platformy (testovací režim obchodníkov); môže chýbať
module.exports = function createDashboard(stripe, stripeTest = null) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    // Zmeny iba cez JSON (prihlásenie je v hlavičke Authorization, nie v cookie)
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Očakávam JSON.' });
    }
    next();
  });

  // Návrat zo Stripe onboardingu, keď odkaz vypršal (Stripe ho otvorí bez prihlásenia => podpísaný odkaz)
  router.get('/connect/refresh', async (req, res) => {
    const { m, mode = 'live', exp, sig } = req.query;
    const expected = refreshSig(String(m), String(mode), String(exp));
    const valid = typeof sig === 'string' && sig.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && Number(exp) > Date.now();
    const merchant = valid && await db.getMerchant(String(m));
    if (!merchant) return res.redirect(dashboardUrl('stripe=expired'));
    if (mode === 'test') {
      check(stripeTest && merchant.test_account_id, 'Testovací Stripe účet ešte nie je vytvorený.');
      return res.redirect((await testAccountLink(merchant)).url);
    }
    check(merchant.stripe_account_id && !merchant.stripe_api_key, 'Stripe účet ešte nie je vytvorený.');
    res.redirect((await accountLink(merchant)).url);
  });

  // Všetko ďalej vyžaduje prihlásenie do Neoworkly (JWT v hlavičke Authorization)
  router.use(async (req, res, next) => {
    let userId;
    try {
      userId = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), process.env.JWT_SECRET || 'changeme').userId;
    } catch {
      return res.status(401).json({ error: 'Prihláste sa.' });
    }
    const user = getDb().prepare('SELECT id, email, password_hash FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'Prihláste sa.' });
    let merchant = await db.getMerchantByUser(user.id);
    if (!merchant) {
      // Staré účty z funnel.neoworkly.com pripája iba migrácia (e-mail v Neoworkly nie je overený –
      // automatické spojenie podľa e-mailu by umožnilo prevziať cudzí funnel aj Stripe účet)
      const taken = await db.getMerchantByEmail(normEmail(user.email));
      merchant = await db.createMerchantForUser({ userId: user.id, email: taken ? `${user.id}@users.neoworkly` : normEmail(user.email) });
    } else if (merchant.email !== normEmail(user.email) && !await db.getMerchantByEmail(normEmail(user.email))) {
      await db.updateMerchant(merchant.id, { email: normEmail(user.email) }); // e-mail na oznámenia sleduje účet Neoworkly
      merchant = await db.getMerchant(merchant.id);
    }
    req.user = user;
    req.merchant = merchant;
    next();
  });

  // Stav predplatného a Stripe účtu sa pri načítaní dashboardu overí priamo v Stripe
  router.get('/api/me', async (req, res) => {
    let merchant = await refreshSubscription(stripe, req.merchant);
    merchant = await refreshAccount(stripe, merchant);
    res.json(view(merchant, await testModeInfo(merchant)));
  });

  // Staré predplatné Funnel 4 € (klienti z funnel.neoworkly.com): zrušenie, zmena karty, faktúry
  router.post('/api/billing-portal', async (req, res) => {
    check(req.merchant.platform_customer_id, 'Nemáte samostatné predplatné Funnel.');
    const session = await stripe.billingPortal.sessions.create({
      customer: req.merchant.platform_customer_id,
      return_url: dashboardUrl('view=funnels'),
    });
    res.json({ url: session.url });
  });

  // Ďalšie funkcie iba s prístupom k Neoworkly (predplatné alebo skúšobné obdobie) a nezablokovaným účtom
  router.use((req, res, next) => {
    if (req.merchant.blocked) return res.status(403).json({ error: BLOCKED });
    if (!isActive(req.merchant)) return res.status(402).json({ error: 'Funnely sú súčasťou predplatného Neoworkly – aktivujte ho.' });
    next();
  });

  // --- Testovací režim -----------------------------------------------------------
  // Testovací Stripe účet obchodníka (vytvorený testovacími kľúčmi platformy). Funnel ho použije,
  // keď snippet pošle tajný testovací kľúč – obchodník si tak vyskúša funnel testovacími kartami.
  async function testModeInfo(merchant) {
    if (!stripeTest) return { available: false };
    const info = { available: true, accountId: merchant.test_account_id, ready: false, key: merchant.test_key };
    if (merchant.test_account_id) {
      info.ready = (await stripeTest.accounts.retrieve(merchant.test_account_id)).charges_enabled;
    }
    return info;
  }

  function testAccountLink(merchant) {
    return stripeTest.accountLinks.create({
      account: merchant.test_account_id,
      refresh_url: refreshUrl(merchant.id, 'test'),
      return_url: dashboardUrl('stripe=test-return'),
      type: 'account_onboarding',
    });
  }

  // Opakovaný produkt potrebuje Price aj v testovacom účte (ceny patria konkrétnemu účtu)
  async function syncTestProduct(merchant, product) {
    if (!stripeTest || !merchant.test_account_id || product.type !== 'recurring') return;
    const opts = { stripeAccount: merchant.test_account_id };
    const t = product.test;
    const priceParams = { currency: currencyOf(product), unit_amount: product.amount, recurring: { interval: product.interval } };
    if (!t || t.accountId !== merchant.test_account_id) {
      const price = await stripeTest.prices.create({ ...priceParams, product_data: { name: product.name } }, opts);
      product.test = { accountId: merchant.test_account_id, productId: price.product, priceId: price.id, amount: product.amount, name: product.name };
      return;
    }
    if (t.name !== product.name) {
      await stripeTest.products.update(t.productId, { name: product.name }, opts);
      t.name = product.name;
    }
    if (t.amount !== product.amount) {
      const price = await stripeTest.prices.create({ ...priceParams, product: t.productId }, opts);
      await stripeTest.prices.update(t.priceId, { active: false }, opts);
      Object.assign(t, { priceId: price.id, amount: product.amount });
    }
  }

  router.post('/api/test/connect', async (req, res) => {
    check(stripeTest, 'Testovací režim nie je na tomto serveri zapnutý.');
    let merchant = req.merchant;
    if (!merchant.test_account_id) {
      const account = await stripeTest.accounts.create({
        email: merchant.email,
        controller: STANDARD_CONTROLLER,
        metadata: { neoworkly_merchant: merchant.id, neoworkly_mode: 'test' },
      });
      await db.updateMerchant(merchant.id, {
        test_account_id: account.id,
        test_key: merchant.test_key || `nwtest_${crypto.randomBytes(12).toString('base64url')}`,
      });
      merchant = await db.getMerchant(merchant.id);
      for (const product of Object.values(merchant.funnel.products)) await syncTestProduct(merchant, product);
      await db.saveFunnel(merchant.id, merchant.funnel, merchant.funnel_version);
    }
    res.json({ url: (await testAccountLink(merchant)).url });
  });

  // --- Stripe Connect ----------------------------------------------------------
  function accountLink(merchant) {
    return stripe.accountLinks.create({
      account: merchant.stripe_account_id,
      refresh_url: refreshUrl(merchant.id),
      return_url: dashboardUrl('stripe=return'),
      type: 'account_onboarding',
    });
  }

  router.post('/api/connect', async (req, res) => {
    let merchant = req.merchant;
    check(!merchant.stripe_api_key, 'Stripe je prepojený API kľúčmi. Najprv ich odpoj, potom prepoj cez Stripe Connect.');
    if (!merchant.stripe_account_id) {
      // Ekvivalent Standard účtu: plný Stripe Dashboard, poplatky platí obchodník,
      // overenie (KYC) a straty zo záporných zostatkov rieši Stripe
      const account = await stripe.accounts.create({
        email: merchant.email,
        controller: STANDARD_CONTROLLER,
        metadata: { neoworkly_merchant: merchant.id },
      });
      await db.updateMerchant(merchant.id, { stripe_account_id: account.id });
      merchant = await db.getMerchant(merchant.id);
      await moveRecurringProducts(merchant);
    }
    res.json({ url: (await accountLink(merchant)).url });
  });

  // Ceny opakovaných produktov patria Stripe účtu, v ktorom vznikli. Po odpojení a prepojení
  // nového účtu sa v ňom vytvoria znova, inak by nákup v funneli zlyhal ("No such price").
  async function moveRecurringProducts(merchant) {
    const { products } = merchant.funnel;
    const stale = Object.values(products).filter(
      (p) => p.type === 'recurring' && p.stripeAccountId !== merchant.stripe_account_id,
    );
    if (!stale.length) return;
    const { stripe: client, opts } = live(merchant);
    for (const product of stale) {
      const price = await client.prices.create(
        {
          currency: currencyOf(product),
          unit_amount: product.amount,
          recurring: { interval: product.interval },
          product_data: { name: product.name },
        },
        opts,
      );
      Object.assign(product, {
        stripeProductId: price.product,
        stripePriceId: price.id,
        stripeAccountId: merchant.stripe_account_id,
      });
    }
    await db.saveFunnel(merchant.id, merchant.funnel, merchant.funnel_version);
  }

  // --- Prepojenie vlastnými API kľúčmi (voliteľná, menej bezpečná alternatíva k Connect) ---
  // Neoworkly uloží tajný kľúč obchodníka (šifrovane) a volá Stripe priamo v jeho účte.
  // Vyžaduje heslo: kto by kľúče vymenil, presmeroval by platby na iný Stripe účet.
  const accountLimit = rateLimit({ name: 'account', max: 10, windowMs: 15 * MINUTE, key: (req) => req.merchant.id });
  // Heslo účtu Neoworkly: kto by kľúče vymenil, presmeroval by platby na iný Stripe účet
  const requirePassword = async (req) =>
    check(await passwords.verify(String(req.body.password || ''), req.user.password_hash), 'Nesprávne heslo.', 403);

  // Vlastné kľúče: webhook v Stripe obchodníka pre platby rezervácií a digitálnych produktov
  // (funnel ho nepotrebuje – platby overuje priamo). Bez neho sa platby potvrdia pri návrate zo Stripe.
  const PAYMENT_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'charge.refunded'];
  async function createPaymentsWebhook(client, merchant) {
    try {
      const wh = await client.webhookEndpoints.create({
        url: new URL(`/api/payments/webhook/u/${merchant.neoworkly_user_id}`, process.env.APP_URL || process.env.PUBLIC_URL).href,
        enabled_events: PAYMENT_EVENTS,
        description: 'Neoworkly – rezervácie a digitálne produkty',
      });
      return { stripe_webhook_id: wh.id, stripe_webhook_secret: totp.encrypt(wh.secret) };
    } catch (err) {
      console.warn('[stripe] webhook pre platby sa nepodarilo vytvoriť:', err.message);
      return { stripe_webhook_id: null, stripe_webhook_secret: null };
    }
  }
  async function removePaymentsWebhook(merchant) {
    if (!merchant.stripe_webhook_id || !merchant.stripe_api_key) return;
    await merchantKeys.client(totp.decrypt(merchant.stripe_api_key)).webhookEndpoints.del(merchant.stripe_webhook_id)
      .catch((err) => console.warn('[stripe] webhook sa nepodarilo zmazať:', err.message));
  }

  router.post('/api/connect/keys', accountLimit, async (req, res) => {
    await requirePassword(req);
    const secretKey = String(req.body.secretKey || '').trim();
    const publishableKey = String(req.body.publishableKey || '').trim();
    const secretMode = (secretKey.match(/^(?:sk|rk)_(live|test)_[A-Za-z0-9]+$/) || [])[1];
    const publishableMode = (publishableKey.match(/^pk_(live|test)_[A-Za-z0-9]+$/) || [])[1];
    check(!PLATFORM_FEE_PERCENT, 'Pri poplatku z predaja je možné iba prepojenie cez Stripe Connect.');
    check(secretMode, 'Tajný kľúč začína sk_live_, sk_test_ alebo rk_… (obmedzený kľúč).');
    check(publishableMode, 'Verejný kľúč začína pk_live_ alebo pk_test_.');
    check(secretMode === publishableMode, 'Tajný aj verejný kľúč musia byť z rovnakého režimu (oba live alebo oba test).');

    let account;
    try {
      account = await merchantKeys.client(secretKey).accounts.retrieve();
    } catch (err) {
      throw new BadRequest(`Kľúč sa nepodarilo overiť v Stripe: ${err.message}`);
    }
    const other = await db.getMerchantByAccount(account.id);
    check(!other || other.id === req.merchant.id, 'Tento Stripe účet už používa iný účet Neoworkly.', 409);

    await removePaymentsWebhook(req.merchant);
    await db.updateMerchant(req.merchant.id, {
      stripe_account_id: account.id,
      stripe_api_key: totp.encrypt(secretKey),
      stripe_publishable_key: publishableKey,
      charges_enabled: account.charges_enabled,
      ...(await createPaymentsWebhook(merchantKeys.client(secretKey), req.merchant)),
    });
    const merchant = await db.getMerchant(req.merchant.id);
    await moveRecurringProducts(merchant);
    console.log(`[stripe] ${merchant.email} prepojil ${account.id} API kľúčmi`);
    res.json(view(await db.getMerchant(merchant.id), await testModeInfo(merchant)));
  });

  router.delete('/api/connect/keys', async (req, res) => {
    check(req.merchant.stripe_api_key, 'Stripe nie je prepojený API kľúčmi.');
    await removePaymentsWebhook(req.merchant);
    await db.updateMerchant(req.merchant.id, {
      stripe_account_id: null,
      stripe_api_key: null,
      stripe_publishable_key: null,
      charges_enabled: false,
      stripe_webhook_id: null,
      stripe_webhook_secret: null,
    });
    const merchant = await db.getMerchant(req.merchant.id);
    res.json(view(merchant, await testModeInfo(merchant)));
  });

  // --- Produkty (na pripojenom účte obchodníka) ---------------------------------
  const live = (merchant) => liveStripe(stripe, merchant);
  const save = async (req, res) => {
    const { id, funnel, funnel_version: version } = req.merchant;
    check(await db.saveFunnel(id, funnel, version), 'Funnel sa medzitým zmenil (napr. v inom okne). Obnov stránku a skús znova.', 409);
    res.json(view(await db.getMerchant(id)));
  };

  router.post('/api/products', async (req, res) => {
    const { products } = req.merchant.funnel;
    const { id, name, type, amount, interval } = req.body;
    const currency = String(req.body.currency || DEFAULT_CURRENCY).toLowerCase();
    check(SLUG.test(id || ''), 'ID produktu: iba malé písmená, čísla a pomlčky.');
    check(!products[id], 'Produkt s týmto ID už existuje.');
    check(typeof name === 'string' && name.trim(), 'Zadaj názov.');
    check(['one_time', 'recurring'].includes(type), 'Neplatný typ.');
    check(CURRENCIES[currency], 'Nepodporovaná mena.');
    check(!validateAmount(amount, currency), validateAmount(amount, currency));

    // Mena sa po vytvorení nemení (ceny v Stripe sú v konkrétnej mene)
    const product = { name: name.trim(), type, amount, currency };
    if (type === 'recurring') {
      check(INTERVALS.includes(interval), 'Neplatný interval.');
      check(req.merchant.stripe_account_id, 'Opakovaný produkt vyžaduje prepojený Stripe účet.');
      // Product + recurring Price vzniknú v Stripe účte obchodníka
      const { stripe: client, opts } = live(req.merchant);
      const price = await client.prices.create(
        {
          currency,
          unit_amount: amount,
          recurring: { interval },
          product_data: { name: product.name },
        },
        opts,
      );
      Object.assign(product, {
        interval,
        stripeProductId: price.product,
        stripePriceId: price.id,
        stripeAccountId: req.merchant.stripe_account_id,
      });
    }
    await syncTestProduct(req.merchant, product);
    products[id] = product;
    return save(req, res);
  });

  router.put('/api/products/:id', async (req, res) => {
    const product = req.merchant.funnel.products[req.params.id];
    check(product, 'Produkt neexistuje.');
    const { name, amount } = req.body;
    check(typeof name === 'string' && name.trim(), 'Zadaj názov.');
    check(!validateAmount(amount, currencyOf(product)), validateAmount(amount, currencyOf(product)));

    if (product.type === 'recurring') {
      const { stripe: client, opts } = live(req.merchant);
      // Importovaný produkt patrí katalógu obchodníka => názov v Stripe nemeníme, starú cenu nearchivujeme
      if (name.trim() !== product.name && !product.imported) {
        await client.products.update(product.stripeProductId, { name: name.trim() }, opts);
      }
      // Ceny v Stripe sú nemenné => nová Price, stará sa archivuje.
      // Existujúci predplatitelia zostávajú na pôvodnej cene.
      if (amount !== product.amount) {
        const price = await client.prices.create(
          {
            currency: currencyOf(product),
            unit_amount: amount,
            recurring: { interval: product.interval },
            product: product.stripeProductId,
          },
          opts,
        );
        if (!product.imported) await client.prices.update(product.stripePriceId, { active: false }, opts);
        product.stripePriceId = price.id;
      }
    }
    Object.assign(product, { name: name.trim(), amount });
    await syncTestProduct(req.merchant, product);
    return save(req, res);
  });

  router.delete('/api/products/:id', async (req, res) => {
    const { products, steps } = req.merchant.funnel;
    const product = products[req.params.id];
    check(product, 'Produkt neexistuje.');
    const usedBy = Object.keys(steps).filter(
      (s) => steps[s].productId === req.params.id || (steps[s].ab && steps[s].ab.b.productId === req.params.id),
    );
    check(!usedBy.length, `Produkt používajú kroky: ${usedBy.join(', ')}.`);
    if (product.type === 'recurring') {
      // Product s cenami sa v Stripe nedá zmazať, iba archivovať (importovaný zostáva obchodníkovi)
      const { stripe: client, opts } = live(req.merchant);
      if (!product.imported) await client.products.update(product.stripeProductId, { active: false }, opts);
      if (product.test && stripeTest) {
        await stripeTest.products.update(product.test.productId, { active: false }, { stripeAccount: product.test.accountId });
      }
    }
    delete products[req.params.id];
    return save(req, res);
  });

  // --- Import existujúcich produktov zo Stripe účtu obchodníka -----------------------
  // Použiteľná je aktívna cena s pevnou sumou v podporovanej mene; opakovaná iba mesačne/ročne.
  function importable(price) {
    const product = price.product;
    const recurring = price.recurring;
    if (!product || typeof product !== 'object' || !product.active || product.deleted) return null;
    if (price.billing_scheme !== 'per_unit' || price.unit_amount == null || !CURRENCIES[price.currency]) return null;
    if (recurring && (!INTERVALS.includes(recurring.interval) || recurring.interval_count !== 1 || recurring.usage_type !== 'licensed')) {
      return null;
    }
    return {
      priceId: price.id,
      productId: product.id,
      name: product.name,
      type: recurring ? 'recurring' : 'one_time',
      amount: price.unit_amount,
      currency: price.currency,
      ...(recurring && { interval: recurring.interval }),
    };
  }

  router.get('/api/stripe/prices', async (req, res) => {
    check(req.merchant.stripe_account_id, 'Najprv prepoj Stripe účet.');
    const { stripe: client, opts } = live(req.merchant);
    const { data } = await client.prices.list({ active: true, limit: 100, expand: ['data.product'] }, opts);
    const used = new Set(Object.values(req.merchant.funnel.products).map((p) => p.stripePriceId).filter(Boolean));
    const prices = data.map(importable).filter(Boolean).map((p) => ({
      ...p,
      label: snippets.priceLabel(p),
      imported: used.has(p.priceId),
    }));
    res.json({ prices, skipped: data.length - prices.length });
  });

  // ID produktu z názvu: "Kurz Pro – ročne" => kurz-pro-rocne (pri zhode s pomlčkou a číslom)
  function slugFrom(name, taken) {
    const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'produkt';
    let id = base;
    for (let n = 2; taken[id]; n += 1) id = `${base}-${n}`;
    return id;
  }

  router.post('/api/products/import', async (req, res) => {
    check(req.merchant.stripe_account_id, 'Najprv prepoj Stripe účet.');
    const { products } = req.merchant.funnel;
    const { stripe: client, opts } = live(req.merchant);
    let price;
    try {
      price = await client.prices.retrieve(String(req.body.priceId || ''), { expand: ['product'] }, opts);
    } catch (err) {
      throw new BadRequest(`Cenu sa v Stripe nepodarilo nájsť: ${err.message}`);
    }
    const found = price && price.active && importable(price);
    check(found, 'Túto cenu nevieme použiť (musí byť aktívna, s pevnou sumou, opakovaná iba mesačne alebo ročne).');
    check(!validateAmount(found.amount, found.currency), validateAmount(found.amount, found.currency));
    const id = slugFrom(found.name, products);
    const product = { name: found.name, type: found.type, amount: found.amount, currency: found.currency, imported: true };
    if (found.type === 'recurring') {
      Object.assign(product, {
        interval: found.interval,
        stripeProductId: found.productId,
        stripePriceId: found.priceId,
        stripeAccountId: req.merchant.stripe_account_id,
      });
    } else {
      product.stripePriceId = found.priceId; // iba na označenie, že je už importovaná
    }
    await syncTestProduct(req.merchant, product);
    products[id] = product;
    return save(req, res);
  });

  // --- Kroky funnela ----------------------------------------------------------
  router.put('/api/steps/:id', (req, res) => {
    const { kind, productId, maxQuantity, onAccept, onDecline } = req.body;
    const texts = readTexts(kind, req.body);
    const funnelId = String(req.body.funnelId || '');
    check(!funnelId || (req.merchant.funnel.funnels || {})[funnelId], 'Neznámy funnel.');
    check(SLUG.test(req.params.id), 'ID kroku: iba malé písmená, čísla a pomlčky.');
    check(['entry', 'offer'].includes(kind), 'Neplatný typ kroku.');
    check(req.merchant.funnel.products[productId], 'Vyber produkt.');
    check(isUrl(onAccept), 'Neplatná URL po prijatí.');

    const fields = readFields(req.body);
    const step = { kind, productId, onAccept, ...texts };
    if (funnelId) step.funnelId = funnelId;
    if (fields.length) step.fields = fields;
    // Adresa doručenia sa zadáva raz vo vstupnom kroku a platí pre celý nákup (aj upselly)
    if (kind === 'entry' && req.body.shipping === true) step.shipping = true;
    // Prebiehajúci A/B test zostáva, pokiaľ sa nezmenil typ kroku ani mena (inak by sa varianty nedali porovnať)
    const previous = req.merchant.funnel.steps[req.params.id];
    const products = req.merchant.funnel.products;
    if (previous && previous.ab && previous.kind === kind
      && currencyOf(products[productId]) === currencyOf(products[previous.ab.b.productId || previous.productId])) {
      step.ab = previous.ab;
    }
    if (kind === 'entry') {
      check(Number.isInteger(maxQuantity) && maxQuantity >= 1 && maxQuantity <= 100, 'Max. počet kusov: 1–100.');
      step.maxQuantity = maxQuantity;
    } else {
      check(isUrl(onDecline), 'Neplatná URL po odmietnutí.');
      step.onDecline = onDecline;
      // Priamy predaj: kto príde na stránku ponuky mimo funnela, kúpi tento produkt (napr. za plnú cenu)
      const directProductId = String(req.body.directProductId || '');
      if (directProductId) {
        check(products[directProductId], 'Neznámy produkt pre priamy predaj.');
        step.direct = { productId: directProductId, ...(req.body.directShipping === true && { shipping: true }) };
      }
    }
    req.merchant.funnel.steps[req.params.id] = step;
    return save(req, res);
  });

  // Voliteľné vlastné texty kroku / variantu (prázdne = predvolené)
  function readTexts(kind, body) {
    const texts = {};
    for (const key of kind === 'entry' ? ['title', 'buttonText'] : ['title', 'yesText', 'noText']) {
      const value = String(body[key] || '').trim();
      check(value.length <= 120, 'Texty môžu mať najviac 120 znakov.');
      if (value) texts[key] = value;
    }
    return texts;
  }

  // Voľné polia kroku (napr. venovanie). Hodnota ide do metadát platby v Stripe pod názvom poľa
  // => názov max. 40 znakov (limit kľúča metadát), bez [ ], jedinečný a nie vyhradený; hodnota max. 500.
  const MAX_FIELDS = 5;
  const RESERVED_FIELD_NAMES = ['funnel_step', 'quantity', 'variant'];
  function readFields(body) {
    const list = Array.isArray(body.fields) ? body.fields : [];
    check(list.length <= MAX_FIELDS, `Krok môže mať najviac ${MAX_FIELDS} voľných polí.`);
    const seen = new Set();
    return list.map((f, i) => {
      const label = String((f && f.label) || '').trim();
      check(label && label.length <= 40, 'Názov poľa: 1–40 znakov.');
      check(!/[[\]]/.test(label), 'Názov poľa nesmie obsahovať hranaté zátvorky.');
      check(!seen.has(label.toLowerCase()) && !RESERVED_FIELD_NAMES.includes(label.toLowerCase()), `Názov poľa „${label}“ je použitý viackrát alebo je vyhradený.`);
      seen.add(label.toLowerCase());
      check(['text', 'textarea'].includes(f.type), 'Neplatný typ poľa.');
      const maxLength = Number(f.maxLength);
      check(Number.isInteger(maxLength) && maxLength >= 1 && maxLength <= 500, 'Max. dĺžka poľa: 1–500 znakov.');
      return { id: `f${i + 1}`, label, type: f.type, required: f.required === true, maxLength };
    });
  }

  // --- Funnely (pomenované skupiny krokov) ------------------------------------------
  router.put('/api/funnels/:id', (req, res) => {
    const name = String(req.body.name || '').trim();
    check(SLUG.test(req.params.id), 'ID funnela: iba malé písmená, čísla a pomlčky.');
    check(name && name.length <= 80, 'Zadaj názov funnela (najviac 80 znakov).');
    req.merchant.funnel.funnels = { ...req.merchant.funnel.funnels, [req.params.id]: { name } };
    return save(req, res);
  });

  router.delete('/api/funnels/:id', (req, res) => {
    const funnels = { ...req.merchant.funnel.funnels };
    check(funnels[req.params.id], 'Funnel neexistuje.');
    delete funnels[req.params.id];
    req.merchant.funnel.funnels = funnels;
    // Kroky zostávajú, iba prestanú patriť do funnela
    for (const step of Object.values(req.merchant.funnel.steps)) if (step.funnelId === req.params.id) delete step.funnelId;
    return save(req, res);
  });

  // --- A/B testy ------------------------------------------------------------------
  // Každá zmena testu ho spustí odznova (výsledky sa počítajú od startedAt), aby sa nemiešali
  // návštevy staršieho nastavenia s novým.
  router.put('/api/steps/:id/ab', (req, res) => {
    const step = req.merchant.funnel.steps[req.params.id];
    check(step, 'Krok neexistuje.');
    const split = Number(req.body.split);
    check(Number.isInteger(split) && split >= 1 && split <= 99, 'Rozdelenie návštevníkov: 1–99 % pre variant B.');
    const b = readTexts(step.kind, req.body);
    const productId = String(req.body.productId || '');
    if (productId && productId !== step.productId) {
      const { products } = req.merchant.funnel;
      check(products[productId], 'Neznámy produkt.');
      check(currencyOf(products[productId]) === currencyOf(products[step.productId]), 'Varianty musia byť v rovnakej mene.');
      b.productId = productId;
    }
    check(Object.keys(b).length, 'Variant B sa musí od A v niečom líšiť (produkt alebo texty).');
    step.ab = { startedAt: Date.now(), split, b };
    return save(req, res);
  });

  router.delete('/api/steps/:id/ab', (req, res) => {
    const step = req.merchant.funnel.steps[req.params.id];
    check(step && step.ab, 'Krok nemá A/B test.');
    delete step.ab;
    return save(req, res);
  });

  // Víťaz: variant B sa stane natrvalo podobou kroku (A zostane, ak vyhral A), test sa ukončí
  router.post('/api/steps/:id/ab/winner', (req, res) => {
    const step = req.merchant.funnel.steps[req.params.id];
    check(step && step.ab, 'Krok nemá A/B test.');
    check(['a', 'b'].includes(req.body.variant), 'Vyber variant A alebo B.');
    if (req.body.variant === 'b') Object.assign(step, step.ab.b);
    delete step.ab;
    return save(req, res);
  });

  // Výsledky A/B testu od jeho spustenia (nezávisle od obdobia štatistík)
  async function abResults(merchantId, stepId, step, products) {
    const { a, b } = await db.variantStats(merchantId, stepId, step.ab.startedAt);
    const enrich = (r) => ({ ...r, conversion: r.views ? r.purchases / r.views : null, revenuePerView: r.views ? r.revenue / r.views : null });
    return {
      startedAt: step.ab.startedAt,
      split: step.ab.split,
      currency: currencyOf(products[step.productId]),
      a: enrich(a),
      b: enrich(b),
      minViews: ab.MIN_VIEWS,
      ...ab.evaluate(a, b),
    };
  }

  // --- Štatistiky ---------------------------------------------------------------
  // Konverzia = nákupy / zobrazenia. Zobrazenie = prvé načítanie snippetu v relácii prehliadača.
  router.get('/api/stats', async (req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const { steps, products } = req.merchant.funnel;
    const funnels = req.merchant.funnel.funnels || {};
    const funnelFilter = funnels[req.query.funnel] ? req.query.funnel : null;
    const rows = await db.stepStats(req.merchant.id, since);
    const byStep = Object.fromEntries(rows.map((r) => [r.stepId, r]));
    const empty = { views: 0, purchases: 0, declines: 0, revenue: {} };
    const addRevenue = (a, b) => {
      const sum = { ...a };
      for (const [cur, amount] of Object.entries(b)) sum[cur] = (sum[cur] || 0) + amount;
      return sum;
    };
    const conversion = (r) => (r.views ? r.purchases / r.views : null);

    // Poradie ako v dashboarde; priamy predaj ponuky ("<krok>:priamo") hneď za ňou; zmazané kroky na konci
    const directOf = (id) => id.endsWith(':priamo') && steps[id.slice(0, -':priamo'.length)];
    const stepIds = Object.keys(steps).flatMap((id) => (byStep[`${id}:priamo`] || steps[id].direct ? [id, `${id}:priamo`] : [id]));
    const ids = [...stepIds, ...rows.map((r) => r.stepId).filter((id) => !stepIds.includes(id))]
      .filter((id) => !funnelFilter || ((steps[id] || directOf(id)) && (steps[id] || directOf(id)).funnelId === funnelFilter));
    const list = await Promise.all(ids.map(async (id) => {
      const r = { ...empty, ...byStep[id] };
      const parent = directOf(id);
      const step = steps[id];
      const productId = parent ? parent.direct && parent.direct.productId : step && step.productId;
      return {
        stepId: id,
        funnelId: (step || parent) ? (step || parent).funnelId || null : null,
        kind: step ? step.kind : parent ? 'direct' : null,
        product: products[productId] ? products[productId].name : null,
        deleted: !step && !parent,
        views: r.views,
        purchases: r.purchases,
        declines: r.declines,
        revenue: r.revenue,
        conversion: conversion(r),
        ab: step && step.ab ? await abResults(req.merchant.id, id, step, products) : null,
      };
    }));
    const totals = list.reduce(
      (t, r) => ({ views: t.views + r.views, purchases: t.purchases + r.purchases, declines: t.declines + r.declines, revenue: addRevenue(t.revenue, r.revenue) }),
      empty,
    );
    // Konverzia funnela = nákupy vo vstupnom kroku / jeho zobrazenia
    const entry = list.filter((r) => r.kind === 'entry').reduce((t, r) => ({ views: t.views + r.views, purchases: t.purchases + r.purchases }), { views: 0, purchases: 0 });
    res.json({ days, funnel: funnelFilter, totals: { ...totals, conversion: conversion(entry) }, steps: list });
  });

  // --- Oznámenia o objednávkach ---------------------------------------------------
  router.put('/api/notifications', (req, res) => {
    const current = req.merchant.funnel.notifications || {};
    const webhookUrl = String(req.body.webhookUrl || '').trim();
    if (webhookUrl) check(!notify.validateWebhookUrl(webhookUrl), notify.validateWebhookUrl(webhookUrl));
    req.merchant.funnel.notifications = {
      email: req.body.email !== false,
      webhookUrl,
      // Tajomstvo na overenie podpisu sa vytvorí pri prvom nastavení webhooku a zostáva, kým ho obchodník nevymení
      webhookSecret: current.webhookSecret || (webhookUrl ? notify.newWebhookSecret() : ''),
    };
    return save(req, res);
  });

  router.post('/api/notifications/secret', (req, res) => {
    const current = req.merchant.funnel.notifications || {};
    check(current.webhookUrl, 'Najprv nastav URL webhooku.');
    req.merchant.funnel.notifications = { ...current, webhookSecret: notify.newWebhookSecret() };
    return save(req, res);
  });

  // Skúšobná objednávka na webhook – obchodník hneď vidí, či jeho systém odpovedá
  router.post(
    '/api/notifications/test',
    rateLimit({ name: 'webhook-test', max: 10, windowMs: 10 * MINUTE, key: (req) => req.merchant.id }),
    async (req, res) => {
      const { webhookUrl, webhookSecret } = req.merchant.funnel.notifications || {};
      check(webhookUrl, 'Najprv nastav URL webhooku.');
      const sample = {
        type: 'order.completed', id: 'ord_test', created: new Date().toISOString(), mode: 'test', test: true,
        merchantId: req.merchant.id, step: 'vstup',
        product: { id: 'ukazka', name: 'Ukážkový produkt', type: 'one_time', interval: null },
        quantity: 1, amount: 1900, currency: DEFAULT_CURRENCY,
        customer: { email: 'zakaznik@example.com', stripeCustomerId: 'cus_test' },
        stripeAccountId: req.merchant.stripe_account_id, paymentIntentId: 'pi_test',
      };
      try {
        const { status } = await notify.deliver(webhookUrl, webhookSecret, sample);
        res.json({ ok: true, status });
      } catch (err) {
        res.status(424).json({ error: `Webhook sa nepodarilo doručiť: ${err.message}` }); // nie 502 (Cloudflare)
      }
    },
  );

  // Vzhľad snippetov – platí pre všetky kroky a prejaví sa bez nového vkladania snippetu
  router.put('/api/appearance', (req, res) => {
    const color = String(req.body.color || '').toLowerCase();
    const termsUrl = String(req.body.termsUrl || '').trim();
    const privacyUrl = String(req.body.privacyUrl || '').trim();
    const customCss = String(req.body.customCss || '').trim();
    const absoluteUrl = (u) => /^https?:\/\/\S+$/.test(u);
    check(/^#[0-9a-f]{6}$/.test(color), 'Farba musí byť v tvare #RRGGBB.');
    check(!termsUrl === !privacyUrl, 'Vyplň oba odkazy (obchodné podmienky aj ochranu osobných údajov) alebo žiadny.');
    check(!termsUrl || (absoluteUrl(termsUrl) && absoluteUrl(privacyUrl)), 'Odkazy musia začínať https://');
    check(customCss.length <= snippets.MAX_CUSTOM_CSS, `Vlastné CSS môže mať najviac ${snippets.MAX_CUSTOM_CSS} znakov.`);
    const pausedText = String(req.body.pausedText || '').trim();
    const pausedUrl = String(req.body.pausedUrl || '').trim();
    check(pausedText.length <= 200, 'Text pri pozastavenom predaji môže mať najviac 200 znakov.');
    check(!pausedUrl || absoluteUrl(pausedUrl), 'Náhradná stránka musí začínať https://');
    req.merchant.funnel.appearance = { color, termsUrl, privacyUrl, customCss, pausedText, pausedUrl };
    return save(req, res);
  });

  router.delete('/api/steps/:id', (req, res) => {
    check(req.merchant.funnel.steps[req.params.id], 'Krok neexistuje.');
    delete req.merchant.funnel.steps[req.params.id];
    return save(req, res);
  });

  // --- Snippety ---------------------------------------------------------------
  router.get('/api/snippets/:step', (req, res) => {
    check(req.merchant.funnel.steps[req.params.step], 'Krok neexistuje.');
    check(req.merchant.stripe_account_id, 'Najprv prepoj Stripe účet.');
    const html = snippets.stepSnippet(req.merchant, req.params.step);
    // Vstupný krok sa dá zaplatiť aj na stránke Stripe – stačí odkaz alebo tlačidlo na webe
    const checkoutUrl = req.merchant.funnel.steps[req.params.step].kind === 'entry'
      ? new URL(`/api/f/${req.merchant.id}/${req.params.step}/checkout`, process.env.PUBLIC_URL).href
      : null;
    res.json({ html, csp: snippets.snippetCsp(html), checkoutUrl });
  });

  // --- Apple Pay a Google Pay: doména webu obchodníka zaregistrovaná v jeho Stripe účte ---------
  // Bez registrácie Stripe tieto peňaženky vo formulári na webe nezobrazí (na stránke Stripe áno).
  const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const domainView = (d) => ({
    domain: d.domain_name,
    applePay: d.apple_pay.status,
    googlePay: d.google_pay.status,
    error: (d.apple_pay.status_details && d.apple_pay.status_details.error_message)
      || (d.google_pay.status_details && d.google_pay.status_details.error_message) || null,
  });
  async function walletDomains(merchant) {
    const { stripe: client, opts } = live(merchant);
    const { data } = await client.paymentMethodDomains.list({ limit: 100 }, opts);
    return { domains: data.filter((d) => d.enabled).map(domainView) };
  }

  router.get('/api/wallets', async (req, res) => {
    check(req.merchant.stripe_account_id, 'Najprv prepoj Stripe účet.');
    res.json(await walletDomains(req.merchant));
  });

  router.post('/api/wallets', async (req, res) => {
    check(req.merchant.stripe_account_id, 'Najprv prepoj Stripe účet.');
    const domain = String(req.body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
    check(DOMAIN.test(domain), 'Zadaj doménu webu, napr. mojweb.sk (bez https://).');
    const register = async (client, opts) => {
      const { data } = await client.paymentMethodDomains.list({ domain_name: domain, limit: 1 }, opts);
      return data[0]
        ? client.paymentMethodDomains.validate(data[0].id, {}, opts) // znova overí (napr. po oprave)
        : client.paymentMethodDomains.create({ domain_name: domain }, opts);
    };
    const { stripe: client, opts } = live(req.merchant);
    await register(client, opts);
    // Aj testovací účet, aby peňaženky šli vyskúšať v testovacom režime (chyba tu nevadí)
    if (stripeTest && req.merchant.test_account_id) {
      await register(stripeTest, { stripeAccount: req.merchant.test_account_id }).catch((err) =>
        console.error('[peňaženky] testovací účet:', err.message));
    }
    res.json(await walletDomains(req.merchant));
  });

  router.use((err, req, res, next) => {
    if (err instanceof BadRequest) return res.status(err.status).json({ error: err.message });
    // 424, nie 502: Cloudflare odpoveď 502/504 zo servera nahradí vlastnou stránkou a správa by sa stratila
    if (err.type && err.type.startsWith('Stripe')) {
      console.error(`Stripe chyba (${req.method} ${req.originalUrl}):`, err.message);
      return res.status(424).json({ error: `Stripe: ${err.message}` });
    }
    next(err);
  });

  return router;
};
