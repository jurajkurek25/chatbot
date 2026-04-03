'use strict';

const { getDb } = require('../db/database');

function requireSubscription(req, res, next) {
  const db = getDb();
  const user = db.prepare(
    'SELECT subscription_status, free_until FROM users WHERE id = ?'
  ).get(req.userId);

  if (!user) {
    return res.status(403).json({ error: 'Aktívne predplatné je potrebné.', code: 'NO_SUBSCRIPTION' });
  }

  const now = Math.floor(Date.now() / 1000);
  const inFreePeriod = user.free_until && user.free_until > now;

  if (user.subscription_status !== 'active' && !inFreePeriod) {
    return res.status(403).json({ error: 'Aktívne predplatné je potrebné.', code: 'NO_SUBSCRIPTION' });
  }

  next();
}

module.exports = { requireSubscription };
