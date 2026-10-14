'use strict';
/**
 * Google Calendar integration service.
 * Requires env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 * npm install googleapis
 */

let google;
try { google = require('googleapis').google; } catch { google = null; }

const { getDb } = require('../db/database');
const crypto = require('crypto');

const { zonedToUtc } = require('./bookingCore');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI ||
  `${(process.env.APP_URL || 'https://neoworkly.com').replace(/\/$/, '')}/api/booking/gcal/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

/* ── OAuth2 client factory ─────────────────────────────────────── */
function createClient(tokens) {
  if (!google) throw new Error('googleapis package not installed');
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (tokens) oauth2.setCredentials(tokens);
  return oauth2;
}

/* ── State token (HMAC-signed, carries widgetId + staffId) ───────
   Each staff member connects their own Google Calendar. The state is signed so a
   forged callback can't attach someone else's calendar to a staff member. */
const stateSecret = () => process.env.JWT_SECRET || 'changeme';
const sign = s => crypto.createHmac('sha256', stateSecret()).update(s).digest('base64url');

function getAuthUrl(widgetId, staffId) {
  const oauth2 = createClient();
  const payload = Buffer.from(JSON.stringify({ widgetId, staffId, ts: Date.now() })).toString('base64url');
  return oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', state: `${payload}.${sign(payload)}` });
}

function verifyState(state) {
  try {
    const [payload, sig] = String(state).split('.');
    if (!sig || sig !== sign(payload)) throw new Error('bad signature');
    const { widgetId, staffId, ts } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - ts > 10 * 60 * 1000) throw new Error('State expired');
    return { widgetId, staffId };
  } catch {
    throw new Error('Invalid OAuth state');
  }
}

/* ── Token exchange & storage ──────────────────────────────────── */
async function exchangeCode(staff, code) {
  const oauth2 = createClient();
  const { tokens } = await oauth2.getToken(code);

  // Fetch user email
  let email = null;
  try {
    oauth2.setCredentials(tokens);
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const info = await oauth2Api.userinfo.get();
    email = info.data.email;
  } catch { /* email optional */ }

  getDb().prepare(`
    UPDATE booking_staff SET
      gcal_access_token  = ?,
      gcal_refresh_token = ?,
      gcal_token_expiry  = ?,
      gcal_email         = ?
    WHERE id = ?
  `).run(
    JSON.stringify(tokens),
    tokens.refresh_token || null,
    tokens.expiry_date || null,
    email,
    staff.id
  );
}

/* ── Get a live, refreshed OAuth2 client ──────────────────────── */
async function getAuthedClient(cfg) {
  if (!cfg.gcal_access_token) throw new Error('No GCal tokens for this staff member');
  let tokens;
  try { tokens = JSON.parse(cfg.gcal_access_token); } catch { throw new Error('Invalid token JSON'); }

  const oauth2 = createClient(tokens);

  // Refresh if expired (with 60s buffer)
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 60_000) {
    const { credentials } = await oauth2.refreshAccessToken();
    getDb().prepare(`
      UPDATE booking_staff SET
        gcal_access_token = ?, gcal_token_expiry = ?
      WHERE id = ?
    `).run(JSON.stringify(credentials), credentials.expiry_date || null, cfg.id);
    oauth2.setCredentials(credentials);
  }
  return oauth2;
}

/* ── Calendar event helpers ────────────────────────────────────── */

/**
 * Create a Google Calendar event for a booking.
 * @param {object} cfg     - booking_staff row + { timezone } of its booking config
 * @param {object} booking - bookings row
 */
async function createEvent(cfg, booking) {
  if (!cfg.gcal_access_token || !google) return;
  try {
    const auth     = await getAuthedClient(cfg);
    const calendar = google.calendar({ version: 'v3', auth });

    // Build ISO datetime strings using the widget's timezone
    const startIso = `${booking.date}T${booking.start_time}:00`;
    const endIso   = `${booking.date}T${booking.end_time}:00`;

    const event = {
      summary:     `${booking.service_name ? booking.service_name + ' – ' : 'Rezervácia: '}${booking.customer_name}`,
      description: [booking.customer_phone && `Tel: ${booking.customer_phone}`, booking.notes].filter(Boolean).join('\n'),
      location:    booking.location_detail || undefined,
      start:       { dateTime: startIso, timeZone: cfg.timezone },
      end:         { dateTime: endIso,   timeZone: cfg.timezone },
      attendees:   [{ email: booking.customer_email, displayName: booking.customer_name }],
      reminders:   { useDefault: true },
    };

    const response = await calendar.events.insert({
      calendarId: cfg.gcal_calendar_id || 'primary',
      resource:   event,
      sendUpdates: 'all',
    });

    // Store event ID
    getDb().prepare('UPDATE bookings SET gcal_event_id = ? WHERE id = ?')
      .run(response.data.id, booking.id);
  } catch (err) {
    console.warn('[GCal createEvent]', err.message);
  }
}

/**
 * Delete a Google Calendar event when booking is cancelled.
 */
async function deleteEvent(cfg, gcalEventId) {
  if (!cfg.gcal_access_token || !google || !gcalEventId) return;
  try {
    const auth     = await getAuthedClient(cfg);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({
      calendarId: cfg.gcal_calendar_id || 'primary',
      eventId:    gcalEventId,
      sendUpdates: 'all',
    });
  } catch (err) {
    if (err.code !== 410) console.warn('[GCal deleteEvent]', err.message); // 410 = already deleted
  }
}

/**
 * Return busy time blocks from Google Calendar for a given date.
 * Used to block slots that overlap with existing calendar events.
 *
 * Returns one of:
 *   [{ allDay: true }]              — if an all-day event exists → block whole day
 *   [{ startMins, endMins }, ...]   — timed events (minutes from midnight in widget timezone)
 *   []                              — GCal not connected or no events
 */
async function getBusyTimes(cfg, dateStr) {
  if (!cfg.gcal_access_token || !google) return [];
  try {
    const auth     = await getAuthedClient(cfg);
    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch all events that touch the given date
    const resp = await calendar.events.list({
      calendarId:   cfg.gcal_calendar_id || 'primary',
      timeMin:      new Date(zonedToUtc(dateStr, '00:00', cfg.timezone) * 1000).toISOString(),
      timeMax:      new Date(zonedToUtc(dateStr, '23:59', cfg.timezone) * 1000 + 59000).toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
    });

    const items = (resp.data.items || []).filter(e => e.status !== 'cancelled');

    // All-day event → entire day is blocked
    if (items.some(e => e.start?.date && !e.start?.dateTime)) return [{ allDay: true }];

    // Timed events → convert to minutes-from-midnight in widget timezone
    return items
      .filter(e => e.start?.dateTime && e.end?.dateTime)
      .map(e => ({
        startMins: isoToMinsInTz(e.start.dateTime, cfg.timezone),
        endMins:   isoToMinsInTz(e.end.dateTime,   cfg.timezone),
      }));
  } catch (err) {
    console.warn('[GCal getBusyTimes]', err.message);
    return []; // fail gracefully — never break booking availability
  }
}

/** Convert ISO datetime string to minutes-from-midnight in a given IANA timezone. */
function isoToMinsInTz(isoStr, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(new Date(isoStr));
  const h = parseInt(parts.find(p => p.type === 'hour').value,   10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return (h % 24) * 60 + m;
}

module.exports = { getAuthUrl, verifyState, exchangeCode, createEvent, deleteEvent, getBusyTimes };
