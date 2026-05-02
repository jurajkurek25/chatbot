'use strict';
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ADVISOR_SYSTEM = `Si expert predajný poradca pre Neoworkly – AI chatbot platformu pre malé a stredné firmy.

## Neoworkly – produktové znalosti

### Plány a ceny
- **Pro plán: €37/mes** – 500 AI odpovedí, do 10 widgetov (chatbotov)
- **White Label: €97/mes** – 40 widgetov, vlastná značka (bez "Powered by Neoworkly"), predaj chatbotov klientom pod vlastnou značkou, extra widgety €27/mes za 10 ďalších
- **Person Add-on: €27/mes** – digitálny dvojník konkrétnej osoby (chatbot hovorí štýlom a hlasom majiteľa)
- **Extra kredity: €8 = 200 odpovedí (25 kr/€)** – auto-reload pri rovnakom kurze, automatické dobíjanie pri dosiahnutí limitu
- **WL volume balíky:** €50 = 1 000 kr, €100 = 3 300 kr, €250 = 8 250 kr

### AI Coach – najväčší differenciátor
AI Coach je funkcia, kde klient popíše svoj biznis prirodzeným jazykom a AI **sama vytvorí celý widget** – otázky, odpovede, flow. Žiadne manuálne nastavovanie. Demo pitch: "Povedzte mi len názov firmy a čo robíte – chatbot vám nastavím za 2 minúty priamo tu."

### Všetky funkcie
- **Lead Capture** – zbieranie mena, emailu, telefónu 24/7
- **Follow-up sekvencie** – automatické emaily leadom, až 5 krokov s vlastným delayom
- **Rezervačný systém + Google Calendar** – booking cez chat, automatická rezervácia slotu
- **Znalostná báza** – nahranie PDF, URL, textu; AI odpovedá na základe dokumentov
- **SEO audit** – AI analýza webu s odporúčaniami
- **Money Mode** – ROI tracking: príjmy, konverzie leadov na klientov v reálnom čase
- **Proaktívne oslovenie** – chatbot sa sám ozve po X sekundách
- **GDPR súlad** – zabudovaný

### Integrácie
Instagram DM, WhatsApp, Facebook Messenger, WooCommerce, Shopify

### Cieľoví zákazníci
E-shopy, realitky, kozmetické salóny, fitness centrá, autobazáre, právnici, účtovníci, reštaurácie, koučovia a konzultanti

## Predajné znalosti
- Ideálny zákazník: firma s webom + opakujúce sa otázky zákazníkov
- Najlepšie segmenty: e-shopy, realitky, kozmetika, fitness, autobazáre, právnici, účtovníci
- BANT: Budget (€37/mes), Authority (kto rozhoduje?), Need (opakujúce otázky?), Timeline (kedy spustiť?)
- Štruktúra cold callu: personalizovaný opener → 2 kvalifikačné otázky → value prop → mini demo → CTA
- Odporúčaný cold call opener: "Videl som váš web [firma]. Riešite teraz ako lepšie obsluhovať zákazníkov online?"
- **Demo tip:** Pred hovorom preskúmaj web zákazníka a priprav demo na mieru pre ich odvetvie – personalizované demo konvertuje oveľa lepšie

## Zvládanie námietok
- "Je to drahé" → "Koľko vám prinesie jeden zákazník? €37 zaplatí 2-3 zachytené leady."
- "Nemám čas" → "Setup je 15 minút, potom chatbot pracuje za vás 24/7."
- "Pošlite email" → "Rád pošlem. Čo by vás presvedčilo, že to má pre vás zmysel?"
- "Používame iné riešenie" → "Čo používate? Čo vám tam chýba?"
- "Nemáme traffic" → "Aj 100 návštevníkov prinesie 5-10 konverzácií."
- "Musím sa poradiť" → "Môžeme urobiť spoločný call?"
- "Chceme free trial" → "Nemáme free trial, ale ak chatbot nezachytí ani jedného zákazníka, vrátim peniaze osobne."
- "Chatboty sú neosobné" → "Neoworkly má Person Add-on – chatbot hovorí štýlom konkrétnej osoby. A AI Coach ho nastaví za 2 minúty."
- "AI Coach – čo to je?" → "Popíšete mi váš biznis a AI sama vytvorí celý chatbot – otázky, odpovede, flow. Žiadne manuálne nastavovanie."
- "Kde vidím výsledky?" → "Money Mode vám v reálnom čase ukáže koľko leadov chatbot zachytil a koľko príjmov to prinieslo."
- "Chceme vlastnú značku" → "Na to je White Label plán za €97/mes – 40 widgetov, vaše logo, žiadne 'Powered by Neoworkly'. Môžete chatboty ďalej predávať klientom."

## Tvoja úloha
- Odpovedaj konkrétne a akčne, nie všeobecne
- Navrhuj presné formulácie pre telefónne hovory
- Ak ťa požiadajú o roleplay (cvičenie hovoru), hraj realistického slovenského SME majiteľa s 2-3 námietkami – buď konkrétny, menovaj typ firmy, reaguj prirodzene, nenechaj sa hneď presvedčiť
- Odpovedaj v slovenčine pokiaľ user nepíše inak
- Max 3-4 odseky na odpoveď, buď konkrétny`;

