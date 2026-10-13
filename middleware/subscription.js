'use strict';

const { getDb } = require('../db/database');

const TRIAL_DAYS = 14;
const TRIAL_RESPONSES = 100;
const BASE_RESPONSES = 500;

// Paid (subscription or referral free months) → full limit; 14-day trial → reduced limit
function accessOf(user) {
  const now = Math.floor(Date.now() / 1000);
  const paid = !!user && (user.subscription_status === 'active' || (user.free_until && user.free_until > now));
  const inTrial = !!user && !paid && !!(user.trial_until && user.trial_until > now);
  return {
    hasAccess: paid || inTrial,
    inTrial,
    responseLimit: inTrial ? TRIAL_RESPONSES : BASE_RESPONSES,
  };
}

function ownerAccess(userId) {
  const user = getDb().prepare(
    'SELECT subscription_status, free_until, trial_until FROM users WHERE id = ?'
  ).get(userId);
  return accessOf(user);
}

function requireSubscription(req, res, next) {
  const db = getDb();
  const user = db.prepare(
    'SELECT subscription_status, free_until, trial_until FROM users WHERE id = ?'
  ).get(req.userId);

  if (!accessOf(user).hasAccess) {
    return res.status(403).json({ error: 'Aktívne predplatné je potrebné.', code: 'NO_SUBSCRIPTION' });
  }

  next();
}

module.exports = { requireSubscription, accessOf, ownerAccess, TRIAL_DAYS, TRIAL_RESPONSES, BASE_RESPONSES };
