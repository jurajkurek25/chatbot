// Express 5 podaplikácia funnela, pripojená do hlavného servera Neoworkly. Obsluhuje iba svoje cesty
// (ostatné požiadavky pustí ďalej) a telá parsuje iba na nich – hlavná aplikácia má vlastné parsovanie.
const path = require('path');
const express = require('express5');
const db = require('./db');
const { refreshSubscription } = require('./merchants');
const snippets = require('./snippets');
const createDashboard = require('./dashboard');
const createFunnel = require('./funnel');
const mailer = require('./mailer');

// Udalosti platieb (rezervácie, digitálne produkty) z pripojených účtov rieši hlavná aplikácia
const PAYMENT_EVENT = /^(checkout\.session\.|charge\.refunded$)/;

module.exports = function createFunnelApp(stripe, stripeTest = null) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  function webhook(secret, handle) {
    return [
      express.raw({ type: 'application/json' }),
      async (req, res) => {
        let event;
        try {
          event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret());
        } catch (err) {
          return res.status(400).send(`Webhook Error: ${err.message}`);
        }
        await handle(event);
        res.json({ received: true });
      },
    ];
  }

  // Staré predplatné Funnel 4 € (klienti z funnel.neoworkly.com) – zrušenie cez portál a pod.
  app.post(
    '/api/webhook',
    ...webhook(() => process.env.FUNNEL_STRIPE_WEBHOOK_SECRET, async (event) => {
      if (!event.type.startsWith('customer.subscription.')) return;
      const merchant = await db.getMerchantByPlatformCustomer(event.data.object.customer);
      if (merchant) await refreshSubscription(stripe, merchant);
    }),
  );

  // Udalosti z pripojených účtov klientov (Connect webhook endpoint, event.account = acct_...)
  app.post(
    '/api/webhook/connect',
    ...webhook(() => process.env.STRIPE_CONNECT_WEBHOOK_SECRET, async (event) => {
      if (!event.account) return;
      const merchant = await db.getMerchantByAccount(event.account);
      if (!merchant || merchant.stripe_api_key) return;
      if (PAYMENT_EVENT.test(event.type)) {
        if (merchant.neoworkly_user_id) await require('../../services/payments').handleEvent(event, merchant.neoworkly_user_id);
        return;
      }
      if (event.type === 'account.updated') {
        await db.updateMerchant(merchant.id, { charges_enabled: event.data.object.charges_enabled });
      }
      // Obchodník odpojil Neoworkly vo svojom Stripe => ID účtu už nepoužijeme, funnely prestanú predávať
      if (event.type === 'account.application.deauthorized') {
        await db.updateMerchant(merchant.id, { stripe_account_id: null, charges_enabled: false });
        await mailer.sendMail({
          to: merchant.email,
          subject: 'Stripe účet bol odpojený – Neoworkly',
          text: `Ahoj,\n\ntvoj Stripe účet bol odpojený od Neoworkly, preto tvoje funnely, rezervácie a produkty momentálne neprijímajú platby online.\nPrepoj ho znova v dashboarde (Platby): ${new URL('/dashboard', process.env.APP_URL || process.env.PUBLIC_URL).href}\n\nSnippety na webe netreba meniť – po prepojení začnú fungovať samy.`,
        });
      }
    }),
  );

  app.use(['/api/funnels', '/api/f'], express.json());
  app.use('/api/funnels', createDashboard(stripe, stripeTest));
  app.use('/api/f/:merchant', createFunnel(stripe, stripeTest));

  // Demo: snippet kroku ako samostatná stránka na doméne Neoworkly (na vyskúšanie funnela)
  app.get('/demo/thanks.html', (req, res) => res.sendFile(path.join(__dirname, '..', 'embed', 'thanks.html')));
  app.get('/demo/:merchant/:step', async (req, res) => {
    const merchant = await db.getMerchant(req.params.merchant);
    if (!merchant || !merchant.funnel.steps[req.params.step]) return res.status(404).send('Neznámy krok funnela.');
    res.send(snippets.stepSnippet(merchant, req.params.step));
  });

  // Staré záložky na dashboard funnela => sekcia Funnely v Neoworkly
  app.get(['/app', '/app/'], (req, res) => res.redirect(302, `/dashboard?view=funnels${req.query.stripe ? `&stripe=${encodeURIComponent(req.query.stripe)}` : ''}`));

  app.use((err, req, res, next) => {
    console.error('[funnel]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Nastala chyba, skús to znova.' });
  });

  return app;
};
