'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const gcal = require('../services/gcal');

const router = express.Router();

/* ── Helpers ──────────────────────────────────────────────────── */

/** Parse "HH:MM" → minutes from midnight */
function toMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Format minutes from midnight → "HH:MM" */
function fromMins(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Get YYYY-MM-DD for today in a given timezone */
function todayInTz(tz) {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz });
}

/** Verify widget belongs to authenticated user */
function getOwnedWidget(widgetId, userId) {
  return getDb().prepare(
    'SELECT * FROM widgets WHERE id = ? AND user_id = ?'
  ).get(widgetId, userId);
}

/** Get or create booking_config for a widget (auth) */
function getOrCreateConfig(widgetId) {
  const db = getDb();
  let cfg = db.prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(widgetId);
  if (!cfg) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO booking_configs (id, widget_id) VALUES (?, ?)
    `).run(id, widgetId);
    // Create default schedule Mon–Fri 09:00–17:00
    const schedStmt = db.prepare(`
      INSERT OR IGNORE INTO booking_schedules (id, booking_config_id, day_of_week, start_time, end_time, active)
      VALUES (?, ?, ?, '09:00', '17:00', ?)
    `);
    for (let d = 0; d <= 6; d++) {
      schedStmt.run(uuidv4(), id, d, d >= 1 && d <= 5 ? 1 : 0);
    }
    cfg = db.prepare('SELECT * FROM booking_configs WHERE id = ?').get(id);
  }
  return cfg;
}

/* ── Slot generation ──────────────────────────────────────────── */

/**
 * Generate available time slots for a given date.
 * @param {object} cfg   - booking_configs row
 * @param {string} date  - 'YYYY-MM-DD'
 * @returns {Array<{start_time, end_time}>}
 */
function generateSlots(cfg, date) {
  const db = getDb();

  // Past date?
  const today = todayInTz(cfg.timezone);
  if (date < today) return [];

  // Max advance days
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + cfg.max_advance_days);
  const maxDateStr = maxDate.toLocaleDateString('sv-SE', { timeZone: cfg.timezone });
  if (date > maxDateStr) return [];

  // Day of week (0=Sun…6=Sat) – compute from date string without timezone drift
  const [y, mo, d] = date.split('-').map(Number);
  const dayOfWeek = new Date(y, mo - 1, d).getDay();

  // Check override
  const override = db.prepare(
    'SELECT * FROM booking_overrides WHERE booking_config_id = ? AND date = ?'
  ).get(cfg.id, date);
  if (override && override.type === 'closed') return [];

  let winStart, winEnd;
  if (override && override.type === 'custom' && override.start_time && override.end_time) {
    winStart = toMins(override.start_time);
    winEnd   = toMins(override.end_time);
  } else {
    const sched = db.prepare(
      'SELECT * FROM booking_schedules WHERE booking_config_id = ? AND day_of_week = ? AND active = 1'
    ).get(cfg.id, dayOfWeek);
    if (!sched) return [];
    winStart = toMins(sched.start_time);
    winEnd   = toMins(sched.end_time);
  }

  // Minimum notice: if today, advance start_time
  const nowMins = (() => {
    const now = new Date();
    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: cfg.timezone }));
    return nowInTz.getHours() * 60 + nowInTz.getMinutes() + cfg.min_notice;
  })();
  if (date === today) winStart = Math.max(winStart, nowMins);

  // Existing confirmed bookings for this date
  const existing = db.prepare(
    `SELECT start_time, end_time FROM bookings
     WHERE booking_config_id = ? AND date = ? AND status != 'cancelled'`
  ).all(cfg.id, date);

  const step = cfg.slot_duration + cfg.buffer_between;
  const slots = [];

  for (let cur = winStart; cur + cfg.slot_duration <= winEnd; cur += step) {
    const slotStart = fromMins(cur);
    const slotEnd   = fromMins(cur + cfg.slot_duration);
    const sS = cur, sE = cur + cfg.slot_duration;

    const blocked = existing.some(b => {
      const bS = toMins(b.start_time), bE = toMins(b.end_time);
      return sS < bE && sE > bS;
    });
    if (!blocked) slots.push({ start_time: slotStart, end_time: slotEnd });
  }

  return slots;
}

/* ════════════════════════════════════════════════════════════════
   PUBLIC ENDPOINTS (no auth)
   ════════════════════════════════════════════════════════════════ */

/** GET /api/booking/:widgetId/public/config */
router.get('/:widgetId/public/config', (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id, bot_name, primary_color, active FROM widgets WHERE id = ?')
    .get(req.params.widgetId);
  if (!widget || !widget.active) return res.status(404).json({ error: 'Widget nenájdený.' });

  let cfg = db.prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(req.params.widgetId);
  if (!cfg) return res.status(404).json({ error: 'Booking nie je povolený pre tento widget.' });

  const schedules = db.prepare(
    'SELECT day_of_week, start_time, end_time, active FROM booking_schedules WHERE booking_config_id = ? ORDER BY day_of_week'
  ).all(cfg.id);

  res.json({
    widgetId:           widget.id,
    botName:            widget.bot_name,
    primaryColor:       widget.primary_color,
    timezone:           cfg.timezone,
    slotDuration:       cfg.slot_duration,
    minNoticeMins:      cfg.min_notice,
    maxAdvanceDays:     cfg.max_advance_days,
    confirmationMessage: cfg.confirmation_message,
    schedules,
  });
});

/** GET /api/booking/:widgetId/public/slots?date=YYYY-MM-DD */
router.get('/:widgetId/public/slots', (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id, active FROM widgets WHERE id = ?').get(req.params.widgetId);
  if (!widget || !widget.active) return res.status(404).json({ error: 'Widget nenájdený.' });

  const cfg = db.prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(req.params.widgetId);
  if (!cfg) return res.status(404).json({ error: 'Booking nie je povolený.' });

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Neplatný dátum.' });

  res.json(generateSlots(cfg, date));
});

/** POST /api/booking/:widgetId/public/book */
router.post('/:widgetId/public/book', (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id, active FROM widgets WHERE id = ?').get(req.params.widgetId);
  if (!widget || !widget.active) return res.status(404).json({ error: 'Widget nenájdený.' });

  const cfg = db.prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(req.params.widgetId);
  if (!cfg) return res.status(404).json({ error: 'Booking nie je povolený.' });

  const { customerName, customerEmail, customerPhone, date, startTime, sessionId } = req.body;
  if (!customerName || !customerEmail || !date || !startTime)
    return res.status(400).json({ error: 'Vyplňte meno, email, dátum a čas.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Neplatný dátum.' });
  if (!/^\d{2}:\d{2}$/.test(startTime)) return res.status(400).json({ error: 'Neplatný čas.' });

  // Verify the slot is still available
  const available = generateSlots(cfg, date);
  const slot = available.find(s => s.start_time === startTime);
  if (!slot) return res.status(409).json({ error: 'Termín nie je dostupný. Vyberte iný.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO bookings (id, booking_config_id, widget_id, customer_name, customer_email, customer_phone,
      date, start_time, end_time, status, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)
  `).run(id, cfg.id, widget.id, customerName.trim(), customerEmail.trim(),
         customerPhone ? customerPhone.trim() : null,
         date, slot.start_time, slot.end_time, sessionId || null);

  // Async: sync to Google Calendar
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  setImmediate(() => gcal.createEvent(cfg, booking).catch(() => {}));

  res.json({
    id,
    date,
    startTime: slot.start_time,
    endTime:   slot.end_time,
    confirmationMessage: cfg.confirmation_message || 'Rezervácia potvrdená! Tešíme sa na vás.',
  });
});

