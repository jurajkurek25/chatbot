'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const gcal = require('../services/gcal');

const logoStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '..', 'uploads', 'booking-logos');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `logo-${req.params.widgetId}${ext}`);
  },
});
const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif|svg\+xml)$/.test(file.mimetype));
  },
});

const router = express.Router();

/* ── Async AI booking summary ─────────────────────────────────────
   Loaded lazily to avoid circular require at startup              */
function generateBookingSummary(bookingId, sessionId, widgetId, serviceInfo) {
  setImmediate(async () => {
    try {
      const db = getDb();
      let messages = [];
      if (sessionId) {
        const conv = db.prepare('SELECT id FROM conversations WHERE session_id = ? AND widget_id = ?')
          .get(sessionId, widgetId);
        if (conv) {
          messages = db.prepare(
            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
          ).all(conv.id);
        }
      }
      if (!messages.length) return;
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      const transcript = messages.map(m =>
        `${m.role === 'user' ? 'Zákazník' : 'Asistent'}: ${m.content}`
      ).join('\n');
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Zákazník si práve zarezervoval termín${serviceInfo ? ': ' + serviceInfo : ''}.
Analyzuj konverzáciu a vytvor stručnú rezervačnú kartu pre majiteľa biznisu.

Konverzácia:
${transcript}

Vráť VÝHRADNE tento formát (žiadny iný text):

📋 PREČO SA OBJEDNAL: [1–2 vety – hlavný dôvod rezervácie]
💭 ČO CHCE: [konkrétne požiadavky, preferencie]
⚡ NALIEHAVOSŤ: [okamžitá / bežná / plánuje]
📝 POZNÁMKY: [ďalšie relevantné info z konverzácie, alebo "Žiadne"]`,
        }],
      });
      const summary = resp.content[0]?.text?.trim();
      if (summary) db.prepare('UPDATE bookings SET ai_summary = ? WHERE id = ?').run(summary, bookingId);
    } catch (err) {
      console.error('[booking summary]', err.message);
    }
  });
}

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

  const cfg = getOrCreateConfig(req.params.widgetId);

  const schedules = db.prepare(
    'SELECT day_of_week, start_time, end_time, active FROM booking_schedules WHERE booking_config_id = ? ORDER BY day_of_week'
  ).all(cfg.id);

  const services = db.prepare(
    'SELECT id, name, description, duration_mins, price, currency FROM booking_services WHERE booking_config_id = ? AND active = 1 ORDER BY display_order, name'
  ).all(cfg.id);

  let designConfig = {};
  try { designConfig = JSON.parse(cfg.design_config || '{}'); } catch {}

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
    services,
    designConfig,
  });
});

/** GET /api/booking/:widgetId/public/slots?date=YYYY-MM-DD */
router.get('/:widgetId/public/slots', (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id, active FROM widgets WHERE id = ?').get(req.params.widgetId);
  if (!widget || !widget.active) return res.status(404).json({ error: 'Widget nenájdený.' });

  const cfg = db.prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(req.params.widgetId);
  if (!cfg) return res.status(404).json({ error: 'Booking nie je povolený.' });

  const { date, serviceId } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Neplatný dátum.' });

  // Override slot_duration with service duration if serviceId provided
  let effectiveCfg = cfg;
  if (serviceId) {
    const svc = getDb().prepare('SELECT duration_mins FROM booking_services WHERE id = ? AND booking_config_id = ?')
      .get(serviceId, cfg.id);
    if (svc) effectiveCfg = { ...cfg, slot_duration: svc.duration_mins };
  }

  res.json(generateSlots(effectiveCfg, date));
});

/** POST /api/booking/:widgetId/public/book */
router.post('/:widgetId/public/book', (req, res) => {
  const db = getDb();
  const widget = db.prepare('SELECT id, active FROM widgets WHERE id = ?').get(req.params.widgetId);
  if (!widget || !widget.active) return res.status(404).json({ error: 'Widget nenájdený.' });

  const cfg = db.prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(req.params.widgetId);
  if (!cfg) return res.status(404).json({ error: 'Booking nie je povolený.' });

  const { customerName, customerEmail, customerPhone, date, startTime, sessionId, serviceId, serviceName } = req.body;
  if (!customerName || !customerEmail || !date || !startTime)
    return res.status(400).json({ error: 'Vyplňte meno, email, dátum a čas.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Neplatný dátum.' });
  if (!/^\d{2}:\d{2}$/.test(startTime)) return res.status(400).json({ error: 'Neplatný čas.' });

  // Resolve service & use its duration for slot verification
  let resolvedService = null;
  let effectiveCfg = cfg;
  if (serviceId) {
    resolvedService = db.prepare('SELECT * FROM booking_services WHERE id = ? AND booking_config_id = ?')
      .get(serviceId, cfg.id);
    if (resolvedService) effectiveCfg = { ...cfg, slot_duration: resolvedService.duration_mins };
  }

  // Verify the slot is still available
  const available = generateSlots(effectiveCfg, date);
  const slot = available.find(s => s.start_time === startTime);
  if (!slot) return res.status(409).json({ error: 'Termín nie je dostupný. Vyberte iný čas.' });

  const resolvedServiceName = resolvedService?.name || serviceName || null;

  const id = uuidv4();
  // Try full INSERT first (with service columns); fall back to base INSERT if columns missing
  try {
    db.prepare(`
      INSERT INTO bookings (id, booking_config_id, widget_id, customer_name, customer_email, customer_phone,
        date, start_time, end_time, status, session_id, service_id, service_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
    `).run(id, cfg.id, widget.id, customerName.trim(), customerEmail.trim(),
           customerPhone ? customerPhone.trim() : null,
           date, slot.start_time, slot.end_time,
           sessionId || null, resolvedService?.id || null, resolvedServiceName);
  } catch {
    // Fallback: service_id / service_name columns may not exist yet (pending migration)
    db.prepare(`
      INSERT INTO bookings (id, booking_config_id, widget_id, customer_name, customer_email, customer_phone,
        date, start_time, end_time, status, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)
    `).run(id, cfg.id, widget.id, customerName.trim(), customerEmail.trim(),
           customerPhone ? customerPhone.trim() : null,
           date, slot.start_time, slot.end_time,
           sessionId || null);
  }

  // Async: GCal sync + AI summary
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  setImmediate(() => gcal.createEvent(cfg, booking).catch(() => {}));
  if (sessionId) generateBookingSummary(id, sessionId, widget.id, resolvedServiceName);

  res.json({
    id,
    date,
    startTime:  slot.start_time,
    endTime:    slot.end_time,
    serviceName: resolvedServiceName,
    confirmationMessage: cfg.confirmation_message || 'Rezervácia potvrdená! Tešíme sa na vás.',
  });
});

/* ════════════════════════════════════════════════════════════════
   PROTECTED ENDPOINTS (requireAuth)
   ════════════════════════════════════════════════════════════════ */

/* ── Services ──────────────────────────────────────────────────── */

/** GET /api/booking/:widgetId/services */
router.get('/:widgetId/services', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  res.json(getDb().prepare(
    'SELECT * FROM booking_services WHERE booking_config_id = ? ORDER BY display_order, name'
  ).all(cfg.id));
});

/** POST /api/booking/:widgetId/services */
router.post('/:widgetId/services', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const { name, description, durationMins, price, currency, displayOrder } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Názov služby je povinný.' });
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO booking_services (id, booking_config_id, name, description, duration_mins, price, currency, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, cfg.id, name.trim().slice(0,100), (description||'').trim().slice(0,500),
    parseInt(durationMins)||60, price != null && price !== '' ? parseFloat(price) : null,
    (currency||'EUR').slice(0,5), parseInt(displayOrder)||0);
  res.json({ ok: true, id });
});

/** PUT /api/booking/:widgetId/services/:serviceId */
router.put('/:widgetId/services/:serviceId', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  const db = getDb();
  const svc = db.prepare('SELECT * FROM booking_services WHERE id = ? AND booking_config_id = ?')
    .get(req.params.serviceId, cfg.id);
  if (!svc) return res.status(404).json({ error: 'Služba nenájdená.' });
  const { name, description, durationMins, price, currency, active, displayOrder } = req.body;
  db.prepare(`
    UPDATE booking_services SET name=?, description=?, duration_mins=?, price=?, currency=?, active=?, display_order=? WHERE id=?
  `).run(
    (name||svc.name).trim().slice(0,100),
    description != null ? description.trim().slice(0,500) : svc.description,
    parseInt(durationMins) > 0 ? parseInt(durationMins) : svc.duration_mins,
    price != null && price !== '' ? parseFloat(price) : svc.price,
    (currency||svc.currency).slice(0,5),
    active != null ? (active ? 1 : 0) : svc.active,
    parseInt(displayOrder) >= 0 ? parseInt(displayOrder) : svc.display_order,
    svc.id
  );
  res.json({ ok: true });
});

/** DELETE /api/booking/:widgetId/services/:serviceId */
router.delete('/:widgetId/services/:serviceId', requireAuth, (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  const cfg = getOrCreateConfig(req.params.widgetId);
  getDb().prepare('DELETE FROM booking_services WHERE id = ? AND booking_config_id = ?')
    .run(req.params.serviceId, cfg.id);
  res.json({ ok: true });
});

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
  const { timezone, slotDuration, bufferBetween, minNotice, maxAdvanceDays, confirmationMessage, designConfig } = req.body;

  getDb().prepare(`
    UPDATE booking_configs SET
      timezone = ?, slot_duration = ?, buffer_between = ?,
      min_notice = ?, max_advance_days = ?, confirmation_message = ?,
      design_config = ?
    WHERE id = ?
  `).run(
    timezone || cfg.timezone,
    parseInt(slotDuration) || cfg.slot_duration,
    parseInt(bufferBetween) >= 0 ? parseInt(bufferBetween) : cfg.buffer_between,
    parseInt(minNotice) >= 0 ? parseInt(minNotice) : cfg.min_notice,
    parseInt(maxAdvanceDays) || cfg.max_advance_days,
    confirmationMessage !== undefined ? String(confirmationMessage).slice(0, 500) : cfg.confirmation_message,
    designConfig !== undefined ? JSON.stringify(designConfig) : (cfg.design_config || '{}'),
    cfg.id
  );
  res.json({ ok: true });
});

/** POST /api/booking/:widgetId/logo — upload calendar logo */
router.post('/:widgetId/logo', requireAuth, uploadLogo.single('logo'), (req, res) => {
  if (!getOwnedWidget(req.params.widgetId, req.userId))
    return res.status(404).json({ error: 'Widget nenájdený.' });
  if (!req.file) return res.status(400).json({ error: 'Neplatný súbor.' });

  const logoUrl = `/uploads/booking-logos/${req.file.filename}`;
  const cfg = getOrCreateConfig(req.params.widgetId);

  // Merge logoUrl into existing design_config
  let design = {};
  try { design = JSON.parse(cfg.design_config || '{}'); } catch {}
  design.calendarLogo = logoUrl;

  getDb().prepare('UPDATE booking_configs SET design_config = ? WHERE id = ?')
    .run(JSON.stringify(design), cfg.id);

  res.json({ logo_url: logoUrl });
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

/** GET /api/booking/all/bookings?from=&to= — all bookings across all user's widgets */
// NOTE: must be registered BEFORE /:widgetId/bookings to avoid route conflict
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
