'use strict';
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function getUserProgress(db, userId) {
  return db.prepare('SELECT * FROM user_progress WHERE user_id = ?').all(userId);
}

router.get('/modules', (req, res) => {
  const db = getDb();
  const modules = db.prepare('SELECT id, order_num, title, subtitle, pass_score FROM training_modules ORDER BY order_num').all();
  const progress = getUserProgress(db, req.userId);
  const progressMap = {};
  for (const p of progress) progressMap[p.module_id] = p;

  const result = modules.map((m, i) => {
    const prev = i > 0 ? modules[i - 1] : null;
    const prevProgress = prev ? progressMap[prev.id] : null;
    const unlocked = i === 0 || (prevProgress && prevProgress.passed);
    const myProgress = progressMap[m.id] || null;
    return {
      id: m.id,
      order_num: m.order_num,
      title: m.title,
      subtitle: m.subtitle,
      pass_score: m.pass_score,
      unlocked: Boolean(unlocked),
      passed: Boolean(myProgress?.passed),
      score: myProgress?.score ?? null,
      completed_at: myProgress?.completed_at ?? null,
    };
  });
  res.json(result);
});

router.get('/progress', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM training_modules').get().c;
  const progress = getUserProgress(db, req.userId);
  const completed = progress.filter(p => p.passed).length;
  const lastModule = db.prepare('SELECT id FROM training_modules ORDER BY order_num DESC LIMIT 1').get();
  const certified = lastModule ? Boolean(progress.find(p => p.module_id === lastModule.id && p.passed)) : false;
  res.json({ modules_completed: completed, total_modules: total, certified });
});

router.get('/modules/:id', (req, res) => {
  const db = getDb();
  const module = db.prepare('SELECT * FROM training_modules WHERE id = ?').get(req.params.id);
  if (!module) return res.status(404).json({ error: 'Modul nenájdený.' });

  // Unlock check
  const allModules = db.prepare('SELECT id, order_num FROM training_modules ORDER BY order_num').all();
  const idx = allModules.findIndex(m => m.id === req.params.id);
  if (idx > 0) {
    const prev = allModules[idx - 1];
    const prevProg = db.prepare('SELECT passed FROM user_progress WHERE user_id = ? AND module_id = ?').get(req.userId, prev.id);
    if (!prevProg?.passed) return res.status(403).json({ error: 'Najprv dokončite predchádzajúci modul.' });
  }

  const questions = db.prepare(
    'SELECT id, question, options FROM quiz_questions WHERE module_id = ? ORDER BY rowid'
  ).all(req.params.id).map(q => ({ ...q, options: JSON.parse(q.options) }));

  const myProgress = db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND module_id = ?').get(req.userId, req.params.id);

  res.json({
    id: module.id,
    order_num: module.order_num,
    title: module.title,
    subtitle: module.subtitle,
    content: module.content,
    pass_score: module.pass_score,
    questions,
    my_progress: myProgress || null,
  });
});

router.post('/modules/:id/submit', (req, res) => {
  const db = getDb();
  const module = db.prepare('SELECT * FROM training_modules WHERE id = ?').get(req.params.id);
  if (!module) return res.status(404).json({ error: 'Modul nenájdený.' });

  const { answers } = req.body;
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Odpovede musia byť pole.' });

  const questions = db.prepare('SELECT * FROM quiz_questions WHERE module_id = ? ORDER BY rowid').all(req.params.id);
  if (answers.length !== questions.length)
    return res.status(400).json({ error: `Očakáva sa ${questions.length} odpovedí.` });

  let correct = 0;
  const feedback = questions.map((q, i) => {
    const isCorrect = answers[i] === q.correct_index;
    if (isCorrect) correct++;
    return {
      question: q.question,
      your_answer: answers[i],
      correct_index: q.correct_index,
      is_correct: isCorrect,
      explanation: q.explanation,
      options: JSON.parse(q.options),
    };
  });

  const score = Math.round((correct / questions.length) * 100);
  const passed = score >= module.pass_score;
  const now = Math.floor(Date.now() / 1000);

  const existing = db.prepare('SELECT id FROM user_progress WHERE user_id = ? AND module_id = ?').get(req.userId, module.id);
  if (existing) {
    db.prepare('UPDATE user_progress SET score = ?, passed = ?, completed_at = ? WHERE user_id = ? AND module_id = ?')
      .run(score, passed ? 1 : 0, now, req.userId, module.id);
  } else {
    const { v4: uuidv4 } = require('uuid');
    db.prepare('INSERT INTO user_progress (id, user_id, module_id, score, passed, completed_at) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), req.userId, module.id, score, passed ? 1 : 0, now);
  }

  res.json({ score, passed, total: questions.length, correct, feedback });
});

module.exports = router;
