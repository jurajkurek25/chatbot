'use strict';
const https = require('https');

function volaiRequest(apiKey, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'volai.cz',
      path,
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sendSms(apiKey, to, body) {
  const res = await volaiRequest(apiKey, 'POST', '/v1/messages', { to, body });
  if (res.status >= 400) throw new Error(`volai SMS error ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function makeCall(apiKey, agentId, to) {
  const res = await volaiRequest(apiKey, 'POST', '/v1/calls', { agentId, to });
  if (res.status >= 400) throw new Error(`volai call error ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function getBalance(apiKey) {
  const res = await volaiRequest(apiKey, 'GET', '/v1/balance');
  if (res.status >= 400) throw new Error(`volai balance error ${res.status}`);
  return res.data;
}

module.exports = { sendSms, makeCall, getBalance };
