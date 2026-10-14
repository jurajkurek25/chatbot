'use strict';
/**
 * Tabule (Excalidraw, MIT): prvky kresby sú v zdieľanom Yjs dokumente „board:<priestor>:<id>“
 * (mapa „elements“: id prvku → prvok, „files“: obrázky). Na Disku je tabuľa položka s odkazom.
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const drive = require('./drive');
const realtime = require('./realtime');
const links = require('./links');

const MIME = 'application/vnd.neoworkly.board';
const boardName = (ownerId, id) => `board:${ownerId}:${id}`;
const openUrl = (ownerId, id) => `/boards/${id}?ws=${ownerId}`;

const getBoard = (ownerId, id) => getDb().prepare('SELECT * FROM boards WHERE id = ? AND owner_id = ?').get(id, ownerId);
/** Tabuľa je dostupná, kým jej položka na Disku nie je v koši. */
function liveBoard(ownerId, id) {
  const b = getBoard(ownerId, id);
  const item = b && b.drive_item_id && drive.getItem(ownerId, b.drive_item_id);
  return item && !item.trashed_at ? b : null;
}

/** Texty z tabule (hľadanie): textové prvky, ktoré nie sú zmazané. */
function textOf(ydoc) {
  const out = [];
  ydoc.getMap('elements').forEach(el => { if (el && el.type === 'text' && !el.isDeleted && el.text) out.push(el.text); });
  return out.join('\n');
}

function createBoard(ownerId, { title, folderId }, userId) {
  const id = uuidv4();
  const name = String(title || 'Tabuľa').trim().slice(0, 200) || 'Tabuľa';
  const parent = folderId && drive.liveItem(ownerId, folderId);
  const folder = parent && parent.kind === 'folder' ? parent : drive.systemFolder(ownerId, 'boards', 'Tabule');
  const item = drive.addRef(ownerId, folder.id, { name, mime: MIME, ref: `board:${id}` }, `user:${userId}`);
  getDb().prepare('INSERT INTO boards (id, owner_id, title, drive_item_id, created_by) VALUES (?, ?, ?, ?, ?)').run(id, ownerId, name, item.id, userId);
  realtime.publish(ownerId, { type: 'board', id });
  return getBoard(ownerId, id);
}

function rename(ownerId, b, title) {
  const name = String(title || '').trim().slice(0, 200) || b.title;
  getDb().prepare('UPDATE boards SET title = ?, updated_at = unixepoch() WHERE id = ?').run(name, b.id);
  if (b.drive_item_id) getDb().prepare('UPDATE drive_items SET name = ?, updated_at = unixepoch() WHERE id = ?').run(name, b.drive_item_id);
  realtime.publish(ownerId, { type: 'board', id: b.id });
  return getBoard(ownerId, b.id);
}

function boardView(b) {
  const author = b.created_by && getDb().prepare('SELECT name FROM users WHERE id = ?').get(b.created_by);
  return { id: b.id, title: b.title, driveItemId: b.drive_item_id, updatedAt: b.updated_at, createdAt: b.created_at,
    author: author?.name || '', excerpt: b.text.slice(0, 200), url: openUrl(b.owner_id, b.id) };
}

realtime.registerDocType('board', {
  exists: (userId, ownerId, id) => !!liveBoard(ownerId, id),
  onSave(ownerId, id, ydoc) {
    getDb().prepare('UPDATE boards SET text = ?, updated_at = unixepoch() WHERE id = ? AND owner_id = ?').run(textOf(ydoc).slice(0, 200000), id, ownerId);
    const b = getBoard(ownerId, id);
    if (b?.drive_item_id) getDb().prepare('UPDATE drive_items SET updated_at = unixepoch() WHERE id = ?').run(b.drive_item_id);
  },
});

drive.registerRef('board', {
  openUrl,
  text: (ownerId, id) => getBoard(ownerId, id)?.text || '',
  destroy(ownerId, id) {
    realtime.deleteDoc(boardName(ownerId, id));
    links.forget(ownerId, 'board', id);
    getDb().prepare('DELETE FROM boards WHERE id = ? AND owner_id = ?').run(id, ownerId);
  },
});

links.registerType('board', {
  label: 'Tabuľa', icon: '🎨',
  resolve: (ownerId, id) => { const b = liveBoard(ownerId, id); return b ? { title: b.title, url: openUrl(ownerId, id) } : null; },
});

module.exports = { MIME, boardName, openUrl, getBoard, liveBoard, textOf, createBoard, rename, boardView };
