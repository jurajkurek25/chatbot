// Generovanie inline snippetov zo šablón v embed/ ({{PREMENNÁ}} => hodnota, HTML-escaped).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { currencyOf, formatMoney } = require('./currency');
const { resolveStep } = require('./abtest');
const DIR = path.join(__dirname, '..', 'embed');
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

function render(file, vars) {
  const tpl = fs.readFileSync(path.join(DIR, file), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => esc(vars[key] ?? ''));
}

const INTERVALS = { month: 'mesačne', year: 'ročne' };

function priceLabel(product) {
  const price = formatMoney(product.amount, currencyOf(product));
  return product.type === 'recurring' ? `${price} ${INTERVALS[product.interval]}` : price;
}

// --- Vzhľad a texty (snippet si ich načíta z API pri každom zobrazení) --------------
// pausedText / pausedUrl: čo vidí zákazník, keď predaj nebeží (napr. po skončení predplatného)
const DEFAULT_APPEARANCE = { color: '#635bff', termsUrl: '', privacyUrl: '', customCss: '', pausedText: '', pausedUrl: '' };
const MAX_CUSTOM_CSS = 20000;
const DEFAULT_TEXTS = { buttonText: 'Pokračovať', yesText: 'Chcem pridať', noText: 'Nechcem pridať', leadButtonText: 'Chcem to zadarmo' };
const DEFAULT_MARKETING_TEXT = 'Chcem dostávať novinky a tipy e-mailom (odhlásiť sa dá kedykoľvek).';

// Farba textu na tlačidle: biela alebo čierna podľa toho, čo má väčší kontrast (WCAG)
function textColorFor(hex) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.05) ? '#ffffff' : '#111111';
}

// Nastavenia snippetu pre daný variant A/B testu (variant B môže mať iný produkt aj texty)
function stepConfig(merchant, stepId, variant = 'a') {
  const { step, product } = resolveStep(merchant, stepId, variant);
  const appearance = { ...DEFAULT_APPEARANCE, ...merchant.funnel.appearance };
  const defaultTitle = step.kind === 'entry' ? `${product.name} – ${priceLabel(product)} / ks` : '';
  const lead = step.kind === 'lead';
  return {
    kind: step.kind,
    title: step.title || defaultTitle,
    price: product ? priceLabel(product) : '',
    buttonText: step.buttonText || (lead ? DEFAULT_TEXTS.leadButtonText : DEFAULT_TEXTS.buttonText),
    ...(lead && {
      askName: Boolean(step.askName),
      marketing: Boolean(step.marketing),
      marketingText: step.marketingText || DEFAULT_MARKETING_TEXT,
    }),
    yesText: step.yesText || DEFAULT_TEXTS.yesText,
    noText: step.noText || DEFAULT_TEXTS.noText,
    maxQuantity: step.maxQuantity || 1,
    color: appearance.color,
    textColor: textColorFor(appearance.color),
    termsUrl: appearance.termsUrl,
    privacyUrl: appearance.privacyUrl,
    customCss: appearance.customCss,
    variant: step.variant,
    fields: (step.fields || []).map(({ id, label, type, required, maxLength }) => ({ id, label, type, required, maxLength })),
    shipping: step.kind === 'entry' && Boolean(step.shipping),
  };
}

// Hodnoty vkladané do JS reťazcov obsahujú iba [A-Za-z0-9_:/.-] (ID, URL bez úvodzoviek).
function stepSnippet(merchant, stepId) {
  const step = merchant.funnel.steps[stepId];
  const product = merchant.funnel.products[step.productId];
  if (step.kind === 'lead') return render('lead.html', { STEP: stepId, NW_API: process.env.PUBLIC_URL, NW_MERCHANT: merchant.id });
  // Stripe kľúč a účet si snippet stiahne z API (/view) => funguje aj testovací režim
  // a po novom prepojení Stripe účtu netreba snippety vkladať znova
  const vars = { STEP: stepId, NW_API: process.env.PUBLIC_URL, NW_MERCHANT: merchant.id };
  if (step.kind === 'entry') {
    return render('entry.html', {
      ...vars,
      TITLE: `${product.name} – ${priceLabel(product)} / ks`,
      MAX: step.maxQuantity || 1,
    });
  }
  return render('offer.html', vars);
}

// Content Security Policy pre web obchodníka: zdroje pre Stripe.js (podľa docs.stripe.com/security/guide,
// vrátane Link a 3D Secure), API Neoworkly a SHA-256 inline <script>/<style> presne tohto snippetu.
// Vlastné CSS sa vkladá cez CSSOM (adoptedStyleSheets), takže 'unsafe-inline' netreba.
const sha256 = (text) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

function snippetCsp(html) {
  const inline = (tag) => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => sha256(m[1]));
  return [
    `script-src https://js.stripe.com https://*.js.stripe.com ${inline('script').join(' ')}`,
    `style-src ${inline('style').join(' ')}`,
    `connect-src ${new URL(process.env.PUBLIC_URL).origin} https://api.stripe.com https://link.com https://*.link.com`,
    'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://link.com https://*.link.com',
    'img-src https://*.link.com',
  ];
}

module.exports = { esc, snippetCsp, stepSnippet, stepConfig, priceLabel, textColorFor, DEFAULT_APPEARANCE, DEFAULT_TEXTS, DEFAULT_MARKETING_TEXT, MAX_CUSTOM_CSS };
