'use strict';
/**
 * Paid bookings: a booking that needs payment is held as `pending_payment` while the
 * customer pays in Stripe Checkout, confirmed when paid, released when the checkout expires
 * or is abandoned, and refunded on cancellation according to the policy.
 */

const { getDb } = require('../db/database');
const payments = require('./payments');
const gcal = require('./gcal');
const notifyMod = require('./bookingNotify');

const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');
const ownerOf = widgetId => getDb().prepare('SELECT user_id FROM widgets WHERE id = ?').get(widgetId)?.user_id;
const notify = (kind, id, extra) => setImmediate(() => notifyMod.notify(kind, id, extra).catch(err => console.error('[booking notify]', err.message)));

/** Amount (in cents) to charge online for `service`, or 0 when no online payment applies. */
function amountFor(service, seats = 1) {
  if (!service || !service.payment_mode || service.payment_mode === 'none' || !(service.price > 0)) return 0;
  const total = service.price * Math.max(1, seats);
  const due = service.payment_mode === 'deposit' && service.deposit_amount > 0 ? Math.min(service.deposit_amount * Math.max(1, seats), total) : total;
  return payments.toCents(due);
}

/** Whether online payment can be taken for this widget's owner. */
const canCharge = widgetId => payments.isReady(payments.getMerchant(ownerOf(widgetId)));

async function startCheckout(booking, service) {
  const userId = ownerOf(booking.widget_id);
  const deposit = service.payment_mode === 'deposit' && booking.amount_due < payments.toCents(service.price * (booking.seats || 1));
  const session = await payments.createCheckout(userId, {
    kind: 'booking', ref: booking.id, amount: booking.amount_due, currency: booking.currency,
    name: `${deposit ? 'Záloha – ' : ''}${booking.service_name || 'Rezervácia'}`,
    description: `${booking.date} ${booking.start_time}–${booking.end_time}${booking.seats > 1 ? ` · ${booking.seats} osoby` : ''}`,
    customerEmail: booking.customer_email,
    successUrl: `${appUrl()}/booking/manage/${booking.manage_token}?paid={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl()}/api/booking/pay/cancel/${booking.manage_token}`,
  });
  getDb().prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(session.id, booking.id);
  return session.url;
}

/** Confirms a paid booking (idempotent — webhook and return URL may both call it). */
function markPaid(bookingId, session) {
  const db = getDb();
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b || b.payment_status === 'paid' || b.payment_status === 'refunded') return b;
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  // A payment arriving after the hold was released still confirms the booking: the customer paid.
  db.prepare(`UPDATE bookings SET status = CASE WHEN status IN ('pending_payment', 'expired') THEN 'confirmed' ELSE status END,
              payment_status = 'paid', amount_paid = ?, stripe_payment_intent = ? WHERE id = ?`)
    .run(session.amount_total ?? b.amount_due, pi || null, b.id);
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  if (updated.status === 'confirmed') {
    const cfg = db.prepare('SELECT timezone FROM booking_configs WHERE id = ?').get(updated.booking_config_id);
    const staff = updated.staff_id && db.prepare('SELECT * FROM booking_staff WHERE id = ?').get(updated.staff_id);
    if (staff) setImmediate(() => gcal.createEvent({ ...staff, timezone: cfg.timezone }, updated).catch(() => {}));
    notify('confirmed', updated.id);
  }
  return updated;
}

function release(bookingId) {
  getDb().prepare(`UPDATE bookings SET status = 'expired', payment_status = 'expired'
                   WHERE id = ? AND status = 'pending_payment'`).run(bookingId);
}

/** Return-URL fallback when webhooks are not configured: verify the session directly. */
async function syncFromStripe(booking) {
  if (booking.status !== 'pending_payment' || !booking.stripe_session_id) return booking;
  try {
    const s = await payments.retrieveSession(ownerOf(booking.widget_id), booking.stripe_session_id);
    if (s.payment_status === 'paid') return markPaid(booking.id, s);
    if (s.status === 'expired') release(booking.id);
  } catch (e) { console.warn('[booking pay sync]', e.message); }
  return getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
}

/**
 * Refunds what is still refundable. Business cancellations always refund in full;
 * customer cancellations follow the config's refund policy ('full' | 'none').
 */
async function refundOnCancel(booking, cfg, by) {
  const left = (booking.amount_paid || 0) - (booking.amount_refunded || 0);
  if (booking.payment_status !== 'paid' || left <= 0 || !booking.stripe_payment_intent) return 0;
  if (by === 'customer' && cfg.refund_policy !== 'full') return 0;
  try {
    await payments.refund(ownerOf(booking.widget_id), booking.stripe_payment_intent, left);
    getDb().prepare("UPDATE bookings SET amount_refunded = amount_refunded + ?, payment_status = 'refunded' WHERE id = ?").run(left, booking.id);
    return left;
  } catch (e) {
    console.error('[booking refund]', e.message);
    return 0;
  }
}

payments.register('booking', {
  paid: session => markPaid(session.metadata.ref, session),
  expired: session => release(session.metadata.ref),
  refunded: charge => {
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!pi) return;
    getDb().prepare(`UPDATE bookings SET amount_refunded = ?, payment_status = CASE WHEN ? >= amount_paid THEN 'refunded' ELSE 'partially_refunded' END
                     WHERE stripe_payment_intent = ?`).run(charge.amount_refunded, charge.amount_refunded, pi);
  },
});

/** Releases holds whose checkout was abandoned (Stripe sessions live at most 30–45 min). */
function expireStaleHolds() {
  getDb().prepare(`UPDATE bookings SET status = 'expired', payment_status = 'expired'
                   WHERE status = 'pending_payment' AND created_at < unixepoch() - 50 * 60`).run();
}

let timer = null;
function startHoldSweeper() {
  if (timer) return;
  timer = setInterval(() => { try { expireStaleHolds(); } catch (e) { console.error('[booking holds]', e.message); } }, 5 * 60 * 1000);
  timer.unref?.();
}

module.exports = { startHoldSweeper, amountFor, canCharge, startCheckout, markPaid, release, syncFromStripe, refundOnCancel, expireStaleHolds };
