const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.LIVE_JWT_SECRET || 'live_secret_change_me';

function authClient(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'client') return res.status(403).json({ error: 'Forbidden' });
    req.clientId = payload.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function authOperator(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'operator') return res.status(403).json({ error: 'Forbidden' });
    req.operatorId = payload.id;
    req.clientId = payload.clientId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function authAny(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    req.clientId = payload.clientId || payload.id;
    req.operatorId = payload.role === 'operator' ? payload.id : null;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { authClient, authOperator, authAny };
