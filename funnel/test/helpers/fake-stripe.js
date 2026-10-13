// Falošný Stripe klient pre testy. Zaznamenáva každé volanie (aj stripeAccount a idempotency kľúč)
// a vracia predvídateľné objekty. Webhooky overuje skutočná knižnica Stripe.
const Stripe = require('stripe');

class FakeStripe {
  constructor() {
    this.calls = [];
    this.customers_ = {}; // id -> { id, email, metadata, invoice_settings }
    this.paymentIntents_ = {}; // id -> PaymentIntent
    this.subscriptionStatus = {}; // platform customer id -> status predplatného Neoworkly
    this.accounts_ = {}; // acct id -> { charges_enabled }
    this.priceAmounts = {}; // price id -> unit_amount (suma prvej faktúry predplatného)
    this.promotionCodes_ = {}; // code -> { id, code, active, percent_off } (zľavové kódy)
    this.nextPaymentStatus = 'succeeded'; // výsledok platby uloženou kartou: succeeded | requires_action | declined
    this.webhooks = new Stripe('sk_test_fake').webhooks;

    // ID jedinečné aj medzi inštanciami (ostrý a testovací Stripe zdieľajú v testoch jednu databázu)
    const tag = Math.random().toString(36).slice(2, 6);
    let counter = 0;
    const newId = (prefix) => `${prefix}_${tag}${++counter}`;
    // Ako skutočná knižnica: voľby musia obsahovať aspoň jeden známy kľúč (aj s hodnotou undefined),
    // inak ich stripe-node odmietne – napr. prázdny objekt {} => „Unknown arguments“
    const OPTION_KEYS = ['apiKey', 'idempotencyKey', 'stripeAccount', 'apiVersion', 'maxNetworkRetries', 'timeout'];
    const record = (name, params, opts) => {
      if (opts !== undefined && !OPTION_KEYS.some((k) => Object.prototype.hasOwnProperty.call(opts, k))) {
        throw Object.assign(new Error('Stripe: Unknown arguments ([object Object]). Did you mean to pass an options object?'), { type: undefined });
      }
      const o = opts || {};
      this.calls.push({ name, params, account: o.stripeAccount || null, idempotencyKey: o.idempotencyKey || null });
    };

    const createPi = (params, opts = {}) => {
      const id = newId('pi');
      const pi = {
        id,
        client_secret: `${id}_secret_test`,
        customer: params.customer,
        amount: params.amount,
        payment_method: params.payment_method || null,
        metadata: params.metadata || {},
        status: 'requires_payment_method',
        account: opts.stripeAccount || null,
      };
      if (params.confirm) {
        if (this.nextPaymentStatus === 'declined') {
          throw Object.assign(new Error('Karta bola zamietnutá.'), { type: 'StripeCardError' });
        }
        pi.status = this.nextPaymentStatus;
      }
      this.paymentIntents_[id] = pi;
      return pi;
    };

    this.customers = {
      create: async (params, opts) => {
        record('customers.create', params, opts);
        const id = newId('cus');
        this.customers_[id] = { id, email: params.email, shipping: params.shipping || null, metadata: {}, invoice_settings: {} };
        return this.customers_[id];
      },
      retrieve: async (id, opts) => {
        record('customers.retrieve', { id }, opts);
        return this.customers_[id];
      },
      update: async (id, params, opts) => {
        record('customers.update', { id, ...params }, opts);
        const c = this.customers_[id];
        Object.assign(c.metadata, params.metadata);
        Object.assign(c.invoice_settings, params.invoice_settings);
        if (params.email) c.email = params.email;
        if (params.name) c.name = params.name;
        if (params.address) c.address = params.address;
        if (params.shipping) c.shipping = params.shipping;
        return c;
      },
      listTaxIds: async (id) => ({ data: this.customers_[id].taxIds || [] }),
      createTaxId: async (id, params) => {
        record('customers.createTaxId', { id, ...params });
        // Skutočný Stripe odmietne IČ DPH v zlom formáte (tu: kratšie než 10 znakov)
        if (params.value.length < 10) {
          throw Object.assign(new Error('Invalid value for eu_vat.'), { type: 'StripeInvalidRequestError' });
        }
        const taxId = { id: newId('txi'), type: params.type, value: params.value };
        (this.customers_[id].taxIds ||= []).push(taxId);
        return taxId;
      },
      deleteTaxId: async (id, taxId) => {
        record('customers.deleteTaxId', { id, taxId });
        this.customers_[id].taxIds = this.customers_[id].taxIds.filter((t) => t.id !== taxId);
      },
    };

    this.subscriptions = {
      list: async (params) => {
        const status = this.subscriptionStatus[params.customer];
        return { data: status ? [{ id: `sub_of_${params.customer}`, status }] : [] };
      },
      cancel: async (id) => {
        record('subscriptions.cancel', { id });
        this.subscriptionStatus[id.replace('sub_of_', '')] = 'canceled';
        return { id, status: 'canceled' };
      },
      create: async (params, opts) => {
        record('subscriptions.create', params, opts);
        // Prvá faktúra: pri default_incomplete čaká na potvrdenie, inak sa hneď strhne uloženou kartou
        const [item] = params.items;
        let amount = (this.priceAmounts[item.price] || 0) * (item.quantity || 1);
        const promo = params.discounts && Object.values(this.promotionCodes_).find((p) => p.id === params.discounts[0].promotion_code);
        if (promo) {
          if (promo.firstTimeOnly) {
            throw Object.assign(new Error('This promotion code cannot be redeemed because the associated customer has prior transactions.'), { type: 'StripeInvalidRequestError' });
          }
          amount = Math.round(amount * (1 - promo.percent_off / 100));
          if (promo.percent_off === 100) {
            // Nič na zaplatenie: Stripe predplatné hneď aktivuje a faktúra nemá čo potvrdzovať
            this.subscriptionStatus[params.customer] = 'active';
            return { id: newId('sub'), status: 'active', latest_invoice: { confirmation_secret: null, amount_due: 0, currency: 'eur' } };
          }
        }
        const pi = createPi(
          { customer: params.customer, amount, payment_method: params.default_payment_method, confirm: !params.payment_behavior },
          opts,
        );
        return {
          id: newId('sub'),
          latest_invoice: {
            amount_due: amount,
            currency: 'eur',
            confirmation_secret: { client_secret: pi.client_secret },
            payments: { data: [{ payment: { type: 'payment_intent', payment_intent: pi.id } }] },
          },
        };
      },
    };

    this.promotionCodes = {
      list: async (params) => {
        record('promotionCodes.list', params);
        const promo = this.promotionCodes_[String(params.code).toUpperCase()];
        return { data: promo && (!params.active || promo.active) ? [promo] : [] };
      },
    };
    // Pomocník pre testy: zľavový kód ako v Stripe (Coupon + Promotion code)
    this.addPromotionCode = (code, percentOff, extra = {}) => {
      this.promotionCodes_[code.toUpperCase()] = { id: newId('promo'), code, active: true, percent_off: percentOff, ...extra };
    };

    this.paymentIntents = {
      create: async (params, opts) => {
        record('paymentIntents.create', params, opts);
        return createPi(params, opts);
      },
      retrieve: async (id, opts) => {
        record('paymentIntents.retrieve', { id }, opts);
        return this.paymentIntents_[id];
      },
      update: async (id, params, opts) => {
        record('paymentIntents.update', { id, ...params }, opts);
        Object.assign(this.paymentIntents_[id].metadata, params.metadata);
        return this.paymentIntents_[id];
      },
    };

    this.prices = {
      create: async (params, opts) => {
        record('prices.create', params, opts);
        const id = newId('price');
        this.priceAmounts[id] = params.unit_amount;
        return { id, product: params.product || newId('prod') };
      },
      update: async (id, params, opts) => record('prices.update', { id, ...params }, opts),
      retrieve: async (id, params, opts) => {
        if (this.catalog_[id]) return this.catalog_[id];
        if (id.startsWith('price_neexistuje')) throw Object.assign(new Error(`No such price: '${id}'`), { type: 'StripeInvalidRequestError' });
        return { id, unit_amount: 400, recurring: { interval: 'month', interval_count: 1 } };
      },
      list: async (params, opts) => {
        record('prices.list', params, opts);
        return { data: Object.values(this.catalog_).filter((p) => !params.active || p.active) };
      },
    };
    // Existujúce ceny v Stripe účte obchodníka (import produktov); product je rozbalený (expand)
    this.catalog_ = {};
    this.addCatalogPrice = (name, unitAmount, extra = {}) => {
      const price = {
        id: newId('price'),
        active: true,
        currency: 'eur',
        unit_amount: unitAmount,
        billing_scheme: 'per_unit',
        recurring: null,
        product: { id: newId('prod'), name, active: true },
        ...extra,
      };
      this.catalog_[price.id] = price;
      return price;
    };

    this.products = {
      update: async (id, params, opts) => record('products.update', { id, ...params }, opts),
    };

    this.accounts = {
      create: async (params) => {
        record('accounts.create', params);
        const id = newId('acct');
        this.accounts_[id] = { charges_enabled: false };
        return { id };
      },
      retrieve: async (id) => ({ id, ...this.accounts_[id] }),
    };

    // Stripe Checkout: zaplatenie stránky simuluje completeCheckout(id)
    this.checkoutSessions_ = {};
    this.checkout = {
      sessions: {
        create: async (params, opts) => {
          record('checkout.sessions.create', params, opts);
          const id = `cs_test_${tag}${++counter}`;
          this.checkoutSessions_[id] = {
            id, object: 'checkout.session', mode: params.mode, metadata: params.metadata || {}, status: 'open',
            payment_status: 'unpaid', created: Math.floor(Date.now() / 1000), customer: null, payment_intent: null,
            invoice: null, amount_total: null, custom_fields: [], collected_information: null, params,
            url: `https://checkout.stripe.test/c/pay/${id}`, account: (opts && opts.stripeAccount) || null,
          };
          return this.checkoutSessions_[id];
        },
        retrieve: async (id, params, opts) => {
          record('checkout.sessions.retrieve', { id, ...params }, opts);
          const session = this.checkoutSessions_[id];
          if (!session || session.account !== ((opts && opts.stripeAccount) || null)) {
            throw Object.assign(new Error(`No such checkout.session: '${id}'`), { type: 'StripeInvalidRequestError' });
          }
          return session;
        },
      },
    };
    // Zákazník zaplatí na stránke Stripe: vznikne zákazník, platba s uloženou kartou, polia a adresa
    this.completeCheckout = (id, { quantity = 1, fields = {}, shipping = null } = {}) => {
      const session = this.checkoutSessions_[id];
      const customer = newId('cus');
      this.customers_[customer] = { id: customer, email: 'checkout@example.sk', shipping: null, metadata: {}, invoice_settings: {} };
      const item = session.params.line_items[0];
      const unit = item.price_data ? item.price_data.unit_amount : this.priceAmounts[item.price] || 0;
      const meta = (session.params.payment_intent_data || session.params.subscription_data || {}).metadata || {};
      const pi = createPi({ customer, amount: unit * quantity, metadata: { ...meta } }, { stripeAccount: session.account });
      Object.assign(pi, { status: 'succeeded', payment_method: 'pm_card_visa' });
      Object.assign(session, {
        status: 'complete', payment_status: 'paid', customer, amount_total: unit * quantity,
        payment_intent: session.mode === 'payment' ? pi : null,
        invoice: session.mode === 'subscription' ? { payments: { data: [{ payment: { payment_intent: pi.id } }] } } : null,
        custom_fields: Object.entries(fields).map(([key, value]) => ({ key, text: { value } })),
        collected_information: shipping ? { shipping_details: shipping } : null,
        line_items: { data: [{ quantity }] },
      });
      return { customer, pi: pi.id };
    };

    // Domény pre Apple Pay a Google Pay
    this.paymentMethodDomains_ = [];
    const domainObject = (domain_name, account) => ({
      id: newId('pmd'), domain_name, enabled: true, account,
      apple_pay: { status: 'active' }, google_pay: { status: 'active' }, link: { status: 'active' },
    });
    this.paymentMethodDomains = {
      create: async (params, opts) => {
        record('paymentMethodDomains.create', params, opts);
        const d = domainObject(params.domain_name, (opts && opts.stripeAccount) || null);
        this.paymentMethodDomains_.push(d);
        return d;
      },
      list: async (params, opts) => {
        record('paymentMethodDomains.list', params, opts);
        const account = (opts && opts.stripeAccount) || null;
        return { data: this.paymentMethodDomains_.filter((d) => d.account === account && (!params.domain_name || d.domain_name === params.domain_name)) };
      },
      validate: async (id, params, opts) => {
        record('paymentMethodDomains.validate', { id }, opts);
        return this.paymentMethodDomains_.find((d) => d.id === id);
      },
    };

    // Vrátenie platby (rezervácie a digitálne produkty)
    this.refunds = {
      create: async (params, opts) => {
        record('refunds.create', params, opts);
        return { id: newId('re'), object: 'refund', ...params };
      },
    };
    // Webhook pre platby rezervácií a produktov (vlastné kľúče obchodníka)
    this.webhookEndpoints_ = {};
    this.webhookEndpoints = {
      create: async (params) => {
        this.calls.push({ name: 'webhookEndpoints.create', params, account: null });
        const id = `we_${Object.keys(this.webhookEndpoints_).length + 1}`;
        this.webhookEndpoints_[id] = params;
        return { id, secret: `whsec_${id}` };
      },
      del: async (id) => {
        this.calls.push({ name: 'webhookEndpoints.del', params: { id }, account: null });
        delete this.webhookEndpoints_[id];
        return { id, deleted: true };
      },
    };
    this.accountLinks = {
      create: async (params) => {
        record('accountLinks.create', params);
        return { url: `https://connect.stripe.test/setup/${params.account}` };
      },
    };

    this.billingPortal = {
      sessions: {
        create: async (params, opts) => {
          record('billingPortal.sessions.create', params, opts);
          return { url: 'https://billing.stripe.test/session' };
        },
      },
    };
  }

  // Simulácia úspešného potvrdenia platby v prehliadači (Payment Element)
  completePayment(piId) {
    Object.assign(this.paymentIntents_[piId], { status: 'succeeded', payment_method: 'pm_card_visa' });
  }

  callsTo(name) {
    return this.calls.filter((c) => c.name === name);
  }

  lastCall(name) {
    return this.callsTo(name).at(-1);
  }
}

module.exports = FakeStripe;
