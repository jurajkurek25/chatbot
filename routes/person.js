'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

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

module.exports = router;
