'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { streamTrainingQuestion, analyzeTrainingSession } = require('../services/claude');

const router = express.Router();

// GET /api/person/:widgetId — load Person profile for dashboard
router.get('/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
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

module.exports = router;
