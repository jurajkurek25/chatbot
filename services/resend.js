'use strict';
/**
 * Resend API (https://api.resend.com) cez fetch, bez SDK. RESEND_API_URL prepíše adresu (testy).
 * Webhooky podpisuje Svix: HMAC-SHA256 nad "id.timestamp.telo", kľúč = base64 časť "whsec_…".
 */
const crypto = require('crypto');

const base = () => (process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/$/, '');
const configured = () => Boolean(process.env.RESEND_API_KEY);

async function request(method, path, body, headers = {}) {
  if (!configured()) throw new Error('E-mail marketing nie je nastavený (chýba RESEND_API_KEY).');
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Resend ${res.status}`), { status: res.status });
  return data;
}

/** Overí podpis webhooku; vráti udalosť alebo null. */
function verifyWebhook(rawBody, headers, secret = process.env.RESEND_WEBHOOK_SECRET, now = Date.now()) {
  if (!secret || !rawBody) return null;
  const id = headers['svix-id'] || headers['webhook-id'];
  const ts = headers['svix-timestamp'] || headers['webhook-timestamp'];
  const sigs = String(headers['svix-signature'] || headers['webhook-signature'] || '');
  if (!id || !/^\d+$/.test(ts || '') || Math.abs(now / 1000 - Number(ts)) > 5 * 60) return null;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  const ok = sigs.split(' ').some(part => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!ok) return null;
  try { return JSON.parse(String(rawBody)); } catch { return null; }
}

module.exports = { request, configured, verifyWebhook };
