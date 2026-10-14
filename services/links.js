'use strict';
/**
 * Prepojenia medzi položkami modulov (úloha ↔ súbor ↔ poznámka ↔ udalosť ↔ správa…).
 * Každý modul zaregistruje typ: ako zistiť názov a odkaz položky (a či ešte existuje).
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

const types = new Map(); // typ → { label, icon, resolve(ownerId, id) → { title, url } | null }

function registerType(type, def) { types.set(type, def); }
const known = type => types.has(type);

/** Prepojí dve položky (smer nerozhoduje; ukladá sa zoradene, aby nevznikali duplikáty). */
function link(ownerId, a, b, userId) {
  if (!known(a.type) || !known(b.type)) return { error: 'Neznámy typ položky.' };
  if (a.type === b.type && a.id === b.id) return { error: 'Položku nejde prepojiť samu so sebou.' };
  if (!types.get(a.type).resolve(ownerId, a.id) || !types.get(b.type).resolve(ownerId, b.id)) return { error: 'Položka neexistuje.' };
  const [x, y] = `${a.type}:${a.id}` < `${b.type}:${b.id}` ? [a, b] : [b, a];
  getDb().prepare('INSERT OR IGNORE INTO item_links (id, owner_id, a_type, a_id, b_type, b_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), ownerId, x.type, x.id, y.type, y.id, userId || null);
  return { ok: true };
}

function unlink(ownerId, a, b) {
  getDb().prepare(`DELETE FROM item_links WHERE owner_id = ? AND ((a_type = ? AND a_id = ? AND b_type = ? AND b_id = ?) OR (a_type = ? AND a_id = ? AND b_type = ? AND b_id = ?))`)
    .run(ownerId, a.type, a.id, b.type, b.id, b.type, b.id, a.type, a.id);
}

/** Všetko prepojené s položkou, s názvom a odkazom; zmazané položky sa vynechajú (a odkaz uprace). */
function related(ownerId, type, id) {
  const db = getDb();
  const rows = db.prepare(`SELECT b_type AS type, b_id AS id FROM item_links WHERE owner_id = ? AND a_type = ? AND a_id = ?
                           UNION SELECT a_type, a_id FROM item_links WHERE owner_id = ? AND b_type = ? AND b_id = ?`).all(ownerId, type, id, ownerId, type, id);
  const out = [];
  for (const r of rows) {
    const t = types.get(r.type);
    const info = t && t.resolve(ownerId, r.id);
    if (!info) { unlink(ownerId, { type, id }, r); continue; }
    out.push({ type: r.type, id: r.id, label: t.label, icon: t.icon, ...info });
  }
  return out;
}

/** Pri zmazaní položky: zruší všetky jej prepojenia. */
function forget(ownerId, type, id) {
  getDb().prepare('DELETE FROM item_links WHERE owner_id = ? AND ((a_type = ? AND a_id = ?) OR (b_type = ? AND b_id = ?))').run(ownerId, type, id, type, id);
}

module.exports = { registerType, known, link, unlink, related, forget, types };
