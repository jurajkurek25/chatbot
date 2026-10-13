'use strict';
/** Úlohy (/api/tasks): projekty, kanban, úlohy, komentáre, štítky, prílohy z Disku, „Moje úlohy“. */
const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const tasks = require('../services/tasks');
const drive = require('../services/drive');
const links = require('../services/links');
const realtime = require('../services/realtime');

const router = express.Router();
router.use(requireAuth, ws.middleware);
const W = ws.writer;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drive.DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 12)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 10 },
});

const projectView = p => {
  const c = getDb().prepare('SELECT COUNT(*) AS total, SUM(done) AS done FROM tasks WHERE project_id = ? AND parent_id IS NULL').get(p.id);
  return { id: p.id, name: p.name, color: p.color, description: p.description, archived: !!p.archived, position: p.position, total: c.total || 0, done: c.done || 0 };
};
const bucketView = b => ({ id: b.id, name: b.name, position: b.position, isDone: !!b.is_done });
function ownProject(req, res, next) {
  const p = tasks.project(req.ownerId, req.params.id);
  if (!p) return res.status(404).json({ error: 'Projekt nenájdený.' });
  req.project = p;
  next();
}
function ownTask(req, res, next) {
  const t = tasks.getTask(req.ownerId, req.params.id);
  if (!t) return res.status(404).json({ error: 'Úloha nenájdená.' });
  req.task = t;
  next();
}
const projectChanged = (req, id) => realtime.publish(req.ownerId, { type: 'project', id });

/* ── Projekty ── */

router.get('/projects', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY archived, position').all(req.ownerId).map(projectView));
});
router.post('/projects', W, (req, res) => {
  const p = tasks.createProject(req.ownerId, req.body || {}, req.userId);
  projectChanged(req, p.id);
  res.json(projectView(p));
});
router.get('/projects/:id', ownProject, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position, created_at').all(req.project.id);
  res.json({ project: projectView(req.project), buckets: tasks.buckets(req.project.id).map(bucketView), tasks: rows.map(tasks.taskView) });
});
router.patch('/projects/:id', W, ownProject, (req, res) => {
  const b = req.body || {};
  const p = req.project;
  getDb().prepare('UPDATE projects SET name = ?, color = ?, description = ?, archived = ?, position = ? WHERE id = ?').run(
    b.name !== undefined ? String(b.name).trim().slice(0, 120) || p.name : p.name, /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : p.color,
    b.description !== undefined ? String(b.description).slice(0, 5000) : p.description, b.archived !== undefined ? (b.archived ? 1 : 0) : p.archived,
    b.position !== undefined ? Number(b.position) || 0 : p.position, p.id);
  projectChanged(req, p.id);
  res.json(projectView(tasks.project(req.ownerId, p.id)));
});
router.delete('/projects/:id', W, ownProject, (req, res) => {
  const db = getDb();
  db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(req.project.id).forEach(t => links.forget(req.ownerId, 'task', t.id));
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.project.id);
  projectChanged(req, req.project.id);
  res.json({ ok: true });
});

/* ── Stĺpce kanbanu ── */

router.post('/projects/:id/buckets', W, ownProject, (req, res) => {
  const pos = getDb().prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM task_buckets WHERE project_id = ?').get(req.project.id).n;
  const id = uuidv4();
  getDb().prepare('INSERT INTO task_buckets (id, project_id, name, position) VALUES (?, ?, ?, ?)').run(id, req.project.id, String(req.body?.name || 'Nový stĺpec').slice(0, 60), pos);
  projectChanged(req, req.project.id);
  res.json(bucketView(getDb().prepare('SELECT * FROM task_buckets WHERE id = ?').get(id)));
});
function ownBucket(req, res, next) {
  const b = getDb().prepare('SELECT b.* FROM task_buckets b JOIN projects p ON p.id = b.project_id WHERE b.id = ? AND p.owner_id = ?').get(req.params.id, req.ownerId);
  if (!b) return res.status(404).json({ error: 'Stĺpec nenájdený.' });
  req.bucket = b;
  next();
}
router.patch('/buckets/:id', W, ownBucket, (req, res) => {
  const db = getDb();
  const b = req.bucket;
  if (req.body?.isDone === true) db.prepare('UPDATE task_buckets SET is_done = 0 WHERE project_id = ?').run(b.project_id); // jeden stĺpec „hotovo“
  db.prepare('UPDATE task_buckets SET name = ?, position = ?, is_done = ? WHERE id = ?').run(
    req.body?.name !== undefined ? String(req.body.name).slice(0, 60) || b.name : b.name, req.body?.position !== undefined ? Number(req.body.position) || 0 : b.position,
    req.body?.isDone !== undefined ? (req.body.isDone ? 1 : 0) : b.is_done, b.id);
  projectChanged(req, b.project_id);
  res.json(bucketView(db.prepare('SELECT * FROM task_buckets WHERE id = ?').get(b.id)));
});
router.delete('/buckets/:id', W, ownBucket, (req, res) => {
  const db = getDb();
  const rest = tasks.buckets(req.bucket.project_id).filter(x => x.id !== req.bucket.id);
  if (!rest.length) return res.status(400).json({ error: 'Projekt musí mať aspoň jeden stĺpec.' });
  db.prepare('UPDATE tasks SET bucket_id = ? WHERE bucket_id = ?').run(rest[0].id, req.bucket.id);
  db.prepare('DELETE FROM task_buckets WHERE id = ?').run(req.bucket.id);
  projectChanged(req, req.bucket.project_id);
  res.json({ ok: true });
});

