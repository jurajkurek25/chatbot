'use strict';

const { getDb } = require('../db/database');
const { accessOf } = require('../middleware/subscription');
const { maybeResetUsage } = require('../routes/credits');
const { sendUsageNotification } = require('./email');

// Can this widget owner get another AI response? Shared by web chat, Messenger and Instagram.
// Returns { ok, code, owner, access }; code is 'NO_SUBSCRIPTION' or 'LIMIT_REACHED' when !ok.
function checkUsage(userId) {
  const db = getDb();
  const owner = db.prepare(
    'SELECT id, email, name, ai_responses_this_month, ai_responses_reset_at, extra_response_credits, usage_notified_80, usage_notified_100, subscription_status, free_until, trial_until FROM users WHERE id = ?'
  ).get(userId);
  const access = accessOf(owner);
  if (!access.hasAccess) return { ok: false, code: 'NO_SUBSCRIPTION', owner, access };

  const thisMonth = maybeResetUsage(db, owner.id, owner);
  if (thisMonth >= access.responseLimit && (owner.extra_response_credits || 0) <= 0) {
    return { ok: false, code: 'LIMIT_REACHED', owner, access };
  }
  return { ok: true, owner, access };
}

// Count one AI response (base allowance first, then extra credits) and send 80 % / 100 % e-mails
function recordResponse(owner, access) {
  const db = getDb();
  const limit = access.responseLimit;
  const fresh = db.prepare(
    'SELECT ai_responses_this_month, extra_response_credits, usage_notified_80, usage_notified_100 FROM users WHERE id = ?'
  ).get(owner.id);
  const currentMonth = fresh.ai_responses_this_month || 0;
  const currentExtra = fresh.extra_response_credits || 0;

  if (currentMonth < limit) {
    db.prepare('UPDATE users SET ai_responses_this_month = ai_responses_this_month + 1 WHERE id = ?').run(owner.id);
  } else if (currentExtra > 0) {
    db.prepare('UPDATE users SET extra_response_credits = extra_response_credits - 1 WHERE id = ?').run(owner.id);
  }

  const newCount = currentMonth + 1;
  const notify = pct => sendUsageNotification({
    toEmail: owner.email, ownerName: owner.name, pct, extra: currentExtra,
    limit, used: Math.min(newCount, limit), inTrial: access.inTrial,
  }).catch(() => {});
  if (newCount >= limit && !fresh.usage_notified_100) {
    db.prepare('UPDATE users SET usage_notified_100 = 1 WHERE id = ?').run(owner.id);
    notify(100);
  } else if (newCount >= limit * 0.8 && !fresh.usage_notified_80) {
    db.prepare('UPDATE users SET usage_notified_80 = 1 WHERE id = ?').run(owner.id);
    notify(80);
  }
}

module.exports = { checkUsage, recordResponse };
