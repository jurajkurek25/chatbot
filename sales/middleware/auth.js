'use strict';
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'sales-secret-changeme';

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Neautorizovaný.' });
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Neplatný token.' });
  }
}

module.exports = { requireAuth, SECRET };
