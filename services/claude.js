'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { logTrainingSample } = require('./training-logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TYPE_LABELS = {
  digital: 'Digitálny produkt', physical: 'Fyzický produkt', service: 'Služba',
  consultation: 'Konzultácia', course: 'Kurz', ticket: 'Vstupenka', lead_magnet: 'Lead magnet',
};

function buildProductsSection(products) {
  const active = products.filter(p => p.active);
  if (!active.length) return '';

  // Sort by priority desc
  active.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  let section = '\n\n## KATALÓG PRODUKTOV & SLUŽIEB\n';
  section += '\n**Pravidlá odporúčania produktov:**\n';
  section += '- Odporúčaj max 1–3 produkty naraz — nikdy nedávaj zákazníkovi celý zoznam\n';
  section += '- Vždy vysvetli PREČO je produkt vhodný pre tohto konkrétneho zákazníka\n';
  section += '- Použi polia "Odporúčaj keď" a "NEodporúčaj keď" na presné matchovanie\n';
  section += '- Pri odporúčaní vždy uveď cenu a CTA text s linkom (ak existuje)\n';
  section += '- Ak zákazník nespĺňa podmienky produktu, neodporúčaj ho — ponúkni vhodnejší\n\n';

  active.forEach((p, i) => {
    section += `### Produkt ${i + 1}: ${p.name}\n`;
    section += `Typ: ${TYPE_LABELS[p.type] || p.type}\n`;
    if (p.description) section += `Popis: ${p.description}\n`;
    if (p.for_whom) section += `Pre koho: ${p.for_whom}\n`;
    if (p.benefits) section += `Hlavné benefity: ${p.benefits}\n`;
    if (p.price != null) section += `Cena: ${p.price} ${p.currency || 'EUR'}\n`;
    if (p.recommend_when) section += `✅ Odporúčaj keď: ${p.recommend_when}\n`;
    if (p.not_recommend_when) section += `❌ NEodporúčaj keď: ${p.not_recommend_when}\n`;
    if (p.cta_text) section += `CTA: ${p.cta_text}`;
    if (p.stripe_link) section += ` → ${p.stripe_link}`;
    else if (p.landing_url) section += ` → ${p.landing_url}`;
    section += '\n';
    if (p.faq) section += `FAQ: ${p.faq}\n`;
    section += '\n';
  });

  return section;
}

