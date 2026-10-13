'use strict';
/** Kalendár (/api/calendar): udalosti tímu + termíny úloh + rezervácie, ICS odber. */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const cal = require('../services/calendar');
const links = require('../services/links');

const router = express.Router();
const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');

// Verejný ICS odber (token v adrese, bez prihlásenia – kalendárové aplikácie nevedia hlavičky)
router.get('/ics/:token', (req, res) => {
  const body = cal.ics(String(req.params.token).replace(/\.ics$/, ''));
  if (!body) return res.status(404).send('Neznámy kalendár.');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(body);
});

router.use(requireAuth, ws.middleware);

router.get('/events', (req, res) => {
  const from = cal.parseTime(req.query.start);
  const to = cal.parseTime(req.query.end);
  if (!from || !to || to <= from || to - from > 400 * 86400) return res.status(400).json({ error: 'Neplatný rozsah.' });
  const only = req.query.only ? String(req.query.only).split(',') : null;
  res.json(cal.feed(req.ownerId, from, to, { userId: req.userId, only }));
});

router.post('/events', ws.writer, (req, res) => {
  const r = cal.createEvent(req.ownerId, req.body || {}, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(r.event);
});

function own(req, res, next) {
  const e = cal.getEvent(req.ownerId, req.params.id);
  if (!e) return res.status(404).json({ error: 'Udalosť nenájdená.' });
  req.event = e;
  next();
}
router.get('/events/:id', own, (req, res) => res.json({ ...cal.eventView(req.event), related: links.related(req.ownerId, 'event', req.event.id) }));
router.patch('/events/:id', ws.writer, own, (req, res) => {
  const r = cal.updateEvent(req.ownerId, req.event, req.body || {}, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(r.event);
});
router.delete('/events/:id', ws.writer, own, (req, res) => {
  cal.deleteEvent(req.ownerId, req.event);
  res.json({ ok: true });
});

router.get('/feed', (req, res) => res.json({ url: `${appUrl()}/api/calendar/ics/${cal.feedToken(req.userId)}.ics` }));

module.exports = router;