/* ── Úlohy ── */

router.post('/tasks', W, (req, res) => {
  const r = tasks.createTask(req.ownerId, req.body || {}, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(r.task);
});

router.get('/tasks/:id', ownTask, (req, res) => {
  const db = getDb();
  res.json({
    ...tasks.taskView(req.task),
    comments: db.prepare('SELECT c.*, u.name AS user_name FROM task_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.created_at').all(req.task.id),
    subtaskList: db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, created_at').all(req.task.id).map(tasks.taskView),
    related: links.related(req.ownerId, 'task', req.task.id),
  });
});

router.patch('/tasks/:id', W, ownTask, (req, res) => {
  const r = tasks.updateTask(req.ownerId, req.task, req.body || {}, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(r.task);
});

router.delete('/tasks/:id', W, ownTask, (req, res) => {
  tasks.deleteTask(req.ownerId, req.task);
  res.json({ ok: true });
});

router.post('/tasks/:id/comments', W, ownTask, (req, res) => {
  const r = tasks.addComment(req.ownerId, req.task, req.body?.body, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(r.comment);
});
router.delete('/comments/:cid', W, (req, res) => {
  const c = getDb().prepare('SELECT c.*, t.owner_id FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?').get(req.params.cid);
  if (!c || c.owner_id !== req.ownerId) return res.status(404).json({ error: 'Komentár nenájdený.' });
  if (c.user_id !== req.userId && req.role !== 'owner') return res.status(403).json({ error: 'Zmazať môžete iba svoj komentár.' });
  getDb().prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

/** Príloha: súbor sa uloží na Disk (Prílohy úloh) a prepojí s úlohou. */
router.post('/tasks/:id/files', W, ownTask, upload.array('files', 10), (req, res) => {
  const folder = drive.systemFolder(req.ownerId, 'task-files', 'Prílohy úloh');
  const r = drive.storeFiles(req.ownerId, folder.id, req.files, `user:${req.userId}`);
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  r.items.forEach(f => links.link(req.ownerId, { type: 'task', id: req.task.id }, { type: 'file', id: f.id }, req.userId));
  realtime.publish(req.ownerId, { type: 'task', projectId: req.task.project_id, id: req.task.id, action: 'files' });
  res.json(links.related(req.ownerId, 'task', req.task.id));
});

/* ── Štítky ── */

router.get('/labels', (req, res) => res.json(getDb().prepare('SELECT * FROM labels WHERE owner_id = ? ORDER BY name').all(req.ownerId)));
router.post('/labels', W, (req, res) => {
  const l = tasks.labelByName(req.ownerId, req.body?.name);
  if (!l) return res.status(400).json({ error: 'Zadajte názov štítka.' });
  if (/^#[0-9a-f]{6}$/i.test(req.body?.color || '')) getDb().prepare('UPDATE labels SET color = ? WHERE id = ?').run(req.body.color, l.id);
  res.json(getDb().prepare('SELECT * FROM labels WHERE id = ?').get(l.id));
});
router.delete('/labels/:lid', W, (req, res) => {
  getDb().prepare('DELETE FROM labels WHERE id = ? AND owner_id = ?').run(req.params.lid, req.ownerId);
  res.json({ ok: true });
});

/* ── Prehľady naprieč projektmi ── */

/** Moje otvorené úlohy (riešiteľ) a nadchádzajúce termíny v priestore. */
router.get('/overview', (req, res) => {
  const db = getDb();
  const days = Math.max(1, Math.min(60, Number(req.query.days) || 7));
  const mine = db.prepare(`SELECT t.* FROM tasks t JOIN task_assignees a ON a.task_id = t.id JOIN projects p ON p.id = t.project_id
                           WHERE t.owner_id = ? AND a.user_id = ? AND t.done = 0 AND p.archived = 0 ORDER BY t.due_at IS NULL, t.due_at, t.priority DESC LIMIT 200`).all(req.ownerId, req.userId);
  const upcoming = db.prepare(`SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.owner_id = ? AND t.done = 0 AND p.archived = 0
                               AND t.due_at IS NOT NULL AND t.due_at <= ? ORDER BY t.due_at LIMIT 200`).all(req.ownerId, Math.floor(Date.now() / 1000) + days * 86400);
  res.json({ mine: mine.map(tasks.taskView), upcoming: upcoming.map(tasks.taskView) });
});

/** Náhľad rýchleho zadania (čo sa z textu rozpozná). */
router.post('/parse', (req, res) => res.json(tasks.parseQuickAdd(req.ownerId, req.body?.text)));

module.exports = router;