/* ── System prompt builder ─────────────────────────────────────── */
function buildSystemPrompt(widget, knowledgeItems, products = [], pageContext = null) {
  const cfg = safeParseJSON(widget.cta_config, {});

  let knowledgeSection = '';
  if (knowledgeItems.length > 0) {
    knowledgeSection = '\n\n## ZNALOSTNÁ BÁZA\n';
    knowledgeItems.forEach((item, i) => {
      knowledgeSection += `\n### ${i + 1}. ${item.title}\n${item.content}\n`;
    });
  }

  const ctaInstructions = {
    call: `\n\n## PRIMÁRNY CIEĽ – TELEFONÁT\nTvoj hlavný cieľ je doviesť zákazníka k tomu, aby zavolal na ${cfg.phone || 'naše číslo'}. Keď zákazník prejaví záujem alebo si ujasní potreby, prirodzene navrhni telefonát ako ďalší krok: "Najrýchlejšie to vyriešime telefonicky – môžete zavolať priamo na ${cfg.phone || 'naše číslo'}."`,
    contact: `\n\n## PRIMÁRNY CIEĽ – KONTAKT\nTvoj hlavný cieľ je získať kontaktné údaje zákazníka. Keď zákazník prejaví záujem alebo sa dostatočne otvorí, prirodzene ponúkni možnosť zanechať kontakt: "Aby som vám mohol pripraviť konkrétny návrh, stačí zanechať kontakt kliknutím nižšie."`,
    purchase: `\n\n## PRIMÁRNY CIEĽ – NÁKUP\nTvoj hlavný cieľ je presvedčiť zákazníka ku kúpe. ${cfg.link ? `Odkáž ho na: ${cfg.link}` : ''} Najskôr pochop jeho potreby, potom prezentuj riešenie v benefitoch a vyzvi k akcii.`,
    order: `\n\n## PRIMÁRNY CIEĽ – OBJEDNÁVKA\nTvoj hlavný cieľ je doviesť zákazníka k objednávke. ${cfg.details || ''} Pomôž mu vybrať správnu možnosť na základe jeho potrieb.`,
    booking: `\n\n## PRIMÁRNY CIEĽ – REZERVÁCIA TERMÍNU\nTvoj hlavný cieľ je zarezervovať termín PRIAMO CEZ CHAT bez toho, aby zákazník musel čokoľvek klikať. Keď zákazník prejaví záujem, spýtaj sa postupne: (1) aký dátum a čas mu vyhovuje, (2) jeho meno, (3) email. Keď máš všetky 4 údaje (meno, email, dátum, čas), použi __DIRECTBOOK__ token na okamžitú rezerváciu. NEZOBRAZUJ formulár ani kalendár – zákazník nesmie musieť nič vyplňovať sám.`,
    custom: cfg.text ? `\n\n## PRIMÁRNY CIEĽ\n${cfg.text}${cfg.customLink ? `\nKeď zákazník prejaví záujem, odporuč mu kliknúť na tlačidlo s odkazom: ${cfg.customLink}` : ''}` : '',
    none: '',
  };

  let goalsSection = '';
  if (widget.goals?.trim()) {
    goalsSection = `\n\n## KONTEXT BIZNISU A PRODUKTU\n${widget.goals}`;
  }

  let videoSection = '';
  if (widget.demo_video_url?.trim()) {
    videoSection = `\n\n## DEMO VIDEO\nAk zákazník požiada o ukážku alebo demo, môžeš zdieľať tento odkaz: ${widget.demo_video_url}\nOdkaz pošli priamo v správe ako text URL — chatbot ho automaticky zobrazí ako video.`;
  }

  const productsSection = buildProductsSection(products);

  let pageContextSection = '';
  if (pageContext?.url) {
    pageContextSection = `\n\n## KONTEXT AKTUÁLNEJ STRÁNKY\nZákazník sa nachádza na: ${pageContext.url}`;
    if (pageContext.title) pageContextSection += `\nNázov stránky: ${pageContext.title}`;
    pageContextSection += `\nPouži tento kontext — ak je stránka produktová alebo kategóriová, opýtaj sa čo konkrétne hľadá alebo potrebuje v súvislosti s tým, čo práve prezerá. Nie je potrebné to komentovať priamo, len prispôsob otázky.`;
  }

  return `Si ${widget.bot_name}, skúsený predajný konzultant. Ovládaš psychológiu predaja a konzultačný predaj. Vieš predať čokoľvek – pretože predávaš cez pochopenie potrieb, nie cez tlak.

## PREDAJNÝ FRAMEWORK – VŽDY DODRŽUJ TENTO POSTUP

### FÁZA 1: DISCOVERY (prvé 1–3 správy)
Skôr ako čokoľvek prezentujete, zisti situáciu zákazníka. Klásť otázky prirodzene, jednu naraz:
- Čo konkrétne hľadá alebo aký problém rieši?
- Aká je jeho aktuálna situácia?
- Čo mu na súčasnom stave vadí alebo chýba?
- Aký má časový horizont / naliehavosť?
Príklad: "Aby som vám mohol odporučiť to najvhodnejšie – čo vás k nám priviedlo? Máte konkrétny problém, ktorý riešite?"

### FÁZA 2: PAIN AMPLIFICATION (keď vieš problém)
Pomôž zákazníkovi uvedomiť si dôsledky problému – nie manipuláciou, ale otázkami:
- "Aký dopad to má na vás / váš biznis?"
- "Ako dlho to už riešite?"
- "Čo sa stane, ak to nevyriešite?"
Zákazník musí cítiť, že POTREBUJE riešenie – nie že ty CHCEŠ predať.

### FÁZA 3: SOLUTION MATCHING (prezentácia riešenia)
Až keď poznáš potreby, prezentuj produkt/službu cez BENEFITY, nie features:
- NIE: "Ponúkame produkt X s funkciami A, B, C"
- ÁNO: "Presne pre váš prípad – keď [problém zákazníka] – naši klienti používajú [riešenie], pretože [benefit]. Výsledok je [konkrétny výsledok]."
Vždy prepoj vlastnosti na konkrétnu potrebu, ktorú zákazník vyslovil.

### FÁZA 4: OBJECTION HANDLING (námietky = záujem)
Každú námietku považuj za príležitosť:
1. Pochváľ otázku: "To je dôležitá otázka..."
2. Potvrď pochopenie: "Chápem, že vás zaujíma [námietka]..."
3. Odpovedz s argumentom a opýtaj sa späť: "...čo myslíte, riešilo by to váš prípad?"
Časté námietky a odpovede:
- "Je to drahé" → Porovnaj s hodnotou/nákladmi problému, nie s cenou konkurencie
- "Musím si to rozmyslieť" → Zisti čo konkrétne potrebuje rozmyslieť, ponúkni pomoc
- "Nechám to na neskôr" → Jemne zdôrazni, čo stratí čakaním

### FÁZA 5: CLOSING (uzatvorenie)
Keď zákazník prejaví záujem alebo súhlas:
- Sumarizuj čo sa dohodlo: "Takže ak to zhrniem – vy potrebujete [X] a naše riešenie vám dá [Y]."
- Navrhni konkrétny ďalší krok (CTA – viď nižšie)
- Použi soft close: "Chcete to vyskúšať / má zmysel dohodnúť ďalší krok?"

## PRAVIDLÁ
- Odpovedaj na základe znalostnej bázy. Ak informácia chýba, povedz to a ponúkni kontakt.
- Max 3–4 vety + 1 otázka alebo výzva na akciu. Buď stručný a konkrétny.
- Odpovedaj VŽDY v jazyku zákazníka (podľa toho ako píše – sk, en, de, fr, es, pl, cs, hu, ro, hr alebo iný).
- Nikdy si nevymýšľaj fakty, ceny, mená, kontakty ani referencie.
- Nebuď agresívny ani nátlakový – predávaj cez dôveru a pochopenie.
- Každú odpoveď ukončuj otázkou ALEBO výzvou k akcii – nikdy nedaj "slepú uličku".${goalsSection}${videoSection}${productsSection}${knowledgeSection}${ctaInstructions[widget.cta_type] || ''}${pageContextSection}`;
}

