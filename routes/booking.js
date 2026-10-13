'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const gcal = require('../services/gcal');
const core = require('../services/bookingCore');
const notifyMod = require('../services/bookingNotify');

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

const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const notify = (kind, id, extra) => setImmediate(() => notifyMod.notify(kind, id, extra).catch(err => console.error('[booking notify]', err.message)));
const TIME = /^\d{2}:\d{2}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  core.ensureStaff(cfg);
  return cfg;
}

const defaultStaff = cfg => core.ensureStaff(cfg)[0];
const withTz = (staff, cfg) => ({ ...staff, timezone: cfg.timezone });
const busyFor = cfg => (staff, date) => gcal.getBusyTimes(withTz(staff, cfg), date);

function publicWidget(widgetId) {
  const db = getDb();
  const widget = db.prepare('SELECT id, active FROM widgets WHERE id = ?').get(widgetId);
  if (!widget || !widget.active) return null;
  const cfg = db.prepare('SELECT * FROM booking_configs WHERE widget_id = ?').get(widgetId);
  return cfg ? { widget, cfg } : null;
}

/** Validates intake answers against the service's questions → [{q, a}] or { error }. */
function collectAnswers(service, input) {
  const questions = parseJSON(service.questions, []);
  const out = [];
  for (const q of questions) {
    let v = input && input[q.id];
    if (Array.isArray(v)) v = v.join(', ');
    v = v == null ? '' : String(v).trim().slice(0, 1000);
    if (q.type === 'checkbox') v = v && v !== 'false' ? 'Áno' : '';
    if (q.required && !v) return { error: `Vyplňte: ${q.label}` };
    if (v) out.push({ q: q.label, a: v });
  }
  return { answers: out };
}

/**
 * Creates a confirmed booking after re-checking availability (including Google
 * Calendar) for the requested staff member or for anyone offering the service.
 */
