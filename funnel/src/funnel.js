// Funnel pre koncových zákazníkov obchodníka. Všetky platby prebiehajú na pripojenom
// Stripe účte obchodníka (direct charges): zákazník, karta aj peniaze patria obchodníkovi.
//
// Snippety bežia na doméne obchodníka, API na doméne Neoworkly. Zákazníka preto neidentifikuje
// cookie (tretia strana), ale podpísaný token, ktorý snippet drží v sessionStorage a posiela
// v hlavičke Authorization. Keďže nejde o cookies, CORS môže povoliť akýkoľvek pôvod.
const crypto = require('crypto');
const express = require('express5');
const db = require('./db');
const { canSell, isActive, liveStripe } = require('./merchants');
const { stepConfig, esc, priceLabel } = require('./snippets');
const { currencyOf } = require('./currency');
const { pickVariant, resolveStep } = require('./abtest');
const { rateLimit, byIp, MINUTE } = require('./ratelimit');
const notify = require('./notify');

const TOKEN_TTL = 1000 * 60 * 60 * 2; // 2 h stačí na prejdenie funnela

// Voliteľný poplatok Neoworkly z každej platby (application fee pri direct charges). 0 = žiadny.
// Iba cez Connect – pri prepojení vlastnými kľúčmi (bez stripeAccount) poplatok nejde strhnúť.
const FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT) || 0;
const feeForAmount = (amount, acct) =>
  FEE_PERCENT && acct.stripeAccount ? { application_fee_amount: Math.round((amount * FEE_PERCENT) / 100) } : {};
const feeForSubscription = (acct) => (FEE_PERCENT && acct.stripeAccount ? { application_fee_percent: FEE_PERCENT } : {});

