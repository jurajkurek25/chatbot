'use strict';
/**
 * E-mail (/api/mail): domény klientov a schránky na vlastnom mail serveri (Stalwart) + webmail (IMAP/SMTP).
 * Domény a schránky spravuje majiteľ priestoru. Schránka pridelená kolegovi je iba jeho;
 * nepridelená (napr. info@) je spoločná pre majiteľa a editorov.
 */
const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const stalwart = require('../services/stalwart');
const mc = require('../services/mailClient');
const drive = require('../services/drive');
const tasks = require('../services/tasks');

const router = express.Router();
router.use(requireAuth, ws.middleware);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const db = () => getDb();
const owner = (req, res, next) => (req.role === 'owner' ? next() : res.status(403).json({ error: 'Schránky a domény spravuje majiteľ priestoru.' }));
const fail = (res, e) => res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message });

/* ── Šifrovanie hesiel schránok (webmail sa prihlasuje za používateľa) ── */
const key = () => crypto.createHash('sha256').update(process.env.MAIL_SECRET_KEY || process.env.JWT_SECRET || 'changeme').digest();
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function unseal(s) {
  const [iv, tag, enc] = s.split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const newPassword = () => crypto.randomBytes(15).toString('base64url');

/* ── Domény ── */
const domainView = d => ({ id: d.id, domain: d.domain, status: d.status, records: JSON.parse(d.records), checks: JSON.parse(d.checks), verifiedAt: d.verified_at,
  mailboxes: db().prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE domain_id = ?').get(d.id).n });

router.get('/config', (req, res) => res.json({ configured: stalwart.configured(), host: stalwart.mailHost(),
  imap: { host: process.env.IMAP_HOST || stalwart.mailHost(), port: Number(process.env.IMAP_PORT || 993) },
  smtp: { host: process.env.SMTP_HOST || stalwart.mailHost(), port: Number(process.env.SMTP_SUBMIT_PORT || 465) } }));

router.get('/domains', (req, res) => res.json(db().prepare('SELECT * FROM mail_domains WHERE owner_id = ? ORDER BY domain').all(req.ownerId).map(domainView)));

router.post('/domains', owner, async (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!DOMAIN.test(domain)) return res.status(400).json({ error: 'Zadajte doménu, napr. mojafirma.sk' });
  if (/neoworkly\.com$/.test(domain)) return res.status(400).json({ error: 'Túto doménu nemožno pridať.' });
  if (db().prepare('SELECT 1 FROM mail_domains WHERE domain = ?').get(domain)) return res.status(409).json({ error: 'Doména už je pridaná (možno v inom účte).' });
  try {
    await stalwart.createDomain(domain);
    const records = await stalwart.dnsRecords(domain);
    const id = uuidv4();
    db().prepare('INSERT INTO mail_domains (id, owner_id, domain, records) VALUES (?, ?, ?, ?)').run(id, req.ownerId, domain, JSON.stringify(records));
    res.json(domainView(db().prepare('SELECT * FROM mail_domains WHERE id = ?').get(id)));
  } catch (e) { fail(res, e); }
});

const ownDomain = (req, res, next) => {
  const d = db().prepare('SELECT * FROM mail_domains WHERE id = ? AND owner_id = ?').get(req.params.id, req.ownerId);
  if (!d) return res.status(404).json({ error: 'Doména nenájdená.' });
  req.domain = d;
  next();
};

const txt = async name => { try { return (await dns.resolveTxt(name)).map(r => r.join('')); } catch { return []; } };
/** Overenie DNS: MX musí smerovať na náš server a SPF ho povoliť; DKIM a DMARC sú odporúčané. */
async function checkDns(d) {
  const host = stalwart.mailHost().toLowerCase();
  let mx = [];
  try { mx = (await dns.resolveMx(d.domain)).map(r => r.exchange.toLowerCase().replace(/\.$/, '')); } catch { /* žiadne MX */ }
  const spf = (await txt(d.domain)).find(t => t.startsWith('v=spf1')) || '';
  const dmarc = (await txt(`_dmarc.${d.domain}`)).some(t => t.startsWith('v=DMARC1'));
  const dkimNames = JSON.parse(d.records).filter(r => /_domainkey/.test(r.name)).map(r => r.name.replace(/\.$/, ''));
  const dkim = dkimNames.length ? (await Promise.all(dkimNames.map(n => txt(n)))).some(l => l.some(t => t.includes('p='))) : null;
  const checks = { mx: mx.includes(host), spf: !!spf && (spf.includes(host) || /\bmx\b/.test(spf)), dkim, dmarc };
  return { checks, ok: checks.mx && checks.spf };
}

router.post('/domains/:id/verify', owner, ownDomain, async (req, res) => {
  const { checks, ok } = await checkDns(req.domain);
  db().prepare('UPDATE mail_domains SET checks = ?, status = ?, verified_at = CASE WHEN ? THEN COALESCE(verified_at, unixepoch()) ELSE verified_at END WHERE id = ?')
    .run(JSON.stringify(checks), ok ? 'active' : 'pending', ok ? 1 : 0, req.domain.id);
  res.json(domainView(db().prepare('SELECT * FROM mail_domains WHERE id = ?').get(req.domain.id)));
});

router.delete('/domains/:id', owner, ownDomain, async (req, res) => {
  if (db().prepare('SELECT 1 FROM mailboxes WHERE domain_id = ?').get(req.domain.id)) return res.status(400).json({ error: 'Najprv zmažte schránky na tejto doméne.' });
  try { await stalwart.deleteDomain(req.domain.domain); } catch (e) { return fail(res, e); }
  db().prepare('DELETE FROM mail_domains WHERE id = ?').run(req.domain.id);
  res.json({ ok: true });
});

/* ── Schránky ── */
const userName = id => (id ? db().prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || '' : '');
const boxView = (b, extra = {}) => ({ id: b.id, address: b.address, name: b.name, userId: b.user_id, userName: userName(b.user_id), shared: !b.user_id, quotaMb: b.quota_mb, signature: b.signature, ...extra });
/** Kto smie čítať schránku: pridelený kolega; spoločnú majiteľ a editori. */
const canRead = (req, b) => (b.user_id ? b.user_id === req.userId : ws.canWrite(req.role));

router.get('/mailboxes', (req, res) => {
  const rows = db().prepare('SELECT * FROM mailboxes WHERE owner_id = ? ORDER BY address').all(req.ownerId);
  res.json(rows.filter(b => req.role === 'owner' || canRead(req, b)).map(b => boxView(b, { canRead: canRead(req, b) })));
});

router.post('/mailboxes', owner, async (req, res) => {
  const b = req.body || {};
  const d = db().prepare('SELECT * FROM mail_domains WHERE id = ? AND owner_id = ?').get(b.domainId, req.ownerId);
  if (!d) return res.status(400).json({ error: 'Vyberte doménu.' });
  const local = String(b.local || '').trim().toLowerCase();
  if (!LOCAL.test(local)) return res.status(400).json({ error: 'Adresa môže obsahovať malé písmená, čísla, bodku, pomlčku a podčiarkovník.' });
  const address = `${local}@${d.domain}`;
  if (db().prepare('SELECT 1 FROM mailboxes WHERE address = ?').get(address)) return res.status(409).json({ error: 'Táto adresa už existuje.' });
  const userId = b.userId && ws.isMember(req.ownerId, b.userId) ? b.userId : null;
  const password = newPassword();
  const quota = Math.max(100, Math.min(51200, Number(b.quotaMb) || 5120));
  try {
    await stalwart.createMailbox({ address, name: String(b.name || '').slice(0, 120), password, quotaMb: quota });
  } catch (e) { return fail(res, e); }
  const id = uuidv4();
  db().prepare('INSERT INTO mailboxes (id, owner_id, domain_id, address, name, user_id, secret, quota_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.ownerId, d.id, address, String(b.name || '').slice(0, 120), userId, seal(password), quota);
  // heslo sa zobrazí iba teraz – na nastavenie v telefóne / Outlooku
  res.json(boxView(db().prepare('SELECT * FROM mailboxes WHERE id = ?').get(id), { password }));
});

function box(req, res, next) {
  const b = db().prepare('SELECT * FROM mailboxes WHERE id = ? AND owner_id = ?').get(req.params.id, req.ownerId);
  if (!b) return res.status(404).json({ error: 'Schránka nenájdená.' });
  req.box = b;
  next();
}
const reader = (req, res, next) => (canRead(req, req.box) ? next() : res.status(403).json({ error: 'Táto schránka patrí kolegovi.' }));
const session = b => ({ id: b.id, address: b.address, name: b.name, password: unseal(b.secret) });

router.patch('/mailboxes/:id', box, async (req, res) => {
  const b = req.body || {};
  const isOwner = req.role === 'owner';
  if (!isOwner && !(req.box.user_id === req.userId)) return res.status(403).json({ error: 'Nemáte oprávnenie.' });
  let password;
  if (b.resetPassword) {
    password = newPassword();
    try { await stalwart.setPassword(req.box.address, password); } catch (e) { return fail(res, e); }
    mc.close(req.box.id);
  }
  db().prepare('UPDATE mailboxes SET name = ?, user_id = ?, signature = ?, secret = ? WHERE id = ?').run(
    b.name !== undefined ? String(b.name).slice(0, 120) : req.box.name,
    isOwner && b.userId !== undefined ? (b.userId && ws.isMember(req.ownerId, b.userId) ? b.userId : null) : req.box.user_id,
    b.signature !== undefined ? String(b.signature).slice(0, 2000) : req.box.signature,
    password ? seal(password) : req.box.secret, req.box.id);
  res.json(boxView(db().prepare('SELECT * FROM mailboxes WHERE id = ?').get(req.box.id), password ? { password } : {}));
});

router.delete('/mailboxes/:id', owner, box, async (req, res) => {
  try { await stalwart.deleteMailbox(req.box.address); } catch (e) { return fail(res, e); }
  mc.close(req.box.id);
  db().prepare('DELETE FROM mailboxes WHERE id = ?').run(req.box.id);
  res.json({ ok: true });
});

/* ── Webmail ── */
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 502).json({ error: e.authenticationFailed ? 'Prihlásenie do schránky zlyhalo.' : `Pošta: ${e.responseText || e.message}` }); } };
const folderOf = req => String(req.query.folder || req.body?.folder || 'INBOX');
const uidsOf = req => [].concat(req.body?.uids || []).map(Number).filter(n => n > 0).slice(0, 500);

