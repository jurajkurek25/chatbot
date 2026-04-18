'use strict';
const https = require('https');

const WA_API_VERSION = 'v21.0';

function waRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'graph.facebook.com',
      path: `/${WA_API_VERSION}/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sendTextMessage(phoneNumberId, to, text, token) {
  return waRequest('POST', `${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  }, token);
}

async function markAsRead(phoneNumberId, messageId, token) {
  return waRequest('POST', `${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  }, token);
}

module.exports = { sendTextMessage, markAsRead, waRequest };
