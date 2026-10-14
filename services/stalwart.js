'use strict';
/**
 * Adaptér na správcovské REST API mail servera Stalwart (vlastný server Neoworkly).
 * Jediné miesto, ktoré pozná cesty API – pri inej verzii Stalwartu stačí upraviť tento súbor.
 * Cesty podľa správcovského API Stalwart 0.11–0.15 (/api/principal, /api/dkim, /api/dns/records);
 * pred nasadením overte voči nainštalovanej verzii (docs/EMAIL-STALWART.md).
 *
 * STALWART_URL         https://mail.neoworkly.com (správcovské rozhranie)
 * STALWART_API_KEY     API kľúč (Bearer) alebo STALWART_ADMIN_USER + STALWART_ADMIN_PASSWORD (Basic)
 * MAIL_HOST            verejný názov mail servera pre MX / IMAP / SMTP (predvolene host zo STALWART_URL)
 */
const base = () => String(process.env.STALWART_URL || '').replace(/\/$/, '');
const configured = () => !!base() && !!(process.env.STALWART_API_KEY || process.env.STALWART_ADMIN_PASSWORD);
const mailHost = () => process.env.MAIL_HOST || (base() ? new URL(base()).hostname : 'mail.neoworkly.com');

function auth() {
  if (process.env.STALWART_API_KEY) return `Bearer ${process.env.STALWART_API_KEY}`;
  return `Basic ${Buffer.from(`${process.env.STALWART_ADMIN_USER || 'admin'}:${process.env.STALWART_ADMIN_PASSWORD}`).toString('base64')}`;
}

async function call(method, path, body) {
  if (!configured()) throw Object.assign(new Error('Mail server nie je nastavený (STALWART_URL).'), { status: 503 });
  const r = await fetch(`${base()}${path}`, {
    method, headers: { Authorization: auth(), Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  // Stalwart vracia chyby aj s HTTP 200 v tvare { error: '…' }
  if (!r.ok || d.error) {
    const msg = d.details || d.reason || d.error || `HTTP ${r.status}`;
    throw Object.assign(new Error(`Mail server: ${msg}`), { status: r.status === 404 ? 404 : 502, code: d.error });
  }
  return d.data ?? d;
}
const alreadyExists = e => /exist/i.test(`${e.code} ${e.message}`);

async function createDomain(domain) {
  try { await call('POST', '/api/principal', { type: 'domain', name: domain, description: 'Neoworkly' }); } catch (e) { if (!alreadyExists(e)) throw e; }
  // DKIM podpis (Ed25519 + RSA kvôli starším príjemcom)
  for (const algorithm of ['Ed25519', 'Rsa']) {
    try { await call('POST', '/api/dkim', { id: null, algorithm, domain, selector: null }); } catch (e) { if (!alreadyExists(e)) throw e; }
  }
}
async function deleteDomain(domain) {
  try { await call('DELETE', `/api/principal/${encodeURIComponent(domain)}`); } catch (e) { if (e.status !== 404) throw e; }
}

/** Záznamy, ktoré klient pridá u svojho registrátora. Ak ich server nevráti, vygenerujeme základné. */
async function dnsRecords(domain) {
  try {
    const list = await call('GET', `/api/dns/records/${encodeURIComponent(domain)}`);
    if (Array.isArray(list) && list.length) return list.map(r => ({ type: r.type, name: r.name, content: r.content }));
  } catch (e) { if (e.status === 503) throw e; }
  const host = mailHost();
  return [
    { type: 'MX', name: `${domain}.`, content: `10 ${host}.` },
    { type: 'TXT', name: `${domain}.`, content: `v=spf1 mx a:${host} ~all` },
    { type: 'TXT', name: `_dmarc.${domain}.`, content: 'v=DMARC1; p=quarantine; adkim=r; aspf=r' },
    { type: 'CNAME', name: `autoconfig.${domain}.`, content: `${host}.` },
  ];
}

/** Používateľský účet (schránka). Prihlasovacie meno = celá adresa. */
async function createMailbox({ address, name, password, quotaMb }) {
  await call('POST', '/api/principal', {
    type: 'individual', name: address, description: name || address, secrets: [password], emails: [address],
    quota: quotaMb ? quotaMb * 1024 * 1024 : 0, roles: ['user'],
  });
}
const setPassword = (address, password) => call('PATCH', `/api/principal/${encodeURIComponent(address)}`, [{ action: 'set', field: 'secrets', value: [password] }]);
async function deleteMailbox(address) {
  try { await call('DELETE', `/api/principal/${encodeURIComponent(address)}`); } catch (e) { if (e.status !== 404) throw e; }
}

module.exports = { configured, mailHost, createDomain, deleteDomain, dnsRecords, createMailbox, setPassword, deleteMailbox };
