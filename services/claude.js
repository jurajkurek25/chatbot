'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ── System prompt builder ─────────────────────────────────────── */
function buildSystemPrompt(widget, knowledgeItems) {
  const cfg = safeParseJSON(widget.cta_config, {});

  let knowledgeSection = '';
  if (knowledgeItems.length > 0) {
    knowledgeSection = '\n\n## ZNALOSTNÁ BÁZA\n';
    knowledgeItems.forEach((item, i) => {
      knowledgeSection += `\n### ${i + 1}. ${item.title}\n${item.content}\n`;
    });
  }

  const ctaInstructions = {
    call: `\n\n## KONVERZNÝ CIEĽ – TELEFONÁT\nTvoj hlavný cieľ je presvedčiť zákazníka, aby zavolal na číslo ${cfg.phone || '[číslo]'}. Keď zákazník prejaví záujem, pochváliš ho a prirodzene navrhnúť zavolanie. Použi frázy ako "Pre rýchle riešenie vám odporúčam zavolať priamo na ${cfg.phone || 'naše číslo'}."`,
    contact: `\n\n## KONVERZNÝ CIEĽ – KONTAKTNÝ FORMULÁR\nTvoj hlavný cieľ je získať kontaktné údaje zákazníka (meno + email/telefón). Keď zákazník prejaví záujem alebo položí konkrétnu otázku, ponúkni mu možnosť zanechať kontakt – "Rád vám pošlem viac informácií, stačí zanechať kontakt kliknutím nižšie."`,
    purchase: `\n\n## KONVERZNÝ CIEĽ – NÁKUP\nTvoj hlavný cieľ je presvedčiť zákazníka ku kúpe. ${cfg.link ? `Odkáž ho na: ${cfg.link}` : ''} Zdôrazni hodnotu produktu, odpovedaj na námietky a na konci vyzvi k akcii.`,
    order: `\n\n## KONVERZNÝ CIEĽ – OBJEDNÁVKA\nTvoj hlavný cieľ je doviesť zákazníka k objednávke. ${cfg.details || ''} Pomôž mu vybrať, odpovedaj na otázky a vyzvi ho k objednaniu.`,
    custom: cfg.text ? `\n\n## KONVERZNÝ CIEĽ\n${cfg.text}` : '',
    none: '',
  };

  let goalsSection = '';
  if (widget.goals?.trim()) {
    goalsSection = `\n\n## KONTEXT BIZNISU\n${widget.goals}`;
  }

  return `Si ${widget.bot_name}, inteligentný AI asistent. Pomáhaš zákazníkom a vedieš ich k akcii.

## PRAVIDLÁ
- Odpovedaj výhradne na základe znalostnej bázy. Ak informácia chýba, povedz to slušne.
- Buď priateľský, konkrétny a stručný (max 3–4 vety na odpoveď).
- Odpovedaj v jazyku zákazníka (sk/cs/en atď.).
- Nikdy si nevymýšľaj fakty, ceny ani kontakty.
- Aktívne veď zákazníka k cieľu konverzie.${goalsSection}${knowledgeSection}${ctaInstructions[widget.cta_type] || ''}`;
}

/* ── Streaming chat response ───────────────────────────────────── */
async function streamChatResponse(widget, knowledgeItems, history, userMessage, res) {
  const systemPrompt = buildSystemPrompt(widget, knowledgeItems);
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

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = { streamChatResponse, generateSuggestedQuestions };
