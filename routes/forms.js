'use strict';
/**
 * Formuláre (/api/forms): správa v dashboarde (priestor tímu) a verejné vyplnenie (/api/forms/public/:token).
 * Verejná stránka: /form/:token (dá sa vložiť na web cez iframe).
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const forms = require('../services/forms');
const drive = require('../services/drive');
const { rateLimit } = require('../funnel/src/ratelimit');

const router = express.Router();
const MINUTE = 60 * 1000;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drive.DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 12)}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});
const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');

/* ── Verejné vyplnenie ──────────────────────────────────────── */

const publicLimit = rateLimit({ name: 'form-view-ip', max: 300, windowMs: 15 * MINUTE, key: req => req.ip });
const submitLimit = rateLimit({ name: 'form-submit-ip', max: 20, windowMs: 15 * MINUTE, key: req => req.ip });

function publicForm(req, res, next) {
  const f = forms.byToken(req.params.token);
  if (!f) return res.status(404).json({ error: 'Formulár neexistuje.' });
  req.form = f;
  next();
}

router.get('/public/:token', publicLimit, publicForm, (req, res) => {
  const f = req.form, s = f.settings;
  const owner = getDb().prepare('SELECT name FROM users WHERE id = ?').get(f.owner_id);
  res.json({ title: f.title, description: f.description, fields: f.fields, closed: f.status === 'closed', owner: owner?.name || '',
    settings: { layout: s.layout, theme: s.theme, color: s.color, submitLabel: s.submitLabel } });
});

const open = (req, res, next) => (req.form.status === 'closed' ? res.status(400).json({ error: 'Formulár už neprijíma odpovede.' }) : next());

router.post('/public/:token', submitLimit, publicForm, open, upload.any(), (req, res) => {
  const f = req.form;
  const files = req.files || [];
  // Pasca na roboty: skryté pole vyplní iba robot – tvárime sa, že sa podarilo
  if (req.body?._hp) { forms.unlink(files); return res.json({ ok: true, thankYou: f.settings.thankYou }); }
  let body = req.body || {};
  if (typeof body._json === 'string') { try { body = JSON.parse(body._json); } catch { body = {}; } }
  // Súbory len do polí typu „file“
  const fileFields = new Set(f.fields.filter(x => x.type === 'file').map(x => x.id));
  const bad = files.filter(x => !fileFields.has(x.fieldname));
  forms.unlink(bad);
  const good = files.filter(x => fileFields.has(x.fieldname));
  const pre = forms.validate(f, body, Object.fromEntries([...fileFields].map(id => [id, good.filter(x => x.fieldname === id).map(x => ({ id: '', name: x.originalname }))])));
  if (Object.keys(pre.errors).length) { forms.unlink(good); return res.status(400).json({ error: 'Skontrolujte vyznačené polia.', fields: pre.errors }); }
  const stored = {};
  if (good.length) {
    const folder = drive.systemFolder(f.owner_id, 'form-files', 'Odpovede z formulárov');
    const r = drive.storeFiles(f.owner_id, folder.id, good, `form:${f.id}`);
    if (r.error) return res.status(r.status || 400).json({ error: 'Súbor sa nepodarilo uložiť.' });
    r.items.forEach((it, i) => { (stored[good[i].fieldname] = stored[good[i].fieldname] || []).push({ id: it.id, name: it.name }); });
  }
  const v = forms.validate(f, body, stored);
  forms.submit(f, v);
  res.json({ ok: true, thankYou: f.settings.thankYou, redirect: f.settings.redirect || null });
});

/* ── Správa (dashboard) ─────────────────────────────────────── */

router.use(requireAuth, ws.middleware);
const W = ws.writer;
const count = id => getDb().prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM form_responses WHERE form_id = ?').get(id);
const view = f => {
  const c = count(f.id);
  return { id: f.id, title: f.title, description: f.description, fields: f.fields, settings: f.settings, status: f.status,
    url: `${appUrl()}/form/${f.token}`, responses: c.n, lastResponse: c.last, updatedAt: f.updated_at, createdAt: f.created_at };
};
function own(req, res, next) {
  const f = forms.get(req.ownerId, req.params.id);
  if (!f) return res.status(404).json({ error: 'Formulár nenájdený.' });
  req.form = f;
  next();
}

router.get('/types', (req, res) => res.json({ types: forms.TYPES, templates: Object.fromEntries(Object.entries(forms.TEMPLATES).map(([k, t]) => [k, t.title])) }));
router.get('/', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM forms WHERE owner_id = ? ORDER BY updated_at DESC').all(req.ownerId).map(r => view(forms.get(req.ownerId, r.id))));
});
router.post('/', W, (req, res) => res.json(view(forms.create(req.ownerId, req.body || {}, req.userId))));
router.get('/:id', own, (req, res) => res.json(view(req.form)));

router.patch('/:id', W, own, (req, res) => {
  const b = req.body || {}, f = req.form;
  const fields = b.fields !== undefined ? forms.cleanFields(b.fields) : f.fields;
  const settings = b.settings !== undefined ? forms.cleanSettings(b.settings, f.settings) : f.settings;
  getDb().prepare('UPDATE forms SET title = ?, description = ?, fields = ?, settings = ?, status = ?, updated_at = unixepoch() WHERE id = ?').run(
    b.title !== undefined ? String(b.title).trim().slice(0, 200) || f.title : f.title,
    b.description !== undefined ? String(b.description).slice(0, 2000) : f.description,
    JSON.stringify(fields), JSON.stringify(settings), ['open', 'closed'].includes(b.status) ? b.status : f.status, f.id);
  res.json(view(forms.get(req.ownerId, f.id)));
});

router.post('/:id/duplicate', W, own, (req, res) => {
  const copy = forms.create(req.ownerId, { title: `${req.form.title} (kópia)` }, req.userId);
  getDb().prepare('UPDATE forms SET description = ?, fields = ?, settings = ? WHERE id = ?').run(req.form.description, JSON.stringify(req.form.fields), JSON.stringify(req.form.settings), copy.id);
  res.json(view(forms.get(req.ownerId, copy.id)));
});

router.delete('/:id', W, own, (req, res) => { forms.remove(req.form); res.json({ ok: true }); });

router.get('/:id/responses', own, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM form_responses WHERE form_id = ? ORDER BY created_at DESC LIMIT 500').all(req.form.id);
  res.json(rows.map(r => ({ id: r.id, email: r.email, createdAt: r.created_at, data: JSON.parse(r.data || '{}') })));
});
router.get('/:id/stats', own, (req, res) => res.json(forms.stats(req.form)));
router.get('/:id/export.csv', own, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(req.form.title.replace(/[\\/:*?"<>|]/g, '_'))}.csv"`);
  res.send(forms.csv(req.form));
});
router.delete('/:id/responses/:rid', W, own, (req, res) => {
  getDb().prepare('DELETE FROM form_responses WHERE id = ? AND form_id = ?').run(req.params.rid, req.form.id);
  res.json({ ok: true });
});

module.exports = router;
