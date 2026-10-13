'use strict';
/** Lístok na WebSocket (/ws, /yjs), ľudia v priestore a prepojenia medzi položkami modulov. */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const realtime = require('../services/realtime');
const workspace = require('../services/workspace');
const links = require('../services/links');

const router = express.Router();
router.use(requireAuth);

router.post('/ticket', (req, res) => res.json({ ticket: realtime.ticket(req.userId) }));

router.get('/workspaces', (req, res) => res.json(workspace.list(req.userId)));
router.get('/members', workspace.middleware, (req, res) => res.json(workspace.members(req.ownerId)));
router.get('/presence', workspace.middleware, (req, res) => res.json(realtime.presence(req.ownerId)));

const ref = (o) => ({ type: String(o?.type || ''), id: String(o?.id || '') });
router.get('/links', workspace.middleware, (req, res) => res.json(links.related(req.ownerId, String(req.query.type), String(req.query.id))));
router.post('/links', workspace.middleware, workspace.writer, (req, res) => {
  const r = links.link(req.ownerId, ref(req.body.a), ref(req.body.b), req.userId);
  if (r.error) return res.status(400).json(r);
  realtime.publish(req.ownerId, { type: 'links', items: [ref(req.body.a), ref(req.body.b)] });
  res.json(r);
});
router.delete('/links', workspace.middleware, workspace.writer, (req, res) => {
  links.unlink(req.ownerId, ref(req.body.a), ref(req.body.b));
  realtime.publish(req.ownerId, { type: 'links', items: [ref(req.body.a), ref(req.body.b)] });
  res.json({ ok: true });
});

module.exports = router;
