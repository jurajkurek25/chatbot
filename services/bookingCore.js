'use strict';
/**
 * Booking core: staff, time-zone helpers and the slot engine.
 *
 * Everything availability-related lives here so the public booking page, the chat
 * widget, the customer "manage booking" page and the dashboard share one set of rules:
 * staff schedules + time off, service buffers / capacity, work-life limits
 * (lunch break, max bookings / minutes per day, max bookings per week) and Google
 * Calendar busy times.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

/* ── Time helpers ─────────────────────────────────────────────── */

const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMins = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const todayInTz = tz => new Date().toLocaleDateString('sv-SE', { timeZone: tz });

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** Local wall-clock date + time in `tz` → unix seconds (DST-safe). */
function zonedToUtc(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz); // second pass fixes DST edges
  return Math.floor(utc / 1000);
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const dayOfWeek = date => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
/** Monday of the ISO week containing `date`. */
const weekStart = date => addDays(date, -((dayOfWeek(date) + 6) % 7));

const newToken = () => crypto.randomBytes(24).toString('base64url');

/* ── Staff ────────────────────────────────────────────────────── */

/**
 * Every booking config has at least one staff member. Older configs kept the schedule,
 * days off and Google Calendar on the config itself; the first call migrates those to a
 * default staff member and attaches existing bookings to it.
 */
