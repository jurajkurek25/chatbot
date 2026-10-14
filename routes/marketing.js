'use strict';
/**
 * E-mail marketing (/api/marketing): kontakty, kampane, automatické série, doména odosielateľa.
 * Verejné: /u/:token (odhlásenie aj jedným klikom z e-mailového klienta), /webhook (Resend).
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const mk = require('../services/marketing');
const resend = require('../services/resend');

const router = express.Router();
const TRIGGERS = ['contact_added', 'lead_magnet', 'purchase', 'tag'];
const SOURCES = { manual: 'Ručne', import: 'Import', funnel: 'Funnel', customer: 'Zákazník', chatbot: 'Chatbot', form: 'Formulár' };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fail = (res, e) => res.status(e.status && e.status < 500 ? 400 : 502).json({ error: e.message });

/* ════════ Verejné ════════ */

function unsubPage(title, text, form) {
  return `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b}.c{max-width:440px;margin:4rem auto;background:#fff;border-radius:16px;padding:2rem;box-shadow:0 2px 20px rgba(0,0,0,.06);text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#64748b;font-size:.92rem;line-height:1.6}button{margin-top:1rem;padding:.75rem 1.4rem;border:0;border-radius:10px;background:#5b4fff;color:#fff;font-weight:700;font-size:.95rem;cursor:pointer}</style></head>
<body><div class="c"><h1>${esc(title)}</h1><p>${text}</p>${form || ''}</div></body></html>`;
}

// Potvrdenie tlačidlom (antivírusové skenery odkazov by GET inak odhlásili sami)
router.get('/u/:token', (req, res) => {
  const c = getDb().prepare('SELECT c.*, u.name AS owner FROM email_contacts c JOIN users u ON u.id = c.user_id WHERE c.unsubscribe_token = ?').get(req.params.token);
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!c) return res.status(404).send(unsubPage('Odkaz neplatí', 'Tento odkaz na odhlásenie neexistuje.'));
  const name = esc(mk.settings(c.user_id).fromName || require('../services/shop').storeOf(c.user_id).name);
  if (c.status !== 'subscribed') return res.send(unsubPage('Ste odhlásený/á', `Adresa ${esc(c.email)} už od ${name} e-maily nedostáva.`));
  res.send(unsubPage('Odhlásiť sa z odberu?', `Adresa ${esc(c.email)} prestane dostávať novinky od ${name}.`,
    `<form method="post"><button type="submit">Odhlásiť sa</button></form>`));
});

router.post('/u/:token', express.urlencoded({ extended: false }), (req, res) => {
  const c = mk.unsubscribe(req.params.token);
  if (!c) return res.status(404).send(unsubPage('Odkaz neplatí', 'Tento odkaz na odhlásenie neexistuje.'));
  res.send(unsubPage('Odhlásené ✓', `Adresa ${esc(c.email)} už nebude dostávať tieto e-maily.`));
});

router.post('/webhook', (req, res) => {
  const evt = resend.verifyWebhook(req.rawBody ? req.rawBody.toString('utf8') : '', req.headers);
  if (!evt) return res.status(400).json({ error: 'Neplatný podpis.' });
  mk.handleEvent(evt);
  res.json({ ok: true });
});

/* ════════ Prihlásený majiteľ ════════ */

router.use(requireAuth);

router.get('/overview', (req, res) => {
  const db = getDb();
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM email_contacts WHERE user_id = ? GROUP BY status').all(req.userId).map(r => [r.status, r.n]));
  let senderInfo = null, senderError = null;
  try { senderInfo = mk.sender(req.userId); } catch (e) { senderError = e.message; }
  res.json({
    configured: resend.configured(), settings: mk.settings(req.userId), usage: mk.usage(req.userId), limit: mk.monthlyLimit(),
    counts, sender: senderInfo, senderError, platformDomain: process.env.MARKETING_FROM_DOMAIN || null, sources: SOURCES,
  });
});