function loadProducts(widgetId) {
  try {
    const { getDb } = require('../db/database');
    return getDb().prepare(
      'SELECT * FROM products WHERE widget_id = ? AND active = 1 ORDER BY priority DESC'
    ).all(widgetId);
  } catch { return []; }
}

function loadLeadMagnets(widgetId) {
  try {
    const { getDb } = require('../db/database');
    return getDb().prepare(
      'SELECT id, name, description, ai_content, when_to_recommend, target_audience FROM lead_magnets WHERE widget_id = ? AND active = 1 ORDER BY created_at DESC'
    ).all(widgetId);
  } catch { return []; }
}

function buildLeadMagnetSection(leadMagnets) {
  if (!leadMagnets || !leadMagnets.length) return '';

  let section = '\n\n## LEAD MAGNETY (bezplatné materiály pre zákazníkov)\n';
  section += 'Ak zákazník prejaví záujem o tému, ktorú pokrýva niektorý lead magnet, ponúkni mu ho.\n';
  section += 'Použi token __LEADMAGNET__:JSON na konci odpovede (JSON na jednom riadku).\n';
  section += 'Zákazník zadá email a okamžite dostane prístup k materiálu.\n\n';

  leadMagnets.forEach((lm, i) => {
    section += `### Lead Magnet ${i + 1}: ${lm.name}\n`;
    if (lm.description) section += `Popis: ${lm.description}\n`;
    if (lm.ai_content) section += `Obsah: ${lm.ai_content}\n`;
    if (lm.when_to_recommend) section += `✅ Odporúčaj keď: ${lm.when_to_recommend}\n`;
    if (lm.target_audience) section += `👤 Pre koho: ${lm.target_audience}\n`;
    section += `ID: ${lm.id}\n\n`;
  });

  section += `**Ako použiť token:**
Keď chceš zákazníkovi ponúknuť lead magnet, na KONIEC svojej odpovede (po texte) vlož:
__LEADMAGNET__:{"id":"ID_LEAD_MAGNETU","title":"NAZOV_LEAD_MAGNETU"}

PRAVIDLÁ:
- Ponúkni max 1 lead magnet naraz
- Ponúkni ho ako pridanú hodnotu, nie ako prerušenie konverzácie
- Príklad: "Mimochodom, máme aj bezplatného sprievodcu na túto tému – ak chcete, stačí zadať email."
- NIKDY nepýtaj email priamo v texte – token sa o to postará automaticky`;

  return section;
}

function loadBookingConfig(widgetId) {
  try {
    const { getDb } = require('../db/database');
    const cfg = getDb().prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(widgetId) || null;
    if (!cfg) return null;
    cfg.services = getDb().prepare(
      'SELECT id, name, description, duration_mins, price, currency FROM booking_services WHERE booking_config_id = ? AND active = 1 ORDER BY display_order, name'
    ).all(cfg.id);
    return cfg;
  } catch { return null; }
}

