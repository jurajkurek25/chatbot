'use strict';

const https = require('https');

// Rotating discovery queries targeting Slovak/Czech SME segments that fit Neoworkly
const DISCOVERY_QUERIES = [
  'e-shop Slovensko "kontakt" -amazon -aliexpress -ebay',
  'kozmetický salón Slovensko web kontakt',
  'fitness centrum Slovakia web kontakt',
  'realitná kancelária Slovensko web kontakt',
  'kouč konzultant Slovensko web kontakt',
  'reštaurácia catering Slovensko web kontakt',
  'autoservis pneuservis Slovensko web kontakt',
  'lekáreň klinika Slovensko web kontakt',
  'právnik advokát Slovensko web kontakt',
  'účtovník daňový poradca Slovensko web',
  'fitness personal trainer Slovensko web',
  'stavebná firma Slovensko web kontakt',
  'svadba fotograf Slovensko web',
  'hotel penzión Slovensko rezervácia web',
  'zubar zubna ambulancia Slovensko web',
];

async function searchGoogle(query, num = 10) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY nie je nastavený v .env');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ q: query, num, gl: 'sk', hl: 'sk' });
    const opts = {
      hostname: 'google.serper.dev',
      path: '/search',
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Neplatná odpoveď od Serper API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function getNextQuery(db) {
  let idx = 0;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE id = 'discovery_query_idx'").get();
    idx = row ? (parseInt(row.value || '0') + 1) % DISCOVERY_QUERIES.length : 0;
  } catch {}
  try {
    db.prepare("INSERT OR REPLACE INTO settings (id, value) VALUES ('discovery_query_idx', ?)").run(String(idx));
  } catch {}
  return { query: DISCOVERY_QUERIES[idx], idx };
}

module.exports = { searchGoogle, getNextQuery, DISCOVERY_QUERIES };