async function createBooking(cfg, widgetId, body) {
  const db = getDb();
  const { customerName, customerEmail, customerPhone, date, startTime, sessionId, serviceId, serviceName, staffId, answers, notes } = body;
  const seats = Math.max(1, Math.min(50, parseInt(body.seats, 10) || 1));
  if (!customerName || !customerEmail || !date || !startTime) return { status: 400, error: 'Vyplňte meno, email, dátum a čas.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return { status: 400, error: 'Neplatný email.' };
  if (!DATE.test(date)) return { status: 400, error: 'Neplatný dátum.' };
  if (!TIME.test(startTime)) return { status: 400, error: 'Neplatný čas.' };
  if (cfg.require_phone && !String(customerPhone || '').trim()) return { status: 400, error: 'Vyplňte telefón.' };

  const service = core.resolveService(cfg, serviceId);
  const collected = collectAnswers(service, answers);
  if (collected.error) return { status: 400, error: collected.error };

  const slots = await core.availableSlots({ cfg, serviceId: service.id, staffId, date, seats, busyFor: busyFor(cfg) });
  const slot = slots.find(s => s.start_time === startTime);
  if (!slot) return { status: 409, error: 'Termín nie je dostupný. Vyberte iný čas.' };

  const id = uuidv4();
  const manageToken = core.newToken();
  db.prepare(`
    INSERT INTO bookings (id, booking_config_id, widget_id, customer_name, customer_email, customer_phone,
      date, start_time, end_time, status, session_id, service_id, service_name, staff_id, manage_token,
      answers, seats, start_utc, end_utc, buffer_before, buffer_after, location_type, location_detail, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, cfg.id, widgetId, String(customerName).trim().slice(0, 120), String(customerEmail).trim().slice(0, 200),
         customerPhone ? String(customerPhone).trim().slice(0, 40) : null,
         date, slot.start_time, slot.end_time, sessionId || null, service.id, service.name || serviceName || null,
         slot.staff_id, manageToken, JSON.stringify(collected.answers), seats,
         core.zonedToUtc(date, slot.start_time, cfg.timezone), core.zonedToUtc(date, slot.end_time, cfg.timezone),
         service.buffer_before || 0, service.buffer_after || 0, service.location_type || null, service.location_detail || null,
         String(notes || '').slice(0, 1000));

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  const staff = db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(slot.staff_id);
  setImmediate(() => gcal.createEvent(withTz(staff, cfg), booking).catch(() => {}));
  if (sessionId) generateBookingSummary(id, sessionId, widgetId, booking.service_name);
  notify('confirmed', id);
  return { booking, staff };
}

/** Moves a booking to a new date/time (same service; same staff unless staffId given). */
async function rescheduleBooking(cfg, booking, { date, startTime, staffId }) {
  const db = getDb();
  if (!DATE.test(date || '') || !TIME.test(startTime || '')) return { status: 400, error: 'Neplatný dátum alebo čas.' };
  const slots = await core.availableSlots({ cfg, serviceId: booking.service_id, staffId: staffId || booking.staff_id, date,
    seats: booking.seats || 1, excludeBookingId: booking.id, busyFor: busyFor(cfg) });
  const slot = slots.find(s => s.start_time === startTime);
  if (!slot) return { status: 409, error: 'Termín nie je dostupný. Vyberte iný čas.' };

  const previous = `${booking.date} ${booking.start_time}`;
  const oldStaff = db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(booking.staff_id);
  db.prepare(`UPDATE bookings SET date = ?, start_time = ?, end_time = ?, staff_id = ?, start_utc = ?, end_utc = ?,
              reschedule_count = reschedule_count + 1, gcal_event_id = NULL WHERE id = ?`)
    .run(date, slot.start_time, slot.end_time, slot.staff_id,
         core.zonedToUtc(date, slot.start_time, cfg.timezone), core.zonedToUtc(date, slot.end_time, cfg.timezone), booking.id);
  // Reminders for the new time are sent again
  db.prepare("DELETE FROM booking_notifications WHERE booking_id = ? AND kind LIKE 'rem_%'").run(booking.id);

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  const newStaff = db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(slot.staff_id);
  setImmediate(async () => {
    if (oldStaff && booking.gcal_event_id) await gcal.deleteEvent(withTz(oldStaff, cfg), booking.gcal_event_id).catch(() => {});
    await gcal.createEvent(withTz(newStaff, cfg), updated).catch(() => {});
  });
  notify('rescheduled', booking.id, { previous });
  return { booking: updated };
}

function cancelBooking(cfg, booking, { by, reason }) {
  const db = getDb();
  db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancel_reason = ? WHERE id = ?")
    .run(by, reason ? String(reason).slice(0, 500) : null, booking.id);
  const staff = booking.staff_id && db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(booking.staff_id);
  if (staff && booking.gcal_event_id) setImmediate(() => gcal.deleteEvent(withTz(staff, cfg), booking.gcal_event_id).catch(() => {}));
  notify('cancelled', booking.id);
}

/* ════════════════════════════════════════════════════════════════
   CUSTOMER SELF-SERVICE (manage link from the e-mail, no login)
   ════════════════════════════════════════════════════════════════ */

function loadByToken(token) {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE manage_token = ?').get(String(token || ''));
  if (!booking) return null;
  const cfg = db.prepare('SELECT * FROM booking_configs WHERE id = ?').get(booking.booking_config_id);
  return { booking, cfg };
}

function policy(cfg, booking) {
  const deadline = (booking.start_utc || 0) - cfg.cancel_hours * 3600;
  const open = booking.status === 'confirmed' && Math.floor(Date.now() / 1000) < deadline;
  return { canCancel: !!cfg.allow_cancel && open, canReschedule: !!cfg.allow_reschedule && open, deadline, cancelHours: cfg.cancel_hours };
}

router.get('/manage/:token', (req, res) => {
  const ctx = loadByToken(req.params.token);
  if (!ctx) return res.status(404).json({ error: 'Rezervácia nenájdená.' });
  const { booking: b, cfg } = ctx;
  const db = getDb();
  const staff = b.staff_id && db.prepare('SELECT name FROM booking_staff WHERE id = ?').get(b.staff_id);
  const widget = db.prepare('SELECT bot_name, primary_color FROM widgets WHERE id = ?').get(b.widget_id) || {};
  const design = parseJSON(cfg.design_config, {});
  res.json({
    business: design.calendarName || widget.bot_name, primaryColor: design.primaryColor || widget.primary_color,
    customCss: cfg.custom_css || '', widgetId: b.widget_id, timezone: cfg.timezone,
    booking: { status: b.status, date: b.date, startTime: b.start_time, endTime: b.end_time, startUtc: b.start_utc,
      serviceName: b.service_name, staffName: staff?.name || null, customerName: b.customer_name, seats: b.seats,
      locationType: b.location_type, locationDetail: b.location_detail },
    calendar: notifyMod.calendarLinks(notifyMod.loadContext(b.id)),
    ...policy(cfg, b),
  });
});

router.get('/manage/:token/ics', (req, res) => {
  const ctx = loadByToken(req.params.token);
  if (!ctx) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rezervacia.ics"');
  res.send(notifyMod.buildIcs(notifyMod.loadContext(ctx.booking.id), { method: 'PUBLISH' }));
});

router.get('/manage/:token/slots', async (req, res) => {
  const ctx = loadByToken(req.params.token);
  if (!ctx) return res.status(404).json({ error: 'Rezervácia nenájdená.' });
  if (!policy(ctx.cfg, ctx.booking).canReschedule) return res.status(403).json({ error: 'Termín už nie je možné presunúť.' });
  if (!DATE.test(req.query.date || '')) return res.status(400).json({ error: 'Neplatný dátum.' });
  res.json(await core.availableSlots({ cfg: ctx.cfg, serviceId: ctx.booking.service_id, staffId: ctx.booking.staff_id,
    date: req.query.date, seats: ctx.booking.seats || 1, excludeBookingId: ctx.booking.id, busyFor: busyFor(ctx.cfg) }));
});

router.post('/manage/:token/cancel', (req, res) => {
  const ctx = loadByToken(req.params.token);
  if (!ctx) return res.status(404).json({ error: 'Rezervácia nenájdená.' });
  if (!policy(ctx.cfg, ctx.booking).canCancel) return res.status(403).json({ error: `Rezerváciu už nie je možné zrušiť online (najneskôr ${ctx.cfg.cancel_hours} h vopred).` });
  cancelBooking(ctx.cfg, ctx.booking, { by: 'customer', reason: req.body?.reason });
  res.json({ ok: true });
});

router.post('/manage/:token/reschedule', async (req, res) => {
  const ctx = loadByToken(req.params.token);
  if (!ctx) return res.status(404).json({ error: 'Rezervácia nenájdená.' });
  if (!policy(ctx.cfg, ctx.booking).canReschedule) return res.status(403).json({ error: `Termín už nie je možné presunúť (najneskôr ${ctx.cfg.cancel_hours} h vopred).` });
  const r = await rescheduleBooking(ctx.cfg, ctx.booking, { date: req.body?.date, startTime: req.body?.startTime });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, date: r.booking.date, startTime: r.booking.start_time, endTime: r.booking.end_time });
});

/** Subscribable calendar feed per staff member (Apple / Outlook / Google "from URL"). */
router.get('/feed/:token.ics', (req, res) => {
  const db = getDb();
  const staff = db.prepare('SELECT * FROM booking_staff WHERE ics_token = ?').get(req.params.token);
  if (!staff) return res.status(404).send('Not found');
  const cfg = db.prepare('SELECT * FROM booking_configs WHERE id = ?').get(staff.booking_config_id);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.send(notifyMod.buildStaffFeed(staff, cfg));
});

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
  const staff = core.ensureStaff(cfg).filter(s => s.active);

  // A weekday is bookable when any active staff member works that day
  const rows = db.prepare('SELECT staff_id, day_of_week, active FROM booking_staff_schedules').all()
    .filter(r => r.active && staff.some(s => s.id === r.staff_id));
  const schedules = [0, 1, 2, 3, 4, 5, 6].map(d => {
    const ids = rows.filter(r => r.day_of_week === d).map(r => r.staff_id);
    return { day_of_week: d, active: ids.length ? 1 : 0, staffIds: ids };
  });

  const links = db.prepare('SELECT service_id, staff_id FROM booking_service_staff').all();
  const services = db.prepare(
    `SELECT id, name, description, duration_mins, price, currency, capacity, location_type, location_detail, questions
     FROM booking_services WHERE booking_config_id = ? AND active = 1 ORDER BY display_order, name`
  ).all(cfg.id).map(s => {
    const ids = links.filter(l => l.service_id === s.id).map(l => l.staff_id);
    return {
      ...s, questions: parseJSON(s.questions, []),
      // the meeting link is only sent after booking
      location_detail: s.location_type === 'online' ? '' : s.location_detail,
      staffIds: ids.length ? ids.filter(id => staff.some(st => st.id === id)) : staff.map(st => st.id),
    };
  });

  res.json({
    widgetId:           widget.id,
    botName:            widget.bot_name,
    primaryColor:       widget.primary_color,
    timezone:           cfg.timezone,
    slotDuration:       cfg.slot_duration,
    minNoticeMins:      cfg.min_notice,
    maxAdvanceDays:     cfg.max_advance_days,
    confirmationMessage: cfg.confirmation_message,
    staffSelection:     staff.length > 1 ? cfg.staff_selection : 'none',
    requirePhone:       !!cfg.require_phone,
    customCss:          cfg.custom_css || '',
    staff:              staff.map(s => ({ id: s.id, name: s.name, bio: s.bio, photoUrl: s.photo_url })),
    schedules,
    services,
    designConfig:       parseJSON(cfg.design_config || '{}', {}),
  });
});

/** GET /api/booking/:widgetId/public/slots?date=YYYY-MM-DD&serviceId=&staffId=&seats= */
router.get('/:widgetId/public/slots', async (req, res) => {
  const pw = publicWidget(req.params.widgetId);
  if (!pw) return res.status(404).json({ error: 'Rezervácie nie sú k dispozícii.' });
  const { date, serviceId, staffId } = req.query;
  if (!date || !DATE.test(date)) return res.status(400).json({ error: 'Neplatný dátum.' });
  core.ensureStaff(pw.cfg);
  res.json(await core.availableSlots({ cfg: pw.cfg, serviceId, staffId, date,
    seats: Math.max(1, parseInt(req.query.seats, 10) || 1), busyFor: busyFor(pw.cfg) }));
});

/** POST /api/booking/:widgetId/public/book */
router.post('/:widgetId/public/book', async (req, res) => {
  const pw = publicWidget(req.params.widgetId);
  if (!pw) return res.status(404).json({ error: 'Rezervácie nie sú k dispozícii.' });
  core.ensureStaff(pw.cfg);
  const r = await createBooking(pw.cfg, pw.widget.id, req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  const b = r.booking;
  res.json({
    id:          b.id,
    date:        b.date,
    startTime:   b.start_time,
    endTime:     b.end_time,
    serviceName: b.service_name,
    staffName:   r.staff?.name || null,
    manageUrl:   notifyMod.manageUrl(b),
    calendar:    notifyMod.calendarLinks(notifyMod.loadContext(b.id)),
    confirmationMessage: pw.cfg.confirmation_message || 'Rezervácia potvrdená! Tešíme sa na vás.',
  });
});

/* ════════════════════════════════════════════════════════════════
   PROTECTED ENDPOINTS (requireAuth)
   ════════════════════════════════════════════════════════════════ */

/** Owner check + config, as middleware for /:widgetId/... routes */
function owned(req, res, next) {
  if (!getOwnedWidget(req.params.widgetId, req.userId)) return res.status(404).json({ error: 'Widget nenájdený.' });
  req.cfg = getOrCreateConfig(req.params.widgetId);
  next();
}
const auth = [requireAuth, owned];

/* ── Services ──────────────────────────────────────────────────── */

const LOCATION_TYPES = ['in_person', 'online', 'phone'];
const QUESTION_TYPES = ['text', 'textarea', 'select', 'checkbox'];

function cleanQuestions(list) {
  if (!Array.isArray(list)) return '[]';
  return JSON.stringify(list.slice(0, 15).map(q => ({
    id: String(q.id || uuidv4()).slice(0, 40),
    label: String(q.label || '').trim().slice(0, 200),
    type: QUESTION_TYPES.includes(q.type) ? q.type : 'text',
    options: q.type === 'select' ? (Array.isArray(q.options) ? q.options : String(q.options || '').split('\n'))
      .map(o => String(o).trim()).filter(Boolean).slice(0, 20) : [],
    required: !!q.required,
  })).filter(q => q.label));
}

function serviceFields(body, prev = {}) {
  const int = (v, d, min = 0, max = 100000) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };
  return {
    name: body.name !== undefined ? String(body.name).trim().slice(0, 100) : prev.name,
    description: body.description !== undefined ? String(body.description).trim().slice(0, 1000) : (prev.description || ''),
    duration_mins: int(body.durationMins, prev.duration_mins || 60, 5, 1440),
    price: body.price !== undefined ? (body.price === '' || body.price === null ? null : parseFloat(body.price)) : (prev.price ?? null),
    currency: String(body.currency || prev.currency || 'EUR').slice(0, 5),
    display_order: int(body.displayOrder, prev.display_order || 0),
    active: body.active !== undefined ? (body.active ? 1 : 0) : (prev.active ?? 1),
    buffer_before: int(body.bufferBefore, prev.buffer_before || 0, 0, 240),
    buffer_after: int(body.bufferAfter, prev.buffer_after || 0, 0, 240),
    capacity: int(body.capacity, prev.capacity || 1, 1, 500),
    location_type: LOCATION_TYPES.includes(body.locationType) ? body.locationType : (prev.location_type || 'in_person'),
    location_detail: body.locationDetail !== undefined ? String(body.locationDetail).trim().slice(0, 500) : (prev.location_detail || ''),
    questions: body.questions !== undefined ? cleanQuestions(body.questions) : (prev.questions || '[]'),
  };
}

function setServiceStaff(cfg, serviceId, staffIds) {
  if (!Array.isArray(staffIds)) return;
  const db = getDb();
  const valid = core.ensureStaff(cfg).map(s => s.id);
  db.prepare('DELETE FROM booking_service_staff WHERE service_id = ?').run(serviceId);
  const ins = db.prepare('INSERT OR IGNORE INTO booking_service_staff (service_id, staff_id) VALUES (?, ?)');
  for (const id of staffIds) if (valid.includes(id)) ins.run(serviceId, id);
}

/** GET /api/booking/:widgetId/services */
router.get('/:widgetId/services', auth, (req, res) => {
  const db = getDb();
  const links = db.prepare('SELECT service_id, staff_id FROM booking_service_staff').all();
  res.json(db.prepare('SELECT * FROM booking_services WHERE booking_config_id = ? ORDER BY display_order, name').all(req.cfg.id)
    .map(s => ({ ...s, questions: parseJSON(s.questions, []), staff_ids: links.filter(l => l.service_id === s.id).map(l => l.staff_id) })));
});

/** POST /api/booking/:widgetId/services */
router.post('/:widgetId/services', auth, (req, res) => {
  const f = serviceFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Názov služby je povinný.' });
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO booking_services (id, booking_config_id, name, description, duration_mins, price, currency, display_order, active,
      buffer_before, buffer_after, capacity, location_type, location_detail, questions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.cfg.id, f.name, f.description, f.duration_mins, f.price, f.currency, f.display_order, f.active,
         f.buffer_before, f.buffer_after, f.capacity, f.location_type, f.location_detail, f.questions);
  setServiceStaff(req.cfg, id, req.body.staffIds);
  res.json({ ok: true, id });
});

/** PUT /api/booking/:widgetId/services/:serviceId */
router.put('/:widgetId/services/:serviceId', auth, (req, res) => {
  const db = getDb();
  const svc = db.prepare('SELECT * FROM booking_services WHERE id = ? AND booking_config_id = ?').get(req.params.serviceId, req.cfg.id);
  if (!svc) return res.status(404).json({ error: 'Služba nenájdená.' });
  const f = serviceFields(req.body, svc);
  db.prepare(`
    UPDATE booking_services SET name=?, description=?, duration_mins=?, price=?, currency=?, active=?, display_order=?,
      buffer_before=?, buffer_after=?, capacity=?, location_type=?, location_detail=?, questions=? WHERE id=?
  `).run(f.name || svc.name, f.description, f.duration_mins, f.price, f.currency, f.active, f.display_order,
         f.buffer_before, f.buffer_after, f.capacity, f.location_type, f.location_detail, f.questions, svc.id);
  setServiceStaff(req.cfg, svc.id, req.body.staffIds);
  res.json({ ok: true });
});

/** DELETE /api/booking/:widgetId/services/:serviceId */
router.delete('/:widgetId/services/:serviceId', auth, (req, res) => {
  getDb().prepare('DELETE FROM booking_services WHERE id = ? AND booking_config_id = ?').run(req.params.serviceId, req.cfg.id);
  res.json({ ok: true });
});

/* ── Config ────────────────────────────────────────────────────── */

/** GET /api/booking/:widgetId/config */
router.get('/:widgetId/config', auth, (req, res) => {
  const { gcal_access_token, gcal_refresh_token, ...cfg } = req.cfg;
  const schedules = getDb().prepare('SELECT * FROM booking_staff_schedules WHERE staff_id = ? ORDER BY day_of_week').all(defaultStaff(req.cfg).id);
  res.json({ ...cfg, reminders_customer: parseJSON(cfg.reminders_customer, []), reminders_staff: parseJSON(cfg.reminders_staff, []), schedules });
});

/** PUT /api/booking/:widgetId/config */
router.put('/:widgetId/config', auth, (req, res) => {
  const cfg = req.cfg;
  const b = req.body || {};
  const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };
  const offsets = (v, d) => Array.isArray(v) ? JSON.stringify([...new Set(v.map(Number).filter(n => n > 0 && n <= 20160))].sort((a, c) => c - a).slice(0, 5)) : d;
  getDb().prepare(`
    UPDATE booking_configs SET
      timezone = ?, slot_duration = ?, buffer_between = ?, min_notice = ?, max_advance_days = ?, confirmation_message = ?,
      design_config = ?, slot_interval = ?, cancel_hours = ?, allow_cancel = ?, allow_reschedule = ?,
      reminders_customer = ?, reminders_staff = ?, notify_staff = ?, custom_css = ?, staff_selection = ?, require_phone = ?
    WHERE id = ?
  `).run(
    b.timezone || cfg.timezone,
    int(b.slotDuration, cfg.slot_duration, 5, 1440),
    int(b.bufferBetween, cfg.buffer_between, 0, 240),
    int(b.minNotice, cfg.min_notice, 0, 43200),
    int(b.maxAdvanceDays, cfg.max_advance_days, 1, 730),
    b.confirmationMessage !== undefined ? String(b.confirmationMessage).slice(0, 500) : cfg.confirmation_message,
    b.designConfig !== undefined ? JSON.stringify(b.designConfig) : (cfg.design_config || '{}'),
    int(b.slotInterval, cfg.slot_interval, 0, 240),
    int(b.cancelHours, cfg.cancel_hours, 0, 720),
    b.allowCancel !== undefined ? (b.allowCancel ? 1 : 0) : cfg.allow_cancel,
    b.allowReschedule !== undefined ? (b.allowReschedule ? 1 : 0) : cfg.allow_reschedule,
    offsets(b.remindersCustomer, cfg.reminders_customer),
    offsets(b.remindersStaff, cfg.reminders_staff),
    b.notifyStaff !== undefined ? (b.notifyStaff ? 1 : 0) : cfg.notify_staff,
    // custom CSS is rendered inside a <style> on the booking page: never let it close the tag
    b.customCss !== undefined ? String(b.customCss).replace(/<\/?style/gi, '').slice(0, 20000) : cfg.custom_css,
    ['choose', 'any'].includes(b.staffSelection) ? b.staffSelection : cfg.staff_selection,
    b.requirePhone !== undefined ? (b.requirePhone ? 1 : 0) : cfg.require_phone,
    cfg.id
  );
  res.json({ ok: true });
});

/** POST /api/booking/:widgetId/logo — upload calendar logo */
router.post('/:widgetId/logo', requireAuth, uploadLogo.single('logo'), owned, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Neplatný súbor.' });
  const logoUrl = `/uploads/booking-logos/${req.file.filename}`;
  const design = parseJSON(req.cfg.design_config || '{}', {});
  design.calendarLogo = logoUrl;
  getDb().prepare('UPDATE booking_configs SET design_config = ? WHERE id = ?').run(JSON.stringify(design), req.cfg.id);
  res.json({ logo_url: logoUrl });
});

/* ── Staff ─────────────────────────────────────────────────────── */

function ownedStaff(req, res, next) {
  const s = getDb().prepare('SELECT * FROM booking_staff WHERE id = ? AND booking_config_id = ?').get(req.params.staffId, req.cfg.id);
  if (!s) return res.status(404).json({ error: 'Zamestnanec nenájdený.' });
  req.staff = s;
  next();
}
const staffAuth = [requireAuth, owned, ownedStaff];
const feedUrl = s => `${(process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '')}/api/booking/feed/${s.ics_token}.ics`;

function staffView(s) {
  const db = getDb();
  return {
    id: s.id, name: s.name, email: s.email, bio: s.bio, photo_url: s.photo_url, active: !!s.active, display_order: s.display_order,
    break_start: s.break_start, break_end: s.break_end, max_per_day: s.max_per_day, max_minutes_per_day: s.max_minutes_per_day,
    max_per_week: s.max_per_week, gcal_connected: !!s.gcal_access_token, gcal_email: s.gcal_email, feed_url: feedUrl(s),
    schedules: db.prepare('SELECT day_of_week, start_time, end_time, active FROM booking_staff_schedules WHERE staff_id = ? ORDER BY day_of_week').all(s.id),
    time_off: db.prepare('SELECT id, date_from, date_to, type, start_time, end_time, note FROM booking_time_off WHERE staff_id = ? AND date_to >= date(\'now\', \'-1 day\') ORDER BY date_from').all(s.id),
    service_ids: db.prepare('SELECT service_id FROM booking_service_staff WHERE staff_id = ?').all(s.id).map(r => r.service_id),
  };
}

router.get('/:widgetId/staff', auth, (req, res) => res.json(core.ensureStaff(req.cfg).map(staffView)));

router.post('/:widgetId/staff', auth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Meno je povinné.' });
  const s = core.createStaff(req.cfg, { name, email: String(req.body.email || '').trim().slice(0, 200) });
  res.json(staffView(s));
});

router.put('/:widgetId/staff/:staffId', staffAuth, (req, res) => {
  const s = req.staff, b = req.body || {};
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 100000) : d; };
  const time = (v, d) => v === '' || v === null ? null : (TIME.test(v || '') ? v : d);
  getDb().prepare(`UPDATE booking_staff SET name = ?, email = ?, bio = ?, photo_url = ?, active = ?, display_order = ?,
                   break_start = ?, break_end = ?, max_per_day = ?, max_minutes_per_day = ?, max_per_week = ? WHERE id = ?`)
    .run(b.name !== undefined ? String(b.name).trim().slice(0, 100) || s.name : s.name,
         b.email !== undefined ? String(b.email).trim().slice(0, 200) : s.email,
         b.bio !== undefined ? String(b.bio).trim().slice(0, 1000) : s.bio,
         b.photoUrl !== undefined ? String(b.photoUrl).trim().slice(0, 500) : s.photo_url,
         b.active !== undefined ? (b.active ? 1 : 0) : s.active,
         int(b.displayOrder, s.display_order),
         time(b.breakStart, s.break_start), time(b.breakEnd, s.break_end),
         int(b.maxPerDay, s.max_per_day), int(b.maxMinutesPerDay, s.max_minutes_per_day), int(b.maxPerWeek, s.max_per_week), s.id);
  if (Array.isArray(b.serviceIds)) {
    const db = getDb();
    const own = db.prepare('SELECT id FROM booking_services WHERE booking_config_id = ?').all(req.cfg.id).map(r => r.id);
    db.prepare('DELETE FROM booking_service_staff WHERE staff_id = ?').run(s.id);
    for (const id of b.serviceIds) if (own.includes(id)) db.prepare('INSERT OR IGNORE INTO booking_service_staff (service_id, staff_id) VALUES (?, ?)').run(id, s.id);
  }
  res.json(staffView(getDb().prepare('SELECT * FROM booking_staff WHERE id = ?').get(s.id)));
});

router.delete('/:widgetId/staff/:staffId', staffAuth, (req, res) => {
  const db = getDb();
  if (core.ensureStaff(req.cfg).length <= 1) return res.status(400).json({ error: 'Musí zostať aspoň jeden zamestnanec.' });
  const upcoming = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE staff_id = ? AND status = 'confirmed' AND start_utc > unixepoch()").get(req.staff.id).n;
  if (upcoming) {
    db.prepare('UPDATE booking_staff SET active = 0 WHERE id = ?').run(req.staff.id);
    return res.json({ ok: true, deactivated: true, upcoming });
  }
  db.prepare('DELETE FROM booking_staff WHERE id = ?').run(req.staff.id);
  res.json({ ok: true });
});

router.put('/:widgetId/staff/:staffId/schedule', staffAuth, (req, res) => {
  const stmt = getDb().prepare(`INSERT INTO booking_staff_schedules (id, staff_id, day_of_week, start_time, end_time, active) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(staff_id, day_of_week) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, active = excluded.active`);
  for (const r of Array.isArray(req.body) ? req.body : []) {
    if (!(r.day_of_week >= 0 && r.day_of_week <= 6)) continue;
    stmt.run(uuidv4(), req.staff.id, r.day_of_week, TIME.test(r.start_time) ? r.start_time : '09:00', TIME.test(r.end_time) ? r.end_time : '17:00', r.active ? 1 : 0);
  }
  res.json({ ok: true });
});

router.post('/:widgetId/staff/:staffId/time-off', staffAuth, (req, res) => {
  const { dateFrom, dateTo, type, startTime, endTime, note } = req.body || {};
  const to = dateTo || dateFrom;
  if (!DATE.test(dateFrom || '') || !DATE.test(to) || to < dateFrom) return res.status(400).json({ error: 'Neplatný dátum.' });
  const custom = type === 'custom';
  getDb().prepare('INSERT INTO booking_time_off (id, staff_id, date_from, date_to, type, start_time, end_time, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), req.staff.id, dateFrom, to, custom ? 'custom' : 'closed', custom ? (startTime || '09:00') : null, custom ? (endTime || '17:00') : null,
         String(note || '').slice(0, 200));
  res.json({ ok: true });
});

router.delete('/:widgetId/staff/:staffId/time-off/:offId', staffAuth, (req, res) => {
  getDb().prepare('DELETE FROM booking_time_off WHERE id = ? AND staff_id = ?').run(req.params.offId, req.staff.id);
  res.json({ ok: true });
});

router.post('/:widgetId/staff/:staffId/feed-reset', staffAuth, (req, res) => {
  getDb().prepare('UPDATE booking_staff SET ics_token = ? WHERE id = ?').run(core.newToken(), req.staff.id);
  res.json({ feed_url: feedUrl(getDb().prepare('SELECT * FROM booking_staff WHERE id = ?').get(req.staff.id)) });
});

router.get('/:widgetId/staff/:staffId/gcal/auth-url', staffAuth, (req, res) => {
  try { res.json({ url: gcal.getAuthUrl(req.params.widgetId, req.staff.id) }); }
  catch { res.status(503).json({ error: 'Google Calendar nie je nakonfigurovaný. Nastavte GOOGLE_CLIENT_ID a GOOGLE_CLIENT_SECRET.' }); }
});

router.delete('/:widgetId/staff/:staffId/gcal', staffAuth, (req, res) => {
  getDb().prepare('UPDATE booking_staff SET gcal_access_token = NULL, gcal_refresh_token = NULL, gcal_token_expiry = NULL, gcal_email = NULL WHERE id = ?').run(req.staff.id);
  res.json({ ok: true });
});

/* ── Legacy single-calendar endpoints → default (first) staff member ── */

/** PUT /api/booking/:widgetId/schedule  (replaces all 7 rows) */
router.put('/:widgetId/schedule', auth, (req, res) => {
  const staffId = defaultStaff(req.cfg).id;
  const stmt = getDb().prepare(`INSERT INTO booking_staff_schedules (id, staff_id, day_of_week, start_time, end_time, active) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(staff_id, day_of_week) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, active = excluded.active`);
  for (const r of Array.isArray(req.body) ? req.body : []) {
    if (r.day_of_week < 0 || r.day_of_week > 6) continue;
    stmt.run(uuidv4(), staffId, r.day_of_week, r.start_time || '09:00', r.end_time || '17:00', r.active ? 1 : 0);
  }
  res.json({ ok: true });
});

/** GET /api/booking/:widgetId/overrides — single-day time off of the default staff member */
router.get('/:widgetId/overrides', auth, (req, res) => {
  res.json(getDb().prepare('SELECT id, date_from AS date, type, start_time, end_time FROM booking_time_off WHERE staff_id = ? AND date_from = date_to ORDER BY date_from')
    .all(defaultStaff(req.cfg).id));
});

/** POST /api/booking/:widgetId/overrides */
router.post('/:widgetId/overrides', auth, (req, res) => {
  const { date, type, startTime, endTime } = req.body;
  if (!date || !DATE.test(date)) return res.status(400).json({ error: 'Neplatný dátum.' });
  const db = getDb();
  const staffId = defaultStaff(req.cfg).id;
  db.prepare('DELETE FROM booking_time_off WHERE staff_id = ? AND date_from = ? AND date_to = ?').run(staffId, date, date);
  db.prepare('INSERT INTO booking_time_off (id, staff_id, date_from, date_to, type, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), staffId, date, date, type === 'custom' ? 'custom' : 'closed',
         type === 'custom' ? (startTime || '09:00') : null, type === 'custom' ? (endTime || '17:00') : null);
  res.json({ ok: true });
});

/** DELETE /api/booking/:widgetId/overrides/:overrideId */
router.delete('/:widgetId/overrides/:overrideId', auth, (req, res) => {
  getDb().prepare('DELETE FROM booking_time_off WHERE id = ? AND staff_id IN (SELECT id FROM booking_staff WHERE booking_config_id = ?)')
    .run(req.params.overrideId, req.cfg.id);
  res.json({ ok: true });
});

/* ── Bookings ──────────────────────────────────────────────────── */

const BOOKING_SELECT = `SELECT b.*, s.name AS staff_name FROM bookings b LEFT JOIN booking_staff s ON s.id = b.staff_id`;

/** GET /api/booking/all/bookings?from=&to= — all bookings across all user's widgets */
// NOTE: must be registered BEFORE /:widgetId/bookings to avoid route conflict
router.get('/all/bookings', requireAuth, (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  const widgetIds = db.prepare('SELECT id FROM widgets WHERE user_id = ?').all(req.userId).map(w => w.id);
  if (!widgetIds.length) return res.json([]);
  const placeholders = widgetIds.map(() => '?').join(',');
  let sql = `SELECT b.*, s.name AS staff_name, w.name as widget_name FROM bookings b
             JOIN widgets w ON w.id = b.widget_id LEFT JOIN booking_staff s ON s.id = b.staff_id
             WHERE b.widget_id IN (${placeholders})`;
  const params = [...widgetIds];
  if (from) { sql += ' AND b.date >= ?'; params.push(from); }
  if (to)   { sql += ' AND b.date <= ?'; params.push(to); }
  sql += ' ORDER BY b.date, b.start_time';
  res.json(db.prepare(sql).all(...params).map(b => ({ ...b, answers: parseJSON(b.answers, []) })));
});

/** GET /api/booking/:widgetId/bookings?from=&to=&status=&staffId= */
router.get('/:widgetId/bookings', auth, (req, res) => {
  const { from, to, status, staffId } = req.query;
  let sql = `${BOOKING_SELECT} WHERE b.booking_config_id = ?`;
  const params = [req.cfg.id];
  if (from) { sql += ' AND b.date >= ?'; params.push(from); }
  if (to)   { sql += ' AND b.date <= ?'; params.push(to); }
  if (status) { sql += ' AND b.status = ?'; params.push(status); }
  if (staffId) { sql += ' AND b.staff_id = ?'; params.push(staffId); }
  sql += ' ORDER BY b.date, b.start_time';
  res.json(getDb().prepare(sql).all(...params).map(b => ({ ...b, answers: parseJSON(b.answers, []) })));
});

/** GET /api/booking/:widgetId/slots?date=&serviceId=&staffId= — owner view, e.g. for rescheduling */
router.get('/:widgetId/slots', auth, async (req, res) => {
  if (!DATE.test(req.query.date || '')) return res.status(400).json({ error: 'Neplatný dátum.' });
  res.json(await core.availableSlots({ cfg: req.cfg, serviceId: req.query.serviceId, staffId: req.query.staffId, date: req.query.date,
    excludeBookingId: req.query.excludeBookingId || null, busyFor: busyFor(req.cfg) }));
});

/** PATCH /api/booking/:widgetId/bookings/:bookingId — status, notes, or move (date + startTime [+ staffId]) */
router.patch('/:widgetId/bookings/:bookingId', auth, async (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND booking_config_id = ?').get(req.params.bookingId, req.cfg.id);
  if (!booking) return res.status(404).json({ error: 'Rezervácia nenájdená.' });
  const { status, internalNotes, date, startTime, staffId, reason } = req.body || {};

  if (date && startTime) {
    const r = await rescheduleBooking(req.cfg, booking, { date, startTime, staffId });
    if (r.error) return res.status(r.status).json({ error: r.error });
  }
  if (status === 'cancelled' && booking.status !== 'cancelled') {
    cancelBooking(req.cfg, booking, { by: 'owner', reason });
  } else if (status && ['confirmed', 'no_show', 'completed'].includes(status)) {
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
  }
  if (internalNotes !== undefined) {
    db.prepare('UPDATE bookings SET internal_notes = ? WHERE id = ?').run(String(internalNotes).slice(0, 1000), booking.id);
  }
  res.json({ ok: true });
});

/* ── Google Calendar OAuth ─────────────────────────────────────── */

/** GET /api/booking/:widgetId/gcal/status — default staff member (legacy single-calendar UI) */
router.get('/:widgetId/gcal/status', auth, (req, res) => {
  const s = defaultStaff(req.cfg);
  res.json({ connected: !!s.gcal_access_token, email: s.gcal_email || null });
});

/** GET /api/booking/:widgetId/gcal/auth-url */
router.get('/:widgetId/gcal/auth-url', auth, (req, res) => {
  try { res.json({ url: gcal.getAuthUrl(req.params.widgetId, defaultStaff(req.cfg).id) }); }
  catch { res.status(503).json({ error: 'Google Calendar nie je nakonfigurovaný. Nastavte GOOGLE_CLIENT_ID a GOOGLE_CLIENT_SECRET.' }); }
});

/** GET /api/booking/gcal/callback  (called by Google after OAuth) */
router.get('/gcal/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) return res.redirect('/dashboard?gcal_error=1');
  try {
    const { widgetId, staffId } = gcal.verifyState(state);
    const cfg = getOrCreateConfig(widgetId);
    const staff = getDb().prepare('SELECT * FROM booking_staff WHERE id = ? AND booking_config_id = ?').get(staffId, cfg.id) || defaultStaff(cfg);
    await gcal.exchangeCode(staff, code);
    res.redirect('/dashboard?gcal_ok=1');
  } catch (e) {
    console.error('[GCal callback]', e.message);
    res.redirect('/dashboard?gcal_error=1');
  }
});

/** DELETE /api/booking/:widgetId/gcal/disconnect */
router.delete('/:widgetId/gcal/disconnect', auth, (req, res) => {
  getDb().prepare('UPDATE booking_staff SET gcal_access_token = NULL, gcal_refresh_token = NULL, gcal_token_expiry = NULL, gcal_email = NULL WHERE id = ?')
    .run(defaultStaff(req.cfg).id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.createBooking = createBooking;
