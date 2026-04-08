'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const client = new Anthropic();

// POST /api/demo/simulate
// Generates a demo sales conversation for the user's business
router.post('/simulate', requireAuth, async (req, res) => {
  const { business } = req.body;
  if (!business || business.trim().length < 3) {
    return res.status(400).json({ error: 'Zadajte popis vášho biznisu.' });
  }

  const biz = business.trim().slice(0, 200);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: `Vygeneruj realistický predajný chat rozhovor pre firmu/biznis: "${biz}".

Ukáž 8 správ striedajúcich zákazníka a AI predajného bota.

Scenár:
1. customer: napíše otázku o produkte/službe
2. bot: teplý pozdrav + kvalifikačná otázka
3. customer: odpovie a povie čo potrebuje
4. bot: identifikuje potrebu, odporučí konkrétnu službu/produkt s benefitmi
5. customer: prejaví záujem ale má námietku (cena alebo čas)
6. bot: zvládne námietku, ponúkne hodnotu
7. customer: hovorí "ok, zaujíma ma to" alebo podobne
8. bot: požiada o kontakt (meno + email) a uzavrie konverzáciu

Výstup MUSÍ byť iba JSON pole bez akéhokoľvek iného textu:
[{"role":"customer","text":"..."},{"role":"bot","text":"..."},...]

Pravidlá:
- Jazyk: slovenčina
- Správy krátke (1-3 vety), prirodzené
- Bot je priateľský, profesionálny, presvedčivý
- Produkty/služby musia dávať zmysel pre daný biznis`,
      }],
    });

    const raw = response.content[0].text.trim();

    // Extract JSON from response (handle markdown code blocks if present)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('Demo simulate: no JSON array found in response:', raw);
      return res.status(500).json({ error: 'Chyba generovania demo konverzácie.' });
    }

    const messages = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(500).json({ error: 'Neplatná odpoveď od AI.' });
    }

    return res.json({ messages });
  } catch (err) {
    console.error('Demo simulate error:', err);
    return res.status(500).json({ error: 'Chyba servera pri generovaní dema.' });
  }
});

module.exports = router;