router.put('/settings', (req, res) => {
  const r = mk.saveSettings(req.userId, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r.settings);
});

router.post('/domain', async (req, res) => {
  try {
    const r = await mk.addDomain(req.userId, req.body?.domain);
    if (r.error) return res.status(400).json(r);
    res.json(r.settings);
  } catch (e) { fail(res, e); }
});
router.post('/domain/verify', async (req, res) => {
  try {
    const r = await mk.refreshDomain(req.userId, true);
    if (r.error) return res.status(400).json(r);
    res.json(r.settings);
  } catch (e) { fail(res, e); }
});
router.delete('/domain', async (req, res) => {
  try { res.json((await mk.removeDomain(req.userId)).settings); } catch (e) { fail(res, e); }
});

/* ── Kontakty ── */

const contactView = c => ({ id: c.id, email: c.email, name: c.name, status: c.status, source: c.source, tags: JSON.parse(c.tags || '[]'), createdAt: c.created_at, consentAt: c.consent_at });

router.get('/contacts', (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const status = ['subscribed', 'unsubscribed', 'bounced', 'complained'].includes(req.query.status) ? req.query.status : null;
  const rows = getDb().prepare(`SELECT * FROM email_contacts WHERE user_id = ? AND (lower(email) LIKE ? OR lower(name) LIKE ?) AND (? IS NULL OR status = ?)
                                ORDER BY created_at DESC LIMIT 500`).all(req.userId, q, q, status, status);
  res.json(rows.map(contactView));
});

router.post('/contacts', (req, res) => {
  const { email, name, tags, consent } = req.body || {};
  if (consent !== true) return res.status(400).json({ error: 'Potvrďte, že kontakt súhlasil s odberom.' });
  const c = mk.upsertContact(req.userId, { email, name, tags, consent: true, source: 'manual' });
  if (!c) return res.status(400).json({ error: 'Neplatný e-mail.' });
  res.json(contactView(c));
});

/** CSV/riadky: "email" alebo "email,meno" (oddeľovač , ; alebo tab). */
router.post('/contacts/import', (req, res) => {
  const { csv, tags, consent } = req.body || {};
  if (consent !== true) return res.status(400).json({ error: 'Potvrďte, že všetky kontakty súhlasili s odberom.' });
  let added = 0, skipped = 0;
  const lines = String(csv || '').split(/\r?\n/).slice(0, 20000);
  getDb().transaction(() => {
    for (const line of lines) {
      const [email, ...rest] = line.split(/[,;\t]/).map(x => x.trim().replace(/^"|"$/g, ''));
      if (!email || /^e-?mail$/i.test(email)) continue;
      const before = getDb().prepare('SELECT 1 FROM email_contacts WHERE user_id = ? AND email = ?').get(req.userId, email.toLowerCase());
      const c = mk.upsertContact(req.userId, { email, name: rest.join(' '), tags, consent: true, source: 'import' });
      if (c && !before) added++; else skipped++;
    }
  })();
  res.json({ added, skipped });
});

router.patch('/contacts/:id', (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM email_contacts WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: 'Kontakt nenájdený.' });
  const b = req.body || {};
  if (b.name !== undefined) db.prepare('UPDATE email_contacts SET name = ? WHERE id = ?').run(String(b.name).trim().slice(0, 120), c.id);
  if (b.tags !== undefined) {
    const before = JSON.parse(c.tags || '[]');
    const tags = mk.parseTags(b.tags);
    db.prepare('UPDATE email_contacts SET tags = ? WHERE id = ?').run(JSON.stringify(tags), c.id);
    if (c.status === 'subscribed') tags.filter(t => !before.includes(t)).forEach(t => mk.enroll(req.userId, 'tag', t, c.id));
  }
  if (b.status === 'unsubscribed') mk.unsubscribe(c.unsubscribe_token);
  if (b.status === 'subscribed' && c.status !== 'subscribed') {
    // Znovu prihlásiť smie iba nový súhlas kontaktu; odrazené a sťažnosti nie
    if (c.status !== 'unsubscribed' || b.consent !== true) return res.status(400).json({ error: 'Kontakt sa dá znova prihlásiť iba s jeho novým súhlasom.' });
    mk.upsertContact(req.userId, { email: c.email, consent: true });
  }
  res.json(contactView(db.prepare('SELECT * FROM email_contacts WHERE id = ?').get(c.id)));
});

