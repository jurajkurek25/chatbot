'use strict';
/**
 * Wellbeing: leave that clears the calendar (bookings move to a colleague or are
 * cancelled with an apology — the reason is never shown to customers) and burnout alerts.
 * Health data (cycle, menstrual / mental-health leave) is entered by the staff member on a
 * private link and is only visible to the owner when the staff member opts in.
 */

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const core = require('./bookingCore');
const gcal = require('./gcal');
const notifyMod = require('./bookingNotify');
const bookingPayments = require('./bookingPayments');

const LEAVE_REASONS = ['vacation', 'sick', 'menstrual', 'mental_health', 'other'];
const withTz = (staff, cfg) => ({ ...staff, timezone: cfg.timezone });
const notify = (kind, id, extra) => setImmediate(() => notifyMod.notify(kind, id, extra).catch(err => console.error('[booking notify]', err.message)));

/** Cancels a booking, refunds per policy (before the e-mail, so it can mention the refund) and notifies. */
async function cancelBooking(cfg, booking, { by, reason }) {
  const db = getDb();
  db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancel_reason = ? WHERE id = ?")
    .run(by, reason ? String(reason).slice(0, 500) : null, booking.id);
  const staff = booking.staff_id && db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(booking.staff_id);
  if (staff && booking.gcal_event_id) setImmediate(() => gcal.deleteEvent(withTz(staff, cfg), booking.gcal_event_id).catch(() => {}));
  await bookingPayments.refundOnCancel(booking, cfg, by);
  notify('cancelled', booking.id);
}

/** Moves a booking to another staff member free at the same time; returns that staff or null. */
async function reassignBooking(cfg, booking) {
  const db = getDb();
  const others = core.staffForService(cfg, booking.service_id).filter(s => s.id !== booking.staff_id);
  for (const s of others) {
    const busy = await gcal.getBusyTimes(withTz(s, cfg), booking.date).catch(() => []);
    const slots = core.staffSlots({ cfg, staff: s, service: core.resolveService(cfg, booking.service_id), date: booking.date,
      gcalBusy: busy, seats: booking.seats || 1, excludeBookingId: booking.id });
    if (!slots.some(x => x.start_time === booking.start_time)) continue;
    const old = db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(booking.staff_id);
    db.prepare('UPDATE bookings SET staff_id = ?, reschedule_count = reschedule_count + 1, gcal_event_id = NULL WHERE id = ?').run(s.id, booking.id);
    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
    setImmediate(async () => {
      if (old && booking.gcal_event_id) await gcal.deleteEvent(withTz(old, cfg), booking.gcal_event_id).catch(() => {});
      await gcal.createEvent(withTz(s, cfg), updated).catch(() => {});
    });
    notify('staff_changed', booking.id);
    return s;
  }
  return null;
}

/**
 * Adds leave for a staff member and handles bookings inside it.
 * handle: 'reassign' (to a free colleague, else cancel) | 'cancel' | 'keep'
 */
