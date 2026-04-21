const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateSummary(chats) {
  const transcripts = chats.map((c, i) =>
    `--- Rozhovor ${i + 1} (${c.started_at?.slice(0, 10)}, návštevník: ${c.visitor_name}) ---\n${c.transcript || '(prázdny)'}`
  ).join('\n\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `Si analytik krízového live chatu. Analyzuješ prepisy rozhovorov medzi operátormi a návštevníkmi krízovej linky.
Tvojou úlohou je identifikovať najčastejšie témy a problémy, s ktorými ľudia prichádzajú, a poskytnúť stručné štatistické zhrnutie.
Nikdy nespomínaj konkrétne osobné údaje. Zachovaj citlivý a empatický tón.`,
    messages: [
      {
        role: 'user',
        content: `Analyzuj nasledujúcich ${chats.length} rozhovorov z krízového chatu a vytvor stručné zhrnutie:
- Aké sú najčastejšie témy / problémy?
- Aké vzory sa opakujú?
- Odporúčania pre operátorov (ak je to vhodné)

Rozhovory:\n\n${transcripts}`
      }
    ]
  });

  return message.content[0].text;
}

module.exports = { generateSummary };
