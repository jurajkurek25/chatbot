'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');

const router = express.Router();
router.use(requireAuth);

const MONTHLY_PRICE = 29; // €

// GET /api/affiliate/status
router.get('/status', (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT referral_code, referral_credits, credits_redeem_enabled, free_until, subscription_id
    FROM users WHERE id = ?
  `).get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  const referredCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM users WHERE referred_by = ?'
  ).get(req.userId)?.cnt || 0;

  const paidReferrals = db.prepare(
    "SELECT COUNT(*) as cnt FROM users WHERE referred_by = ? AND subscription_status = 'active'"
  ).get(req.userId)?.cnt || 0;

  const now = Math.floor(Date.now() / 1000);
  const freeMonthsAvailable = Math.floor((user.referral_credits || 0) / MONTHLY_PRICE);

  res.json({
    referral_code: user.referral_code,
    referral_credits: user.referral_credits || 0,
    credits_redeem_enabled: Boolean(user.credits_redeem_enabled),
    free_until: user.free_until || null,
    in_free_period: !!(user.free_until && user.free_until > now),
    free_months_available: freeMonthsAvailable,
    referred_count: referredCount,
    paid_referrals: paidReferrals,
    monthly_price: MONTHLY_PRICE,
    share_url: `${process.env.BASE_URL || ''}/?ref=${user.referral_code}`,
  });
});

// POST /api/affiliate/toggle-redeem — zapnúť/vypnúť auto uplatňovanie kreditov
router.post('/toggle-redeem', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT credits_redeem_enabled FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  const newVal = user.credits_redeem_enabled ? 0 : 1;
  db.prepare('UPDATE users SET credits_redeem_enabled = ? WHERE id = ?').run(newVal, req.userId);
  res.json({ credits_redeem_enabled: Boolean(newVal) });
});

// POST /api/affiliate/redeem — uplatniť kredity teraz (pauza predplatného)
router.post('/redeem', async (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT referral_credits, subscription_id, subscription_status, free_until
    FROM users WHERE id = ?
  `).get(req.userId);
  if (!user) return res.status(404).json({ error: 'Používateľ nenájdený.' });

  const credits = user.referral_credits || 0;
  if (credits < MONTHLY_PRICE) {
    return res.status(400).json({ error: `Potrebujete aspoň ${MONTHLY_PRICE}€ kreditov (máte ${credits}€).` });
  }

  const freeMonths = Math.floor(credits / MONTHLY_PRICE);
  const creditsToUse = freeMonths * MONTHLY_PRICE;
  const now = Math.floor(Date.now() / 1000);

  // free_until = teraz + počet voľných mesiacov (30 dní každý)
  const freeUntil = now + freeMonths * 30 * 24 * 3600;

  // Pause Stripe subscription if active
  if (user.subscription_id && user.subscription_status === 'active') {
    try {
      const Stripe = require('stripe');
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.update(user.subscription_id, {
        pause_collection: {
          behavior: 'void',
          resumes_at: freeUntil,
        },
      });
    } catch (err) {
      console.error('[affiliate] Stripe pause error:', err.message);
      // Continue anyway — we still grant the free period server-side
    }
  }

  // Deduct credits, set free_until, enable redeem flag
  db.prepare(`
    UPDATE users
    SET referral_credits = referral_credits - ?,
        free_until = ?,
        credits_redeem_enabled = 1,
        subscription_status = 'active'
    WHERE id = ?
  `).run(creditsToUse, freeUntil, req.userId);

  res.json({
    ok: true,
    free_months: freeMonths,
    credits_used: creditsToUse,
    free_until: freeUntil,
  });
});

// GET /api/affiliate/validate/:code — check if referral code is valid (public)
router.get('/validate/:code', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT name FROM users WHERE referral_code = ?')
    .get(req.params.code.toUpperCase().trim());
  res.json({ valid: !!user });
});

module.exports = router;
