'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0,1,I,O,L to avoid confusion
function generateCode() {
  const seg = () => Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  return `NEOW-${seg()}-${seg()}-${seg()}`;
}

// POST /api/gift-cards/checkout — create Stripe checkout (public, no auth)
router.post('/checkout', async (req, res) => {
  const { amount, buyer_email, buyer_name = '', recipient_email = '', message = '' } = req.body;

  const amountEur = parseFloat(amount);
  if (!amountEur || amountEur < 5 || amountEur > 500) {
    return res.status(400).json({ error: 'Suma musí byť medzi €5 a €500.' });
  }
  if (!buyer_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)) {
    return res.status(400).json({ error: 'Zadajte platný email.' });
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Neoworkly darčeková karta (€${amountEur.toFixed(2)})`,
            description: recipient_email ? `Pre: ${recipient_email}` : 'Darčeková karta Neoworkly',
          },
          unit_amount: Math.round(amountEur * 100),
        },
        quantity: 1,
      }],
      customer_email: buyer_email,
      locale: 'sk',
      success_url: `${baseUrl}/darcek?success=1&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/darcek`,
      metadata: {
        type: 'gift_card',
        amount_eur: amountEur.toFixed(2),
        buyer_email,
        buyer_name: buyer_name.slice(0, 100),
        recipient_email: recipient_email.slice(0, 200),
        message: message.slice(0, 300),
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[gift-card checkout]', err.message);
    res.status(500).json({ error: 'Chyba pri vytváraní platby.' });
  }
});

// GET /api/gift-cards/status?session=xxx — get gift card data after successful payment
router.get('/status', (req, res) => {
  const db = getDb();
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Chýba session.' });

  const card = db.prepare('SELECT code, amount_eur, buyer_name, recipient_email, message, created_at FROM gift_cards WHERE stripe_session_id = ?').get(session);
  if (!card) return res.status(404).json({ error: 'Darčeková karta ešte nebola vygenerovaná.' });

  res.json(card);
});

// Allowed characters in a valid gift card code
const CODE_REGEX = /^NEOW-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

// POST /api/gift-cards/redeem — redeem a gift card code (requires auth)
router.post('/redeem', requireAuth, (req, res) => {
  const db = getDb();
  const { code } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Zadajte kód.' });

  const normalised = code.trim().toUpperCase();

  // Validate code format before hitting DB
  if (!CODE_REGEX.test(normalised)) {
    return res.status(400).json({ error: 'Neplatný formát kódu.' });
  }

  const card = db.prepare('SELECT * FROM gift_cards WHERE code = ?').get(normalised);

  if (!card) return res.status(404).json({ error: 'Kód neexistuje. Skontrolujte správnosť kódu.' });
  if (card.used) return res.status(409).json({ error: 'Tento kód bol už použitý.' });

  // Security: card must have been created by a real Stripe webhook (not a manually inserted record)
  if (!card.stripe_session_id) {
    return res.status(403).json({ error: 'Táto darčeková karta nie je platná.' });
  }

  // Validate amount (must be positive and within bounds)
  const amount = parseFloat(card.amount_eur);
  if (!amount || amount <= 0 || amount > 500) {
    return res.status(403).json({ error: 'Neplatná hodnota darčekovej karty.' });
  }

  // Atomic redemption — WHERE used = 0 prevents double-spend under concurrent requests
  const redeemResult = db.prepare(
    "UPDATE gift_cards SET used = 1, used_by = ?, redeemed_at = datetime('now') WHERE id = ? AND used = 0"
  ).run(req.userId, card.id);
  if (redeemResult.changes === 0) {
    return res.status(409).json({ error: 'Tento kód bol práve použitý.' });
  }
  db.prepare('UPDATE users SET referral_credits = referral_credits + ? WHERE id = ?').run(amount, req.userId);

  // Log credit transaction
  const { v4: uuidv4 } = require('uuid');
  db.prepare('INSERT OR IGNORE INTO credit_transactions (id, user_id, type, amount, note) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), req.userId, 'gift_card', Math.round(amount * 100), `Gift card ${card.code}`);

  console.log(`[gift-card] Code ${card.code} redeemed by user ${req.userId} — €${amount}`);
  res.json({ ok: true, amount_eur: amount });
});

module.exports = { router, generateCode };
