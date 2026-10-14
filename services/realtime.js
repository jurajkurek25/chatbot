'use strict';
/**
 * Spolupráca v reálnom čase na hlavnom HTTP serveri:
 *  - /ws?ticket=…            udalosti priestoru (zmeny úloh, správy v chate…), kto je online, „píše…“
 *  - /yjs/<typ:priestor:id>  zdieľané dokumenty (Yjs, protokol y-websocket) s ukladaním do SQLite
 * Prihlásenie: krátkodobý lístok z POST /api/realtime/ticket (JWT do URL nepatrí).
 */
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const { getDb } = require('../db/database');
const workspace = require('./workspace');

const secret = () => process.env.JWT_SECRET || 'changeme';
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/* ── Lístky ──────────────────────────────────────────────────── */

const sign = body => crypto.createHmac('sha256', secret()).update(`rt.${body}`).digest('base64url');
function ticket(userId, ttlSec = 60) {
  const body = Buffer.from(JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readTicket(t) {
  const [body, sig] = String(t || '').split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  if (expected.length !== Buffer.byteLength(sig) || !crypto.timingSafeEqual(expected, Buffer.from(sig))) return null;
  const d = JSON.parse(Buffer.from(body, 'base64url').toString());
  return d.e >= Date.now() / 1000 ? d.u : null;
}

/* ── Udalosti priestoru a prítomnosť ────────────────────────── */

const rooms = new Map(); // ownerId → Set<socket>
const userSockets = new Map(); // userId → Set<socket>

function userInfo(userId) {
  return getDb().prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId) || { id: userId, name: '' };
}

function presence(ownerId) {
  const seen = new Map();
  for (const s of rooms.get(ownerId) || []) {
    const cur = seen.get(s.user.id) || { id: s.user.id, name: s.user.name, where: [] };
    if (s.where) cur.where.push(s.where);
    seen.set(s.user.id, cur);
  }
  return [...seen.values()];
}

function sendJson(s, obj) {
  if (s.readyState === 1) s.send(JSON.stringify(obj));
}

/** Pošle udalosť všetkým pripojeným v priestore (okrem `exceptUserId`, ak je zadané). */
function publish(ownerId, event, exceptUserId) {
  for (const s of rooms.get(ownerId) || []) if (s.user.id !== exceptUserId) sendJson(s, event);
}

function broadcastPresence(ownerId) {
  publish(ownerId, { type: 'presence', users: presence(ownerId) });
}

/** Pošle udalosť konkrétnemu používateľovi (všetky jeho okná), napr. nové upozornenie. */
function publishUser(userId, event) {
  for (const s of userSockets.get(userId) || []) sendJson(s, event);
}

const isOnline = userId => (userSockets.get(userId)?.size || 0) > 0;

function onEventsSocket(socket, userId) {
  socket.user = userInfo(userId);
  socket.ownerIds = new Set();
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket);
  socket.on('message', raw => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'subscribe' && typeof m.ws === 'string' && workspace.roleIn(userId, m.ws)) {
      if (!rooms.has(m.ws)) rooms.set(m.ws, new Set());
      rooms.get(m.ws).add(socket);
      socket.ownerIds.add(m.ws);
      broadcastPresence(m.ws);
    } else if (m.type === 'where' && typeof m.where === 'string') {
      socket.where = m.where.slice(0, 120);
      socket.ownerIds.forEach(broadcastPresence);
    } else if (m.type === 'typing' && socket.ownerIds.has(m.ws) && typeof m.topic === 'string') {
      publish(m.ws, { type: 'typing', topic: m.topic.slice(0, 120), user: { id: socket.user.id, name: socket.user.name } }, userId);
    }
  });
  socket.on('close', () => {
    userSockets.get(userId)?.delete(socket);
    for (const ownerId of socket.ownerIds) {
      rooms.get(ownerId)?.delete(socket);
      broadcastPresence(ownerId);
    }
  });
}

/* ── Zdieľané dokumenty (Yjs) ───────────────────────────────── */

const docTypes = new Map(); // typ → (userId, ownerId, id) => bool (existuje v priestore)
const docs = new Map();     // názov → WSSharedDoc
const saveHooks = new Map(); // typ → (ownerId, id, ydoc) => void

/** Typ dokumentu (napr. 'doc', 'board'): overenie, že položka v priestore existuje, a voliteľný háčik po uložení. */
function registerDocType(type, { exists, onSave }) {
  docTypes.set(type, exists);
  if (onSave) saveHooks.set(type, onSave);
}

function loadState(name) {
  return getDb().prepare('SELECT state FROM yjs_docs WHERE name = ?').get(name)?.state || null;
}

function persist(doc) {
  clearTimeout(doc.saveTimer);
  doc.saveTimer = null;
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  getDb().prepare(`INSERT INTO yjs_docs (name, state, updated_at) VALUES (?, ?, unixepoch())
                   ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = unixepoch()`).run(doc.name, state);
  const [type, ownerId, id] = doc.name.split(':');
  const hook = saveHooks.get(type);
  if (hook) { try { hook(ownerId, id, doc); } catch (e) { console.error('[realtime save hook]', e.message); } }
}

function wireSend(doc, conn, message) {
  if (conn.readyState !== 1) return closeConn(doc, conn);
  conn.send(message, err => { if (err) closeConn(doc, conn); });
}

