'use strict';
/**
 * Booking e-mails + calendar files.
 *
 * Customer: confirmation (with .ics invite, add-to-calendar buttons and a manage link),
 * reminders, cancellation and reschedule notices.
 * Staff: new booking, reminders, cancellation and reschedule notices.
 * Every send is recorded in booking_notifications so reminders go out exactly once.
 */

const { getDb } = require('../db/database');
const { createTransport } = require('./email');

const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const manageUrl = b => `${appUrl()}/booking/manage/${b.manage_token}`;
const icsUrl = b => `${appUrl()}/api/booking/manage/${b.manage_token}/ics`;

/* ── Context ──────────────────────────────────────────────────── */

function loadContext(bookingId) {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return null;
  const cfg = db.prepare('SELECT * FROM booking_configs WHERE id = ?').get(booking.booking_config_id);
  const staff = booking.staff_id ? db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(booking.staff_id) : null;
  const widget = db.prepare('SELECT w.bot_name, w.primary_color, u.email AS owner_email, u.name AS owner_name FROM widgets w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(booking.widget_id) || {};
  const design = parse(cfg?.design_config, {});
  const service = booking.service_id ? db.prepare('SELECT * FROM booking_services WHERE id = ?').get(booking.service_id) : null;
  return {
    booking, cfg, staff, service,
    business: design.calendarName || widget.bot_name || 'Neoworkly',
    color: design.primaryColor || widget.primary_color || '#5b4fff',
    staffEmail: (staff && staff.email) || widget.owner_email,
    tz: cfg?.timezone || 'Europe/Bratislava',
  };
}

function fmtWhen(b, tz) {
  const d = new Date(b.start_utc * 1000);
  const day = d.toLocaleDateString('sk-SK', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `${day}, ${b.start_time} – ${b.end_time}`;
}

const LOCATION_LABEL = { in_person: 'Osobne', online: 'Online', phone: 'Telefonicky' };

/* ── Calendar: .ics + add-to-calendar links ───────────────────── */

const icsDate = sec => new Date(sec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545: lines longer than 75 octets are folded
const fold = line => { const out = []; let s = line; while (Buffer.byteLength(s) > 74) { let i = 74; while (Buffer.byteLength(s.slice(0, i)) > 74) i--; out.push(s.slice(0, i)); s = ' ' + s.slice(i); } out.push(s); return out.join('\r\n'); };

function eventFields(ctx) {
  const b = ctx.booking;
  const title = `${b.service_name || 'Rezervácia'} – ${ctx.business}`;
  const details = [
    ctx.staff ? `S: ${ctx.staff.name}` : '',
    b.location_type === 'online' && b.location_detail ? `Online: ${b.location_detail}` : '',
    `Zmena alebo zrušenie: ${manageUrl(b)}`,
  ].filter(Boolean).join('\n');
  const location = b.location_type === 'online' ? (b.location_detail || 'Online') : (b.location_detail || '');
  return { title, details, location };
}

/** A single-event calendar. method REQUEST for new/updated, CANCEL for cancellations. */
function buildIcs(ctx, { method = 'REQUEST', forStaff = false } = {}) {
  const b = ctx.booking;
  const { title, details, location } = eventFields(ctx);
  const summary = forStaff ? `${b.service_name || 'Rezervácia'} – ${b.customer_name}` : title;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Neoworkly//Booking//SK', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${b.id}@neoworkly`,
    `SEQUENCE:${(b.reschedule_count || 0) + (method === 'CANCEL' ? 1 : 0)}`,
    `DTSTAMP:${icsDate(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${icsDate(b.start_utc)}`, `DTEND:${icsDate(b.end_utc)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(forStaff ? [b.customer_email, b.customer_phone].filter(Boolean).join(', ') : details)}`,
    location ? `LOCATION:${icsText(location)}` : '',
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    `ORGANIZER;CN=${icsText(ctx.business)}:mailto:${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || 'noreply@neoworkly.com'}`,
    `ATTENDEE;CN=${icsText(b.customer_name)};ROLE=REQ-PARTICIPANT:mailto:${b.customer_email}`,
    'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Feed of a staff member's bookings (subscribe in Apple / Outlook / Google Calendar). */
function buildStaffFeed(staff, cfg) {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const rows = db.prepare(`SELECT * FROM bookings WHERE staff_id = ? AND status = 'confirmed' AND start_utc >= ? ORDER BY start_utc`).all(staff.id, since);
  const events = rows.map(b => [
    'BEGIN:VEVENT', `UID:${b.id}@neoworkly`, `DTSTAMP:${icsDate(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${icsDate(b.start_utc)}`, `DTEND:${icsDate(b.end_utc)}`,
    `SUMMARY:${icsText(`${b.service_name || 'Rezervácia'} – ${b.customer_name}`)}`,
    `DESCRIPTION:${icsText([b.customer_email, b.customer_phone, b.notes].filter(Boolean).join('\n'))}`,
    b.location_detail ? `LOCATION:${icsText(b.location_detail)}` : '',
    'END:VEVENT',
  ].filter(Boolean).map(fold).join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Neoworkly//Booking feed//SK', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
          fold(`X-WR-CALNAME:${icsText(`Rezervácie – ${staff.name}`)}`), `X-WR-TIMEZONE:${cfg.timezone}`,
          ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

function calendarLinks(ctx) {
  const b = ctx.booking;
  const { title, details, location } = eventFields(ctx);
  const g = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${icsDate(b.start_utc)}/${icsDate(b.end_utc)}`, details, location });
  const o = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: title, body: details, location,
    startdt: new Date(b.start_utc * 1000).toISOString(), enddt: new Date(b.end_utc * 1000).toISOString() });
  return {
    google: `https://calendar.google.com/calendar/render?${g}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?${o}`,
    ics: icsUrl(b),
  };
}

/* ── E-mail layout ────────────────────────────────────────────── */

function layout(ctx, { heading, intro, rows = [], buttons = [], note = '' }) {
  const btn = (label, href, primary) => `<a href="${esc(href)}" style="display:inline-block;margin:4px 6px 4px 0;padding:11px 18px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;${primary ? `background:${ctx.color};color:#fff` : 'background:#f1f5f9;color:#1e293b'}">${esc(label)}</a>`;
  return `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1e293b">
<div style="max-width:560px;margin:28px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.07)">
  <div style="background:${ctx.color};padding:22px 28px;color:#fff">
    <div style="font-size:13px;opacity:.85">${esc(ctx.business)}</div>
    <div style="font-size:21px;font-weight:800;margin-top:4px">${esc(heading)}</div>
  </div>
  <div style="padding:24px 28px">
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6">${intro}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px">
      ${rows.filter(r => r && r[1]).map(([k, v]) => `<tr><td style="padding:7px 0;color:#64748b;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:7px 0;font-weight:600">${v}</td></tr>`).join('')}
    </table>
    <div>${buttons.map(([l, h, p]) => btn(l, h, p)).join('')}</div>
    ${note ? `<p style="margin:18px 0 0;font-size:13px;color:#64748b;line-height:1.6">${note}</p>` : ''}
  </div>
  <div style="padding:14px 28px;border-top:1px solid #eef0f4;font-size:12px;color:#94a3b8">${esc(ctx.business)} · rezervácie cez Neoworkly</div>
</div></body></html>`;
}

function bookingRows(ctx, { forStaff = false } = {}) {
  const b = ctx.booking;
  const answers = parse(b.answers, []);
  const loc = b.location_type ? `${LOCATION_LABEL[b.location_type] || ''}${b.location_detail ? ': ' + esc(b.location_detail) : ''}` : '';
  return [
    ['Služba', esc(b.service_name || 'Rezervácia')],
    ['Termín', esc(fmtWhen(b, ctx.tz))],
    ctx.staff && ['S kým', esc(ctx.staff.name)],
    b.seats > 1 && ['Počet osôb', String(b.seats)],
    ['Miesto', loc],
    forStaff && ['Zákazník', `${esc(b.customer_name)}<br><a href="mailto:${esc(b.customer_email)}">${esc(b.customer_email)}</a>${b.customer_phone ? `<br>${esc(b.customer_phone)}` : ''}`],
    ...(forStaff ? answers.map(a => [a.q, esc(a.a)]) : []),
    forStaff && b.notes && ['Poznámka', esc(b.notes)],
  ];
}

/* ── Sending ──────────────────────────────────────────────────── */

async function sendMail({ to, subject, html, ics, icsMethod, replyTo, business }) {
  const transport = createTransport();
  if (!transport || !to) { console.log(`[booking-mail] SMTP not configured or no recipient, skipped: ${subject}`); return false; }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const fromAddr = (from.match(/<([^>]+)>/) || [])[1] || from;
  const msg = { from: `"${String(business).replace(/"/g, '')}" <${fromAddr}>`, to, subject, html, replyTo };
  if (ics) msg.icalEvent = { method: icsMethod || 'REQUEST', filename: 'rezervacia.ics', content: ics };
  try { await transport.sendMail(msg); return true; }
  catch (err) { console.error('[booking-mail] failed:', err.message); return false; }
}

/** Record + send once; returns false when this kind was already sent for the booking. */
function once(bookingId, kind) {
  const r = getDb().prepare('INSERT OR IGNORE INTO booking_notifications (booking_id, kind) VALUES (?, ?)').run(bookingId, kind);
  return r.changes > 0;
}

const policyNote = ctx => {
  const { cfg } = ctx;
  if (!cfg.allow_cancel && !cfg.allow_reschedule) return '';
  const what = [cfg.allow_reschedule && 'presunúť', cfg.allow_cancel && 'zrušiť'].filter(Boolean).join(' alebo ');
  return `Termín môžete ${what} najneskôr ${cfg.cancel_hours} h pred začiatkom cez tlačidlo „Spravovať rezerváciu“.`;
};

async function notify(kind, bookingId, extra = {}) {
  const ctx = loadContext(bookingId);
  if (!ctx || !ctx.cfg) return;
  const b = ctx.booking;
  const links = calendarLinks(ctx);
  const calButtons = [['Google Kalendár', links.google], ['Outlook', links.outlook], ['Apple / iCal', links.ics]];
  const manageBtn = (ctx.cfg.allow_cancel || ctx.cfg.allow_reschedule) ? [['Spravovať rezerváciu', manageUrl(b), true]] : [];
  const staffMail = (subject, heading, intro, method) => ctx.cfg.notify_staff && sendMail({
    to: ctx.staffEmail, subject, business: ctx.business, replyTo: b.customer_email,
    html: layout(ctx, { heading, intro, rows: bookingRows(ctx, { forStaff: true }), buttons: [['Otvoriť dashboard', `${appUrl()}/dashboard`, true]] }),
    ics: buildIcs(ctx, { method, forStaff: true }), icsMethod: method,
  });

  if (kind === 'confirmed') {
    if (!once(b.id, 'confirmed')) return;
    await sendMail({
      to: b.customer_email, business: ctx.business, replyTo: ctx.staffEmail,
      subject: `Potvrdenie rezervácie – ${b.service_name || ctx.business}, ${b.date} ${b.start_time}`,
      html: layout(ctx, { heading: 'Rezervácia je potvrdená ✓', intro: `Dobrý deň ${esc(b.customer_name)}, tešíme sa na vás. Tu je zhrnutie:`,
        rows: bookingRows(ctx), buttons: [...manageBtn, ...calButtons], note: policyNote(ctx) }),
      ics: buildIcs(ctx), icsMethod: 'REQUEST',
    });
    await staffMail(`Nová rezervácia: ${b.customer_name} – ${b.date} ${b.start_time}`, 'Nová rezervácia', 'Práve pribudla nová rezervácia:', 'REQUEST');
  }

  if (kind === 'cancelled') {
    if (!once(b.id, 'cancelled')) return;
    const byCustomer = b.cancelled_by === 'customer';
    await sendMail({
      to: b.customer_email, business: ctx.business, replyTo: ctx.staffEmail,
      subject: `Rezervácia zrušená – ${b.service_name || ctx.business}, ${b.date} ${b.start_time}`,
      html: layout(ctx, { heading: 'Rezervácia bola zrušená',
        intro: byCustomer ? 'Vašu rezerváciu sme zrušili podľa vašej žiadosti.' : `Ospravedlňujeme sa, rezerváciu sme museli zrušiť.${b.cancel_reason ? ' Dôvod: ' + esc(b.cancel_reason) : ''}`,
        rows: bookingRows(ctx), buttons: [['Rezervovať nový termín', `${appUrl()}/book/${b.widget_id}`, true]] }),
      ics: buildIcs(ctx, { method: 'CANCEL' }), icsMethod: 'CANCEL',
    });
    if (byCustomer) await staffMail(`Zrušená rezervácia: ${b.customer_name} – ${b.date} ${b.start_time}`, 'Zákazník zrušil rezerváciu',
      `${esc(b.customer_name)} zrušil(a) rezerváciu.${b.cancel_reason ? ' Dôvod: ' + esc(b.cancel_reason) : ''}`, 'CANCEL');
  }

  if (kind === 'rescheduled') {
    const k = `rescheduled_${b.reschedule_count}`;
    if (!once(b.id, k)) return;
    const old = extra.previous ? ` (pôvodne ${extra.previous})` : '';
    await sendMail({
      to: b.customer_email, business: ctx.business, replyTo: ctx.staffEmail,
      subject: `Rezervácia presunutá – ${b.date} ${b.start_time}`,
      html: layout(ctx, { heading: 'Termín bol zmenený', intro: `Váš nový termín${esc(old)}:`, rows: bookingRows(ctx),
        buttons: [...manageBtn, ...calButtons], note: policyNote(ctx) }),
      ics: buildIcs(ctx), icsMethod: 'REQUEST',
    });
    await staffMail(`Presunutá rezervácia: ${b.customer_name} → ${b.date} ${b.start_time}`, 'Rezervácia bola presunutá',
      `${esc(b.customer_name)} presunul(a) rezerváciu${esc(old)}.`, 'REQUEST');
  }

  if (kind === 'staff_changed') {
    if (!once(b.id, `staff_${b.reschedule_count}`)) return;
    await sendMail({
      to: b.customer_email, business: ctx.business, replyTo: ctx.staffEmail,
      subject: `Zmena v rezervácii – ${b.date} ${b.start_time}`,
      html: layout(ctx, { heading: 'Termín platí, mení sa kolega', intro: `Dobrý deň ${esc(b.customer_name)}, váš termín zostáva rovnaký. Obslúži vás ${esc(ctx.staff?.name || 'iný kolega')}.`,
        rows: bookingRows(ctx), buttons: [...manageBtn, ...calButtons], note: policyNote(ctx) }),
      ics: buildIcs(ctx), icsMethod: 'REQUEST',
    });
    await staffMail(`Prevzatá rezervácia: ${b.customer_name} – ${b.date} ${b.start_time}`, 'Prevzali ste rezerváciu', 'Táto rezervácia vám bola priradená:', 'REQUEST');
  }

  if (kind === 'reminder_customer') {
    await sendMail({
      to: b.customer_email, business: ctx.business, replyTo: ctx.staffEmail,
      subject: `Pripomienka: ${b.service_name || 'rezervácia'} ${extra.when || ''}`.trim(),
      html: layout(ctx, { heading: `Pripomienka termínu${extra.when ? ' – ' + extra.when : ''}`, intro: `Dobrý deň ${esc(b.customer_name)}, pripomíname váš termín:`,
        rows: bookingRows(ctx), buttons: [...manageBtn, ...calButtons], note: policyNote(ctx) }),
    });
  }

  if (kind === 'reminder_staff') {
    await sendMail({
      to: ctx.staffEmail, business: ctx.business, replyTo: b.customer_email,
      subject: `Pripomienka: ${b.customer_name} ${extra.when || ''} (${b.start_time})`,
      html: layout(ctx, { heading: `Blíži sa termín${extra.when ? ' – ' + extra.when : ''}`, intro: 'Pripomienka nadchádzajúcej rezervácie:',
        rows: bookingRows(ctx, { forStaff: true }), buttons: [['Otvoriť dashboard', `${appUrl()}/dashboard`, true]] }),
    });
  }
}

/* ── Reminder scheduler ───────────────────────────────────────── */

const whenLabel = mins => mins >= 1440 ? (mins === 1440 ? 'zajtra' : `o ${Math.round(mins / 1440)} dni`) : mins >= 60 ? `o ${Math.round(mins / 60)} h` : `o ${mins} min`;

/**
 * Sends due reminders. Offsets are minutes before start (config: reminders_customer /
 * reminders_staff). A reminder whose moment had already passed when the booking was made
 * (e.g. booked 30 min ahead with a 60-min reminder) is skipped, not sent late.
 */
async function runReminders() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`SELECT b.id, b.start_utc, b.created_at, c.reminders_customer, c.reminders_staff
                           FROM bookings b JOIN booking_configs c ON c.id = b.booking_config_id
                           WHERE b.status = 'confirmed' AND b.start_utc > ? AND b.start_utc <= ?`).all(now, now + 8 * 86400);
  for (const r of rows) {
    for (const [who, list] of [['customer', parse(r.reminders_customer, [])], ['staff', parse(r.reminders_staff, [])]]) {
      for (const mins of list) {
        const at = r.start_utc - mins * 60;
        if (now < at) continue;                       // not due yet
        // booked inside the window, or a closer reminder is already due (e.g. after downtime): skip
        const stale = r.created_at > at || list.some(m => m < mins && now >= r.start_utc - m * 60);
        if (stale) { once(r.id, `rem_${who}_${mins}`); continue; }
        if (once(r.id, `rem_${who}_${mins}`)) await notify(`reminder_${who}`, r.id, { when: whenLabel(mins) });
      }
    }
  }
}

let timer = null;
function startReminderScheduler() {
  if (timer) return;
  const tick = () => runReminders().catch(err => console.error('[booking reminders]', err.message));
  timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
}

/** Sends the staff member their private wellbeing link (the owner never sees it). */
async function sendWellbeingLink(staff, business, token) {
  return sendMail({
    to: staff.email, business, subject: `Váš súkromný wellbeing odkaz – ${business}`,
    html: layout({ color: '#5b4fff', business }, {
      heading: 'Váš súkromný wellbeing priestor',
      intro: `Dobrý deň ${esc(staff.name)}, cez tento odkaz si môžete sami nastaviť voľno (aj menštruačné alebo pre duševné zdravie) a sledovanie cyklu s vlastnými limitmi termínov. Údaje vidíte iba vy – zamestnávateľ vidí len to, že ste nedostupná/ý, pokiaľ mu to sami nepovolíte.`,
      buttons: [['Otvoriť môj wellbeing', `${appUrl()}/wellbeing/${token}`, true]],
      note: 'Odkaz nikomu neposielajte. Kedykoľvek si ho môžete na stránke vygenerovať nanovo.' }),
  });
}

module.exports = { esc, layout, sendMail, appUrl, sendWellbeingLink, notify, buildIcs, buildStaffFeed, calendarLinks, loadContext, runReminders, startReminderScheduler, manageUrl };
