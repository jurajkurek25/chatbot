'use strict';
/**
 * Two-factor login for accounts migrated from Neoworkly Funnel that had TOTP enabled there.
 * The secret, last used step and recovery codes stay on the funnel merchant row (funnel_merchants).
 * Login with a password then returns a short-lived signed challenge instead of a token.
 */
const crypto = require('crypto');
const { getDb } = require('../db/database');

const CHALLENGE_TTL = 5 * 60 * 1000;
// Loaded lazily: funnel/src modules read env defaults set by funnel/index on first require
const totp = () => require('../funnel/src/totp');
const funnelDb = () => require('../funnel/src/db');

const secret = () => process.env.JWT_SECRET || 'changeme';
const sign = body => crypto.createHmac('sha256', secret()).update(`2fa.${body}`).digest('base64url');
// A password change invalidates challenges issued before it
const passwordTag = hash => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 12);

function merchantWithTotp(userId) {
  return getDb().prepare('SELECT * FROM funnel_merchants WHERE neoworkly_user_id = ? AND totp_secret IS NOT NULL').get(userId) || null;
}

function issueChallenge(user) {
  const body = Buffer.from(JSON.stringify({ u: user.id, p: passwordTag(user.password_hash), exp: Date.now() + CHALLENGE_TTL })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Returns the user for a valid, unexpired challenge, otherwise null. */
function readChallenge(challenge) {
  const [body, sig] = String(challenge || '').split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  if (expected.length !== Buffer.byteLength(sig) || !crypto.timingSafeEqual(expected, Buffer.from(sig))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!(data.exp > Date.now())) return null;
  const user = getDb().prepare('SELECT id, email, name, password_hash FROM users WHERE id = ?').get(data.u);
  return user && passwordTag(user.password_hash) === data.p ? user : null;
}

/** Code from the authenticator app (each step only once) or a one-time recovery code. */
async function verify(merchant, code) {
  const t = totp();
  const step = t.verifyCode(t.decrypt(merchant.totp_secret), String(code || '').trim(), merchant.totp_last_step);
  if (step !== null) return funnelDb().useTotpStep(merchant.id, step);
  const hashes = JSON.parse(merchant.recovery_codes || '[]');
  const index = hashes.indexOf(t.hashRecovery(code));
  if (index === -1 || !String(code || '').trim()) return false;
  hashes.splice(index, 1);
  return funnelDb().replaceRecoveryCodes(merchant.id, merchant.recovery_codes, JSON.stringify(hashes));
}

module.exports = { merchantWithTotp, issueChallenge, readChallenge, verify };