const hmac = (body) => crypto.createHmac('sha256', process.env.COOKIE_SECRET).update(body).digest('base64url');

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function verifyToken(header) {
  const [body, sig] = String(header || '').replace(/^Bearer /, '').split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(hmac(body));
  if (expected.length !== sig.length || !crypto.timingSafeEqual(expected, Buffer.from(sig))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Predaj pozastavený (skončené predplatné, blokovanie, nedokončený Stripe účet): zákazník neuvidí chybu.
// Bez vlastného textu obchodníka nový snippet zmizne (hide); staršie snippety ukážu neutrálny text.
const PAUSED_TEXT = 'Predaj je dočasne pozastavený.';
class PausedError extends HttpError {
  constructor(merchant) {
    const { pausedText = '', pausedUrl = '' } = merchant.funnel.appearance || {};
    super(503, pausedText || PAUSED_TEXT);
    Object.assign(this, { paused: true, hide: !pausedText, pausedUrl });
  }
}

// Chyba pri otvorení platobnej stránky (zákazník je v prehliadači)
const errorPage = (message) => `<!doctype html><html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Platba</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center">
<p>${esc(message)}</p><p>Vráť sa prosím späť na stránku obchodu.</p></body></html>`;

// Porovnanie tajných reťazcov v konštantnom čase
function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// stripeTest = klient s testovacími kľúčmi platformy (testovací režim obchodníkov); môže chýbať
module.exports = function createFunnel(stripe, stripeTest) {
  const router = express.Router({ mergeParams: true });

  router.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Neoworkly-Test',
      'Access-Control-Allow-Methods': 'POST',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Obchodník musí mať aktívne predplatné Neoworkly a Stripe účet schopný prijímať platby.
  // Testovací režim: hlavička X-Neoworkly-Test s tajným testovacím kľúčom obchodníka => všetko
  // beží v testovacom Stripe účte obchodníka (testovacie karty, žiadne skutočné peniaze).
  router.use(async (req, res, next) => {
    const merchant = await db.getMerchant(req.params.merchant);
    if (!merchant) return next(new HttpError(404, 'Neznámy obchod.'));
    req.merchant = merchant;
    // Odkaz na platobnú stránku Stripe (GET) nesie testovací kľúč v adrese (?neoworkly_test=…)
    const queryKey = req.method === 'GET' && req.query.neoworkly_test !== '0' ? req.query.neoworkly_test : '';
    const testKey = req.get('X-Neoworkly-Test') || String(queryKey || '');
    if (testKey) {
      if (!stripeTest || !merchant.test_account_id || !merchant.test_key) {
        return next(new HttpError(503, 'Testovací režim nie je nastavený.'));
      }
      if (!sameSecret(testKey, merchant.test_key)) return next(new HttpError(403, 'Neplatný testovací kľúč.'));
      if (!isActive(merchant) || merchant.blocked) return next(new PausedError(merchant));
      Object.assign(req, {
        mode: 'test',
        stripe: stripeTest,
        acct: { stripeAccount: merchant.test_account_id },
        publishableKey: process.env.STRIPE_TEST_PUBLISHABLE_KEY,
      });
      return next();
    }
    if (!canSell(merchant)) return next(new PausedError(merchant));
    const live = liveStripe(stripe, merchant);
    Object.assign(req, {
      mode: 'live',
      stripe: live.stripe,
      acct: live.opts,
      publishableKey: merchant.stripe_api_key ? merchant.stripe_publishable_key : process.env.STRIPE_PUBLISHABLE_KEY,
    });
    next();
  });

  // Krok aj produkt sa čítajú pri každej požiadavke => zmeny z dashboardu platia hneď
  // A/B test: /view vyberie variant (alebo zachová ten zo zákazníkovej relácie), ostatné volania
  // posielajú variant, ktorý snippet dostal. Bez neho variant A (staršie snippety).
  router.param('step', (req, res, next, stepId) => {
    const base = req.merchant.funnel.steps[stepId];
    if (!base) return next(new HttpError(404, 'Neznámy krok funnela.'));
    const requested = req.body && req.body.variant;
    // Variant sa vyberá pri zobrazení snippetu alebo pri otvorení platobnej stránky Stripe
    const variant = /\/(view|checkout)$/.test(req.path) ? pickVariant(base, requested) : requested === 'b' && base.ab ? 'b' : 'a';
    const resolved = resolveStep(req.merchant, stepId, variant);
    if (!resolved) return next(new HttpError(404, 'Neznámy krok funnela.'));
    const { step, product } = resolved;
    // Cena opakovaného produktu patrí konkrétnemu Stripe účtu – ostrému alebo testovaciemu
    const priceId = req.mode === 'test' ? product.test && product.test.priceId : product.stripePriceId;
    if (product.type === 'recurring' && !priceId) {
      return next(new HttpError(503, 'Produkt ešte nie je pripravený v testovacom režime.'));
    }
    req.step = { ...step, product, priceId };
    next();
  });

  // Platný token z funnela tohto obchodu (token z ostrého režimu neplatí v testovacom a naopak)
  function funnelToken(req) {
    const token = verifyToken(req.headers.authorization);
    return token && token.m === req.merchant.id && (token.mode || 'live') === req.mode ? token : null;
  }

  function requireToken(req) {
    const token = funnelToken(req);
    if (!token) throw new HttpError(401, 'Začni prosím od prvého kroku.');
    return token;
  }

  const paidKey = (stepId) => `funnel_${stepId}`;

  // Hodnoty voľných polí kroku (napr. venovanie) => metadáta platby { "Názov poľa": "hodnota" }
  function readFieldValues(step, body) {
    const values = body && body.fields && typeof body.fields === 'object' ? body.fields : {};
    const out = {};
    for (const f of step.fields || []) {
      const value = String(values[f.id] ?? '').trim();
      if (!value) {
        if (f.required) throw new HttpError(400, `Vyplň prosím pole „${f.label}“.`);
        continue;
      }
      if (value.length > f.maxLength) throw new HttpError(400, `Pole „${f.label}“ môže mať najviac ${f.maxLength} znakov.`);
      out[f.label] = value;
    }
    return out;
  }

  // Adresa doručenia z Address Elementu Stripe (formát ako Stripe shipping)
  function readShipping(body) {
    const s = (body && body.shipping) || {};
    const a = s.address || {};
    const text = (v) => String(v || '').trim().slice(0, 200);
    const address = { line1: text(a.line1), line2: text(a.line2), city: text(a.city), postal_code: text(a.postal_code), state: text(a.state), country: text(a.country).toUpperCase() };
    if (!text(s.name) || !address.line1 || !address.city || !address.postal_code || !/^[A-Z]{2}$/.test(address.country)) {
      throw new HttpError(400, 'Vyplň prosím celú adresu doručenia.');
    }
    return withoutEmpty({ name: text(s.name), phone: text(s.phone), address: withoutEmpty(address) });
  }
  const withoutEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));
  // Adresa zo Stripe (prázdne časti sú null) => bez prázdnych hodnôt, alebo null
  const shippingOf = (s) => (s && s.address ? withoutEmpty({ name: s.name, phone: s.phone, address: withoutEmpty(s.address) }) : null);

  // Hodnoty polí späť z metadát platby (pre oznámenie), v poradí podľa nastavenia kroku
  const fieldsOf = (step, metadata) =>
    Object.fromEntries((step.fields || []).filter((f) => metadata[f.label]).map((f) => [f.label, metadata[f.label]]));

  // Štatistiky sú druhoradé: výpadok databázy nesmie zastaviť platbu ani oznámenie o objednávke
  async function record(event) {
    try {
      await db.addEvent(event);
    } catch (err) {
      console.error('Štatistika sa nezapísala:', err.message);
    }
  }

  // Zaplatený krok: zapíše sa k zákazníkovi (ochrana pred dvojitou platbou) a do štatistík.
  // Opakované volanie s tou istou platbou (reload, dvojklik) nič nezopakuje.
  async function purchased(req, pi, customerId, update = {}) {
    const customer = await req.stripe.customers.retrieve(customerId, req.acct);
    if (customer.metadata[paidKey(req.step.id)] === pi.id) return;
    await req.stripe.customers.update(customerId, { ...update, metadata: { [paidKey(req.step.id)]: pi.id } }, req.acct);
    await record({
      merchantId: req.merchant.id, stepId: req.step.id, type: 'purchase', amount: pi.amount,
      currency: currencyOf(req.step.product), variant: req.step.variant, mode: req.mode,
    });

    // Oznámenie obchodníkovi beží na pozadí – zákazník na e-mail ani webhook nečaká
    const { product } = req.step;
    const order = {
      type: 'order.completed',
      id: `ord_${pi.id}`,
      created: new Date().toISOString(),
      mode: req.mode, // "test" = skúšobná objednávka – nedoručuj produkt!
      merchantId: req.merchant.id,
      step: req.step.id,
      product: { id: req.step.productId, name: product.name, type: product.type, interval: product.interval || null },
      quantity: Number(pi.metadata.quantity) || 1,
      amount: pi.amount,
      currency: currencyOf(product),
      customer: { email: customer.email || null, stripeCustomerId: customerId },
      fields: fieldsOf(req.step, pi.metadata || {}),
      shipping: shippingOf(update.shipping || customer.shipping),
      stripeAccountId: req.acct.stripeAccount || req.merchant.stripe_account_id,
      paymentIntentId: pi.id,
    };
    notify.orderCompleted(req.merchant, order).catch((err) => console.error('[oznámenie]', err));
  }
  const nextStep = (req) => ({ next: req.step.onAccept });

  // Snippet pri načítaní: aktuálne texty, cena, farba a odkazy (zmeny z dashboardu bez nového vkladania)
  const viewLimit = rateLimit({ name: 'view-ip', max: 300, windowMs: 10 * MINUTE, key: byIp });
  router.post('/:step/view', viewLimit, async (req, res) => {
    // Ponuka s priamym predajom: návštevník bez tokenu z funnela (prišiel rovno na stránku) dostane
    // namiesto „Chcem pridať“ tlačidlo na kúpu iného produktu (napr. za plnú cenu) na stránke Stripe
    const direct = !funnelToken(req) && directStep(req.merchant, req.step, req.mode);
    if (direct) {
      if (req.body.count === true) {
        await record({ merchantId: req.merchant.id, stepId: direct.id, type: 'view', variant: req.step.variant, mode: req.mode });
      }
      const price = priceLabel(direct.product);
      return res.json({
        ...stepConfig(req.merchant, req.step.id, req.step.variant),
        mode: req.mode,
        direct: {
          title: `${direct.product.name} – ${price}`,
          buttonText: `Kúpiť za ${price}`,
          checkoutUrl: new URL(`/api/f/${req.merchant.id}/${req.step.id}/checkout`, process.env.PUBLIC_URL).href,
        },
        publishableKey: req.publishableKey,
        stripeAccount: req.acct.stripeAccount,
      });
    }
    // Snippet posiela count: true iba pri prvom zobrazení v relácii prehliadača
    if (req.body.count === true) {
      await record({ merchantId: req.merchant.id, stepId: req.step.id, type: 'view', variant: req.step.variant, mode: req.mode });
    }
    res.json({
      ...stepConfig(req.merchant, req.step.id, req.step.variant),
      mode: req.mode,
      // Stripe.js v snippete sa inicializuje až podľa týchto údajov => funguje v oboch režimoch
      // a po novom prepojení Stripe účtu netreba snippety vkladať znova
      // Pri vlastných kľúčoch obchodníka stripeAccount chýba (Stripe.js beží priamo v jeho účte)
      publishableKey: req.publishableKey,
      stripeAccount: req.acct.stripeAccount,
    });
  });

  // ---------------------------------------------------------------------------
  // Vstupný krok: nový zákazník zadá kartu, ktorá sa uloží pre ďalšie kroky
  // ---------------------------------------------------------------------------
  // Každý štart vytvorí zákazníka u obchodníka => limit proti spamu (na IP aj na obchodníka)
  const startLimit = rateLimit(
    { name: 'start-ip', max: 10, windowMs: 10 * MINUTE, key: byIp },
    { name: 'start-merchant', max: 300, windowMs: 60 * MINUTE, key: (req) => req.merchant.id },
  );

  router.post('/:step/start', startLimit, async (req, res) => {
    const { step, acct } = req;
    if (step.kind !== 'entry') throw new HttpError(400, 'Tento krok nezačína funnel.');
    const email = String(req.body.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Neplatný e-mail.');
    const quantity = Math.min(Math.max(parseInt(req.body.quantity, 10) || 1, 1), step.maxQuantity || 1);
    const fields = readFieldValues(step, req.body);
    const shipping = step.shipping ? readShipping(req.body) : null;
    const metadata = { funnel_step: step.id, quantity: String(quantity), variant: step.variant, ...fields };

    // Adresa sa uloží k zákazníkovi => platí aj pre upselly a predplatné
    const customer = await req.stripe.customers.create({ email, ...(shipping && { shipping }) }, acct);
    let clientSecret;
    if (step.product.type === 'recurring') {
      // Predplatné čaká na prvú platbu; karta sa uloží ako default_payment_method predplatného
      const sub = await req.stripe.subscriptions.create(
        {
          customer: customer.id,
          items: [{ price: step.priceId, quantity }],
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
          metadata,
          expand: ['latest_invoice.confirmation_secret'],
          ...feeForSubscription(acct),
        },
        acct,
      );
      clientSecret = sub.latest_invoice.confirmation_secret.client_secret;
      // Voľné polia aj k samotnej platbe (vidno ich pri platbe v Stripe a idú do oznámenia)
      if (Object.keys(fields).length) {
        await req.stripe.paymentIntents.update(clientSecret.split('_secret_')[0], { metadata }, acct);
      }
    } else {
      // setup_future_usage uloží kartu k zákazníkovi pre ďalšie kroky funnela
      const pi = await req.stripe.paymentIntents.create(
        {
          amount: step.product.amount * quantity,
          currency: currencyOf(step.product),
          customer: customer.id,
          ...feeForAmount(step.product.amount * quantity, acct),
          payment_method_types: ['card'],
          setup_future_usage: 'off_session',
          description: `${step.product.name} × ${quantity}`,
          metadata,
          ...(shipping && { shipping }),
        },
        acct,
      );
      clientSecret = pi.client_secret;
    }

    // ID PaymentIntentu je súčasťou client secretu ("pi_..._secret_..."); token ho viaže na tento krok
    const pi = clientSecret.split('_secret_')[0];
    res.json({
      clientSecret,
      token: signToken({ m: req.merchant.id, c: customer.id, step: step.id, pi, mode: req.mode, v: step.variant }),
    });
  });

  // Po potvrdení platby v prehliadači: server overí platbu a uloží kartu ako predvolenú
  router.post('/:step/complete', async (req, res) => {
    const token = requireToken(req);
    if (token.step !== req.step.id) throw new HttpError(400, 'Nesprávny krok.');
    if ((token.v || 'a') !== req.step.variant) throw new HttpError(400, 'Nesprávny variant.');
    const pi = await req.stripe.paymentIntents.retrieve(token.pi, req.acct);
    if (pi.customer !== token.c) throw new HttpError(403, 'Neplatná platba.');
    if (pi.status !== 'succeeded') throw new HttpError(402, 'Platba nebola dokončená.');
    await purchased(req, pi, token.c, { invoice_settings: { default_payment_method: pi.payment_method } });
    res.json(nextStep(req));
  });

  // ---------------------------------------------------------------------------
  // Upsell / downsell: okamžitá platba uloženou kartou
  // ---------------------------------------------------------------------------
  const idempotencyKey = (customerId, stepId) => `${customerId}:${stepId}`;

  function chargeOneTime(req, customerId, paymentMethodId, shipping) {
    const { step, acct } = req;
    return req.stripe.paymentIntents.create(
      {
        amount: step.product.amount,
        currency: currencyOf(step.product),
        customer: customerId,
        ...feeForAmount(step.product.amount, acct),
        payment_method: paymentMethodId,
        payment_method_types: ['card'],
        confirm: true,
        description: step.product.name,
        metadata: { funnel_step: step.id, variant: step.variant, ...req.fieldValues },
        ...(shipping && { shipping }),
      },
      { ...acct, idempotencyKey: idempotencyKey(customerId, step.id) },
    );
  }

  // Opakovaný produkt: samostatné predplatné, prvá faktúra sa hneď strhne z uloženej karty.
  // Vráti PaymentIntent prvej faktúry, aby 3D Secure a /confirm fungovali rovnako.
  async function chargeRecurring(req, customerId, paymentMethodId) {
    const { step, acct } = req;
    const sub = await req.stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: step.priceId }],
        default_payment_method: paymentMethodId,
        payment_settings: { payment_method_types: ['card'] },
        metadata: { funnel_step: step.id, variant: step.variant, ...req.fieldValues },
        expand: ['latest_invoice.payments'],
        ...feeForSubscription(acct),
      },
      { ...acct, idempotencyKey: idempotencyKey(customerId, step.id) },
    );
    const piId = sub.latest_invoice.payments.data[0].payment.payment_intent;
    return req.stripe.paymentIntents.update(piId, { metadata: { funnel_step: step.id, variant: step.variant, ...req.fieldValues } }, acct);
  }

  router.post('/:step/accept', async (req, res) => {
    const token = requireToken(req);
    const { step, acct } = req;
    if (step.kind !== 'offer') throw new HttpError(400, 'Tento krok sa platí formulárom.');

    const customer = await req.stripe.customers.retrieve(token.c, acct);
    if (customer.metadata[paidKey(step.id)]) return res.json(nextStep(req)); // reload / dvojklik
    const paymentMethodId = customer.invoice_settings.default_payment_method;
    if (!paymentMethodId) throw new HttpError(402, 'Chýba uložená karta. Začni prosím od prvého kroku.');
    req.fieldValues = readFieldValues(step, req.body);
    // Adresa zo vstupného kroku sa pridá aj k tejto platbe
    const shipping = customer.shipping && customer.shipping.address
      ? withoutEmpty({ name: customer.shipping.name, phone: customer.shipping.phone, address: withoutEmpty(customer.shipping.address) })
      : null;

    try {
      // Zákazník je na stránke a klikol => on-session platba s uloženou kartou
      const pi = step.product.type === 'recurring'
        ? await chargeRecurring(req, token.c, paymentMethodId)
        : await chargeOneTime(req, token.c, paymentMethodId, shipping);
      if (pi.status === 'requires_action') {
        return res.json({ requiresAction: true, clientSecret: pi.client_secret });
      }
      if (pi.status !== 'succeeded') {
        const reason = pi.last_payment_error && pi.last_payment_error.message;
        throw new HttpError(402, reason || 'Platba nebola dokončená.');
      }
      await purchased(req, pi, token.c);
      res.json(nextStep(req));
    } catch (err) {
      if (err.type === 'StripeCardError') throw new HttpError(402, err.message);
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // Vstupný krok na platobnej stránke Stripe (Checkout) namiesto formulára na webe.
  // Odkaz /checkout vytvorí stránku s aktuálnou cenou, poliami a adresou; karta sa uloží a Stripe
  // vráti zákazníka na „URL po prijatí“ s ?nw_session=… Snippet ponuky si za ňu vymení token
  // (/session) a ďalšie kroky už platí jedným klikom ako po formulári.
  // ---------------------------------------------------------------------------
  // Krajiny doručenia na stránke Stripe (EÚ, EHP a najčastejšie ostatné)
  const SHIPPING_COUNTRIES = ['SK', 'CZ', 'AT', 'BE', 'BG', 'HR', 'CY', 'DK', 'EE', 'FI', 'FR', 'GR', 'NL', 'IE', 'LT', 'LV',
    'LU', 'HU', 'MT', 'DE', 'PL', 'PT', 'RO', 'SI', 'ES', 'SE', 'IT', 'GB', 'CH', 'NO', 'IS', 'LI', 'UA', 'US', 'CA'];
  const CHECKOUT_MAX_FIELDS = 3; // limit vlastných polí v Stripe Checkout
  const CHECKOUT_TTL = 3 * 60 * 60; // s – dokedy sa dá zaplatená stránka vymeniť za token

  // Adresa po zaplatení: „URL po prijatí“ (relatívna sa doplní podľa stránky s tlačidlom) + parametre
  function returnUrl(req, url, params) {
    let target;
    try {
      target = new URL(url, req.get('referer') || undefined);
    } catch {
      throw new HttpError(400, 'Pri platbe na stránke Stripe musí byť „URL po prijatí“ úplná adresa (https://…).');
    }
    if (!/^https?:$/.test(target.protocol)) throw new HttpError(400, 'Neplatná „URL po prijatí“.');
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return target.href.replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');
  }

  // Cieľ platobnej stránky: vstupný krok, alebo ponuka predávaná priamo (návštevník neprišiel cez funnel –
  // nemá token z predchádzajúceho kroku). Priamy predaj má vlastné ID "<krok>:priamo" v štatistikách,
  // v oznámení aj u zákazníka, takže sa nemieša s upsellom.
  function directStep(merchant, step, mode) {
    const product = step.kind === 'offer' && step.direct && merchant.funnel.products[step.direct.productId];
    if (!product) return null;
    const priceId = mode === 'test' ? product.test && product.test.priceId : product.stripePriceId;
    return {
      ...step, id: `${step.id}:priamo`, productId: step.direct.productId, product, priceId,
      maxQuantity: 1, shipping: Boolean(step.direct.shipping), direct: true,
    };
  }

  router.get('/:step/checkout', startLimit, async (req, res) => {
    const { step, acct } = req;
    const target = step.kind === 'entry' ? step : directStep(req.merchant, step, req.mode);
    if (!target) throw new HttpError(400, 'Platobná stránka Stripe je pre vstupný krok alebo pre ponuku s priamym predajom.');
    const fields = target.fields || [];
    if (fields.length > CHECKOUT_MAX_FIELDS) {
      throw new HttpError(400, `Stránka Stripe podporuje najviac ${CHECKOUT_MAX_FIELDS} voľné polia – krok ich má viac.`);
    }
    const recurring = target.product.type === 'recurring';
    if (recurring && !target.priceId) throw new HttpError(503, 'Produkt ešte nie je pripravený v testovacom režime.');
    const metadata = { funnel_step: step.id, variant: step.variant, ...(target.direct && { direct: '1' }) };
    const lineItem = recurring
      ? { price: target.priceId, quantity: 1 }
      : {
        price_data: { currency: currencyOf(target.product), unit_amount: target.product.amount, product_data: { name: target.product.name } },
        quantity: 1,
      };
    // Počet kusov si zákazník zvolí na stránke Stripe (pri poplatku z predaja iba 1 kus – poplatok je pevná suma)
    if ((target.maxQuantity || 1) > 1 && !(FEE_PERCENT && acct.stripeAccount)) {
      lineItem.adjustable_quantity = { enabled: true, minimum: 1, maximum: target.maxQuantity };
    }
    // Po zaplatení Stripe vráti zákazníka najprv sem (/return – nákup sa zapíše hneď), odtiaľ ide na „URL po prijatí“
    const returnTo = returnUrl(req, step.onAccept, {});
    if (returnTo.length > 500) throw new HttpError(400, '„URL po prijatí“ je pre platobnú stránku Stripe príliš dlhá.');
    const success = new URL(`/api/f/${req.merchant.id}/${step.id}/return`, process.env.PUBLIC_URL);
    success.searchParams.set('nw_session', '{CHECKOUT_SESSION_ID}');
    if (req.mode === 'test') success.searchParams.set('neoworkly_test', req.query.neoworkly_test);
    const back = req.get('referer');
    const session = await req.stripe.checkout.sessions.create(
      {
        mode: recurring ? 'subscription' : 'payment',
        line_items: [lineItem],
        payment_method_types: ['card'], // vrátane Apple Pay a Google Pay; kartu potom použije upsell
        success_url: success.href.replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}'),
        ...(back && /^https?:\/\//.test(back) && { cancel_url: back }),
        locale: 'sk',
        metadata: { ...metadata, neoworkly_merchant: req.merchant.id, return_to: returnTo },
        ...(recurring
          ? { subscription_data: { metadata, ...feeForSubscription(acct) } }
          : {
            customer_creation: 'always',
            payment_intent_data: {
              setup_future_usage: 'off_session', // uložená karta pre upselly
              description: target.product.name,
              metadata,
              ...feeForAmount(target.product.amount, acct),
            },
          }),
        ...(target.shipping && { shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES } }),
        ...(fields.length && {
          custom_fields: fields.map((f) => ({
            key: f.id,
            label: { type: 'custom', custom: f.label },
            type: 'text',
            optional: !f.required,
            text: { maximum_length: Math.min(f.maxLength, 255) },
          })),
        }),
      },
      acct,
    );
    if (!target.direct) {
      // Priamy predaj má zobrazenie zapísané už zo snippetu (/view), vstupný krok z odkazu ho má iba tu
      await record({ merchantId: req.merchant.id, stepId: target.id, type: 'view', variant: step.variant, mode: req.mode });
    }
    res.redirect(303, session.url);
  });

  // Zaplatená stránka Stripe => nákup sa zapíše (karta ako predvolená, polia, adresa, oznámenie, štatistiky).
  // Opakované volanie s tou istou platbou nič nezopakuje. Platí iba krátko po vytvorení stránky.
  async function checkoutPurchase(req, sessionId) {
    const invalid = () => new HttpError(403, 'Platbu sa nepodarilo overiť. Začni prosím od prvého kroku.');
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) throw invalid();
    let session;
    try {
      session = await req.stripe.checkout.sessions.retrieve(
        sessionId,
        { expand: ['payment_intent', 'invoice.payments', 'line_items'] },
        req.acct,
      );
    } catch {
      throw invalid();
    }
    const md = session.metadata || {};
    if (md.neoworkly_merchant !== req.merchant.id || session.status !== 'complete' || session.payment_status !== 'paid') throw invalid();
    if (Date.now() / 1000 - session.created > CHECKOUT_TTL) throw new HttpError(410, 'Odkaz po platbe už vypršal.');
    const resolved = resolveStep(req.merchant, md.funnel_step, md.variant);
    if (!resolved) throw invalid();
    const target = md.direct === '1'
      ? directStep(req.merchant, resolved.step, req.mode)
      : resolved.step.kind === 'entry' && { ...resolved.step, product: resolved.product };
    if (!target) throw invalid();

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
    const piRef = session.mode === 'subscription'
      ? session.invoice?.payments?.data[0]?.payment?.payment_intent
      : session.payment_intent;
    if (!piRef) throw invalid();
    const pi = typeof piRef === 'string' ? await req.stripe.paymentIntents.retrieve(piRef, req.acct) : piRef;
    const customer = await req.stripe.customers.retrieve(customerId, req.acct);

    // Voľné polia zo stránky Stripe => metadáta platby pod názvom poľa (ako pri formulári)
    const labels = {};
    for (const f of session.custom_fields || []) {
      const field = (target.fields || []).find((x) => x.id === f.key);
      const value = f.text && f.text.value;
      if (field && value) labels[field.label] = value;
    }
    if (customer.metadata[paidKey(target.id)] !== pi.id) {
      if (Object.keys(labels).length) await req.stripe.paymentIntents.update(pi.id, { metadata: labels }, req.acct);
      const shipping = shippingOf((session.collected_information && session.collected_information.shipping_details) || session.shipping_details);
      const quantity = (session.line_items && session.line_items.data[0] && session.line_items.data[0].quantity) || 1;
      const paid = { ...pi, amount: session.amount_total ?? pi.amount, metadata: { ...pi.metadata, ...labels, quantity: String(quantity) } };
      const paymentMethod = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method.id;
      await purchased(Object.assign(Object.create(req), { step: target }), paid, customerId, {
        invoice_settings: { default_payment_method: paymentMethod },
        ...(shipping && { shipping }),
      });
    }
    return { session, target, customer, pi };
  }

  // Návrat zo Stripe: nákup sa zapíše hneď (aj keď na „URL po prijatí“ nie je snippet) a zákazník ide ďalej
  router.get('/:step/return', viewLimit, async (req, res) => {
    const { session } = await checkoutPurchase(req, String(req.query.nw_session || ''));
    const next = new URL(session.metadata.return_to);
    if (!/^https?:$/.test(next.protocol)) throw new HttpError(400, 'Neplatná „URL po prijatí“.');
    next.searchParams.set('nw_session', session.id);
    if (req.mode === 'test') next.searchParams.set('neoworkly_test', req.query.neoworkly_test);
    res.redirect(303, next.href);
  });

  // Snippet ponuky na „URL po prijatí“ vymení zaplatenú stránku za token pre ďalšie kroky – iba raz
  router.post('/:step/session', viewLimit, async (req, res) => {
    const { session, target, customer, pi } = await checkoutPurchase(req, String(req.body.sessionId || ''));
    if (customer.metadata.nw_exchanged === session.id) {
      throw new HttpError(409, 'Táto platba už bola použitá. Pokračuj v pôvodnom okne.');
    }
    await req.stripe.customers.update(customer.id, { metadata: { nw_exchanged: session.id } }, req.acct);
    res.json({
      token: signToken({ m: req.merchant.id, c: customer.id, step: target.id, pi: pi.id, mode: req.mode, v: target.variant }),
    });
  });

  // Dokončenie po 3D Secure – server si stav platby overí priamo v Stripe
  router.post('/:step/confirm', async (req, res) => {
    const token = requireToken(req);
    const pi = await req.stripe.paymentIntents.retrieve(String(req.body.paymentIntentId || ''), req.acct);
    if (pi.customer !== token.c || pi.metadata.funnel_step !== req.step.id || (pi.metadata.variant || 'a') !== req.step.variant) {
      throw new HttpError(403, 'Neplatná platba.');
    }
    if (pi.status !== 'succeeded') throw new HttpError(402, 'Platba nebola dokončená.');
    await purchased(req, pi, token.c);
    res.json(nextStep(req));
  });

  // "Nechcem pridať" – bez platby, iba ďalší krok
  router.post('/:step/decline', async (req, res) => {
    if (!req.step.onDecline) throw new HttpError(400, 'Tento krok nemožno odmietnuť.');
    await record({ merchantId: req.merchant.id, stepId: req.step.id, type: 'decline', variant: req.step.variant, mode: req.mode });
    res.json({ next: req.step.onDecline });
  });

  router.use((err, req, res, next) => {
    // Odkaz na platobnú stránku Stripe otvoril zákazník v prehliadači => chyba ako stránka, nie JSON
    if (req.method === 'GET' && err.paused && err.pausedUrl) return res.redirect(302, err.pausedUrl); // náhradná stránka
    if (req.method === 'GET' && (err instanceof HttpError || (err.type && err.type.startsWith('Stripe')))) {
      if (!(err instanceof HttpError)) console.error(`Stripe chyba vo funneli (${req.originalUrl}):`, err.message);
      const message = err instanceof HttpError ? err.message : 'Platobnú stránku sa nepodarilo otvoriť. Skús to prosím o chvíľu.';
      return res.status(err instanceof HttpError ? err.status : 424).type('html').send(errorPage(message));
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.paused && { paused: true, hide: err.hide }) });
    }
    // Chyba zo Stripe (napr. chýbajúce oprávnenie kľúča obchodníka) => skutočný dôvod namiesto všeobecnej chyby.
    // 424, nie 502: Cloudflare odpoveď 502/504 nahradí vlastnou stránkou.
    if (err.type && err.type.startsWith('Stripe')) {
      console.error(`Stripe chyba vo funneli ${req.merchant ? req.merchant.id : ''} (${req.method} ${req.originalUrl}):`, err.message);
      return res.status(424).json({ error: `Platbu sa nepodarilo pripraviť (Stripe: ${err.message})` });
    }
    next(err);
  });

  return router;
};
