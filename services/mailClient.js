'use strict';
/**
 * Webmail: prístup k schránke cez IMAP (imapflow) a odosielanie cez SMTP (nodemailer).
 * Spojenia sa držia krátko v pamäti (na schránku), aby prepínanie priečinkov bolo rýchle.
 * IMAP_HOST / IMAP_PORT (993), SMTP_HOST / SMTP_SUBMIT_PORT (465) – predvolene MAIL_HOST.
 */
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');
const stalwart = require('./stalwart');

const IDLE_MS = 2 * 60 * 1000;
const pool = new Map(); // id schránky → { client, timer, busy }

const imapHost = () => process.env.IMAP_HOST || stalwart.mailHost();
const smtpHost = () => process.env.SMTP_HOST || stalwart.mailHost();

async function connect(box) {
  const cur = pool.get(box.id);
  if (cur && cur.client.usable) { clearTimeout(cur.timer); cur.timer = setTimeout(() => close(box.id), IDLE_MS); return cur.client; }
  const client = new ImapFlow({
    host: imapHost(), port: Number(process.env.IMAP_PORT || 993), secure: Number(process.env.IMAP_PORT || 993) === 993,
    auth: { user: box.address, pass: box.password }, logger: false, emitLogs: false,
  });
  client.on('error', () => close(box.id));
  await client.connect();
  pool.set(box.id, { client, timer: setTimeout(() => close(box.id), IDLE_MS) });
  return client;
}
function close(id) {
  const cur = pool.get(id);
  if (!cur) return;
  pool.delete(id);
  clearTimeout(cur.timer);
  cur.client.logout().catch(() => {});
}
/** Práca v jednom priečinku so zámkom (IMAP má jeden vybraný priečinok na spojenie). */
async function inFolder(box, folder, fn) {
  const client = await connect(box);
  const lock = await client.getMailboxLock(folder || 'INBOX');
  try { return await fn(client); } finally { lock.release(); }
}

const SPECIAL = { '\\Inbox': 'Doručená pošta', '\\Sent': 'Odoslané', '\\Drafts': 'Koncepty', '\\Trash': 'Kôš', '\\Junk': 'Spam', '\\Archive': 'Archív' };
const ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];

async function folders(box) {
  const client = await connect(box);
  const list = await client.list({ statusQuery: { unseen: true, messages: true } });
  return list.filter(f => !f.flags?.has('\\Noselect')).map(f => {
    const special = f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : f.specialUse || null;
    return { path: f.path, name: SPECIAL[special] || f.name, special, unseen: f.status?.unseen || 0, total: f.status?.messages || 0 };
  }).sort((a, b) => ((ORDER.indexOf(a.special) + 1 || 99) - (ORDER.indexOf(b.special) + 1 || 99)) || a.name.localeCompare(b.name, 'sk'));
}
const specialPath = async (box, special) => (await folders(box)).find(f => f.special === special)?.path;

const addr = a => (a || []).map(x => ({ name: x.name || '', address: x.address || '' }));

async function list(box, folder, { page = 1, q = '', size = 40 } = {}) {
  return inFolder(box, folder, async client => {
    const query = q ? { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] } : { all: true };
    const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => b - a);
    const slice = uids.slice((page - 1) * size, page * size);
    const items = [];
    if (slice.length) {
      for await (const m of client.fetch(slice, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true })) {
        items.push({
          uid: m.uid, subject: m.envelope.subject || '(bez predmetu)', from: addr(m.envelope.from), to: addr(m.envelope.to), date: m.envelope.date,
          seen: m.flags.has('\\Seen'), flagged: m.flags.has('\\Flagged'), size: m.size,
          attachments: JSON.stringify(m.bodyStructure || {}).includes('"disposition":"attachment"'),
        });
      }
    }
    items.sort((a, b) => b.uid - a.uid);
    return { total: uids.length, page, items };
  });
}

