'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Build system prompt from widget config and relevant knowledge items.
 */
function buildSystemPrompt(widget, knowledgeItems) {
  const config = {
    ctaConfig: safeParseJSON(widget.cta_config, {}),
  };

  let knowledgeSection = '';
  if (knowledgeItems.length > 0) {
    knowledgeSection = `\n\n## ZNALOSTNÁ BÁZA (Knowledge Base)\n`;
    knowledgeItems.forEach((item, i) => {
      knowledgeSection += `\n### ${i + 1}. ${item.title}\n${item.content}\n`;
    });
  }

  let ctaInstruction = '';
  switch (widget.cta_type) {
    case 'call':
      ctaInstruction = `\n\n## VÝZVA K AKCII\nKeď zákazník prejaví záujem alebo je pripravený konať, prirodzene ho vyzvi, aby zavolal na číslo: ${config.ctaConfig.phone || ''}. Nezabudni na to pri vhodnej príležitosti.`;
      break;
    case 'contact':
      ctaInstruction = `\n\n## VÝZVA K AKCII\nKeď zákazník prejaví záujem alebo je pripravený konať, ponúkni mu možnosť zanechať kontaktné údaje. Povedz mu, že kliknutím na tlačidlo nižšie môže zanechať svoje meno a email a ozveme sa mu.`;
      break;
    case 'custom':
      ctaInstruction = `\n\n## VÝZVA K AKCII\n${config.ctaConfig.text || ''}`;
      break;
    default:
      ctaInstruction = '';
  }

  let goalsSection = '';
  if (widget.goals && widget.goals.trim()) {
    goalsSection = `\n\n## CIELE A ZAMERANIE\n${widget.goals}`;
  }

  return `Si ${widget.bot_name}, inteligentný asistent pre zákazníkov. Tvoja úloha je pomáhať návštevníkom webovej stránky, odpovedať na ich otázky a sprevádzať ich na ich ceste zákazníka.

## PRAVIDLÁ
- Odpovedaj len na základe znalostnej bázy nižšie. Ak informácia nie je k dispozícii, povez to slušne.
- Buď priateľský, profesionálny a stručný.
- Odpovedaj v jazyku, v ktorom sa zákazník pýta (slovenčina, čeština, angličtina, atď.).
- Nikdy si nevymýšľaj fakty, ceny ani kontaktné informácie.
- Postupne veď zákazníka k akcii.${goalsSection}${knowledgeSection}${ctaInstruction}`;
}

function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Stream a Claude response via SSE.
 * Calls res.write() for each text delta and res.end() when done.
 */
async function streamChatResponse(widget, knowledgeItems, conversationHistory, userMessage, res) {
  const systemPrompt = buildSystemPrompt(widget, knowledgeItems);

  const messages = conversationHistory.map(m => ({
    role: m.role,
    content: m.content,
  }));
  messages.push({ role: 'user', content: userMessage });

  let fullResponse = '';

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      const text = event.delta.text;
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  }

  // Send done signal with the complete response for saving to DB
  res.write(`data: ${JSON.stringify({ done: true, fullText: fullResponse })}\n\n`);
  res.end();

  return fullResponse;
}

module.exports = { streamChatResponse, buildSystemPrompt };