router.delete('/contacts/:id', (req, res) => {
  getDb().prepare('DELETE FROM email_contacts WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

router.get('/contacts/export.csv', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM email_contacts WHERE user_id = ? ORDER BY created_at').all(req.userId);
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kontakty.csv"');
  res.send('﻿' + ['email,meno,stav,zdroj,stitky,suhlas'].concat(rows.map(c => [c.email, c.name, c.status, c.source, JSON.parse(c.tags || '[]').join(' '),
    c.consent_at ? new Date(c.consent_at * 1000).toISOString() : ''].map(cell).join(','))).join('\n'));
});

router.get('/options', (req, res) => {
  const db = getDb();
  const tags = new Set();
  db.prepare('SELECT tags FROM email_contacts WHERE user_id = ?').all(req.userId).forEach(r => JSON.parse(r.tags || '[]').forEach(t => tags.add(t)));
  res.json({
    products: db.prepare('SELECT id, title FROM digital_products WHERE user_id = ? ORDER BY created_at DESC').all(req.userId),
    leadMagnets: db.prepare('SELECT lm.id, lm.name FROM lead_magnets lm JOIN widgets w ON w.id = lm.widget_id WHERE w.user_id = ?').all(req.userId),
    tags: [...tags].sort(), sources: SOURCES,
  });
});

router.post('/segment/count', (req, res) => res.json({ count: mk.segmentContacts(req.userId, req.body?.segment || {}).length }));

/* ── Kampane ── */

const campaignView = c => ({
  id: c.id, name: c.name, subject: c.subject, preheader: c.preheader, body: c.body, buttonText: c.button_text, buttonUrl: c.button_url,
  segment: JSON.parse(c.segment || '{}'), status: c.status, error: c.error, scheduledAt: c.scheduled_at, sentAt: c.sent_at,
  recipients: c.recipients, createdAt: c.created_at, stats: c.status === 'draft' ? null : mk.campaignStats(c.id),
});
const ownCampaign = (req, res, next) => {
  const c = getDb().prepare('SELECT * FROM email_campaigns WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: 'Kampaň nenájdená.' });
  req.campaign = c;
  next();
};

function campaignFields(b, prev = {}) {
  const pick = (k, max, d = '') => (b[k] !== undefined ? String(b[k]) : (prev[k] ?? d)).slice(0, max);
  const url = b.buttonUrl !== undefined ? String(b.buttonUrl).trim() : prev.button_url || '';
  if (url && !/^https?:\/\//i.test(url)) return { error: 'Odkaz tlačidla musí začínať http:// alebo https://' };
  const seg = b.segment !== undefined ? b.segment || {} : JSON.parse(prev.segment || '{}');
  return {
    name: pick('name', 120), subject: pick('subject', 200), preheader: pick('preheader', 200), body: pick('body', 50000),
    button_text: b.buttonText !== undefined ? String(b.buttonText).slice(0, 80) : prev.button_text || '', button_url: url,
    segment: JSON.stringify({ sources: Array.isArray(seg.sources) ? seg.sources.filter(s => SOURCES[s]) : [], tags: mk.parseTags(seg.tags || []), productId: seg.productId || null }),
  };
}

router.get('/campaigns', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM email_campaigns WHERE user_id = ? ORDER BY created_at DESC').all(req.userId).map(campaignView));
});

router.post('/campaigns', (req, res) => {
  const f = campaignFields(req.body || {});
  if (f.error) return res.status(400).json(f);
  const id = uuidv4();
  getDb().prepare(`INSERT INTO email_campaigns (id, user_id, name, subject, preheader, body, button_text, button_url, segment)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.userId, f.name || 'Nová kampaň', f.subject, f.preheader, f.body, f.button_text, f.button_url, f.segment);
  res.json(campaignView(getDb().prepare('SELECT * FROM email_campaigns WHERE id = ?').get(id)));
});

router.get('/campaigns/:id', ownCampaign, (req, res) => res.json(campaignView(req.campaign)));

router.put('/campaigns/:id', ownCampaign, (req, res) => {
  if (!['draft', 'failed'].includes(req.campaign.status)) return res.status(400).json({ error: 'Odoslanú alebo naplánovanú kampaň už nemožno upraviť.' });
  const f = campaignFields(req.body || {}, req.campaign);
  if (f.error) return res.status(400).json(f);
  getDb().prepare(`UPDATE email_campaigns SET name = ?, subject = ?, preheader = ?, body = ?, button_text = ?, button_url = ?, segment = ?, status = 'draft' WHERE id = ?`)
    .run(f.name, f.subject, f.preheader, f.body, f.button_text, f.button_url, f.segment, req.campaign.id);
  res.json(campaignView(getDb().prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.campaign.id)));
});

router.delete('/campaigns/:id', ownCampaign, (req, res) => {
  if (req.campaign.status === 'sending') return res.status(400).json({ error: 'Kampaň sa práve posiela.' });
  getDb().prepare('DELETE FROM email_campaigns WHERE id = ?').run(req.campaign.id);
  res.json({ ok: true });
});

router.post('/campaigns/:id/preview', ownCampaign, (req, res) => {
  const me = getDb().prepare('SELECT email, name FROM users WHERE id = ?').get(req.userId);
  const sample = { email: me.email, name: me.name || '', unsubscribe_token: 'ukazka' };
  const c = req.campaign;
  res.json({ html: mk.render(req.userId, sample, { subject: c.subject, preheader: c.preheader, body: c.body, buttonText: c.button_text, buttonUrl: c.button_url }).html });
});

/** Skúšobný e-mail na adresu majiteľa (alebo zadanú). */
router.post('/campaigns/:id/test', ownCampaign, async (req, res) => {
  const me = getDb().prepare('SELECT email, name FROM users WHERE id = ?').get(req.userId);
  const to = mk.EMAIL.test(req.body?.email || '') ? req.body.email : me.email;
  const c = req.campaign;
  try {
    const msg = mk.message(req.userId, { email: to, name: me.name || '', unsubscribe_token: 'test' },
      { subject: `[TEST] ${c.subject}`, preheader: c.preheader, body: c.body, buttonText: c.button_text, buttonUrl: c.button_url }, `test-${c.id}`);
    await resend.request('POST', '/emails', msg);
    res.json({ ok: true, to });
  } catch (e) { fail(res, e); }
});

router.post('/campaigns/:id/send', ownCampaign, (req, res) => {
  const c = req.campaign;
  if (!['draft', 'failed'].includes(c.status)) return res.status(400).json({ error: 'Kampaň už bola odoslaná alebo naplánovaná.' });
  if (!resend.configured()) return res.status(400).json({ error: 'E-mail marketing nie je na serveri nastavený (RESEND_API_KEY).' });
  const at = req.body?.scheduledAt ? Math.floor(new Date(req.body.scheduledAt).getTime() / 1000) : null;
  if (at) {
    if (!(at > Date.now() / 1000)) return res.status(400).json({ error: 'Čas odoslania musí byť v budúcnosti.' });
    if (!c.subject.trim() || !c.body.trim()) return res.status(400).json({ error: 'Kampaň potrebuje predmet aj text.' });
    getDb().prepare("UPDATE email_campaigns SET status = 'scheduled', scheduled_at = ?, error = NULL WHERE id = ?").run(at, c.id);
    return res.json(campaignView(getDb().prepare('SELECT * FROM email_campaigns WHERE id = ?').get(c.id)));
  }
  const r = mk.startCampaign(c);
  if (r.error) return res.status(400).json(r);
  res.json(campaignView(getDb().prepare('SELECT * FROM email_campaigns WHERE id = ?').get(c.id)));
});

router.post('/campaigns/:id/cancel', ownCampaign, (req, res) => {
  if (req.campaign.status !== 'scheduled') return res.status(400).json({ error: 'Zrušiť sa dá iba naplánovaná kampaň.' });
  getDb().prepare("UPDATE email_campaigns SET status = 'draft', scheduled_at = NULL WHERE id = ?").run(req.campaign.id);
  res.json(campaignView(getDb().prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.campaign.id)));
});

/* ── Automatické série ── */

function sequenceView(s) {
  const db = getDb();
  const e = db.prepare("SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'done') AS done FROM email_enrollments WHERE sequence_id = ?").get(s.id);
  return { id: s.id, name: s.name, trigger: s.trigger, triggerRef: s.trigger_ref, active: !!s.active, steps: JSON.parse(s.steps || '[]'),
    enrolled: e.total || 0, running: e.active || 0, finished: e.done || 0 };
}

function sequenceFields(b) {
  if (!TRIGGERS.includes(b.trigger)) return { error: 'Vyberte spúšťač.' };
  const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 20).map(s => ({
    delayHours: Math.max(0, Math.min(24 * 365, Number(s.delayHours) || 0)), subject: String(s.subject || '').slice(0, 200),
    preheader: String(s.preheader || '').slice(0, 200), body: String(s.body || '').slice(0, 50000),
    buttonText: String(s.buttonText || '').slice(0, 80), buttonUrl: String(s.buttonUrl || '').trim(),
  }));
  if (steps.some(s => s.buttonUrl && !/^https?:\/\//i.test(s.buttonUrl))) return { error: 'Odkaz tlačidla musí začínať http:// alebo https://' };
  if (b.active && (!steps.length || steps.some(s => !s.subject.trim() || !s.body.trim()))) return { error: 'Každý e-mail série potrebuje predmet aj text.' };
  return { name: String(b.name || 'Nová séria').slice(0, 120), trigger: b.trigger, trigger_ref: b.trigger === 'tag' ? mk.parseTags([b.triggerRef])[0] || null : b.triggerRef || null,
    active: b.active ? 1 : 0, steps: JSON.stringify(steps) };
}

router.get('/sequences', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM email_sequences WHERE user_id = ? ORDER BY created_at DESC').all(req.userId).map(sequenceView));
});

router.post('/sequences', (req, res) => {
  const f = sequenceFields(req.body || {});
  if (f.error) return res.status(400).json(f);
  const id = uuidv4();
  getDb().prepare('INSERT INTO email_sequences (id, user_id, name, trigger, trigger_ref, active, steps) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, f.name, f.trigger, f.trigger_ref, f.active, f.steps);
  res.json(sequenceView(getDb().prepare('SELECT * FROM email_sequences WHERE id = ?').get(id)));
});

router.put('/sequences/:id', (req, res) => {
  const s = getDb().prepare('SELECT * FROM email_sequences WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!s) return res.status(404).json({ error: 'Séria nenájdená.' });
  const f = sequenceFields(req.body || {});
  if (f.error) return res.status(400).json(f);
  getDb().prepare('UPDATE email_sequences SET name = ?, trigger = ?, trigger_ref = ?, active = ?, steps = ? WHERE id = ?')
    .run(f.name, f.trigger, f.trigger_ref, f.active, f.steps, s.id);
  res.json(sequenceView(getDb().prepare('SELECT * FROM email_sequences WHERE id = ?').get(s.id)));
});

router.delete('/sequences/:id', (req, res) => {
  getDb().prepare('DELETE FROM email_sequences WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