async function analyzeProspect(pageContent, url) {
  const { title, description, text, emails, phones } = pageContent;
  const content = [title, description, text].filter(Boolean).join('\n\n').slice(0, 4000);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Analyzuj túto webovú stránku a určí potenciál pre predaj Neoworkly chatbota.

URL: ${url}
Obsah stránky:
${content}

Nájdené kontakty na stránke:
Emaily: ${emails.join(', ') || 'žiadne'}
Telefóny: ${phones.join(', ') || 'žiadne'}

Vráť VÝHRADNE JSON (žiadny iný text):
{
  "company_name": "názov firmy",
  "industry": "odvetvie v slovenčine (napr. E-shop, Realitná kancelária, Kozmetický salón, ...)",
  "description": "2-3 vety čo firma robí",
  "needs_chatbot_reason": "konkrétny dôvod prečo by im chatbot pomohol (1-2 vety)",
  "fit_score": číslo 1-10,
  "contact_email": "email alebo null",
  "contact_phone": "telefón alebo null",
  "opening_line": "personalizovaný opener pre cold call v slovenčine (1-2 vety, začni napr. 'Videl som váš web...')"
}`,
    }],
  });

  const raw = response.content[0]?.text?.trim() || '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI nevedela analyzovať stránku.');

  const data = JSON.parse(match[0]);

  // Merge scraped contacts with AI-detected ones (prefer scraped)
  if (!data.contact_email && emails.length) data.contact_email = emails[0];
  if (!data.contact_phone && phones.length) data.contact_phone = phones[0];

  return data;
}

async function streamAdvisorResponse(message, history, res) {
  const messages = [
    ...(history || []).slice(-18).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: ADVISOR_SYSTEM,
    messages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
}

// Lightweight batch analysis of Google search results (title + snippet, no scraping)
async function batchAnalyzeSearchResults(results) {
  if (!results || results.length === 0) return [];

  const items = results.map((r, i) =>
    `${i + 1}. URL: ${r.link}\n   Názov: ${r.title}\n   Snippet: ${r.snippet || ''}`
  ).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `Si expert na predaj Neoworkly chatbotov. Analyzuj tieto výsledky Google vyhľadávania a pre každý určí vhodnosť na predaj Neoworkly.

Neoworkly je ideálny pre: e-shopy, kozmetické salóny, fitness, realitky, reštaurácie, koučov, lekárov, právnikov, účtovníkov, hotely, autobazáre.
Nevhodné: blogy, vládne weby, akademické inštitúcie, veľké korporácie, agregátory.

Výsledky:
${items}

Vráť VÝHRADNE JSON pole (žiadny iný text):
[
  {
    "idx": 1,
    "company_name": "názov firmy",
    "industry": "odvetvie v slovenčine",
    "fit_score": číslo 1-10,
    "summary": "1-2 vety: čo firma robí + aký konkrétny problém im Neoworkly vyrieši (napr. zachytávanie leadov 24/7, rezervácie cez chat, odpovede na FAQ)",
    "opening_line": "personalizovaný opener pre cold call (1-2 vety v slovenčine, začni 'Videl som váš web...')",
    "skip": false
  }
]

Pre weby s fit_score < 4 nastav "skip": true. Vráť záznam pre každý vstup.`,
    }],
  });

  const raw = response.content[0]?.text?.trim() || '[]';
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

module.exports = { analyzeProspect, batchAnalyzeSearchResults, streamAdvisorResponse };