/* ════════════════════════════════════════════════════════════════
   PROTECTED ENDPOINTS (requireAuth)
   ════════════════════════════════════════════════════════════════ */

/** GET /api/booking/:widgetId/config */
router.get('/:widgetId/config', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const schedules = getDb().prepare(
    'SELECT * FROM booking_schedules WHERE booking_config_id = ? ORDER BY day_of_week'
  ).all(cfg.id);
  res.json({ ...cfg, schedules });
});

/** PUT /api/booking/:widgetId/config */
router.put('/:widgetId/config', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const { timezone, slotDuration, bufferBetween, minNotice, maxAdvanceDays, confirmationMessage } = req.body;

  getDb().prepare(`
    UPDATE booking_configs SET
      timezone = ?, slot_duration = ?, buffer_between = ?,
      min_notice = ?, max_advance_days = ?, confirmation_message = ?
    WHERE id = ?
  `).run(
    timezone || cfg.timezone,
    parseInt(slotDuration) || cfg.slot_duration,
    parseInt(bufferBetween) >= 0 ? parseInt(bufferBetween) : cfg.buffer_between,
    parseInt(minNotice) >= 0 ? parseInt(minNotice) : cfg.min_notice,
    parseInt(maxAdvanceDays) || cfg.max_advance_days,
    confirmationMessage !== undefined ? String(confirmationMessage).slice(0, 500) : cfg.confirmation_message,
    cfg.id
  );
  res.json({ ok: true });
});

