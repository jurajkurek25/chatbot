'use strict';
/**
 * Tabuľky: bunky sú v zdieľanom Yjs dokumente „sheet:<priestor>:<id>“
 * (mapa „cells“: „hárok:riadok:stĺpec“ → { v, s }, pole „tabs“: hárky). Na Disku je tabuľka položka s odkazom.
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const drive = require('./drive');
const realtime = require('./realtime');
const links = require('./links');

const MIME = 'application/vnd.neoworkly.sheet';
const sheetName = (ownerId, id) => `sheet:${ownerId}:${id}`;
const openUrl = (ownerId, id) => `/sheets/${id}?ws=${ownerId}`;

const getSheet = (ownerId, id) => getDb().prepare('SELECT * FROM sheets WHERE id = ? AND owner_id = ?').get(id, ownerId);
/** Tabuľka je dostupná, kým jej položka na Disku nie je v koši. */
function liveSheet(ownerId, id) {
  const b = getSheet(ownerId, id);
  const item = b && b.drive_item_id && drive.getItem(ownerId, b.drive_item_id);
  return item && !item.trashed_at ? b : null;
}

/** Texty buniek (hľadanie). */
function textOf(ydoc) {
  const out = [];
  ydoc.getMap('cells').forEach(cell => { if (cell && cell.v !== undefined && cell.v !== '' && !String(cell.v).startsWith('=')) out.push(String(cell.v)); });
  return out.join(' ');
}

function createSheet(ownerId, { title, folderId }, userId) {
  const id = uuidv4();
  const name = String(title || 'Tabuľka').trim().slice(0, 200) || 'Tabuľka';
  const parent = folderId && drive.liveItem(ownerId, folderId);
  const folder = parent && parent.kind === 'folder' ? parent : drive.systemFolder(ownerId, 'sheets', 'Tabuľky');
  const item = drive.addRef(ownerId, folder.id, { name, mime: MIME, ref: `sheet:${id}` }, `user:${userId}`);
  getDb().prepare('INSERT INTO sheets (id, owner_id, title, drive_item_id, created_by) VALUES (?, ?, ?, ?, ?)').run(id, ownerId, name, item.id, userId);
  realtime.publish(ownerId, { type: 'sheet', id });
  return getSheet(ownerId, id);
}

function rename(ownerId, b, title) {
  const name = String(title || '').trim().slice(0, 200) || b.title;
  getDb().prepare('UPDATE sheets SET title = ?, updated_at = unixepoch() WHERE id = ?').run(name, b.id);
  if (b.drive_item_id) getDb().prepare('UPDATE drive_items SET name = ?, updated_at = unixepoch() WHERE id = ?').run(name, b.drive_item_id);
  realtime.publish(ownerId, { type: 'sheet', id: b.id });
  return getSheet(ownerId, b.id);
}

function sheetView(b) {
  const author = b.created_by && getDb().prepare('SELECT name FROM users WHERE id = ?').get(b.created_by);
  return { id: b.id, title: b.title, driveItemId: b.drive_item_id, updatedAt: b.updated_at, createdAt: b.created_at,
    author: author?.name || '', excerpt: b.text.slice(0, 200), url: openUrl(b.owner_id, b.id) };
}

realtime.registerDocType('sheet', {
  exists: (userId, ownerId, id) => !!liveSheet(ownerId, id),
  onSave(ownerId, id, ydoc) {
    getDb().prepare('UPDATE sheets SET text = ?, updated_at = unixepoch() WHERE id = ? AND owner_id = ?').run(textOf(ydoc).slice(0, 200000), id, ownerId);
    const b = getSheet(ownerId, id);
    if (b?.drive_item_id) getDb().prepare('UPDATE drive_items SET updated_at = unixepoch() WHERE id = ?').run(b.drive_item_id);
  },
});

drive.registerRef('sheet', {
  openUrl,
  text: (ownerId, id) => getSheet(ownerId, id)?.text || '',
  destroy(ownerId, id) {
    realtime.deleteDoc(sheetName(ownerId, id));
    links.forget(ownerId, 'sheet', id);
    getDb().prepare('DELETE FROM sheets WHERE id = ? AND owner_id = ?').run(id, ownerId);
  },
});

links.registerType('sheet', {
  label: 'Tabuľka', icon: '📊',
  resolve: (ownerId, id) => { const b = liveSheet(ownerId, id); return b ? { title: b.title, url: openUrl(ownerId, id) } : null; },
});

module.exports = { MIME, sheetName, openUrl, getSheet, liveSheet, textOf, createSheet, rename, sheetView };