async function takeLeave({ cfg, staff, dateFrom, dateTo, reason, privateEntry = false, note = '', type = 'closed', startTime = null, endTime = null, handle = 'reassign' }) {
  const db = getDb();
  const to = dateTo || dateFrom;
  db.prepare(`INSERT INTO booking_time_off (id, staff_id, date_from, date_to, type, start_time, end_time, note, reason, private)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), staff.id, dateFrom, to, type, type === 'custom' ? startTime : null, type === 'custom' ? endTime : null,
         String(note || '').slice(0, 200), LEAVE_REASONS.includes(reason) ? reason : 'other', privateEntry ? 1 : 0);

  const result = { reassigned: 0, cancelled: 0, kept: 0 };
  let affected = db.prepare(`SELECT * FROM bookings WHERE staff_id = ? AND status = 'confirmed' AND date BETWEEN ? AND ? ORDER BY date, start_time`)
    .all(staff.id, dateFrom, to);
  if (type === 'custom') { // only bookings outside the reduced hours
    affected = affected.filter(b => b.start_time < startTime || b.end_time > endTime);
  }
  for (const b of affected) {
    if (handle === 'keep') { result.kept++; continue; }
    if (handle === 'reassign' && await reassignBooking(cfg, b)) { result.reassigned++; continue; }
    await cancelBooking(cfg, b, { by: 'business', reason: null });
    result.cancelled++;
  }
  return result;
}

/* ── Burnout signals ──────────────────────────────────────────── */

/** Share (0–1) of available working minutes that were booked in the week starting `monday`. */
function weekLoad(staff, monday) {
  const db = getDb();
  let available = 0;
  for (let i = 0; i < 7; i++) {
    const w = core.workingWindow(staff, core.addDays(monday, i));
    if (!w) continue;
    let mins = w[1] - w[0];
    if (staff.break_start && staff.break_end) mins -= Math.max(0, core.toMins(staff.break_end) - core.toMins(staff.break_start));
    available += Math.max(0, mins);
  }
  if (!available) return 0;
  const rows = db.prepare(`SELECT DISTINCT COALESCE(service_id, '') || date || start_time AS k, start_time, end_time FROM bookings
                           WHERE staff_id = ? AND date BETWEEN ? AND ? AND status IN ('confirmed', 'completed', 'no_show')`)
    .all(staff.id, monday, core.addDays(monday, 6));
  const booked = rows.reduce((s, r) => s + core.toMins(r.end_time) - core.toMins(r.start_time), 0);
  return booked / available;
}

/**
 * { highLoadWeeks, daysSinceBreak, alert } — alert when the last 3 full weeks were all ≥ 90 %
 * booked, or there was no full day off for 90+ days while working.
 */
function burnoutStatus(staff, cfg) {
  const db = getDb();
  const today = core.todayInTz(cfg.timezone);
  const thisMonday = core.addDays(today, -((core.dayOfWeek(today) + 6) % 7));
  const loads = [1, 2, 3].map(w => weekLoad(staff, core.addDays(thisMonday, -7 * w)));
  const highLoadWeeks = loads.filter(l => l >= 0.9).length;
  const lastOff = db.prepare(`SELECT MAX(date_to) AS d FROM booking_time_off WHERE staff_id = ? AND type = 'closed' AND date_to <= ?`).get(staff.id, today).d;
  const since = lastOff || new Date(staff.created_at * 1000).toISOString().slice(0, 10);
  const daysSinceBreak = core.daysBetween(since, today);
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE staff_id = ? AND status IN ('confirmed','completed') AND date BETWEEN ? AND ?`)
    .get(staff.id, core.addDays(today, -30), today).n;
  return {
    loads: loads.map(l => Math.round(l * 100)), highLoadWeeks, daysSinceBreak,
    alert: highLoadWeeks === 3 ? 'load' : (daysSinceBreak >= 90 && recent > 0 ? 'no_break' : null),
  };
}

async function runBurnoutCheck() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const staffRows = db.prepare(`SELECT s.*, c.timezone, c.widget_id FROM booking_staff s JOIN booking_configs c ON c.id = s.booking_config_id
                                WHERE s.active = 1 AND (s.burnout_alert_at IS NULL OR s.burnout_alert_at < ?)`).all(now - 14 * 86400);
  for (const s of staffRows) {
    const cfg = db.prepare('SELECT * FROM booking_configs WHERE id = ?').get(s.booking_config_id);
    const st = burnoutStatus(s, cfg);
    if (!st.alert) continue;
    db.prepare('UPDATE booking_staff SET burnout_alert_at = ? WHERE id = ?').run(now, s.id);
    const owner = db.prepare('SELECT u.email, w.bot_name FROM widgets w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(s.widget_id);
    if (!owner) continue;
    const text = st.alert === 'load'
      ? `${notifyMod.esc(s.name)} mal(a) posledné 3 týždne vyťaženosť ${st.loads.join(' %, ')} %. Dlhodobo plný kalendár zvyšuje riziko vyhorenia.`
      : `${notifyMod.esc(s.name)} nemal(a) celý deň voľna už ${st.daysSinceBreak} dní.`;
    await notifyMod.sendMail({
      to: owner.email, business: 'Neoworkly', subject: `Wellbeing: ${s.name} potrebuje oddych`,
      html: notifyMod.layout({ color: '#5b4fff', business: owner.bot_name || 'Neoworkly' }, {
        heading: 'Upozornenie na riziko vyhorenia', intro: text,
        rows: [], buttons: [['Otvoriť tím v dashboarde', `${notifyMod.appUrl()}/dashboard`, true]],
        note: 'Zvážte voľný deň, nižší denný limit termínov alebo dlhšie prestávky medzi klientmi.' }),
    });
  }
}

let timer = null;
function startBurnoutScheduler() {
  if (timer) return;
  const tick = () => runBurnoutCheck().catch(err => console.error('[wellbeing]', err.message));
  timer = setInterval(tick, 6 * 3600 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}

module.exports = { LEAVE_REASONS, cancelBooking, reassignBooking, takeLeave, weekLoad, burnoutStatus, runBurnoutCheck, startBurnoutScheduler };