function buildBookingSection(widgetId, bookingCfg) {
  if (!bookingCfg) return '';
  const origin = (process.env.APP_URL || 'https://neoworkly.com').replace(/\/$/, '');
  const bookingUrl = `${origin}/book/${widgetId}`;
  const now = new Date();
  const todayStr = now.toLocaleDateString('sk-SK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr  = now.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });

  const hasServices = bookingCfg.services && bookingCfg.services.length > 0;
  const servicesList = hasServices
    ? bookingCfg.services.map(s => {
        const dur = `${s.duration_mins} min`;
        const price = s.price != null ? ` | ${s.price} ${s.currency}` : '';
        return `  • ${s.name} (${dur}${price})${s.description ? ' – ' + s.description : ''}`;
      }).join('\n')
    : null;

  return `\n\n## ONLINE REZERVÁCIE
Aktuálny dátum a čas: ${todayStr}, ${timeStr}
Tento biznis prijíma online rezervácie.${servicesList ? `\n\nDostupné služby:\n${servicesList}` : ''}

### POVINNÝ POSTUP pri záujme o rezerváciu:

**ŠTANDARDNÝ POSTUP – rezervácia cez chat (VŽDY použi toto):**
Zber údaje konverzačne, jednu otázku naraz:
1. Preferovaný dátum a čas (preveď "zajtra"/"v pondelok" na skutočný dátum YYYY-MM-DD)${hasServices ? '\n2. Typ služby zo zoznamu vyššie' : ''}
${hasServices ? '3' : '2'}. Meno zákazníka
${hasServices ? '4' : '3'}. Email zákazníka

Keď máš VŠETKY údaje → potvrď rezerváciu v texte A OKAMŽITE vlož na koniec (JSON na jednom riadku):
__DIRECTBOOK__:{"name":"MENO","email":"EMAIL","service":"NAZOV_SLUZBY","serviceId":"ID_SLUZBY_alebo_null","date":"YYYY-MM-DD","time":"HH:MM"}

Systém zarezervuje termín automaticky. Ak termín nie je voľný, navrhni iný čas.

**Interaktívny formulár – POUŽI IBA AK zákazník VÝSLOVNE povie "chcem si vybrať sám" alebo "ukáž mi kalendár":**
→ Vlož na koniec odpovede: __BOOKING__

Booking URL (priamy odkaz): ${bookingUrl}
KRITICKÉ: Použi JEDEN token (__DIRECTBOOK__ ALEBO __BOOKING__) IBA raz za konverzáciu. NIKDY nezobrazuj formulár automaticky.`;
}

/* ── Person mode: system prompt builder ────────────────────────── */
function buildPersonPrompt(widget, personProfile, knowledgeItems = [], pageContext = null) {
  const name = personProfile.person_name?.trim() || widget.bot_name;

  let trainingSection = '';
  if (personProfile.how_i_think?.trim())
    trainingSection += `\n\n## AKO ROZMÝŠĽAM\n${personProfile.how_i_think}`;
  if (personProfile.my_style?.trim())
    trainingSection += `\n\n## MÔJ ŠTÝL KOMUNIKÁCIE\n${personProfile.my_style}`;
  if (personProfile.know_how?.trim())
    trainingSection += `\n\n## KNOW-HOW A EXPERTÍZA\n${personProfile.know_how}`;
  if (personProfile.real_answers?.trim())
    trainingSection += `\n\n## REÁLNE ODPOVEDE (príklady môjho štýlu)\n${personProfile.real_answers}`;
  if (personProfile.never_say?.trim())
    trainingSection += `\n\n## ČO NIKDY NEHOVORÍM\nTieto veci vynechaj – nikdy ich nespomínaj:\n${personProfile.never_say}`;

  let knowledgeSection = '';
  if (knowledgeItems.length > 0) {
    knowledgeSection = '\n\n## ZNALOSTNÁ BÁZA\n';
    knowledgeItems.forEach((item, i) => {
      knowledgeSection += `\n### ${i + 1}. ${item.title}\n${item.content}\n`;
    });
  }

  let pageContextSection = '';
  if (pageContext?.url) {
    pageContextSection = `\n\n## AKTUÁLNA STRÁNKA\nPoužívateľ sa nachádza na: ${pageContext.url}`;
    if (pageContext.title) pageContextSection += `\nNázov: ${pageContext.title}`;
  }

  const intro = personProfile.person_intro?.trim();

  return `Si ${name}${intro ? ` – ${intro}` : ''}.

## TVOJA IDENTITA
Nie si generický chatbot. Si digitálna verzia ${name} – so skutočným štýlom, názormi a spôsobom myslenia. Hovoríš ako ${name}, nie ako asistent.

## PRAVIDLÁ
- Odpovedaj VŽDY v jazyku, v ktorom ti píše používateľ.
- Buď autentický: krátky, priamy, osobný. Nie formálny, nie robotický.
- Ak niečo nevieš s istotou, povedz to úprimne – nevymýšľaj.
- Max 3–4 vety na odpoveď, pokiaľ situácia nevyžaduje viac.
- Nekončíš každú správu predajnou výzvou – si tu pre ľudí, nie pre konverzie.${trainingSection}${knowledgeSection}${pageContextSection}`;
}

/* ── Person mode: streaming response ──────────────────────────── */
async function streamPersonResponse(widget, personProfile, knowledgeItems, history, userMessage, res, pageContext = null) {
  const systemPrompt = buildPersonPrompt(widget, personProfile, knowledgeItems, pageContext);
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let fullResponse = '';

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullResponse += event.delta.text;
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }

  res.write(`data: ${JSON.stringify({ done: true, fullText: fullResponse })}\n\n`);
  res.end();
  return fullResponse;
}

