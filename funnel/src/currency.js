// Podporované meny produktov obchodníkov. Sumy sú vždy v najmenšej jednotke (centy, haliere…).
// Minimá podľa https://docs.stripe.com/currencies (minimálna suma platby v danej mene).
const CURRENCIES = {
  eur: { min: 50 },
  czk: { min: 1500 },
  pln: { min: 200 },
  huf: { min: 17500, wholeUnits: true }, // forint sa zobrazuje bez desatinných miest => iba celé sumy
  ron: { min: 200 },
  usd: { min: 50 },
  gbp: { min: 30 },
  chf: { min: 50 },
  sek: { min: 300 },
  dkk: { min: 250 },
  nok: { min: 300 },
};
const DEFAULT_CURRENCY = 'eur';

// Produkty z čias pred podporou mien nemajú menu => EUR
const currencyOf = (product) => product.currency || DEFAULT_CURRENCY;

// Formátovač sa vytvára raz na menu (vytvorenie Intl.NumberFormat je drahé a cena sa formátuje pri každom zobrazení)
const formatters = new Map();
function formatMoney(amount, currency = DEFAULT_CURRENCY) {
  if (!formatters.has(currency)) {
    formatters.set(currency, new Intl.NumberFormat('sk-SK', { style: 'currency', currency: currency.toUpperCase() }));
  }
  return formatters.get(currency).format(amount / 100);
}

// Vráti chybovú hlášku alebo null
function validateAmount(amount, currency) {
  const rules = CURRENCIES[currency];
  if (!rules) return 'Nepodporovaná mena.';
  if (!Number.isInteger(amount) || amount > 99999999) return 'Neplatná cena.';
  if (amount < rules.min) return `Cena musí byť aspoň ${formatMoney(rules.min, currency)}.`;
  if (rules.wholeUnits && amount % 100 !== 0) return 'Cena v tejto mene musí byť celé číslo.';
  return null;
}

module.exports = { CURRENCIES, DEFAULT_CURRENCY, currencyOf, formatMoney, validateAmount };
