// Dvojfaktorové overenie: TOTP (RFC 6238) – aplikácie Google Authenticator, Authy, 1Password…
const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function base32Decode(text) {
  const bits = text
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '')
    .split('')
    .map((c) => B32.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// HOTP (RFC 4226) pre daný krok času
function hotp(secret, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = hash[hash.length - 1] & 0xf;
  const code = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function otpauthUri(email, secret) {
  const label = encodeURIComponent(`Neoworkly:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Neoworkly&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// Overí kód s toleranciou ±1 krok (posun hodín). Kód z už použitého kroku neprijme (opakovanie).
// Vráti krok, ktorý sa má uložiť ako posledný použitý, alebo null.
function verifyCode(secret, code, lastStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const key = base32Decode(secret);
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    const expected = hotp(key, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(code)))) return s;
  }
  return null;
}

// --- Šifrovanie tajomstva v databáze (AES-256-GCM) -------------------------------------
// TOTP_ENCRYPTION_KEYS="nový,starší": prvým kľúčom sa šifruje, všetkými sa dá dešifrovať
// (výmena kľúča: pridaj nový na začiatok, spusti scripts/rotate-totp-key.js, starý odober).
// Bez nich sa použije kľúč odvodený z COOKIE_SECRET (formát v1) – vtedy COOKIE_SECRET nemeň.
const derive = (secret, info) => Buffer.from(crypto.hkdfSync('sha256', secret, 'neoworkly', info, 32));
const keyId = (secret) => crypto.createHash('sha256').update(secret).digest('base64url').slice(0, 8);

let cached = { env: null, keys: [] };
function keys() {
  const env = process.env.TOTP_ENCRYPTION_KEYS || '';
  if (cached.env !== env) {
    const list = env.split(',').map((k) => k.trim()).filter(Boolean);
    if (list.some((k) => k.length < 32)) throw new Error('Každý kľúč v TOTP_ENCRYPTION_KEYS musí mať aspoň 32 znakov.');
    cached = { env, keys: list.map((k) => ({ id: keyId(k), key: derive(k, 'totp-secret-v2') })) };
  }
  return cached.keys;
}
const legacyKey = () => derive(process.env.COOKIE_SECRET, 'totp-secret');

function seal(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((p) => p.toString('base64url')).join(':');
}

function open(key, [iv, tag, data]) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

function encrypt(text) {
  const [current] = keys();
  return current ? `v2:${current.id}:${seal(current.key, text)}` : `v1:${seal(legacyKey(), text)}`;
}

function decrypt(stored) {
  const [version, ...parts] = stored.split(':');
  if (version === 'v1') return open(legacyKey(), parts);
  const [id, ...rest] = parts;
  const found = keys().find((k) => k.id === id);
  if (!found) throw new Error(`Chýba kľúč ${id} v TOTP_ENCRYPTION_KEYS – zašifrované údaje (2FA, Stripe kľúč) sa nedajú prečítať.`);
  return open(found.key, rest);
}

// Je zašifrované iným ako aktuálnym kľúčom? (treba prešifrovať)
function needsReencrypt(stored) {
  const [current] = keys();
  return Boolean(current) && !stored.startsWith(`v2:${current.id}:`);
}

// --- Záložné kódy (jednorazové, v DB iba hash) ------------------------------------------
const normalizeRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(normalizeRecovery(code)).digest('hex');

function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

module.exports = {
  generateSecret,
  otpauthUri,
  verifyCode,
  hotp,
  base32Decode,
  encrypt,
  decrypt,
  needsReencrypt,
  generateRecoveryCodes,
  hashRecovery,
};
