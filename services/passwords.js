'use strict';
/**
 * Password hashes: bcrypt (Neoworkly) and scrypt ("scrypt$salt$hash", accounts migrated from
 * Neoworkly Funnel). Scrypt hashes are upgraded to bcrypt after a successful login.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;
const isLegacy = hash => typeof hash === 'string' && hash.startsWith('scrypt$');

async function verify(password, hash) {
  if (!hash) return false;
  if (isLegacy(hash)) {
    const [, salt, expected] = hash.split('$');
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const exp = Buffer.from(expected, 'hex');
    return exp.length === candidate.length && crypto.timingSafeEqual(candidate, exp);
  }
  return bcrypt.compare(String(password), hash);
}

const hash = password => bcrypt.hash(String(password), SALT_ROUNDS);

module.exports = { verify, hash, isLegacy, SALT_ROUNDS };
