'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { streamAdvisorResponse } = require('../services/claude');

const router = express.Router();
router.use(requireAuth);

router.post('/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Správa je povinná.' });
  if (message.length > 2000) return res.status(400).json({ error: 'Správa je príliš dlhá.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    await streamAdvisorResponse(message.trim(), Array.isArray(history) ? history : [], res);
  } catch (err) {
    console.error('[advisor/chat]', err.message);
    res.write(`data: ${JSON.stringify({ error: true, text: 'Chyba AI. Skúste znova.' })}\n\n`);
    res.end();
  }
});

module.exports = router;
