'use strict';
// Dynamický fallback na NAJNOVŠÍ dostupný Claude model v ROVNAKEJ cenovej
// triede ako ten, čo zlyhal (haiku→haiku, sonnet→sonnet) — nikdy rovno na
// najdrahší dostupný model len preto, že bol vydaný najnovšie. Na inú
// triedu padne len ako posledný záchranný bod, keď v tej istej triede už
// nie je žiadny ďalší neskúšaný model. Rovnaký princíp ako
// routes/lib/resolveModel.js v hlavnej appke (sciovsp) — tu prerobené na
// oficiálne Anthropic SDK namiesto raw fetch, keďže chatbot ho už používa.
//
// _lastGoodClaudeModel sa pamätá PER BASELINE (nie globálne) — tento modul
// obsluhuje aj Sonnet-triedu (chat, zhrnutia) aj Haiku-triedu (trend
// analýza, GDPR text) call-sites, takže úspešný fallback v jednej triede
// nesmie "nakaziť" štartovací model druhej triedy.
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_LIST_CACHE_TTL_MS = 60 * 60 * 1000;
let _modelListCache = null;
const _lastGoodByBaseline = new Map();

function pickStartingModel(baseline) { return _lastGoodByBaseline.get(baseline) || baseline; }
function markModelGood(baseline, model) { _lastGoodByBaseline.set(baseline, model); }

function tierOf(modelId) {
  const id = (modelId || '').toLowerCase();
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('opus')) return 'opus';
  if (id.includes('fable') || id.includes('mythos')) return 'premium';
  return null;
}

async function fetchAnthropicModelList() {
  const models = [];
  for await (const m of client.models.list()) models.push(m);
  return models;
}

async function getNewestUntriedModel(triedIds, preferTier) {
  try {
    if (!_modelListCache || Date.now() - _modelListCache.fetchedAt > MODEL_LIST_CACHE_TTL_MS) {
      const models = await fetchAnthropicModelList();
      models.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      _modelListCache = { models, fetchedAt: Date.now() };
    }
    if (preferTier) {
      const sameTier = _modelListCache.models.find(m => m && m.id && !triedIds.includes(m.id) && tierOf(m.id) === preferTier);
      if (sameTier) return sameTier.id;
    }
    const found = _modelListCache.models.find(m => m && m.id && !triedIds.includes(m.id));
    return found ? found.id : null;
  } catch (e) {
    console.error('⚠️ Nepodarilo sa zistiť aktuálny zoznam Claude modelov:', e.message);
    return null;
  }
}

// Skúša ďalší model len keď chyba vyzerá na problém so samotným modelom
// (404 / zmienka "model" v chybe) — inou chybou (napr. limit, obsahová
// politika) sa fallback nezaoberá, tá musí prebublať volajúcemu ako predtým.
function looksLikeModelIssue(err) {
  const status = err && (err.status || err.statusCode);
  const msg = ((err && err.message) || '').toLowerCase();
  return status === 404 || msg.includes('model');
}

// Generický wrapper pre NEstreamovacie volania: skúša baseline model, pri
// chybe s problémom modelu prejde na najnovší neskúšaný v rovnakej triede
// (najviac 4 pokusy spolu). Pre streamovací chat (kde sa časť odpovede už
// mohla poslať klientovi pred zlyhaním) má svoju vlastnú, opatrnejšiu
// slučku priamo v claude.js — tam sa retry robí LEN kým ešte nič neodišlo.
async function withModelFallback(baseline, callFn) {
  const triedModels = [];
  let model = pickStartingModel(baseline);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    triedModels.push(model);
    try {
      const result = await callFn(model);
      markModelGood(baseline, model);
      if (attempt > 0) console.error(`⚠️ Claude model fallback: úspešne použitý novší model '${model}'.`);
      return result;
    } catch (err) {
      lastErr = err;
      if (!looksLikeModelIssue(err)) throw err;
      const next = await getNewestUntriedModel(triedModels, tierOf(model));
      if (!next) throw err;
      console.error(`⚠️ Claude model '${model}' zlyhal (vyzerá na problém s modelom), skúšam novší dostupný '${next}'.`);
      model = next;
    }
  }
  throw lastErr;
}

module.exports = { tierOf, pickStartingModel, markModelGood, getNewestUntriedModel, looksLikeModelIssue, withModelFallback };
