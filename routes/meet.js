'use strict';
/** Pripojenie k videohovoru (/api/meet/:room): iba pre členov priestoru, ku ktorému miestnosť patrí. */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const meet = require('../services/meet');

const router = express.Router();
router.get('/', requireAuth, (req, res) => res.json({ domain: meet.domain(), embed: !!process.env.JITSI_DOMAIN }));
router.get('/:room', requireAuth, (req, res) => {
  const j = meet.join(req.userId, req.params.room);
  if (!j) return res.status(404).json({ error: 'Videohovor nenájdený.' });
  res.json(j);
});

module.exports = router;
