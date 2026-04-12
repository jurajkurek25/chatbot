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
    custom: cfg.text ? `\n\n## PRIMÁRNY CIEĽ\n${cfg.text}${cfg.customLink ? `\nKeď zákazník prejaví záujem, odporuč mu kliknúť na tlačidlo s odkazom: ${cfg.customLink}` : ''}` : '',
    none: '',
  };

  let goalsSection = '';
  if (widget.goals?.trim()) {
    goalsSection = `\n\n## KONTEXT BIZNISU A PRODUKTU\n${widget.goals}`;
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
- Každú odpoveď ukončuj otázkou ALEBO výzvou k akcii – nikdy nedaj "slepú uličku".${goalsSection}${productsSection}${knowledgeSection}${ctaInstructions[widget.cta_type] || ''}${pageContextSection}`;
}

function loadProducts(widgetId) {
  try {
    const { getDb } = require('../db/database');
    return getDb().prepare(
      'SELECT * FROM products WHERE widget_id = ? AND active = 1 ORDER BY priority DESC'
    ).all(widgetId);
  } catch { return []; }
}

function loadBookingConfig(widgetId) {
  try {
    const { getDb } = require('../db/database');
    return getDb().prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(widgetId) || null;
  } catch { return null; }
}

function buildBookingSection(widgetId, bookingCfg) {
  if (!bookingCfg) return '';
  const origin = (process.env.APP_URL || 'https://neuradesk.online').replace(/\/$/, '');
  const bookingUrl = `${origin}/book/${widgetId}`;
  return `\n\n## ONLINE REZERVÁCIE
Tento biznis prijíma online rezervácie termínov. Keď zákazník prejaví záujem o stretnutie, konzultáciu alebo rezerváciu, postupuj takto:
1. Stručne potvrď, že je to možné online
2. Vlož na koniec odpovede PRESNE tento token (nič iné nepridávaj za ním): __BOOKING__
Systém automaticky zobrazí zákazníkovi interaktívny formulár na výber termínu.
Booking URL (pre prípad, že zákazník chce priamy odkaz): ${bookingUrl}
DÔLEŽITÉ: Token __BOOKING__ použi IBA raz za konverzáciu, keď zákazník JASNE vyjadrí záujem o rezerváciu.`;
}

/* ── Streaming chat response ───────────────────────────────────── */
async function streamChatResponse(widget, knowledgeItems, history, userMessage, res, pageContext = null) {
  const products      = loadProducts(widget.id);
  const bookingCfg    = loadBookingConfig(widget.id);
  const bookingSection = buildBookingSection(widget.id, bookingCfg);
  const systemPrompt  = buildSystemPrompt(widget, knowledgeItems, products, pageContext) + bookingSection;
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let fullResponse = '';

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 1200,
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

module.exports = { streamChatResponse, getChatResponseText, generateSuggestedQuestions, summarizeConversation, generateGdprText };
