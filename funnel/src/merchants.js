// Funnel účty klientov Neoworkly: kto smie predávať (prístup k Neoworkly alebo staré predplatné
// Funnel 4 €) a stav pripojeného Stripe účtu.
const Stripe = require('stripe18');
const { updateMerchant, getMerchant, changeSubscriptionStatus } = require('./db');
const { ownerAccess } = require('../../middleware/subscription');
const mailer = require('./mailer');
const totp = require('./totp');

// Pevná verzia Stripe API (platí pre klienta platformy aj pre kľúče obchodníkov)
const STRIPE_API_VERSION = '2025-08-27.basil';

// Staré samostatné predplatné Funnel 4 € (klienti z funnel.neoworkly.com). past_due = Stripe ešte
// skúša strhnúť platbu; funnely dovtedy nevypíname.
const legacyActive = (merchant) => ['active', 'past_due'].includes(merchant.subscription_status);
// Funnely sú v cene Neoworkly (aj v skúšobnom období); klientom so starým predplatným 4 € fungujú ďalej
const isActive = (merchant) =>
  legacyActive(merchant) || Boolean(merchant.neoworkly_user_id && ownerAccess(merchant.neoworkly_user_id).hasAccess);
const canSell = (merchant) => isActive(merchant) && merchant.charges_enabled && !merchant.blocked;

// Stav predplatného Neoworkly načítaný zo Stripe (zdroj pravdy) a uložený do DB
async function refreshSubscription(stripe, merchant) {
  if (!merchant.platform_customer_id || !process.env.FUNNEL_SUBSCRIPTION_PRICE_ID) return merchant;
  const { data } = await stripe.subscriptions.list({
    customer: merchant.platform_customer_id,
    price: process.env.FUNNEL_SUBSCRIPTION_PRICE_ID,
    status: 'all',
    limit: 10,
  });
  const live = data.find((s) => ['active', 'past_due'].includes(s.status));
  const status = (live || data[0] || { status: 'none' }).status;
  // Zmena stavu iba z aktuálnej hodnoty v DB (aj keď ju súbežne mení webhook) => e-mail odíde raz
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getMerchant(merchant.id);
    if (!current || current.subscription_status === status) break;
    if (await changeSubscriptionStatus(merchant.id, current.subscription_status, status)) {
      await subscriptionChanged(current, current.subscription_status, status).catch((err) =>
        console.error('[predplatné] e-mail sa neodoslal:', err.message));
      break;
    }
  }
  return getMerchant(merchant.id);
}

// E-mail obchodníkovi pri zmene stavu predplatného, ktorá ovplyvní predaj jeho funnelov
const ENDED = ['canceled', 'unpaid', 'incomplete_expired', 'paused'];
async function subscriptionChanged(merchant, from, to) {
  const link = new URL('/dashboard', process.env.APP_URL || process.env.PUBLIC_URL).href;
  let mail;
  if (from === 'active' && to === 'past_due') {
    mail = {
      subject: 'Platba za predplatné zlyhala – Neoworkly Funnel',
      text: `Ahoj,\n\nplatbu za predplatné Neoworkly Funnel sa nepodarilo strhnúť. Stripe ju ešte niekoľkokrát skúsi a tvoje funnely zatiaľ predávajú.\n\nAby sa predaj nezastavil, skontroluj alebo zmeň kartu v dashboarde (Predplatné → Spravovať predplatné):\n${link}`,
    };
  } else if (legacyActive({ subscription_status: from }) && !legacyActive({ subscription_status: to })
    && !isActive({ ...merchant, subscription_status: to })) {
    mail = {
      subject: 'Tvoje funnely nepredávajú – predplatné skončilo – Neoworkly Funnel',
      text: `Ahoj,\n\ntvoje predplatné Neoworkly Funnel skončilo, preto funnely na tvojom webe momentálne neprijímajú platby. Zákazníci namiesto formulára neuvidia chybu – podľa nastavenia vo Vzhľade sa snippet skryje alebo ukáže tvoj text.\n\nProdukty, kroky, vzhľad aj štatistiky ostávajú. Peniaze a predplatné tvojich zákazníkov sú naďalej v tvojom Stripe.\n\nPredaj obnovíš aktiváciou predplatného v dashboarde – snippety na webe netreba meniť:\n${link}`,
    };
  } else if (ENDED.includes(from) && legacyActive({ subscription_status: to })) {
    mail = {
      subject: 'Tvoje funnely znova predávajú – Neoworkly Funnel',
      text: `Ahoj,\n\npredplatné Neoworkly Funnel je opäť aktívne a tvoje funnely znova prijímajú platby.\n\n${link}`,
    };
  }
  if (mail) await mailer.sendMail({ to: merchant.email, ...mail });
}

// Prepojenie vlastnými API kľúčmi (alternatíva k Connect): Stripe klient s tajným kľúčom
// obchodníka. Testy ho nahrádzajú falošným.
const keyClients = new Map();
const merchantKeys = {
  client(secretKey) {
    if (!keyClients.has(secretKey)) keyClients.set(secretKey, new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION }));
    return keyClients.get(secretKey);
  },
};

// Stripe klient a voľby pre ostrý účet obchodníka: Connect => klient platformy + stripeAccount,
// vlastné kľúče => klient s kľúčom obchodníka (volania idú priamo na jeho účet)
function liveStripe(stripe, merchant) {
  // stripeAccount: undefined, nie prázdne {} – stripe-node prázdny objekt nepovažuje za voľby a volanie odmietne
  if (merchant.stripe_api_key) {
    return { stripe: merchantKeys.client(totp.decrypt(merchant.stripe_api_key)), opts: { stripeAccount: undefined } };
  }
  return { stripe, opts: { stripeAccount: merchant.stripe_account_id } };
}

async function refreshAccount(stripe, merchant) {
  if (!merchant.stripe_account_id) return merchant;
  const account = merchant.stripe_api_key
    ? await liveStripe(stripe, merchant).stripe.accounts.retrieve()
    : await stripe.accounts.retrieve(merchant.stripe_account_id);
  await updateMerchant(merchant.id, { charges_enabled: account.charges_enabled });
  return getMerchant(merchant.id);
}

module.exports = {
  legacyActive,
  isActive,
  canSell,
  refreshSubscription,
  refreshAccount,
  liveStripe,
  merchantKeys,
  STRIPE_API_VERSION,
};
