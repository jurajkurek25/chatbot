'use strict';
/**
 * Videohovory cez Jitsi Meet: miestnosť patrí pracovnému priestoru (chat, úloha alebo udalosť kalendára).
 * JITSI_DOMAIN – vlastný server (potom sa hovor vloží priamo do Neoworkly; meet.jit.si vkladanie obmedzuje na 5 min).
 * JITSI_APP_ID + JITSI_APP_SECRET – overenie tokenom (JWT, prosody token auth): do miestnosti vstúpi iba člen priestoru.
 */
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { meetUrl, newRoom } = require('./calendar');
const workspace = require('./workspace');

const domain = () => process.env.JITSI_DOMAIN || 'meet.jit.si';

function create(ownerId, title, userId) {
  const room = newRoom();
  getDb().prepare('INSERT INTO meetings (room, owner_id, title, created_by) VALUES (?, ?, ?, ?)').run(room, ownerId, String(title || '').slice(0, 200), userId);
  return room;
}

/** Komu miestnosť patrí: { ownerId, title } alebo null. */
function find(room) {
  const db = getDb();
  return db.prepare('SELECT owner_id AS ownerId, title FROM meetings WHERE room = ?').get(room)
    || db.prepare('SELECT owner_id AS ownerId, title FROM calendar_events WHERE meeting_room = ?').get(room) || null;
}

/** Údaje na pripojenie pre člena priestoru (inak null). */
function join(userId, room) {
  const m = find(String(room || ''));
  const role = m && workspace.roleIn(userId, m.ownerId);
  if (!role) return null;
  const u = getDb().prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
  let token = null;
  if (process.env.JITSI_APP_ID && process.env.JITSI_APP_SECRET) {
    token = jwt.sign({ aud: 'jitsi', iss: process.env.JITSI_APP_ID, sub: domain(), room,
      context: { user: { id: u.id, name: u.name, email: u.email, moderator: role === 'owner' } } }, process.env.JITSI_APP_SECRET, { expiresIn: '3h' });
  }
  return { room, title: m.title, domain: domain(), url: meetUrl(room) + (token ? `?jwt=${token}` : ''), jwt: token, embed: !!process.env.JITSI_DOMAIN, user: { name: u.name, email: u.email } };
}

module.exports = { domain, create, find, join };
