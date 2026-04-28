'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { streamTrainingQuestion, analyzeTrainingSession, analyzeIngestedContent } = require('../services/claude');
const { isYouTubeUrl, extractYouTubeTranscript, extractArticleText, extractPdfText } = require('../services/extractor');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = express.Router();

function requirePersonAddon(db, userId, res) {
  const user = db.prepare('SELECT person_addon_active FROM users WHERE id = ?').get(userId);
  if (!user?.person_addon_active) {
    res.status(403).json({ error: 'Person add-on nie je aktívny.', upsell: true });
    return false;
  }
  return true;
}

// GET /api/person/:widgetId — load Person profile for dashboard
router.get('/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const profile = db.prepare('SELECT * FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);
  res.json(profile || {
    widget_id: req.params.widgetId,
    person_name: '',
    person_intro: '',
    how_i_think: '',
    my_style: '',
    know_how: '',
    real_answers: '',
    never_say: '',
    active: 0,
  });
});

// POST /api/person/:widgetId — save Person profile
router.post('/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const {
    person_name = '',
    person_intro = '',
    how_i_think = '',
    my_style = '',
    know_how = '',
    real_answers = '',
    never_say = '',
    active = 0,
  } = req.body;

  const existing = db.prepare('SELECT id FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);
  if (existing) {
    db.prepare(`
      UPDATE person_profiles
      SET person_name=?, person_intro=?, how_i_think=?, my_style=?, know_how=?, real_answers=?, never_say=?, active=?
      WHERE widget_id=?
    `).run(person_name, person_intro, how_i_think, my_style, know_how, real_answers, never_say, active ? 1 : 0, req.params.widgetId);
  } else {
    db.prepare(`
      INSERT INTO person_profiles (id, widget_id, person_name, person_intro, how_i_think, my_style, know_how, real_answers, never_say, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), req.params.widgetId, person_name, person_intro, how_i_think, my_style, know_how, real_answers, never_say, active ? 1 : 0);
  }

  res.json({ ok: true });
});

// POST /api/person/:widgetId/training/question — AI plays customer, streams next question (SSE)
router.post('/:widgetId/training/question', requireAuth, async (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { history = [] } = req.body;

  if (!Array.isArray(history) || history.length > 200) {
    return res.status(400).json({ error: 'Neplatná história.' });
  }

  const personProfile = db.prepare('SELECT * FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    await streamTrainingQuestion(widget, personProfile, history, res);
  } catch (err) {
    console.error('[training/question]', err.message);
    res.write(`data: ${JSON.stringify({ error: true })}\n\n`);
    res.end();
  }
});

// POST /api/person/:widgetId/training/analyze — analyze full session, extract style DNA
router.post('/:widgetId/training/analyze', requireAuth, async (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { history = [] } = req.body;
  const trainerTurns = history.filter(h => h.role === 'trainer').length;

  if (trainerTurns < 3) {
    return res.status(400).json({ error: 'Príliš krátky tréning. Odpovedajte aspoň na 3 otázky.' });
  }

  try {
    const profile = await analyzeTrainingSession(widget, history);
    res.json(profile);
  } catch (err) {
    console.error('[training/analyze]', err.message);
    res.status(500).json({ error: 'Chyba pri analýze.' });
  }
});

// POST /api/person/:widgetId/ingest/url — extract from YouTube or article URL
router.post('/:widgetId/ingest/url', requireAuth, async (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Chýba URL.' });

  let extracted;
  try {
    extracted = isYouTubeUrl(url)
      ? await extractYouTubeTranscript(url)
      : await extractArticleText(url);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const currentProfile = db.prepare('SELECT * FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);

  try {
    const suggestions = await analyzeIngestedContent(extracted.title, extracted.text, currentProfile);
    res.json({ ok: true, source_title: extracted.title, ...suggestions });
  } catch (err) {
    console.error('[ingest/url]', err.message);
    res.status(500).json({ error: 'Chyba pri analýze obsahu.' });
  }
});

// POST /api/person/:widgetId/ingest/pdf — extract from uploaded PDF
router.post('/:widgetId/ingest/pdf', requireAuth, upload.single('file'), async (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  if (!req.file) return res.status(400).json({ error: 'Chýba PDF súbor.' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Súbor musí byť PDF.' });

  let extracted;
  try {
    extracted = await extractPdfText(req.file.buffer);
    if (req.file.originalname) extracted.title = req.file.originalname.replace(/\.pdf$/i, '');
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const currentProfile = db.prepare('SELECT * FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);

  try {
    const suggestions = await analyzeIngestedContent(extracted.title, extracted.text, currentProfile);
    res.json({ ok: true, source_title: extracted.title, ...suggestions });
  } catch (err) {
    console.error('[ingest/pdf]', err.message);
    res.status(500).json({ error: 'Chyba pri analýze obsahu.' });
  }
});

// GET /api/person/:widgetId/email-config — load email channel settings
router.get('/:widgetId/email-config', requireAuth, (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const profile = db.prepare('SELECT email_channel_active, email_address, email_webhook_secret FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);
  res.json({
    email_channel_active: profile?.email_channel_active || 0,
    email_address: profile?.email_address || '',
    email_webhook_secret: profile?.email_webhook_secret || '',
  });
});

// POST /api/person/:widgetId/email-config — save email channel settings
router.post('/:widgetId/email-config', requireAuth, (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { email_channel_active = 0, email_address = '' } = req.body;

  const existing = db.prepare('SELECT id, email_webhook_secret FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);
  const secret = existing?.email_webhook_secret || uuidv4();

  if (existing) {
    db.prepare('UPDATE person_profiles SET email_channel_active = ?, email_address = ?, email_webhook_secret = COALESCE(email_webhook_secret, ?) WHERE widget_id = ?')
      .run(email_channel_active ? 1 : 0, email_address.trim(), secret, req.params.widgetId);
  } else {
    db.prepare('INSERT INTO person_profiles (id, widget_id, email_channel_active, email_address, email_webhook_secret) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), req.params.widgetId, email_channel_active ? 1 : 0, email_address.trim(), secret);
  }

  const updated = db.prepare('SELECT email_channel_active, email_address, email_webhook_secret FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);
  res.json({ ok: true, ...updated });
});

// POST /api/person/:widgetId/email-config/regenerate-secret — new webhook secret
router.post('/:widgetId/email-config/regenerate-secret', requireAuth, (req, res) => {
  const db = getDb();
  if (!requirePersonAddon(db, req.userId, res)) return;
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(req.params.widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const newSecret = uuidv4();
  const existing = db.prepare('SELECT id FROM person_profiles WHERE widget_id = ?').get(req.params.widgetId);
  if (existing) {
    db.prepare('UPDATE person_profiles SET email_webhook_secret = ? WHERE widget_id = ?').run(newSecret, req.params.widgetId);
  } else {
    db.prepare('INSERT INTO person_profiles (id, widget_id, email_webhook_secret) VALUES (?, ?, ?)').run(uuidv4(), req.params.widgetId, newSecret);
  }
  res.json({ ok: true, email_webhook_secret: newSecret });
});

module.exports = router;
