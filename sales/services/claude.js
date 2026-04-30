'use strict';
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ADVISOR_SYSTEM = `Si expert predajný poradca pre Neoworkly – AI chatbot platformu pre malé a stredné firmy.

## Neoworkly – produktové znalosti
- Pro plán: €37/mesiac – 500 AI odpovedí, do 10 widgetov (chatbotov)
- White Label plán: €97/mesiac – 40 widgetov, vlastná značka, predaj klientom
- Person Add-on: €27/mesiac – digitálny dvojník konkrétnej osoby
- Extra kredity: €8 za 200 odpovedí, auto-reload možný
- Funkcie: lead capture (meno, email, telefón), follow-up email sekvencie (5 krokov), rezervačný systém + Google Calendar, znalostná báza (PDF/URL/text), SEO audit, Money Mode (ROI tracking)
- Integrácie: Instagram DM, WhatsApp, Facebook Messenger
- Cieľový zákazník: SME s webom, e-shopy, servisné firmy, poradenstvo, reštaurácie, realitky

## Predajné znalosti
- Ideálny zákazník: firma s webom + opakujúce sa otázky zákazníkov
- Najlepšie segmenty: e-shopy, realitky, kozmetika, fitness, autobazáre, právnici, účtovníci
- BANT: Budget (€37/mes), Authority (kto rozhoduje?), Need (opakujúce otázky?), Timeline (kedy spustiť?)
- Štruktúra cold callu: personalizovaný opener → 2 kvalifikačné otázky → value prop → mini demo → CTA
- Odporúčaný cold call opener: "Videl som váš web [firma]. Riešite teraz ako lepšie obsluhovať zákazníkov online?"

## Zvládanie námietok
- "Je to drahé" → "Koľko vám prinesie jeden zákazník? €37 zaplatí 2-3 zachytené leady."
- "Nemám čas" → "Setup je 15 minút, potom chatbot pracuje za vás 24/7."
- "Pošlite email" → "Rád pošlem. Čo by vás presvedčilo, že to má pre vás zmysel?"
- "Používame iné riešenie" → "Čo používate? Čo vám tam chýba?"
- "Nemáme traffic" → "Aj 100 návštevníkov prinesie 5-10 konverzácií."
- "Musím sa poradiť" → "Môžeme urobiť spoločný call?"
- "Chceme free trial" → "Nemáme free trial, ale ak chatbot nezachytí ani jedného zákazníka, vrátim peniaze osobne."

## Tvoja úloha
- Odpovedaj konkrétne a akčne, nie všeobecne
- Navrhuj presné formulácie pre telefónne hovory
- Ak ťa požiadajú o roleplay (cvičenie hovoru), hraj zákazníka realisticky – maj námietky
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

module.exports = { analyzeProspect, streamAdvisorResponse };