/* ── Streaming chat response ───────────────────────────────────── */
async function streamChatResponse(widget, knowledgeItems, history, userMessage, res, pageContext = null) {
  const products        = loadProducts(widget.id);
  const bookingCfg      = loadBookingConfig(widget.id);
  const leadMagnets     = loadLeadMagnets(widget.id);
  const bookingSection  = buildBookingSection(widget.id, bookingCfg);
  const lmSection       = buildLeadMagnetSection(leadMagnets);
  const systemPrompt    = buildSystemPrompt(widget, knowledgeItems, products, pageContext) + bookingSection + lmSection;
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let fullResponse = '';

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    // Prompt caching: system prompt is cached after first call per widget
    // Saves ~70% on input tokens for repeat calls (same widget, same KB)
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullResponse += event.delta.text;
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }

  res.write(`data: ${JSON.stringify({ done: true, fullText: fullResponse })}\n\n`);
  res.end();

  logTrainingSample({
    source: 'chat',
    systemPrompt,
    userInput: userMessage,
    assistantOutput: fullResponse,
    widgetId: widget.id,
    quality: 0,
  });

  return fullResponse;
}

/* ── AI-generated suggested questions ─────────────────────────── */
async function generateSuggestedQuestions(knowledgeItems, goals, ctaType) {
  if (!knowledgeItems.length) return [];

  const knowledgeSummary = knowledgeItems
    .slice(0, 5)
    .map(k => `${k.title}: ${k.content.slice(0, 400)}`)
    .join('\n\n');

  const ctaHint = {
    call: 'Zákazník má byť nakoniec motivovaný zavolať.',
    contact: 'Zákazník má na konci zanechať kontaktné údaje.',
    purchase: 'Zákazník má byť motivovaný ku kúpe.',
    order: 'Zákazník má podať objednávku.',
    custom: '',
    none: '',
  }[ctaType] || '';

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Na základe nasledujúcich informácií o biznise navrhni 5 krátkych otázok, ktoré by zákazník mohol položiť chatbotovi. Otázky musia byť krátke (max 8 slov), konkrétne a prirodzené.

Cieľ biznisu: ${goals || 'pomôcť zákazníkom'}
${ctaHint}

Znalostná báza:
${knowledgeSummary}

Vráť VÝHRADNE JSON pole stringov, nič iné. Príklad:
["Aké sú vaše ceny?", "Kde sa nachádzate?", "Ako funguje doručenie?", "Čo ponúkate?", "Máte zľavy?"]`,
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const qs = JSON.parse(match[0]);
    return Array.isArray(qs) ? qs.slice(0, 6).map(q => String(q).slice(0, 80)) : [];
  } catch (err) {
    console.error('generateSuggestedQuestions error:', err.message);
    throw err;
  }
}

/* ── Non-streaming Person response (for email channel) ────────── */
async function getPersonResponseText(widget, personProfile, knowledgeItems, history, userMessage) {
  const systemPrompt = buildPersonPrompt(widget, personProfile, knowledgeItems);
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  return response.content.find(b => b.type === 'text')?.text?.trim() || '';
}

/* ── Non-streaming response (for Instagram / WhatsApp DMs) ────── */
async function getChatResponseText(widget, knowledgeItems, history, userMessage) {
  const products = loadProducts(widget.id);
  const systemPrompt = buildSystemPrompt(widget, knowledgeItems, products);
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  return response.content.find(b => b.type === 'text')?.text?.trim() || '';
}

/* ── AI conversation summary for leads ────────────────────────── */
async function summarizeConversation(messages) {
  if (!messages || messages.length === 0) return null;

  const transcript = messages
    .map(m => `${m.role === 'user' ? 'Zákazník' : 'Asistent'}: ${m.content}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Si skúsený obchodný analytik. Analyzuj konverzáciu zákazníka s predajným chatbotom a vytvor obchodnú kartu leadu pre obchodníka.

Konverzácia:
${transcript}

Vráť VÝHRADNE tento formát (žiadny iný text pred ani po):

🌡️ TEPLOTA LEADU: [STUDENÝ / VLAŽNÝ / HORÚCI / PRIPRAVENÝ KÚPIŤ]

🎯 ČO HĽADÁ: [1–2 vety – konkrétny produkt/služba/riešenie]

😣 HLAVNÝ PROBLÉM / BOLESŤ: [1–2 vety – čo ho trápi, čo nefunguje]

📋 SITUÁCIA: [1–2 vety – aktuálny stav, odkiaľ prichádza, kontext]

⏰ NALIEHAVOSŤ: [okamžitá / do mesiaca / plánuje / len zisťuje]

💬 KĽÚČOVÉ NÁMIETKY: [ak žiadne: "Žiadne zistené"]

✅ ODPORÚČANÝ ĎALŠÍ KROK: [konkrétna akcia pre obchodníka]`,
      }],
    });

    return response.content.find(b => b.type === 'text')?.text?.trim() || null;
  } catch (err) {
    console.error('summarizeConversation error:', err.message);
    return null;
  }
}

/* ── Anonymous conversation trend analysis ─────────────────── */
async function analyzeConversationTrends(messages, msgCount) {
  if (!messages || messages.length < 4) return null;

  // Only include user messages for anonymity analysis — no assistant content needed
  const transcript = messages
    .filter(m => m.role === 'user')
    .map(m => `– ${m.content.slice(0, 300)}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Analyzuj správy zákazníka a extrahuj anonymné behaviorálne trendy. BEZ osobných údajov.

Správy zákazníka:
${transcript}

Vráť VÝHRADNE JSON (žiadny iný text):
{
  "topics": ["kľúčové témy (max 3, každá 1-2 slová, slovensky)"],
  "intent": "buying|researching|support|comparing|just_browsing",
  "objection": "price|timing|wrong_product|trust|more_info|just_browsing|none",
  "urgency": "immediate|within_month|planning|just_browsing"
}

Definície:
intent – buying=chce kúpiť, researching=zisťuje info, support=rieši problém, comparing=porovnáva, just_browsing=bez záujmu
objection – dôvod prečo zákazník nekonal; none=ak zanechal kontakt/rezervoval
urgency – immediate=teraz, within_month=čoskoro, planning=dlhodobé, just_browsing=nezistené`,
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const data = JSON.parse(match[0]);

    // Validate and sanitize
    const INTENTS   = new Set(['buying','researching','support','comparing','just_browsing']);
    const OBJECTIONS = new Set(['price','timing','wrong_product','trust','more_info','just_browsing','none']);
    const URGENCIES  = new Set(['immediate','within_month','planning','just_browsing']);

    return {
      topics:    Array.isArray(data.topics) ? data.topics.slice(0,3).map(t => String(t).slice(0,40).toLowerCase()) : [],
      intent:    INTENTS.has(data.intent)     ? data.intent    : 'just_browsing',
      objection: OBJECTIONS.has(data.objection) ? data.objection : 'just_browsing',
      urgency:   URGENCIES.has(data.urgency)   ? data.urgency   : 'just_browsing',
    };
  } catch (err) {
    console.error('analyzeConversationTrends error:', err.message);
    return null;
  }
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/* ── Generate GDPR text ──────────────────────────────────────── */
async function generateGdprText({ companyName, companyAddress, companyId, email, purposes, retention }) {
  const prompt = `Si právny expert na GDPR a ochranu osobných údajov. Napíš stručný, ale kompletný súhlas so spracovaním osobných údajov v slovenčine pre webový kontaktný formulár.

Informácie o prevádzkovateľovi:
- Názov: ${companyName}
- Adresa: ${companyAddress || 'neuvedená'}
- IČO/ID: ${companyId || 'neuvedené'}
- Kontaktný email: ${email || 'neuvedený'}
- Účel spracovania: ${purposes || 'spätný kontakt a zodpovedanie otázok'}
- Doba uchovávania: ${retention || '3 roky'}

Napíš súhlas GDPR v tomto formáte:
1. Krátky úvodný odsek (2-3 vety) o tom kto spracúva údaje a na aký účel
2. Výpis spracúvaných osobných údajov (meno, email, telefón)
3. Právny základ spracovania
4. Doba uchovávania
5. Práva dotknutej osoby (právo na prístup, opravu, vymazanie, odvolanie súhlasu)
6. Kontakt na prevádzkovateľa

Text musí byť zrozumiteľný pre bežného človeka, nie príliš dlhý (max 300 slov), v slovenčine. Nepoužívaj markdown headingy (#), iba odseky.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0]?.text?.trim() || '';
}

/* ── Person training: AI plays customer, asks questions ────────── */
async function streamTrainingQuestion(widget, personProfile, history, res) {
  const name = personProfile?.person_name?.trim() || widget.bot_name;
  const context = widget.goals?.trim() ? `\nKontext biznisu: ${widget.goals}` : '';
  const existing = personProfile
    ? [
        personProfile.know_how?.trim() ? `Expertíza: ${personProfile.know_how}` : '',
        personProfile.how_i_think?.trim() ? `Myslenie: ${personProfile.how_i_think}` : '',
      ].filter(Boolean).join('\n')
    : '';

  const exchangeCount = history.filter(h => h.role === 'trainer').length;
  let depthHint = '';
  if (exchangeCount < 4) {
    depthHint = 'Začni ľahkými úvodnými otázkami – kto si, čo robíš, čo ťa k tomu priviedlo.';
  } else if (exchangeCount < 10) {
    depthHint = 'Pýtaj sa hlbšie – ako riešiš problémy, čo si myslíš o konkrétnych témach z tvojho odboru, aký máš prístup.';
  } else {
    depthHint = 'Použi aj trochu výzvy – pýtaj sa na hraničné situácie, nesúhlasné scenáre, nepríjemné otázky. Chceš vidieť ako reaguje pod tlakom.';
  }

  const systemPrompt = `Si zákazník/follower, ktorý sa práve zoznámil s osobou menom ${name}.${context}${existing ? `\n${existing}` : ''}

Tvoja úloha je klásť prirodzené, konverzačné otázky – jednu naraz – aby si zistil ako ${name} rozmýšľa, aký má štýl komunikácie a čo vie.

${depthHint}

PRAVIDLÁ:
- Vždy iba jedna otázka, max 2 vety.
- Buď autentický zákazník/follower – žiadny interview formát.
- Nadväzuj na predchádzajúce odpovede ak sú k dispozícii.
- Odpovedaj v jazyku, v ktorom s tebou hovorí ${name}.`;

  // Build messages: Claude=customer(assistant), trainer=user
  const messages = [
    { role: 'user', content: 'Začni rozhovor – polož svoju prvú otázku.' },
    ...history.flatMap(h => {
      if (h.role === 'customer') return [{ role: 'assistant', content: h.content }];
      if (h.role === 'trainer')  return [{ role: 'user',      content: h.content }];
      return [];
    }),
  ];

  let fullResponse = '';
  const stream = await client.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: systemPrompt,
    messages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullResponse += event.delta.text;
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }
  res.write(`data: ${JSON.stringify({ done: true, fullText: fullResponse })}\n\n`);
  res.end();
  return fullResponse;
}

