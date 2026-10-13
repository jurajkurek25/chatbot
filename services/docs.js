'use strict';
/**
 * Dokumenty (BlockNote): obsah je zdieľaný Yjs dokument „doc:<priestor>:<id>“ (spolupráca v reálnom čase),
 * na Disku je dokument položka s odkazom (triedenie do priečinkov, kôš, zdieľanie v tíme).
 */
const Y = require('yjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const drive = require('./drive');
const realtime = require('./realtime');
const links = require('./links');

const MIME = 'application/vnd.neoworkly.doc';
const FRAGMENT = 'document-store'; // predvolený fragment BlockNote pri spolupráci
const docName = (ownerId, id) => `doc:${ownerId}:${id}`;
const openUrl = (ownerId, id) => `/docs/${id}?ws=${ownerId}`;

const getDoc = (ownerId, id) => getDb().prepare('SELECT * FROM docs WHERE id = ? AND owner_id = ?').get(id, ownerId);
/** Dokument je dostupný, kým jeho položka na Disku nie je v koši. */
function liveDoc(ownerId, id) {
  const d = getDoc(ownerId, id);
  if (!d) return null;
  const item = d.drive_item_id && drive.getItem(ownerId, d.drive_item_id);
  return item && !item.trashed_at ? d : null;
}

/** Čistý text z BlockNote fragmentu (vyhľadávanie, znalosti chatbota). */
function textOf(ydoc) {
  const out = [];
  const walk = node => {
    if (node instanceof Y.XmlText) {
      out.push(node.toDelta().map(op => (typeof op.insert === 'string' ? op.insert : '')).join(''));
      return;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      node.toArray().forEach(walk);
      if (node instanceof Y.XmlElement && ['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'blockContainer', 'codeBlock', 'quote'].includes(node.nodeName)) out.push('\n');
    }
  };
  walk(ydoc.getXmlFragment(FRAGMENT));
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function createDoc(ownerId, { title, folderId }, userId) {
  const id = uuidv4();
  const name = String(title || 'Bez názvu').trim().slice(0, 200) || 'Bez názvu';
  const parent = folderId && drive.liveItem(ownerId, folderId);
  const folder = parent && parent.kind === 'folder' ? parent : drive.systemFolder(ownerId, 'docs', 'Dokumenty');
  const item = drive.addRef(ownerId, folder.id, { name, mime: MIME, ref: `doc:${id}` }, `user:${userId}`);
  getDb().prepare('INSERT INTO docs (id, owner_id, title, drive_item_id, created_by) VALUES (?, ?, ?, ?, ?)').run(id, ownerId, name, item.id, userId);
  realtime.publish(ownerId, { type: 'doc', id });
  return getDoc(ownerId, id);
}

function rename(ownerId, doc, { title, icon }) {
  const db = getDb();
  const name = title !== undefined ? String(title).trim().slice(0, 200) || 'Bez názvu' : doc.title;
  db.prepare('UPDATE docs SET title = ?, icon = ?, updated_at = unixepoch() WHERE id = ?').run(name, icon !== undefined ? String(icon).slice(0, 8) || '📄' : doc.icon, doc.id);
  if (doc.drive_item_id) db.prepare('UPDATE drive_items SET name = ?, updated_at = unixepoch() WHERE id = ?').run(name, doc.drive_item_id);
  realtime.publish(ownerId, { type: 'doc', id: doc.id });
  return getDoc(ownerId, doc.id);
}

function docView(d) {
  const author = d.created_by && getDb().prepare('SELECT name FROM users WHERE id = ?').get(d.created_by);
  return { id: d.id, title: d.title, icon: d.icon, driveItemId: d.drive_item_id, updatedAt: d.updated_at, createdAt: d.created_at,
    author: author?.name || '', excerpt: d.text.slice(0, 200), url: openUrl(d.owner_id, d.id) };
}

realtime.registerDocType('doc', {
  exists: (userId, ownerId, id) => !!liveDoc(ownerId, id),
  onSave(ownerId, id, ydoc) {
    getDb().prepare('UPDATE docs SET text = ?, updated_at = unixepoch() WHERE id = ? AND owner_id = ?').run(textOf(ydoc).slice(0, 500000), id, ownerId);
    const d = getDoc(ownerId, id);
    if (d?.drive_item_id) getDb().prepare('UPDATE drive_items SET updated_at = unixepoch() WHERE id = ?').run(d.drive_item_id);
  },
});

drive.registerRef('doc', {
  openUrl,
  text: (ownerId, id) => getDoc(ownerId, id)?.text || '',
  destroy(ownerId, id) {
    realtime.deleteDoc(docName(ownerId, id));
    links.forget(ownerId, 'doc', id);
    getDb().prepare('DELETE FROM docs WHERE id = ? AND owner_id = ?').run(id, ownerId);
  },
});

links.registerType('doc', {
  label: 'Dokument', icon: '📄',
  resolve: (ownerId, id) => { const d = liveDoc(ownerId, id); return d ? { title: d.title, url: openUrl(ownerId, id) } : null; },
});

module.exports = { MIME, FRAGMENT, docName, openUrl, getDoc, liveDoc, textOf, createDoc, rename, docView };
