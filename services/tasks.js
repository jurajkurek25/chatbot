'use strict';
/**
 * Úlohy (podľa Vikunja): projekty so stĺpcami kanbanu, úlohy s riešiteľmi, štítkami, termínmi,
 * opakovaním, pripomienkou a podúlohami. Rýchle zadanie: „Zavolať Jane zajtra o 14:00 !3 #klient @eva“.
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { zonedToUtc, todayInTz, addDays, dayOfWeek } = require('./bookingCore');
const workspace = require('./workspace');
const realtime = require('./realtime');
const notifications = require('./notifications');
const links = require('./links');

const TZ = () => process.env.APP_TIMEZONE || 'Europe/Bratislava';
const now = () => Math.floor(Date.now() / 1000);
const DEFAULT_BUCKETS = [['Na spracovanie', 0], ['Robí sa', 0], ['Hotovo', 1]];

/* ── Projekty a stĺpce ───────────────────────────────────────── */

function createProject(ownerId, { name, color, description }, userId) {
  const db = getDb();
  const id = uuidv4();
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM projects WHERE owner_id = ?').get(ownerId).n;
  db.transaction(() => {
    db.prepare('INSERT INTO projects (id, owner_id, name, color, description, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, String(name || 'Nový projekt').trim().slice(0, 120), /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#5b4fff', String(description || '').slice(0, 5000), pos, userId);
    DEFAULT_BUCKETS.forEach(([n, done], i) => db.prepare('INSERT INTO task_buckets (id, project_id, name, position, is_done) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), id, n, i, done));
  })();
  return project(ownerId, id);
}

const project = (ownerId, id) => getDb().prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(id, ownerId);
const buckets = projectId => getDb().prepare('SELECT * FROM task_buckets WHERE project_id = ? ORDER BY position, rowid').all(projectId);
const firstOpenBucket = projectId => buckets(projectId).find(b => !b.is_done) || buckets(projectId)[0] || null;
const doneBucket = projectId => buckets(projectId).find(b => b.is_done) || null;

/** Projekt „Doručená pošta“ – sem idú úlohy bez projektu (z poznámok, chatu, formulárov). */
function inbox(ownerId, userId) {
  const p = getDb().prepare("SELECT * FROM projects WHERE owner_id = ? AND name = 'Doručené' ORDER BY created_at LIMIT 1").get(ownerId);
  return p || createProject(ownerId, { name: 'Doručené', color: '#64748b' }, userId);
}

/* ── Úlohy ───────────────────────────────────────────────────── */

function taskView(t) {
  const db = getDb();
  const sub = db.prepare('SELECT COUNT(*) AS total, SUM(done) AS done FROM tasks WHERE parent_id = ?').get(t.id);
  return {
    id: t.id, projectId: t.project_id, bucketId: t.bucket_id, parentId: t.parent_id, title: t.title, description: t.description,
    done: !!t.done, doneAt: t.done_at, dueAt: t.due_at, startAt: t.start_at, priority: t.priority, percent: t.percent, position: t.position,
    repeatDays: t.repeat_days, remindAt: t.remind_at, createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at,
    assignees: db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(t.id).map(r => r.user_id),
    labels: db.prepare('SELECT label_id FROM task_labels WHERE task_id = ?').all(t.id).map(r => r.label_id),
    comments: db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(t.id).n,
    subtasks: { total: sub.total || 0, done: sub.done || 0 },
    links: db.prepare('SELECT COUNT(*) AS n FROM item_links WHERE owner_id = ? AND ((a_type = \'task\' AND a_id = ?) OR (b_type = \'task\' AND b_id = ?))').get(t.owner_id, t.id, t.id).n,
  };
}
const getTask = (ownerId, id) => getDb().prepare('SELECT * FROM tasks WHERE id = ? AND owner_id = ?').get(id, ownerId);

function changed(ownerId, t, extra = {}) {
  realtime.publish(ownerId, { type: 'task', projectId: t.project_id, id: t.id, ...extra });
}

function setAssignees(ownerId, task, userIds, actorId) {
  const db = getDb();
  const valid = [...new Set(userIds || [])].filter(id => workspace.isMember(ownerId, id));
  const before = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id).map(r => r.user_id);
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(task.id);
  valid.forEach(u => db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(task.id, u));
  const added = valid.filter(u => !before.includes(u));
  if (added.length) {
    const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(actorId)?.name || 'Kolega';
    notifications.notify(added, { ownerId, type: 'task.assigned', title: `Nová úloha: ${task.title}`, body: `${actor} vám pridelil/a úlohu.`, url: `/dashboard?view=tasks&task=${task.id}&ws=${ownerId}`, email: true }, actorId);
  }
}

function setLabels(ownerId, taskId, labelIds) {
  const db = getDb();
  const mine = new Set(db.prepare('SELECT id FROM labels WHERE owner_id = ?').all(ownerId).map(r => r.id));
  db.prepare('DELETE FROM task_labels WHERE task_id = ?').run(taskId);
  [...new Set(labelIds || [])].filter(id => mine.has(id)).forEach(id => db.prepare('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)').run(taskId, id));
}

function labelByName(ownerId, name) {
  const db = getDb();
  const n = String(name).trim().toLowerCase().slice(0, 40);
  if (!n) return null;
  let l = db.prepare('SELECT * FROM labels WHERE owner_id = ? AND name = ?').get(ownerId, n);
  if (!l) {
    const palette = ['#9b8cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];
    const count = db.prepare('SELECT COUNT(*) AS n FROM labels WHERE owner_id = ?').get(ownerId).n;
    db.prepare('INSERT INTO labels (id, owner_id, name, color) VALUES (?, ?, ?, ?)').run(uuidv4(), ownerId, n, palette[count % palette.length]);
    l = db.prepare('SELECT * FROM labels WHERE owner_id = ? AND name = ?').get(ownerId, n);
  }
  return l;
}

/** Rýchle zadanie: !1-5 priorita, #štítok, @meno, dnes/zajtra/pozajtra/pondelok…/o týždeň/15.11.(2026), „o 14:00“. */
const strip = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const DAYS = ['nedela', 'pondelok', 'utorok', 'streda', 'stvrtok', 'piatok', 'sobota'];
function parseQuickAdd(ownerId, text) {
  let t = ` ${String(text || '')} `;
  const out = { priority: 0, labels: [], assignees: [], dueAt: null };
  t = t.replace(/\s!([1-5])(?=\s)/, (m, p) => { out.priority = Number(p); return ' '; });
  t = t.replace(/\s#([\p{L}\p{N}_-]{1,40})(?=\s)/gu, (m, l) => { out.labels.push(l); return ' '; });
  const members = workspace.members(ownerId);
  t = t.replace(/\s@([\p{L}\p{N}._-]{1,60})(?=\s)/gu, (m, who) => {
    const w = strip(who);
    const u = members.find(x => strip(x.name || '').split(/\s+/)[0] === w || strip(x.name || '').replace(/\s+/g, '') === w || strip(x.email || '').split('@')[0] === w);
    if (!u) return m;
    out.assignees.push(u.id);
    return ' ';
  });
  let date = null;
  let time = null;
  const today = todayInTz(TZ());
  t = t.replace(/\s(?:o|at)\s(\d{1,2})[:.](\d{2})(?=\s)/i, (m, h, mi) => { time = `${h.padStart(2, '0')}:${mi}`; return ' '; });
  const s = strip(t);
  const word = (re, fn) => { const m = s.match(re); if (m && !date) { date = fn(m); t = t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length); } };
  word(/\s(dnes)(?=\s)/, () => today);
  word(/\s(pozajtra)(?=\s)/, () => addDays(today, 2));
  word(/\s(zajtra)(?=\s)/, () => addDays(today, 1));
  word(/\s(o tyzden)(?=\s)/, () => addDays(today, 7));
  word(new RegExp(`\\s(?:v |vo |do )?(${DAYS.join('|')})(?=\\s)`), m => {
    const target = DAYS.indexOf(m[1]);
    const diff = (target - dayOfWeek(today) + 7) % 7 || 7;
    return addDays(today, diff);
  });
  word(/\s(?:do )?(\d{1,2})\.\s?(\d{1,2})\.(\d{4})?(?=\s)/, m => {
    const y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    let d = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!m[3] && d < today) d = `${y + 1}${d.slice(4)}`;
    return d;
  });
  if (date || time) out.dueAt = zonedToUtc(date || today, time || '17:00', TZ());
  out.title = t.replace(/\s+/g, ' ').trim();
  return out;
}

function createTask(ownerId, fields, userId) {
  const db = getDb();
  const p = project(ownerId, fields.projectId) || inbox(ownerId, userId);
  let parsed = { title: fields.title, priority: 0, labels: [], assignees: [], dueAt: null };
  if (fields.quick) parsed = parseQuickAdd(ownerId, fields.title);
  const title = String(parsed.title || '').trim().slice(0, 300);
  if (!title) return { error: 'Zadajte názov úlohy.' };
  const parent = fields.parentId ? getTask(ownerId, fields.parentId) : null;
  const bucket = fields.bucketId && buckets(p.id).find(b => b.id === fields.bucketId) || firstOpenBucket(p.id);
  const id = uuidv4();
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM tasks WHERE project_id = ? AND bucket_id IS ?').get(p.id, bucket?.id || null).n;
  db.prepare(`INSERT INTO tasks (id, owner_id, project_id, bucket_id, parent_id, title, description, due_at, priority, position, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ownerId, p.id, bucket?.id || null, parent?.id || null, title, String(fields.description || '').slice(0, 50000),
      fields.dueAt || parsed.dueAt || null, Math.max(0, Math.min(5, Number(fields.priority ?? parsed.priority) || 0)), pos, userId);
  const t = getTask(ownerId, id);
  setLabels(ownerId, id, [...(fields.labels || []), ...parsed.labels.map(n => labelByName(ownerId, n)?.id)]);
  setAssignees(ownerId, t, [...(fields.assignees || []), ...parsed.assignees], userId);
  changed(ownerId, t, { action: 'created' });
  return { task: taskView(getTask(ownerId, id)) };
}

/** Zmena polí úlohy; hotovo ↔ stĺpec „Hotovo“, opakovaná úloha sa po dokončení posunie na ďalší termín. */
function updateTask(ownerId, task, b, userId) {
  const db = getDb();
  const cols = new Map(); // stĺpec → hodnota (posledné nastavenie platí)
  const set = (col, v) => cols.set(col, v);
  if (b.title !== undefined) { const v = String(b.title).trim().slice(0, 300); if (!v) return { error: 'Zadajte názov úlohy.' }; set('title', v); }
  if (b.description !== undefined) set('description', String(b.description).slice(0, 50000));
  if (b.dueAt !== undefined) { set('due_at', b.dueAt || null); set('reminded', 0); }
  if (b.startAt !== undefined) set('start_at', b.startAt || null);
  if (b.priority !== undefined) set('priority', Math.max(0, Math.min(5, Number(b.priority) || 0)));
  if (b.percent !== undefined) set('percent', Math.max(0, Math.min(100, Number(b.percent) || 0)));
  if (b.repeatDays !== undefined) set('repeat_days', Math.max(0, Math.min(3650, Number(b.repeatDays) || 0)));
  if (b.remindAt !== undefined) { set('remind_at', b.remindAt || null); set('reminded', 0); }
  if (b.projectId !== undefined && b.projectId !== task.project_id) {
    const p = project(ownerId, b.projectId);
    if (!p) return { error: 'Projekt neexistuje.' };
    set('project_id', p.id);
    set('bucket_id', (task.done ? doneBucket(p.id) : null)?.id || firstOpenBucket(p.id)?.id || null);
  }
  if (b.bucketId !== undefined && b.projectId === undefined) {
    const bucket = buckets(task.project_id).find(x => x.id === b.bucketId);
    if (!bucket) return { error: 'Stĺpec neexistuje.' };
    set('bucket_id', bucket.id);
    if (bucket.is_done !== task.done && b.done === undefined) b.done = !!bucket.is_done;
  }
  if (b.position !== undefined) set('position', Number(b.position) || 0);
  let repeated = false;
  if (b.done !== undefined && !!b.done !== !!task.done) {
    if (b.done && task.repeat_days > 0) {
      // Opakovaná úloha: zostane otvorená s posunutým termínom
      let due = task.due_at || now();
      do due += task.repeat_days * 86400; while (due < now());
      set('due_at', due);
      set('reminded', 0);
      if (task.remind_at) set('remind_at', task.remind_at + (due - (task.due_at || due)));
      repeated = due;
      set('bucket_id', firstOpenBucket(task.project_id)?.id || task.bucket_id);
    } else {
      set('done', b.done ? 1 : 0);
      set('done_at', b.done ? now() : null);
      if (b.bucketId === undefined) set('bucket_id', (b.done ? doneBucket(task.project_id) : firstOpenBucket(task.project_id))?.id || task.bucket_id);
    }
  }
  if (cols.size) {
    set('updated_at', now());
    db.prepare(`UPDATE tasks SET ${[...cols.keys()].map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.values(), task.id);
  }
  if (repeated) addComment(ownerId, task, `↻ Opakovaná úloha – ďalší termín ${new Date(repeated * 1000).toLocaleDateString('sk-SK')}`, null);
  if (b.labels !== undefined) setLabels(ownerId, task.id, b.labels);
  if (b.assignees !== undefined) setAssignees(ownerId, getTask(ownerId, task.id), b.assignees, userId);
  const t = getTask(ownerId, task.id);
  changed(ownerId, t, { action: 'updated' });
  return { task: taskView(t) };
}

function deleteTask(ownerId, task) {
  const db = getDb();
  const ids = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT x.id FROM tasks x JOIN t ON x.parent_id = t.id) SELECT id FROM t`).all(task.id).map(r => r.id);
  db.transaction(() => ids.forEach(id => { links.forget(ownerId, 'task', id); db.prepare('DELETE FROM tasks WHERE id = ?').run(id); }))();
  changed(ownerId, task, { action: 'deleted' });
}

function addComment(ownerId, task, body, userId) {
  const db = getDb();
  const text = String(body || '').trim().slice(0, 10000);
  if (!text) return { error: 'Prázdny komentár.' };
  const id = uuidv4();
  db.prepare('INSERT INTO task_comments (id, task_id, user_id, body) VALUES (?, ?, ?, ?)').run(id, task.id, userId, text);
  if (userId) {
    const people = new Set([task.created_by, ...db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id).map(r => r.user_id)]);
    const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name || 'Kolega';
    notifications.notify([...people], { ownerId, type: 'task.comment', title: `${actor} komentoval/a: ${task.title}`, body: text.slice(0, 300), url: `/dashboard?view=tasks&task=${task.id}&ws=${ownerId}` }, userId);
  }
  changed(ownerId, task, { action: 'comment' });
  return { comment: db.prepare('SELECT * FROM task_comments WHERE id = ?').get(id) };
}

/* ── Pripomienky (plánovač) ──────────────────────────────────── */

function remindDue() {
  const db = getDb();
  const due = db.prepare('SELECT * FROM tasks WHERE done = 0 AND reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ? LIMIT 200').all(now());
  for (const t of due) {
    db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(t.id);
    const people = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(t.id).map(r => r.user_id);
    const when = t.due_at ? ` (termín ${new Date(t.due_at * 1000).toLocaleString('sk-SK', { timeZone: TZ(), dateStyle: 'medium', timeStyle: 'short' })})` : '';
    notifications.notify(people.length ? people : [t.created_by], { ownerId: t.owner_id, type: 'task.reminder', title: `Pripomienka: ${t.title}`, body: `Úloha čaká na dokončenie${when}.`, url: `/dashboard?view=tasks&task=${t.id}&ws=${t.owner_id}`, email: true });
  }
  return due.length;
}

function startScheduler() {
  const run = () => { try { remindDue(); } catch (e) { console.error('[tasks]', e.message); } };
  setInterval(run, 60 * 1000).unref();
}

links.registerType('task', {
  label: 'Úloha', icon: '✅',
  resolve(ownerId, id) {
    const t = getTask(ownerId, id);
    return t ? { title: t.title, url: `/dashboard?view=tasks&task=${id}&ws=${ownerId}`, done: !!t.done } : null;
  },
});

module.exports = {
  TZ, createProject, project, buckets, inbox, taskView, getTask, createTask, updateTask, deleteTask, addComment,
  setLabels, labelByName, parseQuickAdd, remindDue, startScheduler,
};