/* ── Person training: analyze session, extract style DNA ─────── */
async function analyzeTrainingSession(widget, history) {
  const trainerTurns = history.filter(h => h.role === 'trainer').map(h => h.content);
  if (trainerTurns.length < 2) throw new Error('Príliš krátky tréning.');

  const conversationText = history
    .map(h => `${h.role === 'customer' ? 'ZÁKAZNÍK' : 'OSOBA'}: ${h.content}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `Si expert na analýzu komunikačného štýlu. Analyzuješ rozhovor a extrahuješ DNA komunikácie skutočnej osoby.
Vráť VÝHRADNE validný JSON (bez markdown, bez úvodu, bez komentárov) v tomto formáte:
{
  "how_i_think": "...",
  "my_style": "...",
  "know_how": "...",
  "real_answers": "...",
  "never_say": "..."
}`,
    messages: [{
      role: 'user',
      content: `Analyzuj nasledujúci tréningový rozhovor. Extrahuj komunikačné DNA osoby (nie zákazníka).

KONVERZÁCIA:
${conversationText}

POKYNY PRE KAŽDÉ POLE:
- how_i_think: Ako táto osoba rozmýšľa? Aké má hodnoty, princípy, filozofiu? Čo z jej odpovedí prezrádza jej worldview? (2-4 vety, osobná forma "Rozmýšľam tak, že...")
- my_style: Aký je jej štýl komunikácie? Dĺžka viet, tón, formálnosť, humor, emócie, tempo? (2-3 vety, "Píšem/hovorím...")
- know_how: V čom je expert? Aké témy ovláda, akú má hĺbku znalostí, z akej praxe vychádza? (3-5 viet)
- real_answers: 3-4 ukážkové Q&A páry zachytávajúce jej štýl. Formát: "Otázka: ...\nOdpoveď: ...\n\n" (použiť reálne alebo blízko reálnych formulácií z rozhovoru)
- never_say: Čo táto osoba nikdy nehovorí? Aké frázy, témy alebo postoje sa vyhýba? (na základe čoho NEpovedala, čoho sa zriekla, ako odpovedala opatrne)

Vráť LEN JSON.`,
    }],
  });

  const raw = response.content[0]?.text?.trim() || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    // try to extract JSON from raw if model added text
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

/* ── Person: analyze ingested content (article / video / PDF) ──── */
async function analyzeIngestedContent(sourceTitle, extractedText, currentProfile) {
  const existingCtx = currentProfile
    ? [
        currentProfile.how_i_think?.trim() ? `Ako rozmýšľam: ${currentProfile.how_i_think}` : '',
        currentProfile.my_style?.trim()    ? `Môj štýl: ${currentProfile.my_style}` : '',
        currentProfile.know_how?.trim()    ? `Know-how: ${currentProfile.know_how}` : '',
      ].filter(Boolean).join('\n')
    : '';

  const profileCtx = existingCtx
    ? `\nExistujúci profil (NEDUPLIKUJ, iba doplň nové poznatky):\n${existingCtx}\n`
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: `Si expert na analýzu obsahu a extrakciu komunikačnej DNA autora.
Analyzuješ texty (prepisy videí, články, PDF) a extrahuješ z nich expertízu a komunikačný štýl autora.
Vráť VÝHRADNE validný JSON bez markdown blokov.`,
    messages: [{
      role: 'user',
      content: `Analyzuj obsah zo zdroja "${sourceTitle}". Extrahuj z neho poznatky pre Person profil digitálneho dvojníka AUTORA tohto obsahu (nie poslucháča).
${profileCtx}
OBSAH:
${extractedText.slice(0, 15000)}

Vráť JSON (každé pole je STRING – nové poznatky na doplnenie, prázdny reťazec ak nič relevantné):
{
  "source_title": "${sourceTitle}",
  "summary": "1-2 vety: o čom obsah je a čo z neho vyplýva o autorovi",
  "how_i_think": "Nové poznatky o myšlienkovom štýle, hodnotách, filozofii autora z tohto obsahu",
  "my_style": "Nové poznatky o komunikačnom štýle autora (tón, dĺžka, formálnosť, humor...)",
  "know_how": "Expertné poznatky, skúsenosti a oblasti z tohto obsahu",
  "real_answers": "2-3 ukážkové Q&A zachytávajúce hlas autora. Formát: Otázka: ...\\nOdpoveď: ...\\n\\n",
  "never_say": "Čo z obsahu naznačuje čoho sa autor vyhýba alebo čo by nikdy nepovedal"
}`,
    }],
  });

  const raw = response.content[0]?.text?.trim() || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

module.exports = { streamChatResponse, streamPersonResponse, streamTrainingQuestion, analyzeTrainingSession, analyzeIngestedContent, getChatResponseText, getPersonResponseText, generateSuggestedQuestions, summarizeConversation, generateGdprText, loadLeadMagnets, analyzeConversationTrends };
