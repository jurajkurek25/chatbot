'use strict';

const Anthropic = require('@anthropic-ai/sdk');

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
function buildSystemPrompt(widget, knowledgeItems, products = []) {
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
    custom: cfg.text ? `\n\n## PRIMÁRNY CIEĽ\n${cfg.text}` : '',
    none: '',
  };

  let goalsSection = '';
  if (widget.goals?.trim()) {
    goalsSection = `\n\n## KONTEXT BIZNISU A PRODUKTU\n${widget.goals}`;
  }

  const productsSection = buildProductsSection(products);

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
- Odpovedaj VŽDY v jazyku zákazníka (sk/cs/en podľa toho ako píše).
- Nikdy si nevymýšľaj fakty, ceny, mená, kontakty ani referencie.
- Nebuď agresívny ani nátlakový – predávaj cez dôveru a pochopenie.
- Každú odpoveď ukončuj otázkou ALEBO výzvou k akcii – nikdy nedaj "slepú uličku".${goalsSection}${productsSection}${knowledgeSection}${ctaInstructions[widget.cta_type] || ''}`;
}

function loadProducts(widgetId) {
  try {
    const { getDb } = require('../db/database');
    return getDb().prepare(
      'SELECT * FROM products WHERE widget_id = ? AND active = 1 ORDER BY priority DESC'
    ).all(widgetId);
  } catch { return []; }
}

/* ── Streaming chat response ───────────────────────────────────── */
async function streamChatResponse(widget, knowledgeItems, history, userMessage, res) {
  const products = loadProducts(widget.id);
  const systemPrompt = buildSystemPrompt(widget, knowledgeItems, products);
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let fullResponse = '';

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
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
      model: 'claude-opus-4-6',
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
    return [];
  }
}

/* ── Non-streaming response (for Instagram DMs) ───────────────── */
async function getChatResponseText(widget, knowledgeItems, history, userMessage) {
  const products = loadProducts(widget.id);
  const systemPrompt = buildSystemPrompt(widget, knowledgeItems, products);
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 600,
    system: systemPrompt,
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
      model: 'claude-opus-4-6',
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

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = { streamChatResponse, getChatResponseText, generateSuggestedQuestions, summarizeConversation };
