// A/B testy krokov funnela: výber variantu, efektívna podoba kroku a vyhodnotenie výsledkov.
//
// step.ab = { startedAt, split, b: { productId?, title?, buttonText?, yesText?, noText? } }
//   split = percento návštevníkov, ktorí uvidia variant B (1–99)
const crypto = require('crypto');

const VARIANT_FIELDS = ['productId', 'title', 'buttonText', 'yesText', 'noText'];
const MIN_VIEWS = 100; // menej zobrazení na variant => výsledok sa nevyhlasuje

// Variant, ktorý zákazník už má (z relácie), inak náhodne podľa rozdelenia
function pickVariant(step, requested) {
  if (!step.ab) return 'a';
  if (requested === 'a' || requested === 'b') return requested;
  return crypto.randomInt(100) < step.ab.split ? 'b' : 'a';
}

// Krok tak, ako ho vidí zákazník v danom variante (variant B prepíše vyplnené polia)
function resolveStep(merchant, stepId, variant = 'a') {
  const base = merchant.funnel.steps[stepId];
  if (!base) return null;
  const v = base.ab && variant === 'b' ? 'b' : 'a';
  const overrides = v === 'b' ? Object.fromEntries(VARIANT_FIELDS.filter((f) => base.ab.b[f]).map((f) => [f, base.ab.b[f]])) : {};
  const step = { ...base, ...overrides, id: stepId, variant: v };
  // Krok „Zadarmo za kontakt“ nemá produkt ani platbu
  if (step.kind === 'lead') return { step, product: null };
  const product = merchant.funnel.products[step.productId];
  return product ? { step, product } : null;
}

// Štandardné normálne rozdelenie (Abramowitz–Stegun 7.1.26, presnosť ~1e-7)
function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Dvojvýberový z-test rozdielu konverzií; vráti obojstrannú p-hodnotu alebo null
function pValue(a, b) {
  if (!a.views || !b.views) return null;
  const pooled = (a.purchases + b.purchases) / (a.views + b.views);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.views + 1 / b.views));
  if (!se) return null;
  const z = (b.purchases / b.views - a.purchases / a.views) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// Vyhodnotenie: not_enough_data | no_difference_yet | b_better | a_better
function evaluate(a, b) {
  const p = pValue(a, b);
  if (a.views < MIN_VIEWS || b.views < MIN_VIEWS || p === null) return { pValue: p, verdict: 'not_enough_data' };
  if (p >= 0.05) return { pValue: p, verdict: 'no_difference_yet' };
  return { pValue: p, verdict: b.purchases / b.views > a.purchases / a.views ? 'b_better' : 'a_better' };
}

module.exports = { VARIANT_FIELDS, MIN_VIEWS, pickVariant, resolveStep, normalCdf, pValue, evaluate };
