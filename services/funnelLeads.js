'use strict';
/**
 * Funnel step "free for a contact": saves the contact in Contacts (the chosen widget, or the
 * lead magnet's widget) and e-mails the free digital product and/or lead magnet.
 * Test-mode leads are delivered (so the merchant sees the e-mail) but not stored as contacts.
 */

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const shop = require('./shop');
const notifyMod = require('./bookingNotify');

const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');

/** What the merchant can offer in a lead step (only their own products, lead magnets and widgets). */
function leadOptions(userId) {
  const db = getDb();
  return {
    products: db.prepare('SELECT id, title, type, price, currency FROM digital_products WHERE user_id = ? AND active = 1 ORDER BY created_at DESC').all(userId),
    leadMagnets: db.prepare(`SELECT lm.id, lm.name, lm.widget_id AS widgetId, w.name AS widgetName FROM lead_magnets lm
                             JOIN widgets w ON w.id = lm.widget_id WHERE w.user_id = ? AND lm.active = 1 ORDER BY lm.created_at DESC`).all(userId),
    widgets: db.prepare('SELECT id, name FROM widgets WHERE user_id = ? ORDER BY created_at').all(userId),
  };
}

/** Validates step.deliver against the merchant's account → cleaned object or { error }. */
function cleanDeliver(userId, input = {}) {
  const opts = leadOptions(userId);
  const out = {};
  if (input.productId) {
    if (!opts.products.some(p => p.id === input.productId)) return { error: 'Neznámy digitálny produkt.' };
    out.productId = input.productId;
  }
  if (input.leadMagnetId) {
    if (!opts.leadMagnets.some(l => l.id === input.leadMagnetId)) return { error: 'Neznámy lead magnet.' };
    out.leadMagnetId = input.leadMagnetId;
  }
  if (input.widgetId) {
    if (!opts.widgets.some(w => w.id === input.widgetId)) return { error: 'Neznámy widget pre kontakty.' };
    out.widgetId = input.widgetId;
  }
  return { deliver: out };
}

async function sendLeadMagnet(userId, lm, email, name) {
  const store = shop.storeOf(userId);
  const url = /^https?:\/\//.test(lm.file_url || '') ? lm.file_url : `${appUrl()}${lm.file_url}`;
  return notifyMod.sendMail({
    to: email, business: store.name, replyTo: store.supportEmail || undefined,
    subject: `${lm.name} – váš materiál zadarmo`,
    html: notifyMod.layout({ color: store.color, business: store.name }, {
      heading: 'Váš materiál je pripravený ✓',
      intro: `Dobrý deň${name ? ' ' + notifyMod.esc(name) : ''}, ďakujeme za záujem. ${notifyMod.esc(lm.description || '')}`,
      buttons: [[`⬇ Stiahnuť: ${lm.name}`, url, true]],
    }),
  });
}

/**
 * @returns {Promise<{ product: string|null, leadMagnet: string|null }>} names of what was sent
 */
async function captureLead({ merchant, step, email, name, marketing, mode }) {
  const db = getDb();
  const userId = merchant.neoworkly_user_id;
  const deliver = step.deliver || {};
  const delivered = { product: null, leadMagnet: null };
  if (!userId) return delivered;

  const lm = deliver.leadMagnetId && db.prepare(`SELECT lm.* FROM lead_magnets lm JOIN widgets w ON w.id = lm.widget_id
                                                 WHERE lm.id = ? AND w.user_id = ? AND lm.active = 1`).get(deliver.leadMagnetId, userId);
  const widgetId = (deliver.widgetId && db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(deliver.widgetId, userId)?.id)
    || (lm && lm.widget_id)
    || db.prepare('SELECT id FROM widgets WHERE user_id = ? ORDER BY created_at LIMIT 1').get(userId)?.id || null;

  if (mode === 'live' && widgetId) {
    const existing = db.prepare('SELECT id, marketing_consent FROM leads WHERE widget_id = ? AND lower(email) = ?').get(widgetId, email);
    if (existing) {
      // Súhlas s novinkami sa nikdy neodoberie novým formulárom (odvolanie ide cez odhlásenie)
      if (marketing && !existing.marketing_consent) db.prepare('UPDATE leads SET marketing_consent = 1 WHERE id = ?').run(existing.id);
    } else {
      db.prepare(`INSERT INTO leads (id, widget_id, name, email, chat_summary, gdpr_consent, marketing_consent, source)
                  VALUES (?, ?, ?, ?, ?, 1, ?, 'funnel')`)
        .run(uuidv4(), widgetId, name || email.split('@')[0], email, `Funnel – krok „${step.id}“`, marketing ? 1 : 0);
    }
  }

  if (lm) {
    if (mode === 'live' && !db.prepare('SELECT 1 FROM lead_magnet_leads WHERE lead_magnet_id = ? AND email = ?').get(lm.id, email)) {
      db.prepare('INSERT INTO lead_magnet_leads (id, lead_magnet_id, widget_id, email, name) VALUES (?, ?, ?, ?, ?)')
        .run(uuidv4(), lm.id, lm.widget_id, email, name || '');
    }
    await sendLeadMagnet(userId, lm, email, name).catch(err => console.error('[funnel lead magnet]', err.message));
    delivered.leadMagnet = lm.name;
  }

  const product = deliver.productId && db.prepare('SELECT * FROM digital_products WHERE id = ? AND user_id = ? AND active = 1').get(deliver.productId, userId);
  if (product) {
    // Zadarmo za kontakt: objednávka s nulovou sumou => prístup a e-mail s odkazmi (ako pri nákupe)
    const order = shop.createOrder({ userId, product, email, name, amount: 0 });
    await shop.fulfilOrder(order.id).catch(err => console.error('[funnel product]', err.message));
    delivered.product = product.title;
  }
  return delivered;
}

module.exports = { leadOptions, cleanDeliver, captureLead };