function getDoc(name) {
  let doc = docs.get(name);
  if (doc) return doc;
  doc = new Y.Doc({ gc: true });
  doc.name = name;
  doc.conns = new Map(); // conn → Set<awareness clientId>
  const state = loadState(name);
  if (state) Y.applyUpdate(doc, new Uint8Array(state));
  doc.awareness = new awarenessProtocol.Awareness(doc);
  doc.awareness.setLocalState(null);
  doc.awareness.on('update', ({ added, updated, removed }, conn) => {
    const changed = added.concat(updated, removed);
    const ctrl = conn && doc.conns.get(conn);
    if (ctrl) { added.forEach(id => ctrl.add(id)); removed.forEach(id => ctrl.delete(id)); }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changed));
    const buf = encoding.toUint8Array(enc);
    doc.conns.forEach((_, c) => wireSend(doc, c, buf));
  });
  doc.on('update', update => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    doc.conns.forEach((_, c) => wireSend(doc, c, msg));
    if (!doc.saveTimer) doc.saveTimer = setTimeout(() => persist(doc), 1500);
  });
  docs.set(name, doc);
  return doc;
}

function closeConn(doc, conn) {
  const ids = doc.conns.get(conn);
  if (!ids) return;
  doc.conns.delete(conn);
  awarenessProtocol.removeAwarenessStates(doc.awareness, [...ids], null);
  if (!doc.conns.size) {
    if (doc.saveTimer) persist(doc);
    doc.destroy();
    docs.delete(doc.name);
  }
  try { conn.close(); } catch { /* už zatvorené */ }
}

function onDocSocket(conn, name, readonly) {
  conn.binaryType = 'arraybuffer';
  const doc = getDoc(name);
  doc.conns.set(conn, new Set());
  conn.on('message', data => {
    try {
      const message = new Uint8Array(data);
      const decoder = decoding.createDecoder(message);
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        // Čitateľ smie iba požiadať o stav (krok 1), nie posielať zmeny
        if (readonly && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        if (encoding.length(encoder) > 1) wireSend(doc, conn, encoding.toUint8Array(encoder));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn);
      }
    } catch (e) {
      console.error('[yjs]', e.message);
    }
  });
  conn.on('close', () => closeConn(doc, conn));
  // Úvod: náš stav (krok 1) a kto je v dokumente
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  wireSend(doc, conn, encoding.toUint8Array(enc));
  const states = doc.awareness.getStates();
  if (states.size) {
    const a = encoding.createEncoder();
    encoding.writeVarUint(a, MSG_AWARENESS);
    encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()]));
    wireSend(doc, conn, encoding.toUint8Array(a));
  }
}

/** Aktuálny obsah dokumentu na serveri (otvorený v pamäti alebo z DB). */
function readDoc(name) {
  if (docs.has(name)) return docs.get(name);
  const d = new Y.Doc();
  const state = loadState(name);
  if (state) Y.applyUpdate(d, new Uint8Array(state));
  return d;
}

/** Zapíše obsah (napr. import, šablóna) – otvoreným editorom sa zmena hneď prejaví. */
function writeDoc(name, fn) {
  const open = docs.get(name);
  const d = open || readDoc(name);
  d.name = name;
  Y.transact(d, () => fn(d));
  if (open) persist(open);
  else getDb().prepare(`INSERT INTO yjs_docs (name, state, updated_at) VALUES (?, ?, unixepoch())
                        ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = unixepoch()`).run(name, Buffer.from(Y.encodeStateAsUpdate(d)));
}

function deleteDoc(name) {
  const open = docs.get(name);
  if (open) [...open.conns.keys()].forEach(c => closeConn(open, c));
  getDb().prepare('DELETE FROM yjs_docs WHERE name = ?').run(name);
}

/* ── Pripojenie k HTTP serveru ──────────────────────────────── */

function track(ws) {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const userId = readTicket(url.searchParams.get('ticket'));
    const reject = code => { socket.write(`HTTP/1.1 ${code} \r\n\r\n`); socket.destroy(); };
    if (url.pathname === '/ws') {
      if (!userId) return reject(401);
      return wss.handleUpgrade(req, socket, head, ws => { track(ws); onEventsSocket(ws, userId); });
    }
    const m = url.pathname.match(/^\/yjs\/([a-z]+):([\w-]+):([\w-]+)$/);
    if (!m) return; // iné upgrady (napr. iné moduly) nechá tak
    if (!userId) return reject(401);
    const [, type, ownerId, id] = m;
    const role = workspace.roleIn(userId, ownerId);
    const exists = docTypes.get(type);
    if (!role || !exists || !exists(userId, ownerId, id)) return reject(404);
    wss.handleUpgrade(req, socket, head, ws => { track(ws); onDocSocket(ws, `${type}:${ownerId}:${id}`, !workspace.canWrite(role)); });
  });
  // Udržiavanie spojení (proxy ich inak po čase zatvorí)
  const timer = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.alive === false) return ws.terminate();
      ws.alive = false;
      try { ws.ping(); } catch { /* nič */ }
    });
  }, 30000);
  timer.unref();
  return wss;
}

/** Pri vypínaní servera: uloží otvorené dokumenty. */
function flushAll() {
  docs.forEach(d => { if (d.saveTimer) persist(d); });
}

module.exports = { ticket, readTicket, attach, publish, publishUser, isOnline, presence, registerDocType, readDoc, writeDoc, deleteDoc, flushAll };
