'use strict';
/**
 * Upozornenia v aplikácii (zvonček v dashboarde): uložia sa, pošlú cez WebSocket a voliteľne e-mailom.
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const realtime = require('./realtime');

const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');

/**
 * @param {string[]|string} userIds komu (autor akcie sa vynechá cez exceptUserId)
 * @param {{ ownerId, type, title, body?, url?, email? }} n  email: true => aj e-mail
 */
function notify(userIds, n, exceptUserId) {
  const ids = [...new Set([].concat(userIds || []))].filter(id => id && id !== exceptUserId);
  const db = getDb();
  for (const userId of ids) {
    const row = { id: uuidv4(), user_id: userId, owner_id: n.ownerId || null, type: n.type, title: String(n.title).slice(0, 200), body: String(n.body || '').slice(0, 1000), url: n.url || '' };
    db.prepare('INSERT INTO notifications (id, user_id, owner_id, type, title, body, url) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.owner_id, row.type, row.title, row.body, row.url);
    realtime.publishUser(userId, { type: 'notification', notification: { ...row, created_at: Math.floor(Date.now() / 1000) } });
    if (n.email) sendEmail(userId, row).catch(err => console.error('[notify mail]', err.message));
  }
}

async function sendEmail(userId, row) {
  const u = getDb().prepare('SELECT email FROM users WHERE id = ?').get(userId);
  if (!u) return;
  const mail = require('./bookingNotify');
  await mail.sendMail({
    to: u.email, business: 'Neoworkly', subject: row.title,
    html: mail.layout({ color: '#5b4fff', business: 'Neoworkly' }, {
      heading: row.title, intro: mail.esc(row.body).replace(/\n/g, '<br>'),
      buttons: row.url ? [['Otvoriť v Neoworkly', row.url.startsWith('http') ? row.url : appUrl() + row.url, true]] : [],
    }),
  });
}

function list(userId, limit = 50) {
  return getDb().prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}
const unread = userId => getDb().prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
function markRead(userId, id) {
  if (id) getDb().prepare('UPDATE notifications SET read_at = unixepoch() WHERE id = ? AND user_id = ? AND read_at IS NULL').run(id, userId);
  else getDb().prepare('UPDATE notifications SET read_at = unixepoch() WHERE user_id = ? AND read_at IS NULL').run(userId);
}

module.exports = { notify, list, unread, markRead };
