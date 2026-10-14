// Neoworkly Funnel ako súčasť hlavnej aplikácie (sekcia Funnely). Predvolené premenné prostredia
// sa doplnia PRED načítaním modulov funnela (tie ich čítajú pri načítaní).
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || process.env.JWT_SECRET || 'changeme';
process.env.PUBLIC_URL = process.env.PUBLIC_URL || process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3000';

const Stripe = require('stripe18');
const { STRIPE_API_VERSION } = require('./src/merchants');
const createFunnelApp = require('./src/app');

// Platforma Stripe Connect (pripojené účty klientov). Ak funnel bežal na inom Stripe účte ako
// predplatné Neoworkly, nastav STRIPE_CONNECT_SECRET_KEY na jeho kľúč.
const platformKey = () => process.env.STRIPE_CONNECT_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
let platform = null;
const stripePlatform = () => (platform ||= new Stripe(platformKey(), { apiVersion: STRIPE_API_VERSION }));

// Klient vznikne až pri prvej požiadavke (server sa spustí aj bez kľúča Stripe, napr. pri vývoji)
const lazyPlatform = new Proxy({}, { get: (_, prop) => stripePlatform()[prop] });

function createApp({ stripe, stripeTest } = {}) {
  const testKey = process.env.STRIPE_TEST_SECRET_KEY;
  return createFunnelApp(
    stripe || lazyPlatform,
    stripeTest !== undefined ? stripeTest : testKey ? new Stripe(testKey, { apiVersion: STRIPE_API_VERSION }) : null,
  );
}

// Iba pre testy: falošný Stripe namiesto klienta platformy
const useStripe = (client) => { platform = client; };

module.exports = { createApp, stripePlatform, useStripe };
