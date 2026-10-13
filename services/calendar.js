'use strict';
/**
 * Kalendár tímu: udalosti (s opakovaním, účastníkmi, videohovorom), k tomu termíny úloh a rezervácie.
 * Výstup vo formáte FullCalendar; ICS odber pre Google/Apple/Outlook.
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { zonedToUtc, addDays } = require('./bookingCore');
const workspace = require('./workspace');
const notifications = require('./notifications');
const links = require('./links');
const realtime = require('./realtime');

const TZ = () => process.env.APP_TIMEZONE || 'Europe/Bratislava';
const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const MAX_OCCURRENCES = 500;

/* ── Videohovor (Jitsi Meet) ─────────────────────────────────── */
const meetUrl = room => room ? `https://${process.env.JITSI_DOMAIN || 'meet.jit.si'}/${room}` : null;
const newRoom = () => `neoworkly-${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;

/* ── Čas ─────────────────────────────────────────────────────── */

/** Miestny dátum a čas (TZ) okamihu: ['2026-10-13', '14:30'] */
function local(sec) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(sec * 1000)).map(x => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}`];
}
const iso = sec => new Date(sec * 1000).toISOString();

/** Vstup z klienta: ISO s časom, alebo 'YYYY-MM-DD' pre celodenné (polnoc v TZ). */
function parseTime(v) {
  if (typeof v === 'number') return Math.floor(v);
  const s = String(v || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return zonedToUtc(s, '00:00', TZ());
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Výskyty udalosti v intervale [from, to) – opakovanie podľa miestneho času (sedí cez letný čas). */
function occurrences(e, from, to) {
  const dur = e.end_at - e.start_at;
  if (e.repeat === 'none') return e.start_at < to && e.end_at > from ? [e.start_at] : [];
  const [date0, time0] = local(e.start_at);
  const until = e.repeat_until || Infinity;
  const out = [];
  for (let i = 0; i < 5000 && out.length < MAX_OCCURRENCES; i++) {
    const date = e.repeat === 'daily' ? addDays(date0, i) : e.repeat === 'weekly' ? addDays(date0, 7 * i)
      : e.repeat === 'monthly' ? addMonths(date0, i) : addMonths(date0, 12 * i);
    const start = e.all_day ? zonedToUtc(date, '00:00', TZ()) : zonedToUtc(date, time0, TZ());
    if (start >= to || start > until) break;
    if (start + dur > from) out.push(start);
  }
  return out;
}

/* ── Udalosti ────────────────────────────────────────────────── */

const getEvent = (ownerId, id) => getDb().prepare('SELECT * FROM calendar_events WHERE id = ? AND owner_id = ?').get(id, ownerId);
const attendees = id => getDb().prepare('SELECT user_id FROM event_attendees WHERE event_id = ?').all(id).map(r => r.user_id);

function eventView(e) {
  return {
    id: e.id, title: e.title, description: e.description, location: e.location, start: iso(e.start_at), end: iso(e.end_at), allDay: !!e.all_day,
    color: e.color, repeat: e.repeat, repeatUntil: e.repeat_until ? iso(e.repeat_until) : null, meeting: meetUrl(e.meeting_room),
    attendees: attendees(e.id), createdBy: e.created_by,
  };
}

function fields(b, prev = {}) {
  const start = b.start !== undefined ? parseTime(b.start) : prev.start_at;
  let end = b.end !== undefined ? parseTime(b.end) : prev.end_at;
  const allDay = b.allDay !== undefined ? !!b.allDay : !!prev.all_day;
  if (!start) return { error: 'Zadajte začiatok udalosti.' };
  if (!end || end <= start) end = start + (allDay ? 86400 : 3600);
  const repeat = b.repeat !== undefined ? (REPEATS.includes(b.repeat) ? b.repeat : 'none') : prev.repeat || 'none';
  const title = b.title !== undefined ? String(b.title).trim().slice(0, 200) : prev.title;
  if (!title) return { error: 'Zadajte názov udalosti.' };
  return {
    title, description: b.description !== undefined ? String(b.description).slice(0, 10000) : prev.description || '',
    location: b.location !== undefined ? String(b.location).slice(0, 300) : prev.location || '',
    start_at: start, end_at: end, all_day: allDay ? 1 : 0, repeat,
    repeat_until: b.repeatUntil !== undefined ? parseTime(b.repeatUntil) : prev.repeat_until || null,
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : prev.color || '#5b4fff',
  };
}

function setAttendees(ownerId, e, userIds, actorId) {
  const db = getDb();
  const valid = [...new Set(userIds || [])].filter(u => workspace.isMember(ownerId, u));
  const before = attendees(e.id);
  db.prepare('DELETE FROM event_attendees WHERE event_id = ?').run(e.id);
  valid.forEach(u => db.prepare('INSERT INTO event_attendees (event_id, user_id) VALUES (?, ?)').run(e.id, u));
  const added = valid.filter(u => !before.includes(u));
  if (added.length) {
    const [d, t] = local(e.start_at);
    const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(actorId)?.name || 'Kolega';
    notifications.notify(added, {
      ownerId, type: 'event.invite', title: `Pozvánka: ${e.title}`, email: true,
      body: `${actor} vás pozval/a na ${new Date(`${d}T00:00:00Z`).toLocaleDateString('sk-SK', { timeZone: 'UTC', dateStyle: 'full' })}${e.all_day ? '' : ` o ${t}`}.${e.meeting_room ? `\nVideohovor: ${meetUrl(e.meeting_room)}` : ''}`,
      url: `/dashboard?view=calendar&event=${e.id}&ws=${ownerId}`,
    }, actorId);
  }
}

function createEvent(ownerId, b, userId) {
  const f = fields(b);
  if (f.error) return f;
  const id = uuidv4();
  getDb().prepare(`INSERT INTO calendar_events (id, owner_id, title, description, location, start_at, end_at, all_day, color, repeat, repeat_until, meeting_room, created_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ownerId, f.title, f.description, f.location, f.start_at, f.end_at, f.all_day, f.color, f.repeat, f.repeat_until, b.meeting ? newRoom() : null, userId);
  const e = getEvent(ownerId, id);
  setAttendees(ownerId, e, b.attendees || [], userId);
  realtime.publish(ownerId, { type: 'calendar', id });
  return { event: eventView(getEvent(ownerId, id)) };
}

/** Úprava; pri presune jedného výskytu opakovanej udalosti (occurrence) sa posunie celá séria o rovnaký rozdiel. */
function updateEvent(ownerId, e, b, userId) {
  const body = { ...b };
  if (b.occurrence !== undefined && e.repeat !== 'none' && b.start !== undefined) {
    const delta = parseTime(b.start) - parseTime(b.occurrence);
    const dur = (b.end !== undefined ? parseTime(b.end) - parseTime(b.start) : e.end_at - e.start_at);
    body.start = e.start_at + delta;
    body.end = e.start_at + delta + dur;
  }
  const f = fields(body, e);
  if (f.error) return f;
  let room = e.meeting_room;
  if (b.meeting === true && !room) room = newRoom();
  if (b.meeting === false) room = null;
  getDb().prepare(`UPDATE calendar_events SET title = ?, description = ?, location = ?, start_at = ?, end_at = ?, all_day = ?, color = ?, repeat = ?, repeat_until = ?,
                   meeting_room = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(f.title, f.description, f.location, f.start_at, f.end_at, f.all_day, f.color, f.repeat, f.repeat_until, room, e.id);
  if (b.attendees !== undefined) setAttendees(ownerId, getEvent(ownerId, e.id), b.attendees, userId);
  realtime.publish(ownerId, { type: 'calendar', id: e.id });
  return { event: eventView(getEvent(ownerId, e.id)) };
}

function deleteEvent(ownerId, e) {
  links.forget(ownerId, 'event', e.id);
  getDb().prepare('DELETE FROM calendar_events WHERE id = ?').run(e.id);
  realtime.publish(ownerId, { type: 'calendar', id: e.id });
}

/* ── Spojený pohľad pre FullCalendar ─────────────────────────── */

function feed(ownerId, from, to, { userId, only } = {}) {
  const db = getDb();
  const out = [];
  const want = k => !only || only.includes(k);
  const dateOnly = sec => local(sec)[0];
  if (want('events')) {
    const rows = db.prepare(`SELECT * FROM calendar_events WHERE owner_id = ? AND start_at < ? AND (repeat != 'none' OR end_at > ?)`).all(ownerId, to, from);
    for (const e of rows) {
      const att = attendees(e.id);
      for (const start of occurrences(e, from, to)) {
        const end = start + (e.end_at - e.start_at);
        out.push({
          id: e.repeat === 'none' ? e.id : `${e.id}@${start}`, title: e.title, color: e.color, allDay: !!e.all_day,
          start: e.all_day ? dateOnly(start) : iso(start), end: e.all_day ? dateOnly(end) : iso(end),
          extendedProps: { kind: 'event', eventId: e.id, occurrence: iso(start), repeat: e.repeat, meeting: meetUrl(e.meeting_room), location: e.location, attendees: att, mine: !!userId && (att.includes(userId) || e.created_by === userId) },
        });
      }
    }
  }
  if (want('tasks')) {
    const rows = db.prepare(`SELECT t.*, p.color AS pcolor FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.owner_id = ? AND p.archived = 0 AND t.due_at >= ? AND t.due_at < ?`).all(ownerId, from, to);
    for (const t of rows) {
      out.push({ id: `task:${t.id}`, title: `${t.done ? '✓' : '○'} ${t.title}`, start: iso(t.due_at), allDay: false, color: t.pcolor, editable: true,
        extendedProps: { kind: 'task', taskId: t.id, done: !!t.done } });
    }
  }
  if (want('bookings')) {
    const rows = db.prepare(`SELECT b.* FROM bookings b JOIN widgets w ON w.id = b.widget_id WHERE w.user_id = ? AND b.status NOT IN ('cancelled','expired')
                             AND b.start_utc < ? AND b.end_utc > ?`).all(ownerId, to, from);
    for (const b of rows) {
      out.push({ id: `booking:${b.id}`, title: `📅 ${b.customer_name}`, start: iso(b.start_utc), end: iso(b.end_utc), color: '#0ea5e9', editable: false,
        extendedProps: { kind: 'booking', bookingId: b.id, email: b.customer_email, phone: b.customer_phone, status: b.status } });
    }
  }
  return out;
}

/* ── ICS odber (Google/Apple/Outlook) ────────────────────────── */

function feedToken(userId) {
  const db = getDb();
  let row = db.prepare('SELECT token FROM calendar_feeds WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO calendar_feeds (user_id, token) VALUES (?, ?)').run(userId, crypto.randomBytes(24).toString('base64url'));
    row = db.prepare('SELECT token FROM calendar_feeds WHERE user_id = ?').get(userId);
  }
  return row.token;
}

const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = sec => iso(sec).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = sec => local(sec)[0].replace(/-/g, '');
const RRULE = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

/** Udalosti, kde je používateľ účastník alebo autor, a jeho úlohy s termínom – vo všetkých jeho priestoroch. */
function ics(token) {
  const db = getDb();
  const row = db.prepare('SELECT user_id FROM calendar_feeds WHERE token = ?').get(String(token || ''));
  if (!row) return null;
  const userId = row.user_id;
  const owners = workspace.list(userId).map(w => w.ownerId);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Neoworkly//Kalendar//SK', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Neoworkly'];
  const stamp = icsTime(Math.floor(Date.now() / 1000));
  for (const ownerId of owners) {
    const events = db.prepare(`SELECT DISTINCT e.* FROM calendar_events e LEFT JOIN event_attendees a ON a.event_id = e.id
                                WHERE e.owner_id = ? AND (e.created_by = ? OR a.user_id = ?)`).all(ownerId, userId, userId);
    for (const e of events) {
      lines.push('BEGIN:VEVENT', `UID:${e.id}@neoworkly`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(e.title)}`);
      if (e.all_day) lines.push(`DTSTART;VALUE=DATE:${icsDate(e.start_at)}`, `DTEND;VALUE=DATE:${icsDate(e.end_at)}`);
      else lines.push(`DTSTART:${icsTime(e.start_at)}`, `DTEND:${icsTime(e.end_at)}`);
      if (e.repeat !== 'none') lines.push(`RRULE:FREQ=${RRULE[e.repeat]}${e.repeat_until ? `;UNTIL=${icsTime(e.repeat_until)}` : ''}`);
      const desc = [e.description, e.meeting_room ? `Videohovor: ${meetUrl(e.meeting_room)}` : ''].filter(Boolean).join('\n\n');
      if (desc) lines.push(`DESCRIPTION:${icsText(desc)}`);
      if (e.location || e.meeting_room) lines.push(`LOCATION:${icsText(e.location || meetUrl(e.meeting_room))}`);
      lines.push(`URL:${appUrl()}/dashboard?view=calendar&event=${e.id}&ws=${ownerId}`, 'END:VEVENT');
    }
    const taskRows = db.prepare(`SELECT t.* FROM tasks t JOIN task_assignees a ON a.task_id = t.id WHERE t.owner_id = ? AND a.user_id = ? AND t.due_at IS NOT NULL AND t.done = 0`).all(ownerId, userId);
    for (const t of taskRows) {
      lines.push('BEGIN:VEVENT', `UID:task-${t.id}@neoworkly`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(`✅ ${t.title}`)}`,
        `DTSTART:${icsTime(t.due_at)}`, `DTEND:${icsTime(t.due_at + 1800)}`, `URL:${appUrl()}/dashboard?view=tasks&task=${t.id}&ws=${ownerId}`, 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  // RFC 5545: riadky najviac 75 oktetov
  return lines.map(l => {
    const out = [];
    let cur = '';
    for (const ch of l) {
      if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
      cur += ch;
    }
    out.push(cur);
    return out.join('\r\n ');
  }).join('\r\n') + '\r\n';
}

links.registerType('event', {
  label: 'Udalosť', icon: '📅',
  resolve(ownerId, id) {
    const e = getEvent(ownerId, id);
    return e ? { title: e.title, url: `/dashboard?view=calendar&event=${id}&ws=${ownerId}`, start: iso(e.start_at) } : null;
  },
});

module.exports = { TZ, meetUrl, newRoom, parseTime, occurrences, getEvent, eventView, createEvent, updateEvent, deleteEvent, feed, feedToken, ics };
