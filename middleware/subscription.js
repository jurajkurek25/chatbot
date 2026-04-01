'use strict';

const { getDb } = require('../db/database');

function requireSubscription(req, res, next) {
  const db = getDb();
  const user = db.prepare(
    'SELECT subscription_status FROM users WHERE id = ?'
  ).get(req.userId);

  if (!user || user.subscription_status !== 'active') {
    return res.status(403).json({
      error: 'Aktívne predplatné je potrebné.',
      code: 'NO_SUBSCRIPTION',
    });
  }
  next();
}

module.exports = { requireSubscription };