/** PUT /api/booking/:widgetId/schedule  (replaces all 7 rows) */
router.put('/:widgetId/schedule', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const db = getDb();
  const rows = Array.isArray(req.body) ? req.body : [];

  const stmt = db.prepare(`
    INSERT INTO booking_schedules (id, booking_config_id, day_of_week, start_time, end_time, active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(booking_config_id, day_of_week) DO UPDATE SET
      start_time = excluded.start_time,
      end_time   = excluded.end_time,
      active     = excluded.active
  `);
  for (const r of rows) {
    if (r.day_of_week < 0 || r.day_of_week > 6) continue;
    stmt.run(uuidv4(), cfg.id, r.day_of_week, r.start_time || '09:00', r.end_time || '17:00', r.active ? 1 : 0);
  }
  res.json({ ok: true });
});

/** GET /api/booking/:widgetId/overrides */
router.get('/:widgetId/overrides', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const overrides = getDb().prepare(
    'SELECT * FROM booking_overrides WHERE booking_config_id = ? ORDER BY date'
  ).all(cfg.id);
  res.json(overrides);
});

/** POST /api/booking/:widgetId/overrides */
router.post('/:widgetId/overrides', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const { date, type, startTime, endTime } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Neplatný dátum.' });

  const db = getDb();
  db.prepare(`
    INSERT INTO booking_overrides (id, booking_config_id, date, type, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(booking_config_id, date) DO UPDATE SET
      type = excluded.type, start_time = excluded.start_time, end_time = excluded.end_time
  `).run(uuidv4(), cfg.id, date, type === 'custom' ? 'custom' : 'closed',
         type === 'custom' ? (startTime || '09:00') : null,
         type === 'custom' ? (endTime || '17:00') : null);
  res.json({ ok: true });
});

/** DELETE /api/booking/:widgetId/overrides/:overrideId */
router.delete('/:widgetId/overrides/:overrideId', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  getDb().prepare('DELETE FROM booking_overrides WHERE id = ? AND booking_config_id = ?')
    .run(req.params.overrideId, cfg.id);
  res.json({ ok: true });
});

/** GET /api/booking/:widgetId/bookings?from=&to=&status= */
router.get('/:widgetId/bookings', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const { from, to, status } = req.query;
  let sql = 'SELECT * FROM bookings WHERE booking_config_id = ?';
  const params = [cfg.id];
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to)   { sql += ' AND date <= ?'; params.push(to); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY date, start_time';
  res.json(getDb().prepare(sql).all(...params));
});