/** HTML e-mailu bez skriptov a sledovania; vzdialené obrázky iba na požiadanie (images=true). */
function cleanHtml(html, cid, images) {
  let blocked = 0;
  const out = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'span', 'font', 'center', 'h1', 'h2', 'h3', 'style']),
    allowedAttributes: { '*': ['style', 'align', 'width', 'height', 'bgcolor', 'color', 'valign', 'border', 'cellpadding', 'cellspacing', 'dir'], a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'width', 'height', 'style'], font: ['face', 'size', 'color'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data', 'cid'],
    allowVulnerableTags: true, // <style> v e-mailoch – zobrazuje sa v izolovanom rámci bez skriptov
    transformTags: {
      a: (tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' } }),
      img: (tag, attrs) => {
        let src = attrs.src || '';
        if (src.startsWith('cid:')) src = cid[src.slice(4)] || '';
        else if (/^https?:/i.test(src) && !images) { blocked++; src = ''; }
        return { tagName: 'img', attribs: { ...attrs, src } };
      },
    },
  });
  return { html: out, blockedImages: blocked };
}

async function get(box, folder, uid, { images = false } = {}) {
  return inFolder(box, folder, async client => {
    const m = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
    if (!m) return null;
    const p = await simpleParser(m.source);
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    const cid = {};
    p.attachments.forEach(a => { if (a.cid) cid[a.cid] = `data:${a.contentType};base64,${a.content.toString('base64')}`; });
    const body = p.html ? cleanHtml(p.html, cid, images) : { html: '', blockedImages: 0 };
    return {
      uid, folder, subject: p.subject || '(bez predmetu)', date: p.date, messageId: p.messageId, references: p.references,
      from: addr(p.from?.value), to: addr(p.to?.value), cc: addr(p.cc?.value), replyTo: addr(p.replyTo?.value),
      html: body.html, blockedImages: body.blockedImages, text: p.text || '', flagged: m.flags.has('\\Flagged'),
      attachments: p.attachments.filter(a => !a.related).map((a, idx) => ({ idx, filename: a.filename || `príloha-${idx + 1}`, contentType: a.contentType, size: a.size })),
    };
  });
}

async function attachment(box, folder, uid, idx) {
  return inFolder(box, folder, async client => {
    const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!m) return null;
    const p = await simpleParser(m.source);
    const a = p.attachments.filter(x => !x.related)[idx];
    return a ? { filename: a.filename || `príloha-${idx + 1}`, contentType: a.contentType, content: a.content } : null;
  });
}

async function send(box, mail) {
  const port = Number(process.env.SMTP_SUBMIT_PORT || 465);
  const transport = nodemailer.createTransport({ host: smtpHost(), port, secure: port === 465, auth: { user: box.address, pass: box.password } });
  const message = {
    from: { name: box.name || '', address: box.address }, to: mail.to, cc: mail.cc || undefined, bcc: mail.bcc || undefined, subject: mail.subject,
    html: mail.html, text: mail.text, attachments: mail.attachments, inReplyTo: mail.inReplyTo, references: mail.references,
  };
  const info = await transport.sendMail(message);
  // kópia do Odoslaných (Stalwart ju sám neukladá pri odoslaní cez SMTP)
  try {
    const sent = await specialPath(box, '\\Sent');
    if (sent) {
      const raw = await new Promise((ok, fail) => nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(message, (e, r) => (e ? fail(e) : ok(r.message))));
      await (await connect(box)).append(sent, raw, ['\\Seen']);
    }
  } catch { /* odoslanie prebehlo, kópia nie je kritická */ }
  return { messageId: info.messageId };
}

async function flag(box, folder, uids, { seen, flagged }) {
  return inFolder(box, folder, async client => {
    const set = uids.map(String).join(',');
    if (seen !== undefined) await (seen ? client.messageFlagsAdd(set, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(set, ['\\Seen'], { uid: true }));
    if (flagged !== undefined) await (flagged ? client.messageFlagsAdd(set, ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(set, ['\\Flagged'], { uid: true }));
  });
}
async function move(box, folder, uids, target) {
  return inFolder(box, folder, client => client.messageMove(uids.map(String).join(','), target, { uid: true }));
}
/** Zmazať = presun do Koša; v Koši natrvalo. */
async function remove(box, folder, uids) {
  const trash = await specialPath(box, '\\Trash');
  if (trash && trash !== folder) return move(box, folder, uids, trash);
  return inFolder(box, folder, client => client.messageDelete(uids.map(String).join(','), { uid: true }));
}
async function unread(box) {
  const client = await connect(box);
  return (await client.status('INBOX', { unseen: true })).unseen || 0;
}

module.exports = { folders, list, get, attachment, send, flag, move, remove, unread, cleanHtml, close };
