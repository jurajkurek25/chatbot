'use strict';
/** Grafika (/api/graphics): značka tímu, šablóny (vstavané + tímové), návrhy. Editor beží na /graphics/:id. */
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const ws = require('../services/workspace');
const g = require('../services/graphics');
const drive = require('../services/drive');

const router = express.Router();
// Návrhy s obrázkami bývajú väčšie ako bežné API telá (globálny limit 10 MB)
router.use(express.json({ limit: '20mb' }), requireAuth, ws.middleware);
const W = ws.writer;

router.get('/brand', (req, res) => res.json({ ...g.brand(req.ownerId), fontsAvailable: g.FONTS, sizes: g.SIZES }));
router.put('/brand', W, (req, res) => res.json(g.saveBrand(req.ownerId, req.body || {})));

router.get('/templates', (req, res) => res.json(g.templates(req.ownerId)));
router.get('/templates/:id', (req, res) => {
  const t = g.template(req.ownerId, req.params.id);
  if (!t) return res.status(404).json({ error: 'Šablóna nenájdená.' });
  res.json(t);
});
router.post('/templates', W, (req, res) => {
  const r = g.saveTemplate(req.ownerId, req.body || {}, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(g.template(req.ownerId, r.id));
});
router.delete('/templates/:id', W, (req, res) => {
  const t = g.template(req.ownerId, req.params.id);
  if (!t || t.builtin) return res.status(404).json({ error: 'Šablóna nenájdená.' });
  if (t.createdBy !== req.userId && req.role !== 'owner') return res.status(403).json({ error: 'Šablónu zmaže iba jej autor alebo majiteľ.' });
  getDb().prepare('DELETE FROM design_templates WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

router.get('/designs', (req, res) => {
  const rows = getDb().prepare(`SELECT d.* FROM designs d JOIN drive_items i ON i.id = d.drive_item_id
                                WHERE d.owner_id = ? AND i.trashed_at IS NULL ORDER BY d.updated_at DESC LIMIT 200`).all(req.ownerId);
  res.json(rows.map(g.designView));
});
router.post('/designs', W, (req, res) => {
  const r = g.createDesign(req.ownerId, req.body || {}, req.userId);
  if (r.error) return res.status(400).json(r);
  res.json(g.designView(r.design));
});

function own(req, res, next) {
  const d = g.liveDesign(req.ownerId, req.params.id);
  if (!d) return res.status(404).json({ error: 'Návrh nenájdený.' });
  req.design = d;
  next();
}
router.get('/designs/:id', own, (req, res) => {
  const item = drive.getItem(req.ownerId, req.design.drive_item_id);
  res.json({ ...g.designView(req.design), data: req.design.data, role: req.role, ownerId: req.ownerId, folderId: item?.parent_id || null, brand: g.brand(req.ownerId), fonts: g.FONTS });
});
router.patch('/designs/:id', W, own, (req, res) => {
  const r = g.updateDesign(req.ownerId, req.design, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(g.designView(r.design));
});
router.post('/designs/:id/duplicate', W, own, (req, res) => {
  const d = req.design;
  const r = g.createDesign(req.ownerId, { title: `${d.title} (kópia)`, width: d.width, height: d.height, data: d.data, thumb: d.thumb, templateId: d.template_id }, req.userId);
  res.json(g.designView(r.design));
});
router.delete('/designs/:id', W, own, (req, res) => {
  const item = drive.getItem(req.ownerId, req.design.drive_item_id);
  if (item) drive.trash(req.ownerId, item);
  res.json({ ok: true });
});

module.exports = router;
