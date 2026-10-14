'use strict';

const crypto = require('crypto');

// Verifies Meta (Messenger / Instagram) webhook POSTs via X-Hub-Signature-256 =
// HMAC-SHA256(raw body, app secret). Without it anyone could post fake messages
// and spend the owner's AI credits. req.rawBody is captured by express.json in server.js.
function verifyMetaSignature(req, res, next) {
  const secret = process.env.FB_APP_SECRET || process.env.META_APP_SECRET;
  if (!secret) {
    console.warn('[meta] META_APP_SECRET not set — webhook signature NOT verified.');
    return next();
  }
  const header = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  const ok = header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  if (!ok) {
    console.warn('[meta] Rejected webhook with invalid signature.');
    return res.sendStatus(403);
  }
  next();
}

module.exports = { verifyMetaSignature };