function ensureStaff(cfg) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM booking_staff WHERE booking_config_id = ? ORDER BY display_order, created_at').all(cfg.id);
  if (existing.length) return existing;

  const widget = db.prepare('SELECT w.bot_name, u.name AS owner_name, u.email AS owner_email FROM widgets w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(cfg.widget_id) || {};
  const id = uuidv4();
  db.transaction(() => {
    db.prepare(`INSERT INTO booking_staff (id, booking_config_id, name, email, gcal_access_token, gcal_refresh_token,
                  gcal_token_expiry, gcal_email, gcal_calendar_id, ics_token)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, cfg.id, widget.owner_name || widget.bot_name || 'Tím', widget.owner_email || '',
           cfg.gcal_access_token || null, cfg.gcal_refresh_token || null, cfg.gcal_token_expiry || null,
           cfg.gcal_email || null, cfg.gcal_calendar_id || 'primary', newToken());
    const old = db.prepare('SELECT * FROM booking_schedules WHERE booking_config_id = ?').all(cfg.id);
    const ins = db.prepare('INSERT INTO booking_staff_schedules (id, staff_id, day_of_week, start_time, end_time, active) VALUES (?, ?, ?, ?, ?, ?)');
    for (let d = 0; d <= 6; d++) {
      const o = old.find(s => s.day_of_week === d);
      ins.run(uuidv4(), id, d, o ? o.start_time : '09:00', o ? o.end_time : '17:00', o ? o.active : (d >= 1 && d <= 5 ? 1 : 0));
    }
    for (const o of db.prepare('SELECT * FROM booking_overrides WHERE booking_config_id = ?').all(cfg.id)) {
      db.prepare('INSERT INTO booking_time_off (id, staff_id, date_from, date_to, type, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), id, o.date, o.date, o.type, o.start_time, o.end_time);
    }
    db.prepare('UPDATE bookings SET staff_id = ? WHERE booking_config_id = ? AND staff_id IS NULL').run(id, cfg.id);
  })();
  return db.prepare('SELECT * FROM booking_staff WHERE booking_config_id = ?').all(cfg.id);
}

function createStaff(cfg, fields) {
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO booking_staff (id, booking_config_id, name, email, ics_token, display_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, cfg.id, fields.name, fields.email || '', newToken(),
         (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM booking_staff WHERE booking_config_id = ?').get(cfg.id).n));
  const ins = db.prepare('INSERT INTO booking_staff_schedules (id, staff_id, day_of_week, start_time, end_time, active) VALUES (?, ?, ?, ?, ?, ?)');
  for (let d = 0; d <= 6; d++) ins.run(uuidv4(), id, d, '09:00', '17:00', d >= 1 && d <= 5 ? 1 : 0);
  return db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(id);
}

/** Active staff who can perform `service` (no explicit assignment = everyone). */
function staffForService(cfg, serviceId) {
  const db = getDb();
  const staff = ensureStaff(cfg).filter(s => s.active);
  if (!serviceId) return staff;
  const assigned = db.prepare('SELECT staff_id FROM booking_service_staff WHERE service_id = ?').all(serviceId).map(r => r.staff_id);
  return assigned.length ? staff.filter(s => assigned.includes(s.id)) : staff;
}

/** Service row, or a pseudo-service built from the config defaults when none is chosen. */
function resolveService(cfg, serviceId) {
  if (serviceId) {
    const s = getDb().prepare('SELECT * FROM booking_services WHERE id = ? AND booking_config_id = ? AND active = 1').get(serviceId, cfg.id);
    if (s) return s;
  }
  return { id: null, name: null, duration_mins: cfg.slot_duration, buffer_before: 0, buffer_after: 0,
           capacity: 1, location_type: 'in_person', location_detail: '', questions: '[]', price: null };
}

/* ── Slot engine ──────────────────────────────────────────────── */

/** Working window for a staff member on a date, honouring time off (single days or ranges). */
function workingWindow(staff, date) {
  const db = getDb();
  const off = db.prepare('SELECT * FROM booking_time_off WHERE staff_id = ? AND date_from <= ? AND date_to >= ? ORDER BY type = \'closed\' DESC LIMIT 1').get(staff.id, date, date);
  if (off && off.type === 'closed') return null;
  if (off && off.type === 'custom' && off.start_time && off.end_time) return [toMins(off.start_time), toMins(off.end_time)];
  const sched = db.prepare('SELECT * FROM booking_staff_schedules WHERE staff_id = ? AND day_of_week = ? AND active = 1').get(staff.id, dayOfWeek(date));
  return sched ? [toMins(sched.start_time), toMins(sched.end_time)] : null;
}

/**
 * Available start times for one staff member.
 * @param {object} opts { cfg, staff, service, date, gcalBusy, seats, excludeBookingId }
 * @returns {Array<{start_time, end_time, staff_id, seats_left}>}
 */
function staffSlots({ cfg, staff, service, date, gcalBusy = [], seats = 1, excludeBookingId = null }) {
  const db = getDb();
  const tz = cfg.timezone;
  const today = todayInTz(tz);
  if (date < today || date > addDays(today, cfg.max_advance_days)) return [];
  if (gcalBusy.some(b => b.allDay)) return [];

  const win = workingWindow(staff, date);
  if (!win) return [];
  let [winStart, winEnd] = win;

  const dur = service.duration_mins;
  const before = service.buffer_before || 0, after = service.buffer_after || 0;
  const gap = cfg.buffer_between || 0;
  const step = cfg.slot_interval > 0 ? cfg.slot_interval : dur + gap;

  let minStart = winStart;
  if (date === today) {
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    minStart = Math.max(winStart, nowLocal.getHours() * 60 + nowLocal.getMinutes() + cfg.min_notice);
  }

  const dayBookings = db.prepare(`SELECT * FROM bookings WHERE staff_id = ? AND date = ?
                                  AND status NOT IN ('cancelled', 'expired') AND id != ?`).all(staff.id, date, excludeBookingId || '');
  // One "session" per (service, start) — group bookings share a session
  const sessions = new Map();
  for (const b of dayBookings) {
    const key = `${b.service_id || ''}|${b.start_time}`;
    const s = sessions.get(key) || { ...b, seatsTaken: 0 };
    s.seatsTaken += b.seats || 1;
    sessions.set(key, s);
  }
  const sessionList = [...sessions.values()];
  const dayMinutes = sessionList.reduce((sum, s) => sum + (toMins(s.end_time) - toMins(s.start_time)), 0);

  let weekCount = 0;
  if (staff.max_per_week > 0) {
    const ws = weekStart(date);
    weekCount = db.prepare(`SELECT COUNT(DISTINCT COALESCE(service_id, '') || '|' || date || '|' || start_time) AS n FROM bookings
                            WHERE staff_id = ? AND date BETWEEN ? AND ? AND status NOT IN ('cancelled', 'expired') AND id != ?`)
      .get(staff.id, ws, addDays(ws, 6), excludeBookingId || '').n;
  }

  const breakS = staff.break_start ? toMins(staff.break_start) : null;
  const breakE = staff.break_end ? toMins(staff.break_end) : null;
  const overlaps = (aS, aE, bS, bE) => aS < bE && aE > bS;

  const slots = [];
  for (let cur = winStart; cur + dur <= winEnd; cur += step) {
    if (cur < minStart) continue;
    const start = fromMins(cur), end = fromMins(cur + dur);

    // Joining an existing group session (same service, same start) only needs free seats
    const same = service.id && service.capacity > 1 ? sessions.get(`${service.id}|${start}`) : null;
    if (same) {
      const left = service.capacity - same.seatsTaken;
      if (left >= seats) slots.push({ start_time: start, end_time: end, staff_id: staff.id, seats_left: left });
      continue;
    }
    if (seats > (service.capacity || 1)) continue;

    if (breakS !== null && breakE !== null && overlaps(cur, cur + dur, breakS, breakE)) continue;
    const candS = cur - before, candE = cur + dur + Math.max(after, gap);
    const clash = sessionList.some(s => overlaps(candS, candE,
      toMins(s.start_time) - (s.buffer_before || 0), toMins(s.end_time) + Math.max(s.buffer_after || 0, gap)));
    if (clash) continue;
    if (gcalBusy.some(b => overlaps(cur, cur + dur, b.startMins, b.endMins))) continue;

    // Work-life limits
    if (staff.max_per_day > 0 && sessionList.length + 1 > staff.max_per_day) continue;
    if (staff.max_minutes_per_day > 0 && dayMinutes + dur > staff.max_minutes_per_day) continue;
    if (staff.max_per_week > 0 && weekCount + 1 > staff.max_per_week) continue;

    slots.push({ start_time: start, end_time: end, staff_id: staff.id, seats_left: (service.capacity || 1) });
  }
  return slots;
}

/**
 * Slots across the requested staff member, or across everyone who offers the service
 * ("any"): one entry per start time, assigned to the least busy staff member that day.
 * `busyFor(staff)` returns the staff member's Google Calendar busy blocks (async).
 */
async function availableSlots({ cfg, serviceId, staffId, date, seats = 1, excludeBookingId = null, busyFor }) {
  const service = resolveService(cfg, serviceId);
  let staff = staffForService(cfg, service.id);
  if (staffId && staffId !== 'any') staff = staff.filter(s => s.id === staffId);
  const db = getDb();
  const byStart = new Map();
  for (const s of staff) {
    const gcalBusy = busyFor ? await busyFor(s, date) : [];
    const load = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE staff_id = ? AND date = ? AND status NOT IN ('cancelled','expired')`).get(s.id, date).n;
    for (const slot of staffSlots({ cfg, staff: s, service, date, gcalBusy, seats, excludeBookingId })) {
      const prev = byStart.get(slot.start_time);
      if (!prev || load < prev.load) byStart.set(slot.start_time, { ...slot, load });
    }
  }
  return [...byStart.values()].sort((a, b) => a.start_time.localeCompare(b.start_time)).map(({ load, ...s }) => s);
}

module.exports = {
  toMins, fromMins, todayInTz, zonedToUtc, addDays, dayOfWeek, newToken,
  ensureStaff, createStaff, staffForService, resolveService, staffSlots, availableSlots,
};
