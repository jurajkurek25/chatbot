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

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI ||
  `${(process.env.APP_URL || 'https://neuradesk.online').replace(/\/$/, '')}/api/booking/gcal/callback`;

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

/* ── State token (signed, carries widgetId) ────────────────────── */
function getAuthUrl(widgetId) {
  const oauth2 = createClient();
  const state = Buffer.from(JSON.stringify({ widgetId, ts: Date.now() })).toString('base64url');
  return oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', state });
}

function verifyState(state) {
  try {
    const { widgetId, ts } = JSON.parse(Buffer.from(state, 'base64url').toString());
    if (Date.now() - ts > 10 * 60 * 1000) throw new Error('State expired');
    return widgetId;
  } catch {
    throw new Error('Invalid OAuth state');
  }
}

/* ── Token exchange & storage ──────────────────────────────────── */
async function exchangeCode(cfg, code) {
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
    UPDATE booking_configs SET
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
    cfg.id
  );
}

/* ── Get a live, refreshed OAuth2 client ──────────────────────── */
async function getAuthedClient(cfg) {
  if (!cfg.gcal_access_token) throw new Error('No GCal tokens for this widget');
  let tokens;
  try { tokens = JSON.parse(cfg.gcal_access_token); } catch { throw new Error('Invalid token JSON'); }

  const oauth2 = createClient(tokens);

  // Refresh if expired (with 60s buffer)
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 60_000) {
    const { credentials } = await oauth2.refreshAccessToken();
    getDb().prepare(`
      UPDATE booking_configs SET
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
 * @param {object} cfg     - booking_configs row
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
      summary:     `Rezervácia: ${booking.customer_name}`,
      description: booking.notes || '',
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

module.exports = { getAuthUrl, verifyState, exchangeCode, createEvent, deleteEvent };