/** GET /api/booking/all/bookings?from=&to= — all bookings across all user's widgets */
router.get('/all/bookings', requireAuth, (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  const widgetIds = db.prepare('SELECT id FROM widgets WHERE user_id = ?').all(req.userId).map(w => w.id);
  if (!widgetIds.length) return res.json([]);

  const placeholders = widgetIds.map(() => '?').join(',');
  let sql = `SELECT b.*, w.name as widget_name FROM bookings b
             JOIN widgets w ON w.id = b.widget_id
             WHERE b.widget_id IN (${placeholders})`;
  const params = [...widgetIds];
  if (from) { sql += ' AND b.date >= ?'; params.push(from); }
  if (to)   { sql += ' AND b.date <= ?'; params.push(to); }
  sql += ' ORDER BY b.date, b.start_time';
  res.json(db.prepare(sql).all(...params));
});

/** PATCH /api/booking/:widgetId/bookings/:bookingId */
router.patch('/:widgetId/bookings/:bookingId', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND booking_config_id = ?')
    .get(req.params.bookingId, cfg.id);
  if (!booking) return res.status(404).json({ error: 'Rezervácia nenájdená.' });

  const { status, internalNotes } = req.body;
  const VALID_STATUSES = ['confirmed','cancelled','no_show'];

  if (status && VALID_STATUSES.includes(status)) {
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
    // Async: delete/restore GCal event
    if (status === 'cancelled' && booking.gcal_event_id) {
      const cfg2 = db.prepare('SELECT * FROM booking_configs WHERE id = ?').get(cfg.id);
      setImmediate(() => gcal.deleteEvent(cfg2, booking.gcal_event_id).catch(() => {}));
    }
  }
  if (internalNotes !== undefined) {
    db.prepare('UPDATE bookings SET internal_notes = ? WHERE id = ?')
      .run(String(internalNotes).slice(0, 1000), booking.id);
  }
  res.json({ ok: true });
});

/* ── Google Calendar OAuth ─────────────────────────────────────── */

/** GET /api/booking/:widgetId/gcal/status */
router.get('/:widgetId/gcal/status', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getDb().prepare('SELECT gcal_email, gcal_access_token FROM booking_configs WHERE widget_id = ?')
    .get(req.params.widgetId);
  res.json({
    connected: !!(cfg && cfg.gcal_access_token),
    email: cfg ? (cfg.gcal_email || null) : null,
  });
});

/** GET /api/booking/:widgetId/gcal/auth-url */
router.get('/:widgetId/gcal/auth-url', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  try {
    const url = gcal.getAuthUrl(req.params.widgetId);
    res.json({ url });
  } catch (e) {
    res.status(503).json({ error: 'Google Calendar nie je nakonfigurovaný. Nastavte GOOGLE_CLIENT_ID a GOOGLE_CLIENT_SECRET.' });
  }
});

/** GET /api/booking/gcal/callback  (called by Google after OAuth) */
router.get('/gcal/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect('/dashboard?gcal_error=1');
  }
  try {
    const widgetId = gcal.verifyState(state);
    const cfg = getOrCreateConfig(widgetId);
    await gcal.exchangeCode(cfg, code);
    res.redirect('/dashboard?gcal_ok=1');
  } catch (e) {
    console.error('[GCal callback]', e.message);
    res.redirect('/dashboard?gcal_error=1');
  }
});

/** DELETE /api/booking/:widgetId/gcal/disconnect */
router.delete('/:widgetId/gcal/disconnect', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  getDb().prepare(`
    UPDATE booking_configs SET gcal_access_token = NULL, gcal_refresh_token = NULL,
      gcal_token_expiry = NULL, gcal_email = NULL WHERE widget_id = ?
  `).run(req.params.widgetId);
  res.json({ ok: true });
});

module.exports = router;
