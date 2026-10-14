'use strict';
/**
 * Pracovný priestor = účet majiteľa + jeho tím (team_members: readonly / editor).
 * Zdieľajú ho všetky tímové moduly (Disk, Úlohy, Kalendár, Poznámky, Dokumenty, Chat…).
 */
const { getDb } = require('../db/database');

/** Rola používateľa v priestore majiteľa: 'owner' | 'editor' | 'readonly' | null */
function roleIn(userId, ownerId) {
  if (!ownerId || userId === ownerId) return 'owner';
  const t = getDb().prepare('SELECT role FROM team_members WHERE owner_user_id = ? AND member_user_id = ? AND accepted = 1').get(ownerId, userId);
  return t ? t.role : null;
}
const canWrite = role => role === 'owner' || role === 'editor';

/** Priestory, do ktorých používateľ patrí (vlastný ako prvý). */
function list(userId) {
  const me = getDb().prepare('SELECT name FROM users WHERE id = ?').get(userId);
  const teams = getDb().prepare(`SELECT t.owner_user_id AS ownerId, t.role, u.name FROM team_members t JOIN users u ON u.id = t.owner_user_id
                                 WHERE t.member_user_id = ? AND t.accepted = 1`).all(userId);
  return [{ ownerId: userId, role: 'owner', name: me?.name || 'Môj priestor', mine: true }, ...teams];
}

/** Ľudia v priestore (majiteľ + prijatí členovia tímu) – riešitelia úloh, zmienky v chate. */
function members(ownerId) {
  const db = getDb();
  const owner = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(ownerId);
  const team = db.prepare(`SELECT u.id, u.name, u.email, t.role FROM team_members t JOIN users u ON u.id = t.member_user_id
                           WHERE t.owner_user_id = ? AND t.accepted = 1 ORDER BY u.name`).all(ownerId);
  return [{ ...owner, role: 'owner' }, ...team];
}
const isMember = (ownerId, userId) => !!roleIn(userId, ownerId);

/** Express middleware: ?ws= alebo body.ws → req.ownerId, req.role (404, ak nepatrí do priestoru). */
function middleware(req, res, next) {
  const ownerId = String(req.query.ws || req.body?.ws || req.userId);
  const role = roleIn(req.userId, ownerId);
  if (!role) return res.status(404).json({ error: 'Priestor nenájdený.' });
  req.ownerId = ownerId;
  req.role = role;
  next();
}
const writer = (req, res, next) => canWrite(req.role) ? next() : res.status(403).json({ error: 'Máte prístup iba na čítanie.' });

module.exports = { roleIn, canWrite, list, members, isMember, middleware, writer };
