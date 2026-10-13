// Oznámenia o objednávkach: e-mail obchodníkovi a voliteľný podpísaný webhook (Zapier, Make, vlastný systém).
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const mailer = require('./mailer');

// Webhook nesmie smerovať do súkromnej siete servera (SSRF: interné služby, cloudové metadáta)
const PRIVATE = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  PRIVATE.addSubnet(net6, prefix, 'ipv6');
}

// Iba pre testy a lokálny vývoj: povolí http:// a adresy v súkromnej sieti
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === '1';

function isPrivate(address) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4 zabalená v IPv6
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  return PRIVATE.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

const blockedError = () => new Error('Adresa webhooku smeruje do súkromnej siete.');

// DNS lookup pre http(s).request: kontrola adresy, na ktorú sa naozaj pripojíme (aj proti DNS rebindingu)
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const addresses = Array.isArray(address) ? address : [{ address, family }];
    if (!allowPrivate() && addresses.some((a) => isPrivate(a.address))) return callback(blockedError());
    callback(null, address, family);
  });
}

function validateWebhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Neplatná URL webhooku.';
  }
  if (url.protocol !== 'https:' && !(allowPrivate() && url.protocol === 'http:')) return 'URL webhooku musí začínať https://';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate() && (host === 'localhost' || (net.isIP(host) && isPrivate(host)))) return blockedError().message;
  return null;
}

// Podpis ako pri Stripe: hlavička "t=<čas>,v1=<HMAC-SHA256 z "<čas>.<telo>">"
function signature(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const newWebhookSecret = () => `nwsec_${crypto.randomBytes(24).toString('base64url')}`;

// Jeden pokus o doručenie; úspech = HTTP 2xx do 5 s
function deliver(url, secret, payload) {
  return new Promise((resolve, reject) => {
    const invalid = validateWebhookUrl(url);
    if (invalid) return reject(new Error(invalid));
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? https : http).request(
      target,
      {
        method: 'POST',
        lookup: safeLookup,
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Neoworkly-Webhooks/1.0',
          'Neoworkly-Signature': signature(secret, body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
        else reject(new Error(`Webhook odpovedal HTTP ${res.statusCode}`));
      },
    );
    request.on('timeout', () => request.destroy(new Error('Webhook neodpovedal do 5 s')));
    request.on('error', reject);
    request.end(body);
  });
}

// Opakovanie pri zlyhaní (v pamäti procesu – reštart servera nedoručené opakovania zahodí)
const retryDelays = () =>
  (process.env.WEBHOOK_RETRY_DELAYS_MS || '10000,60000,300000').split(',').map(Number);

async function deliverWithRetries(url, secret, payload) {
  const delays = [0, ...retryDelays()];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    try {
      return await deliver(url, secret, payload);
    } catch (err) {
      console.error(`[webhook] ${payload.id} pokus ${attempt + 1}/${delays.length}: ${err.message}`);
    }
  }
  return null;
}

const { formatMoney } = require('./currency');

// Adresa na doručenie ako riadky do e-mailu
function formatShipping({ name, phone, address = {} }) {
  const cityLine = [address.postal_code, address.city].filter(Boolean).join(' ');
  return [name, address.line1, address.line2, cityLine, address.state, address.country, phone].filter(Boolean).join('\n');
}

// Objednávka dokončená: e-mail a webhook podľa nastavení obchodníka. Nikdy nevyhodí chybu.
async function orderCompleted(merchant, order) {
  const settings = { email: true, webhookUrl: '', ...merchant.funnel.notifications };
  const test = order.mode === 'test' ? '[TEST] ' : '';
  const tasks = [];
  if (settings.email) {
    tasks.push(
      mailer.sendMail({
        to: merchant.email,
        subject: `${test}Nová objednávka: ${order.product.name} – ${formatMoney(order.amount, order.currency)}`,
        text: [
          `${test}Nová objednávka vo funneli Neoworkly`,
          '',
          `Produkt: ${order.product.name} × ${order.quantity}`,
          `Suma: ${formatMoney(order.amount, order.currency)}`,
          `Zákazník: ${order.customer.email || '—'}`,
          `Krok funnela: ${order.step}`,
          ...Object.entries(order.fields || {}).map(([label, value]) => `${label}: ${value}`),
          ...(order.shipping ? ['', 'Doručenie:', formatShipping(order.shipping)] : []),
          '',
          `Platba v tvojom Stripe: https://dashboard.stripe.com${order.mode === 'test' ? '/test' : ''}/payments/${order.paymentIntentId}`,
        ].join('\n'),
      }),
    );
  }
  if (settings.webhookUrl) tasks.push(deliverWithRetries(settings.webhookUrl, settings.webhookSecret, order));
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') console.error('[oznámenie]', r.reason);
}

// Nový kontakt z kroku „Zadarmo za kontakt“: e-mail a webhook podľa nastavení. Nikdy nevyhodí chybu.
async function leadCaptured(merchant, lead) {
  const settings = { email: true, webhookUrl: '', ...merchant.funnel.notifications };
  const test = lead.mode === 'test' ? '[TEST] ' : '';
  const tasks = [];
  if (settings.email) {
    const what = [lead.delivered.product && `produkt „${lead.delivered.product}“`, lead.delivered.leadMagnet && `lead magnet „${lead.delivered.leadMagnet}“`]
      .filter(Boolean).join(' a ');
    tasks.push(mailer.sendMail({
      to: merchant.email,
      subject: `${test}Nový kontakt: ${lead.customer.email}`,
      text: [
        `${test}Nový kontakt vo funneli Neoworkly`,
        '',
        `E-mail: ${lead.customer.email}`,
        ...(lead.customer.name ? [`Meno: ${lead.customer.name}`] : []),
        `Súhlas s novinkami: ${lead.marketingConsent ? 'áno' : 'nie'}`,
        `Krok funnela: ${lead.step}`,
        ...(what ? [`Poslali sme: ${what}`] : []),
        '',
        'Kontakt nájdeš v Neoworkly v sekcii Kontakty.',
      ].join('\n'),
    }));
  }
  if (settings.webhookUrl) tasks.push(deliverWithRetries(settings.webhookUrl, settings.webhookSecret, lead));
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') console.error('[oznámenie]', r.reason);
}

module.exports = { orderCompleted, leadCaptured, deliver, validateWebhookUrl, signature, newWebhookSecret };
