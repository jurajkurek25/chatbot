'use strict';
/**
 * E-mail marketing cez Resend (účet Neoworkly, overená doména klienta).
 * Kontakty sú iba ľudia so súhlasom s odberom (funnel, nákup, chatbot, ručne so súhlasom).
 * Kampane idú dávkami po 100 (Idempotency-Key), série podľa spúšťača; plánovač v server.js.
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const resend = require('./resend');

const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const now = () => Math.floor(Date.now() / 1000);
const monthlyLimit = () => Number(process.env.MARKETING_MONTHLY_LIMIT) || 10000;
const BATCH = 100;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const store = userId => require('./shop').storeOf(userId); // lenivo: shop → marketing → shop

/* ── Nastavenia odosielateľa ─────────────────────────────────── */

function settings(userId) {
  const s = getDb().prepare('SELECT * FROM email_settings WHERE user_id = ?').get(userId);
  return {
    enabled: !!s, fromName: s?.from_name || '', fromLocal: s?.from_local || 'info', replyTo: s?.reply_to || '',
    address: s?.address || '', widgetOptin: s ? !!s.widget_optin : true,
    domain: s?.domain || null, domainStatus: s?.domain_status || null, domainRecords: JSON.parse(s?.domain_records || '[]'),
  };
}

function saveSettings(userId, b) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO email_settings (user_id) VALUES (?)').run(userId);
  const local = String(b.fromLocal ?? 'info').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(local)) return { error: 'Adresa odosielateľa môže obsahovať iba písmená, čísla, bodku, pomlčku a podčiarkovník.' };
  if (b.replyTo && !EMAIL.test(b.replyTo)) return { error: 'Neplatný e-mail pre odpovede.' };
  db.prepare('UPDATE email_settings SET from_name = ?, from_local = ?, reply_to = ?, address = ?, widget_optin = ? WHERE user_id = ?')
    .run(String(b.fromName || '').replace(/["<>\r\n]/g, '').trim().slice(0, 80), local, String(b.replyTo || '').trim(),
      String(b.address || '').trim().slice(0, 300), b.widgetOptin === false ? 0 : 1, userId);
  return { settings: settings(userId) };
}

/** Odosielateľ: overená doména klienta, inak doména platformy s odpoveďou na klienta. */
function sender(userId) {
  const s = settings(userId);
  const st = store(userId);
  const name = (s.fromName || st.name || 'Neoworkly').replace(/["<>\r\n]/g, '');
  const replyTo = s.replyTo || st.supportEmail || undefined;
  if (s.domain && s.domainStatus === 'verified') return { from: `${name} <${s.fromLocal}@${s.domain}>`, replyTo };
  const platform = process.env.MARKETING_FROM_DOMAIN;
  if (!platform) throw new Error('Overte svoju doménu v nastaveniach e-mail marketingu.');
  return { from: `${name} <noreply@${platform}>`, replyTo };
}

/* ── Kontakty ────────────────────────────────────────────────── */

const normEmail = e => String(e || '').trim().toLowerCase();
const parseTags = t => (Array.isArray(t) ? t : String(t || '').split(','))
  .map(x => String(x).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 20);

/**
 * Pridá / aktualizuje kontakt. Nový kontakt vznikne iba so súhlasom (consent). Nový súhlas
 * obnoví odber po odhlásení; odrazené a sťažnosti zostávajú vypnuté.
 */
function upsertContact(userId, { email, name, source = 'manual', consent = false, tags = [] }) {
  const e = normEmail(email);
  if (!EMAIL.test(e)) return null;
  const db = getDb();
  const newTags = parseTags(tags);
  let c = db.prepare('SELECT * FROM email_contacts WHERE user_id = ? AND email = ?').get(userId, e);
  let subscribedNow = false;
  if (!c) {
    if (!consent) return null;
    db.prepare(`INSERT INTO email_contacts (id, user_id, email, name, source, tags, consent_at, unsubscribe_token)
                VALUES (?, ?, ?, ?, ?, ?, unixepoch(), ?)`)
      .run(uuidv4(), userId, e, String(name || '').trim().slice(0, 120), source, JSON.stringify(newTags), crypto.randomBytes(18).toString('base64url'));
    subscribedNow = true;
  } else {
    const merged = [...new Set([...JSON.parse(c.tags || '[]'), ...newTags])];
    const resub = consent && c.status === 'unsubscribed';
    db.prepare(`UPDATE email_contacts SET name = CASE WHEN name = '' THEN ? ELSE name END, tags = ?, updated_at = unixepoch(),
                status = CASE WHEN ? THEN 'subscribed' ELSE status END, consent_at = CASE WHEN ? THEN unixepoch() ELSE consent_at END WHERE id = ?`)
      .run(String(name || '').trim().slice(0, 120), JSON.stringify(merged), resub ? 1 : 0, consent ? 1 : 0, c.id);
    subscribedNow = resub;
    for (const t of newTags.filter(t => !JSON.parse(c.tags || '[]').includes(t))) enroll(userId, 'tag', t, c.id);
  }
  c = db.prepare('SELECT * FROM email_contacts WHERE user_id = ? AND email = ?').get(userId, e);
  if (subscribedNow) {
    enroll(userId, 'contact_added', null, c.id);
    for (const t of newTags) enroll(userId, 'tag', t, c.id);
  }
  return c;
}

const subscribedContact = (userId, email) =>
  getDb().prepare("SELECT * FROM email_contacts WHERE user_id = ? AND email = ? AND status = 'subscribed'").get(userId, normEmail(email));

/** Nákup / produkt zadarmo: spustí série „po nákupe“ pre kontakt so súhlasom. */
function onPurchase(userId, email, productId) {
  const c = subscribedContact(userId, email);
  if (c) enroll(userId, 'purchase', productId, c.id);
}
function onLeadMagnet(userId, email, leadMagnetId) {
  const c = subscribedContact(userId, email);
  if (c) enroll(userId, 'lead_magnet', leadMagnetId, c.id);
}

function unsubscribe(token) {
  const db = getDb();
  const c = db.prepare('SELECT * FROM email_contacts WHERE unsubscribe_token = ?').get(String(token || ''));
  if (!c) return null;
  db.prepare("UPDATE email_contacts SET status = CASE WHEN status = 'subscribed' THEN 'unsubscribed' ELSE status END, updated_at = unixepoch() WHERE id = ?").run(c.id);
  db.prepare("UPDATE email_enrollments SET status = 'stopped' WHERE contact_id = ? AND status = 'active'").run(c.id);
  return c;
}

/** Segment: { sources: [], tags: [], productId } – prázdny = všetci prihlásení. */
function segmentContacts(userId, segment = {}) {
  const db = getDb();
  let list = db.prepare("SELECT * FROM email_contacts WHERE user_id = ? AND status = 'subscribed' ORDER BY created_at").all(userId);
  const sources = Array.isArray(segment.sources) ? segment.sources : [];
  const tags = parseTags(segment.tags || []);
  if (sources.length) list = list.filter(c => sources.includes(c.source));
  if (tags.length) list = list.filter(c => JSON.parse(c.tags || '[]').some(t => tags.includes(t)));
  if (segment.productId) {
    const buyers = new Set(db.prepare("SELECT lower(email) AS e FROM orders WHERE user_id = ? AND product_id = ? AND status IN ('paid','free')").all(userId, segment.productId).map(r => r.e));
    list = list.filter(c => buyers.has(c.email));
  }
  return list;
}

/* ── Šablóna e-mailu ─────────────────────────────────────────── */

function personalize(text, contact) {
  return String(text || '').replace(/\{\{\s*meno\s*\}\}/gi, contact.name || '').replace(/\{\{\s*email\s*\}\}/gi, contact.email);
}

/** Text → HTML: odseky, **tučné**, odkazy (iba http/https), všetko escapované. */
function bodyHtml(text) {
  return String(text || '').trim().split(/\n{2,}/).map(p => {
    let h = esc(p).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" style="color:inherit">$1</a>');
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.65">${h.replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

function render(userId, contact, content) {
  const st = store(userId);
  const s = settings(userId);
  const name = s.fromName || st.name;
  const unsub = `${appUrl()}/api/marketing/u/${contact.unsubscribe_token}`;
  const subject = personalize(content.subject, contact);
  const body = personalize(content.body, contact);
  const button = content.buttonText && /^https?:\/\//.test(content.buttonUrl || '')
    ? `<p style="margin:24px 0"><a href="${esc(content.buttonUrl)}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:${esc(st.color)};color:#fff;font-weight:700;text-decoration:none">${esc(personalize(content.buttonText, contact))}</a></p>` : '';
  const html = `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1e293b">
${content.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${esc(personalize(content.preheader, contact))}</div>` : ''}
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden">
  <div style="height:6px;background:${esc(st.color)}"></div>
  <div style="padding:28px 30px">${bodyHtml(body)}${button}</div>
</div>
<div style="max-width:600px;margin:0 auto 32px;padding:0 30px;font-size:12px;line-height:1.6;color:#64748b;text-align:center">
  ${esc(name)}${s.address ? ` · ${esc(s.address)}` : ''}<br>
  Tento e-mail dostávate, pretože ste súhlasili s odberom noviniek od ${esc(name)}.<br>
  <a href="${unsub}" style="color:#64748b">Odhlásiť sa z odberu</a>
</div></body></html>`;
  const text = `${body}${button ? `\n\n${personalize(content.buttonText, contact)}: ${content.buttonUrl}` : ''}\n\n--\n${name}${s.address ? `, ${s.address}` : ''}\nOdhlásenie: ${unsub}`;
  return { subject, html, text, unsub };
}

function message(userId, contact, content, sendId) {
  const { from, replyTo } = sender(userId);
  const r = render(userId, contact, content);
  return {
    from, to: [contact.email], subject: r.subject, html: r.html, text: r.text, reply_to: replyTo,
    headers: { 'List-Unsubscribe': `<${r.unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    tags: [{ name: 'nw_send', value: sendId }],
  };
}

/* ── Limit ───────────────────────────────────────────────────── */

function monthStart() {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}
const usage = userId => getDb().prepare("SELECT COUNT(*) AS n FROM email_sends WHERE user_id = ? AND created_at >= ? AND status NOT IN ('failed','skipped')").get(userId, monthStart()).n;

/* ── Kampane ─────────────────────────────────────────────────── */

const campaignContent = c => ({ subject: c.subject, preheader: c.preheader, body: c.body, buttonText: c.button_text, buttonUrl: c.button_url });

/** Spustí odoslanie: zoznam príjemcov sa zafixuje (email_sends), samotné posielanie robí processCampaigns. */
function startCampaign(campaign) {
  const db = getDb();
  if (!campaign.subject.trim() || !campaign.body.trim()) return { error: 'Kampaň potrebuje predmet aj text.' };
  try { sender(campaign.user_id); } catch (e) { return { error: e.message }; }
  const recipients = segmentContacts(campaign.user_id, JSON.parse(campaign.segment || '{}'));
  if (!recipients.length) return { error: 'Segment nemá žiadnych prihlásených príjemcov.' };
  if (usage(campaign.user_id) + recipients.length > monthlyLimit()) {
    return { error: `Prekročili by ste mesačný limit ${monthlyLimit().toLocaleString('sk-SK')} e-mailov.` };
  }
  const ins = db.prepare("INSERT OR IGNORE INTO email_sends (id, user_id, contact_id, campaign_id, status) VALUES (?, ?, ?, ?, 'queued')");
  db.transaction(() => {
    recipients.forEach(c => ins.run(uuidv4(), campaign.user_id, c.id, campaign.id));
    db.prepare("UPDATE email_campaigns SET status = 'sending', recipients = ?, error = NULL WHERE id = ?").run(recipients.length, campaign.id);
  })();
  setImmediate(() => processCampaigns().catch(err => console.error('[marketing]', err.message)));
  return { recipients: recipients.length };
}

let busy = false;
async function processCampaigns() {
  if (busy) return;
  busy = true;
  const db = getDb();
  try {
    for (const c of db.prepare("SELECT * FROM email_campaigns WHERE status = 'sending'").all()) {
      for (;;) {
        const batch = db.prepare(`SELECT s.id, s.contact_id, ct.email, ct.name, ct.status AS cstatus, ct.unsubscribe_token FROM email_sends s
                                  JOIN email_contacts ct ON ct.id = s.contact_id WHERE s.campaign_id = ? AND s.status = 'queued' LIMIT ?`).all(c.id, BATCH);
        if (!batch.length) {
          db.prepare("UPDATE email_campaigns SET status = 'sent', sent_at = unixepoch() WHERE id = ?").run(c.id);
          break;
        }
        // Medzitým odhlásení sa preskočia
        const skip = batch.filter(b => b.cstatus !== 'subscribed');
        skip.forEach(b => db.prepare("UPDATE email_sends SET status = 'skipped' WHERE id = ?").run(b.id));
        const live = batch.filter(b => b.cstatus === 'subscribed');
        if (!live.length) continue;
        let payload;
        try {
          payload = live.map(b => message(c.user_id, { id: b.contact_id, email: b.email, name: b.name, unsubscribe_token: b.unsubscribe_token }, campaignContent(c), b.id));
        } catch (e) {
          db.prepare("UPDATE email_campaigns SET status = 'failed', error = ? WHERE id = ?").run(e.message, c.id);
          break;
        }
        const key = crypto.createHash('sha256').update(live.map(b => b.id).join(',')).digest('hex');
        try {
          const res = await resend.request('POST', '/emails/batch', payload, { 'Idempotency-Key': key });
          const ids = res.data || [];
          db.transaction(() => live.forEach((b, i) => db.prepare("UPDATE email_sends SET status = 'sent', resend_id = ? WHERE id = ?").run(ids[i]?.id || null, b.id)))();
        } catch (e) {
          if (e.status && e.status < 500 && e.status !== 429) {
            // Chyba v dátach (napr. neplatná adresa): dávka zlyhá natrvalo, kampaň pokračuje
            live.forEach(b => db.prepare("UPDATE email_sends SET status = 'failed', error = ? WHERE id = ?").run(e.message, b.id));
            continue;
          }
          console.error('[marketing] Resend nedostupný, skúsim neskôr:', e.message);
          break; // ostatné zostanú vo fronte na ďalší beh plánovača
        }
      }
    }
  } finally {
    busy = false;
  }
}

function campaignStats(campaignId) {
  const r = getDb().prepare(`SELECT COUNT(*) AS total,
      SUM(status IN ('sent','delivered','bounced','complained')) AS sent, SUM(status = 'delivered') AS delivered,
      SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked,
      SUM(status = 'bounced') AS bounced, SUM(status = 'complained') AS complained, SUM(status = 'failed') AS failed,
      SUM(status = 'queued') AS queued FROM email_sends WHERE campaign_id = ?`).get(campaignId);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0]));
}

/* ── Automatické série ───────────────────────────────────────── */

function enroll(userId, trigger, ref, contactId) {
  const db = getDb();
  const seqs = db.prepare("SELECT * FROM email_sequences WHERE user_id = ? AND trigger = ? AND active = 1 AND (trigger_ref IS NULL OR trigger_ref = '' OR trigger_ref = ?)")
    .all(userId, trigger, ref == null ? '' : String(ref));
  for (const s of seqs) {
    const steps = JSON.parse(s.steps || '[]');
    if (!steps.length) continue;
    db.prepare('INSERT OR IGNORE INTO email_enrollments (id, sequence_id, contact_id, next_at) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), s.id, contactId, now() + Math.round((Number(steps[0].delayHours) || 0) * 3600));
  }
}

let seqBusy = false;
async function processSequences() {
  if (seqBusy) return;
  seqBusy = true;
  const db = getDb();
  try {
    const due = db.prepare(`SELECT e.*, s.user_id, s.steps, s.active, c.email, c.name, c.status AS cstatus, c.unsubscribe_token
                            FROM email_enrollments e JOIN email_sequences s ON s.id = e.sequence_id JOIN email_contacts c ON c.id = e.contact_id
                            WHERE e.status = 'active' AND e.next_at <= ? ORDER BY e.next_at LIMIT 200`).all(now());
    for (const e of due) {
      const steps = JSON.parse(e.steps || '[]');
      const step = steps[e.step];
      if (!e.active || e.cstatus !== 'subscribed' || !step) {
        db.prepare('UPDATE email_enrollments SET status = ? WHERE id = ?').run(step ? 'stopped' : 'done', e.id);
        continue;
      }
      if (usage(e.user_id) >= monthlyLimit()) continue; // pošle sa po obnovení limitu
      const sendId = uuidv4();
      let payload;
      try {
        payload = message(e.user_id, { id: e.contact_id, email: e.email, name: e.name, unsubscribe_token: e.unsubscribe_token }, step, sendId);
      } catch (err) {
        continue; // bez odosielateľa (neoverená doména) – skúsi sa znova
      }
      try {
        const r = await resend.request('POST', '/emails', payload, { 'Idempotency-Key': `${e.id}-${e.step}` });
        db.prepare("INSERT INTO email_sends (id, user_id, contact_id, sequence_id, step_index, resend_id, status) VALUES (?, ?, ?, ?, ?, ?, 'sent')")
          .run(sendId, e.user_id, e.contact_id, e.sequence_id, e.step, r.id || null);
      } catch (err) {
        if (!err.status || err.status >= 500 || err.status === 429) continue; // dočasná chyba – znova pri ďalšom behu
        db.prepare("INSERT INTO email_sends (id, user_id, contact_id, sequence_id, step_index, status, error) VALUES (?, ?, ?, ?, ?, 'failed', ?)")
          .run(sendId, e.user_id, e.contact_id, e.sequence_id, e.step, err.message);
      }
      const next = steps[e.step + 1];
      if (next) db.prepare('UPDATE email_enrollments SET step = step + 1, next_at = ? WHERE id = ?').run(now() + Math.round((Number(next.delayHours) || 0) * 3600), e.id);
      else db.prepare("UPDATE email_enrollments SET step = step + 1, status = 'done' WHERE id = ?").run(e.id);
    }
  } finally {
    seqBusy = false;
  }
}

/* ── Udalosti z Resend (webhook) ─────────────────────────────── */

function handleEvent(evt) {
  const db = getDb();
  const s = evt?.data?.email_id && db.prepare('SELECT * FROM email_sends WHERE resend_id = ?').get(evt.data.email_id);
  if (!s) return false;
  const stopContact = status => {
    db.prepare("UPDATE email_contacts SET status = ?, updated_at = unixepoch() WHERE id = ? AND status = 'subscribed'").run(status, s.contact_id);
    db.prepare("UPDATE email_enrollments SET status = 'stopped' WHERE contact_id = ? AND status = 'active'").run(s.contact_id);
  };
  switch (evt.type) {
    case 'email.delivered': db.prepare("UPDATE email_sends SET status = 'delivered' WHERE id = ? AND status = 'sent'").run(s.id); break;
    case 'email.opened': db.prepare('UPDATE email_sends SET opened_at = COALESCE(opened_at, unixepoch()) WHERE id = ?').run(s.id); break;
    case 'email.clicked': db.prepare('UPDATE email_sends SET clicked_at = COALESCE(clicked_at, unixepoch()), opened_at = COALESCE(opened_at, unixepoch()) WHERE id = ?').run(s.id); break;
    case 'email.bounced':
      db.prepare("UPDATE email_sends SET status = 'bounced' WHERE id = ?").run(s.id);
      if (!evt.data.bounce || /permanent/i.test(evt.data.bounce.type || '')) stopContact('bounced');
      break;
    case 'email.complained':
      db.prepare("UPDATE email_sends SET status = 'complained' WHERE id = ?").run(s.id);
      stopContact('complained');
      break;
    case 'email.suppressed':
      db.prepare("UPDATE email_sends SET status = 'failed', error = 'suppressed' WHERE id = ?").run(s.id);
      stopContact('bounced');
      break;
    case 'email.failed': db.prepare("UPDATE email_sends SET status = 'failed', error = ? WHERE id = ?").run(evt.data.failed?.reason || 'failed', s.id); break;
    default: return false;
  }
  return true;
}

/* ── Doména klienta (Resend Domains) ─────────────────────────── */

function storeDomain(userId, d) {
  getDb().prepare('UPDATE email_settings SET domain = ?, domain_id = ?, domain_status = ?, domain_records = ? WHERE user_id = ?')
    .run(d.name, d.id, d.status || 'not_started', JSON.stringify(d.records || []), userId);
}

async function addDomain(userId, domain) {
  const name = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!DOMAIN.test(name)) return { error: 'Zadajte doménu, napr. mojafirma.sk' };
  const s = settings(userId);
  if (s.domain) return { error: 'Doménu najprv odstráňte.' };
  getDb().prepare('INSERT OR IGNORE INTO email_settings (user_id) VALUES (?)').run(userId);
  const d = await resend.request('POST', '/domains', { name, region: process.env.RESEND_REGION || 'eu-west-1' });
  storeDomain(userId, { ...d, name });
  return { settings: settings(userId) };
}

async function refreshDomain(userId, verify) {
  const row = getDb().prepare('SELECT domain, domain_id, domain_records FROM email_settings WHERE user_id = ?').get(userId);
  if (!row?.domain_id) return { error: 'Najprv pridajte doménu.' };
  if (verify) await resend.request('POST', `/domains/${encodeURIComponent(row.domain_id)}/verify`);
  const d = await resend.request('GET', `/domains/${encodeURIComponent(row.domain_id)}`);
  storeDomain(userId, { ...d, name: row.domain, records: d.records || JSON.parse(row.domain_records || '[]') });
  return { settings: settings(userId) };
}

async function removeDomain(userId) {
  const row = getDb().prepare('SELECT domain_id FROM email_settings WHERE user_id = ?').get(userId);
  if (row?.domain_id) await resend.request('DELETE', `/domains/${encodeURIComponent(row.domain_id)}`).catch(e => { if (e.status !== 404) throw e; });
  getDb().prepare('UPDATE email_settings SET domain = NULL, domain_id = NULL, domain_status = NULL, domain_records = NULL WHERE user_id = ?').run(userId);
  return { settings: settings(userId) };
}

/* ── Plánovač ────────────────────────────────────────────────── */

async function tick() {
  if (!resend.configured()) return;
  const db = getDb();
  for (const c of db.prepare("SELECT * FROM email_campaigns WHERE status = 'scheduled' AND scheduled_at <= ?").all(now())) {
    const r = startCampaign(c);
    if (r.error) db.prepare("UPDATE email_campaigns SET status = 'failed', error = ? WHERE id = ?").run(r.error, c.id);
  }
  await processCampaigns();
  await processSequences();
}

function startScheduler() {
  const run = () => tick().catch(err => console.error('[marketing]', err.message));
  setTimeout(run, 20 * 1000).unref();
  setInterval(run, 60 * 1000).unref();
}

module.exports = {
  EMAIL, settings, saveSettings, sender, upsertContact, onPurchase, onLeadMagnet, unsubscribe, segmentContacts, parseTags,
  render, message, usage, monthlyLimit, startCampaign, processCampaigns, campaignStats, enroll, processSequences,
  handleEvent, addDomain, refreshDomain, removeDomain, tick, startScheduler,
};
