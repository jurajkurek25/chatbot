'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const client = new Anthropic();

// POST /api/demo/simulate
// Generates a demo sales conversation for the user's business
const DEMO_LANG_NAMES = {
  sk: 'slovenčina', en: 'English', de: 'Deutsch', fr: 'français',
  es: 'español', pl: 'polski', cs: 'čeština', hu: 'magyar', ro: 'română', hr: 'hrvatski',
};

router.post('/simulate', requireAuth, async (req, res) => {
  const { business, lang = 'sk' } = req.body;
  if (!business || business.trim().length < 3) {
    return res.status(400).json({ error: 'Zadajte popis vášho biznisu.' });
  }

  const biz = business.trim().slice(0, 200);
  const langName = DEMO_LANG_NAMES[lang] || 'slovenčina';

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: `Generate a realistic sales chat conversation for this business: "${biz}".

Show 8 messages alternating between a customer and an AI sales bot.

Scenario:
1. customer: asks a question about the product/service
2. bot: warm greeting + qualifying question
3. customer: replies and explains what they need
4. bot: identifies the need, recommends a specific service/product with benefits
5. customer: shows interest but has an objection (price or time)
6. bot: handles objection, offers value
7. customer: says "ok, I'm interested" or similar
8. bot: asks for contact info (name + email) and closes

Output MUST be ONLY a JSON array with no other text:
[{"role":"customer","text":"..."},{"role":"bot","text":"..."},...]

Rules:
- Language: ${langName} (write ALL messages in this language)
- Messages short (1-3 sentences), natural
- Bot is friendly, professional, persuasive
- Products/services must make sense for the given business`,
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