router.get('/unread', wrap(async (req, res) => {
  const rows = db().prepare('SELECT * FROM mailboxes WHERE owner_id = ?').all(req.ownerId).filter(b => canRead(req, b));
  const out = {};
  await Promise.all(rows.map(async b => { try { out[b.id] = await mc.unread(session(b)); } catch { out[b.id] = null; } }));
  res.json(out);
}));
router.get('/mailboxes/:id/folders', box, reader, wrap(async (req, res) => res.json(await mc.folders(session(req.box)))));
router.get('/mailboxes/:id/messages', box, reader, wrap(async (req, res) => {
  res.json(await mc.list(session(req.box), folderOf(req), { page: Math.max(1, Number(req.query.page) || 1), q: String(req.query.q || '').slice(0, 200) }));
}));
router.get('/mailboxes/:id/messages/:uid', box, reader, wrap(async (req, res) => {
  const m = await mc.get(session(req.box), folderOf(req), Number(req.params.uid), { images: req.query.images === '1' });
  if (!m) return res.status(404).json({ error: 'Správa nenájdená.' });
  res.json(m);
}));
router.get('/mailboxes/:id/messages/:uid/attachments/:idx', box, reader, wrap(async (req, res) => {
  const a = await mc.attachment(session(req.box), folderOf(req), Number(req.params.uid), Number(req.params.idx));
  if (!a) return res.status(404).json({ error: 'Príloha nenájdená.' });
  res.setHeader('Content-Type', a.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(a.content);
}));

/** Príloha → Disk (priečinok „Prílohy z e-mailov“). */
router.post('/mailboxes/:id/messages/:uid/attachments/:idx/to-drive', ws.writer, box, reader, wrap(async (req, res) => {
  const a = await mc.attachment(session(req.box), folderOf(req), Number(req.params.uid), Number(req.params.idx));
  if (!a) return res.status(404).json({ error: 'Príloha nenájdená.' });
  const stored = `${uuidv4()}${path.extname(a.filename).toLowerCase().replace(/[^.\w]/g, '').slice(0, 12)}`;
  fs.writeFileSync(path.join(drive.DIR, stored), a.content);
  const folder = drive.systemFolder(req.ownerId, 'mail-files', 'Prílohy z e-mailov');
  const r = drive.storeFiles(req.ownerId, folder.id, [{ originalname: Buffer.from(a.filename, 'utf8').toString('latin1'), filename: stored, path: path.join(drive.DIR, stored), mimetype: a.contentType, size: a.content.length }], `user:${req.userId}`);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json({ id: r.items[0].id, name: r.items[0].name });
}));

/** E-mail → úloha (predmet = názov, odosielateľ a text v popise). */
router.post('/mailboxes/:id/messages/:uid/to-task', ws.writer, box, reader, wrap(async (req, res) => {
  const m = await mc.get(session(req.box), folderOf(req), Number(req.params.uid));
  if (!m) return res.status(404).json({ error: 'Správa nenájdená.' });
  const from = m.from[0] ? `${m.from[0].name} <${m.from[0].address}>`.trim() : '';
  const r = tasks.createTask(req.ownerId, { projectId: req.body?.projectId, title: m.subject.slice(0, 300),
    description: `E-mail od ${from} (${new Date(m.date).toLocaleString('sk-SK')}), schránka ${req.box.address}\n\n${m.text.slice(0, 8000)}`, assignees: [req.userId] }, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(r.task);
}));

router.post('/mailboxes/:id/send', box, reader, upload.array('files', 10), wrap(async (req, res) => {
  let b = req.body || {};
  if (typeof b._json === 'string') b = JSON.parse(b._json);
  const list = v => [].concat(v || []).flatMap(x => String(x).split(/[,;]/)).map(x => x.trim()).filter(Boolean);
  const to = list(b.to), cc = list(b.cc), bcc = list(b.bcc);
  const bad = [...to, ...cc, ...bcc].find(a => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(a.replace(/^.*<|>$/g, '')));
  if (!to.length) return res.status(400).json({ error: 'Zadajte príjemcu.' });
  if (bad) return res.status(400).json({ error: `Neplatná adresa: ${bad}` });
  if (to.length + cc.length + bcc.length > 50) return res.status(400).json({ error: 'Najviac 50 príjemcov – na hromadné e-maily použite E-mail marketing.' });
  const attachments = (req.files || []).map(f => ({ filename: Buffer.from(f.originalname, 'latin1').toString('utf8'), content: f.buffer, contentType: f.mimetype }));
  // prílohy z Disku
  for (const fid of [].concat(b.driveFiles || []).slice(0, 10)) {
    const it = drive.liveItem(req.ownerId, String(fid));
    if (it && it.kind === 'file' && it.stored_name) attachments.push({ filename: it.name, path: path.join(drive.DIR, it.stored_name), contentType: it.mime });
  }
  const text = String(b.text || '').slice(0, 200000);
  const html = String(b.html || '').slice(0, 500000) || undefined;
  const r = await mc.send(session(req.box), { to, cc, bcc, subject: String(b.subject || '').slice(0, 500), text, html, attachments, inReplyTo: b.inReplyTo || undefined, references: b.references || undefined });
  res.json({ ok: true, ...r });
}));

router.post('/mailboxes/:id/flag', box, reader, wrap(async (req, res) => {
  await mc.flag(session(req.box), folderOf(req), uidsOf(req), { seen: req.body?.seen, flagged: req.body?.flagged });
  res.json({ ok: true });
}));
router.post('/mailboxes/:id/move', box, reader, wrap(async (req, res) => {
  await mc.move(session(req.box), folderOf(req), uidsOf(req), String(req.body?.target || ''));
  res.json({ ok: true });
}));
router.post('/mailboxes/:id/delete', box, reader, wrap(async (req, res) => {
  await mc.remove(session(req.box), folderOf(req), uidsOf(req));
  res.json({ ok: true });
}));

module.exports = router;
module.exports._seal = { seal, unseal };
