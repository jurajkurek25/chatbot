'use strict';
/**
 * Grafika zo šablón (podľa Aktivisda): tím si nastaví značku (farby, písma, logá), majiteľ/editor pripraví
 * šablóny so zamknutými vrstvami a ostatní ich len vyplnia a exportujú. Návrh = fabric.js JSON, na Disku je položka s odkazom.
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const drive = require('./drive');
const realtime = require('./realtime');
const links = require('./links');

const MIME = 'application/vnd.neoworkly.design';
const openUrl = (ownerId, id) => `/graphics/${id}?ws=${ownerId}`;
const FONTS = ['Inter', 'Montserrat', 'Playfair Display', 'Bebas Neue', 'Caveat', 'Georgia', 'Arial'];
const DEFAULT_BRAND = {
  colors: { primary: '#5b4fff', secondary: '#0d0d18', accent: '#f59e0b', text: '#111827', background: '#ffffff' },
  fonts: { heading: 'Montserrat', body: 'Inter' },
  logos: [],
};
const MAX_DATA = 15 * 1024 * 1024; // návrh s vloženými obrázkami (dataURL)
const MAX_LOGO = 600 * 1024;

const SIZES = {
  'ig-post': { label: 'Instagram príspevok', width: 1080, height: 1080 },
  'ig-story': { label: 'Instagram / FB story', width: 1080, height: 1920 },
  'fb-post': { label: 'Facebook / LinkedIn príspevok', width: 1200, height: 630 },
  'yt-thumb': { label: 'YouTube miniatúra', width: 1280, height: 720 },
  'a4': { label: 'Plagát A4', width: 1240, height: 1754 },
  'banner': { label: 'Banner na web', width: 1600, height: 500 },
};

/**
 * Vstavané šablóny v jednoduchom formáte vrstiev (editor ich prevedie na objekty fabric.js):
 * farby 'brand.primary' … sa doplnia zo značky, písmo 'heading' / 'body' tiež; locked = vrstva značky.
 */
const BUILTIN = {
  quote: { title: 'Citát', size: 'ig-post', layers: [
    { type: 'rect', x: 0, y: 0, w: 1080, h: 1080, fill: 'brand.primary', locked: true, name: 'Pozadie' },
    { type: 'text', x: 110, y: 120, w: 860, text: '„', font: 'heading', size: 260, weight: 800, color: 'brand.accent', locked: true, name: 'Úvodzovky' },
    { type: 'text', x: 110, y: 330, w: 860, text: 'Najlepší čas začať bol včera. Druhý najlepší je dnes.', font: 'heading', size: 72, weight: 800, color: '#ffffff', lineHeight: 1.15, name: 'Citát' },
    { type: 'text', x: 110, y: 800, w: 860, text: '— Meno autora', font: 'body', size: 40, color: '#ffffff', name: 'Autor' },
    { type: 'logo', x: 830, y: 930, w: 160, h: 80, name: 'Logo' },
  ] },
  sale: { title: 'Akcia / zľava', size: 'ig-post', layers: [
    { type: 'rect', x: 0, y: 0, w: 1080, h: 1080, fill: 'brand.background', locked: true, name: 'Pozadie' },
    { type: 'circle', x: 540, y: 470, r: 330, fill: 'brand.accent', name: 'Kruh' },
    { type: 'text', x: 140, y: 300, w: 800, text: '−30 %', font: 'heading', size: 230, weight: 800, color: 'brand.secondary', align: 'center', name: 'Zľava' },
    { type: 'text', x: 140, y: 560, w: 800, text: 'na celý sortiment', font: 'body', size: 52, color: 'brand.secondary', align: 'center', name: 'Podnadpis' },
    { type: 'rect', x: 290, y: 880, w: 500, h: 110, fill: 'brand.primary', rx: 55, name: 'Tlačidlo' },
    { type: 'text', x: 290, y: 905, w: 500, text: 'Do nedele', font: 'heading', size: 50, weight: 800, color: '#ffffff', align: 'center', name: 'Text tlačidla' },
    { type: 'logo', x: 60, y: 50, w: 180, h: 90, name: 'Logo' },
  ] },
  story: { title: 'Oznam (story)', size: 'ig-story', layers: [
    { type: 'rect', x: 0, y: 0, w: 1080, h: 1920, fill: 'brand.secondary', locked: true, name: 'Pozadie' },
    { type: 'image', x: 0, y: 0, w: 1080, h: 900, name: 'Fotka' },
    { type: 'rect', x: 80, y: 980, w: 360, h: 90, fill: 'brand.accent', rx: 45, name: 'Štítok' },
    { type: 'text', x: 80, y: 1000, w: 360, text: 'NOVINKA', font: 'heading', size: 44, weight: 800, color: 'brand.secondary', align: 'center', name: 'Text štítka' },
    { type: 'text', x: 80, y: 1130, w: 920, text: 'Otvárame novú pobočku', font: 'heading', size: 110, weight: 800, color: '#ffffff', lineHeight: 1.05, name: 'Nadpis' },
    { type: 'text', x: 80, y: 1480, w: 920, text: 'Príďte sa pozrieť v sobotu od 10:00. Čaká vás káva a darček.', font: 'body', size: 48, color: '#d1d5db', lineHeight: 1.3, name: 'Text' },
    { type: 'logo', x: 80, y: 1760, w: 200, h: 100, name: 'Logo' },
  ] },
  news: { title: 'Novinka na sociálne siete', size: 'fb-post', layers: [
    { type: 'rect', x: 0, y: 0, w: 1200, h: 630, fill: 'brand.background', locked: true, name: 'Pozadie' },
    { type: 'rect', x: 0, y: 0, w: 480, h: 630, fill: 'brand.primary', locked: true, name: 'Farebný pás' },
    { type: 'image', x: 40, y: 40, w: 400, h: 550, name: 'Fotka' },
    { type: 'text', x: 530, y: 120, w: 610, text: 'Spúšťame nový online kurz', font: 'heading', size: 64, weight: 800, color: 'brand.text', lineHeight: 1.1, name: 'Nadpis' },
    { type: 'text', x: 530, y: 360, w: 610, text: 'Krátky popis, prečo by to človeka malo zaujímať.', font: 'body', size: 32, color: 'brand.text', lineHeight: 1.35, name: 'Text' },
    { type: 'logo', x: 530, y: 520, w: 160, h: 70, name: 'Logo' },
  ] },
  youtube: { title: 'YouTube miniatúra', size: 'yt-thumb', layers: [
    { type: 'image', x: 0, y: 0, w: 1280, h: 720, name: 'Fotka v pozadí' },
    { type: 'rect', x: 0, y: 430, w: 1280, h: 290, fill: 'brand.secondary', opacity: 0.85, name: 'Pás' },
    { type: 'text', x: 60, y: 460, w: 1160, text: '5 CHÝB, KTORÉ VÁS STOJA ZÁKAZNÍKOV', font: 'Bebas Neue', size: 120, color: '#ffffff', lineHeight: 0.95, name: 'Nadpis' },
    { type: 'rect', x: 60, y: 400, w: 220, h: 16, fill: 'brand.accent', locked: true, name: 'Akcent' },
  ] },
  poster: { title: 'Pozvánka na podujatie', size: 'a4', layers: [
    { type: 'rect', x: 0, y: 0, w: 1240, h: 1754, fill: 'brand.background', locked: true, name: 'Pozadie' },
    { type: 'rect', x: 0, y: 0, w: 1240, h: 760, fill: 'brand.primary', locked: true, name: 'Horná časť' },
    { type: 'text', x: 100, y: 160, w: 1040, text: 'POZÝVAME VÁS', font: 'body', size: 46, weight: 700, color: 'brand.accent', name: 'Nad nadpisom' },
    { type: 'text', x: 100, y: 250, w: 1040, text: 'Letný workshop pre podnikateľky', font: 'heading', size: 110, weight: 800, color: '#ffffff', lineHeight: 1.05, name: 'Nadpis' },
    { type: 'text', x: 100, y: 860, w: 1040, text: '📅 Sobota 14. júna, 10:00 – 15:00\n📍 Kaviareň Pod Hradom, Bratislava', font: 'body', size: 50, color: 'brand.text', lineHeight: 1.5, name: 'Kedy a kde' },
    { type: 'text', x: 100, y: 1110, w: 1040, text: 'Praktické tipy, networking a obed v cene. Počet miest je obmedzený.', font: 'body', size: 42, color: 'brand.text', lineHeight: 1.4, name: 'Popis' },
    { type: 'rect', x: 100, y: 1400, w: 620, h: 130, fill: 'brand.accent', rx: 20, name: 'Tlačidlo' },
    { type: 'text', x: 100, y: 1435, w: 620, text: 'Prihláška: mojweb.sk', font: 'heading', size: 50, weight: 800, color: 'brand.secondary', align: 'center', name: 'Text tlačidla' },
    { type: 'logo', x: 900, y: 1560, w: 240, h: 120, name: 'Logo' },
  ] },
  webinar: { title: 'Banner na webinár', size: 'banner', layers: [
    { type: 'rect', x: 0, y: 0, w: 1600, h: 500, fill: 'brand.secondary', locked: true, name: 'Pozadie' },
    { type: 'circle', x: 1420, y: 80, r: 260, fill: 'brand.primary', opacity: 0.7, name: 'Kruh' },
    { type: 'text', x: 90, y: 90, w: 1100, text: 'BEZPLATNÝ WEBINÁR', font: 'body', size: 36, weight: 700, color: 'brand.accent', name: 'Nad nadpisom' },
    { type: 'text', x: 90, y: 150, w: 1100, text: 'Ako získať prvých 100 zákazníkov', font: 'heading', size: 80, weight: 800, color: '#ffffff', lineHeight: 1.05, name: 'Nadpis' },
    { type: 'text', x: 90, y: 380, w: 1100, text: 'Štvrtok 19:00 · online', font: 'body', size: 36, color: '#d1d5db', name: 'Kedy' },
    { type: 'logo', x: 1300, y: 380, w: 220, h: 80, name: 'Logo' },
  ] },
};

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const hex = c => /^#[0-9a-f]{6}$/i.test(c || '');

function brand(ownerId) {
  const r = getDb().prepare('SELECT * FROM brand_kits WHERE owner_id = ?').get(ownerId);
  if (!r) return JSON.parse(JSON.stringify(DEFAULT_BRAND));
  return { colors: { ...DEFAULT_BRAND.colors, ...parse(r.colors, {}) }, fonts: { ...DEFAULT_BRAND.fonts, ...parse(r.fonts, {}) }, logos: parse(r.logos, []) };
}

function saveBrand(ownerId, b) {
  const cur = brand(ownerId);
  const colors = { ...cur.colors };
  for (const k of Object.keys(DEFAULT_BRAND.colors)) if (hex(b?.colors?.[k])) colors[k] = b.colors[k].toLowerCase();
  const fonts = { ...cur.fonts };
  for (const k of ['heading', 'body']) if (FONTS.includes(b?.fonts?.[k])) fonts[k] = b.fonts[k];
  let logos = cur.logos;
  if (Array.isArray(b?.logos)) {
    logos = b.logos.slice(0, 6).filter(l => /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(l?.dataURL || '') && l.dataURL.length <= MAX_LOGO * 1.37)
      .map(l => ({ id: String(l.id || uuidv4()).slice(0, 40), name: String(l.name || 'Logo').slice(0, 80), dataURL: l.dataURL }));
  }
  getDb().prepare(`INSERT INTO brand_kits (owner_id, colors, fonts, logos) VALUES (?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET colors = excluded.colors, fonts = excluded.fonts, logos = excluded.logos, updated_at = unixepoch()`)
    .run(ownerId, JSON.stringify(colors), JSON.stringify(fonts), JSON.stringify(logos));
  realtime.publish(ownerId, { type: 'design', brand: true });
  return brand(ownerId);
}

/* ── Šablóny ── */

function templates(ownerId) {
  const builtin = Object.entries(BUILTIN).map(([k, t]) => ({ id: `builtin:${k}`, title: t.title, category: SIZES[t.size].label, size: t.size, width: SIZES[t.size].width, height: SIZES[t.size].height, layers: t.layers, builtin: true }));
  const team = getDb().prepare('SELECT id, title, category, width, height, thumb, created_by, created_at FROM design_templates WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId)
    .map(t => ({ id: t.id, title: t.title, category: t.category, width: t.width, height: t.height, thumb: t.thumb, createdBy: t.created_by, team: true }));
  return [...team, ...builtin];
}

function template(ownerId, id) {
  if (String(id).startsWith('builtin:')) {
    const t = BUILTIN[String(id).slice(8)];
    return t ? { id, title: t.title, width: SIZES[t.size].width, height: SIZES[t.size].height, layers: t.layers, builtin: true } : null;
  }
  const t = getDb().prepare('SELECT * FROM design_templates WHERE id = ? AND owner_id = ?').get(id, ownerId);
  return t ? { id: t.id, title: t.title, width: t.width, height: t.height, data: t.data, team: true, createdBy: t.created_by } : null;
}

const dims = (w, h) => [Math.max(50, Math.min(5000, Math.round(Number(w) || 0))), Math.max(50, Math.min(5000, Math.round(Number(h) || 0)))];
const thumbOk = t => (typeof t === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(t) && t.length < 400000 ? t : '');

function saveTemplate(ownerId, b, userId) {
  const data = String(b?.data || '');
  if (!data || data.length > MAX_DATA) return { error: 'Šablóna je prázdna alebo príliš veľká.' };
  const [width, height] = dims(b.width, b.height);
  const id = uuidv4();
  getDb().prepare('INSERT INTO design_templates (id, owner_id, title, category, width, height, data, thumb, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ownerId, String(b.title || 'Šablóna').slice(0, 120), String(b.category || 'Tím').slice(0, 60), width, height, data, thumbOk(b.thumb), userId);
  realtime.publish(ownerId, { type: 'design', template: id });
  return { id };
}

/* ── Návrhy ── */

const getDesign = (ownerId, id) => getDb().prepare('SELECT * FROM designs WHERE id = ? AND owner_id = ?').get(id, ownerId);
function liveDesign(ownerId, id) {
  const d = getDesign(ownerId, id);
  const item = d && d.drive_item_id && drive.getItem(ownerId, d.drive_item_id);
  return item && !item.trashed_at ? d : null;
}

function createDesign(ownerId, b, userId) {
  const [width, height] = dims(b.width, b.height);
  const data = String(b.data || '');
  if (data.length > MAX_DATA) return { error: 'Návrh je príliš veľký.' };
  const id = uuidv4();
  const name = String(b.title || 'Návrh').trim().slice(0, 200) || 'Návrh';
  const folder = drive.systemFolder(ownerId, 'graphics', 'Grafika');
  const item = drive.addRef(ownerId, folder.id, { name, mime: MIME, ref: `design:${id}` }, `user:${userId}`);
  getDb().prepare('INSERT INTO designs (id, owner_id, title, width, height, data, template_id, thumb, drive_item_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ownerId, name, width, height, data, b.templateId ? String(b.templateId).slice(0, 60) : null, thumbOk(b.thumb), item.id, userId);
  realtime.publish(ownerId, { type: 'design', id });
  return { design: getDesign(ownerId, id) };
}

function updateDesign(ownerId, d, b) {
  const db = getDb();
  if (b.data !== undefined && String(b.data).length > MAX_DATA) return { error: 'Návrh je príliš veľký (obrázky zmenšite).' };
  const title = b.title !== undefined ? String(b.title).trim().slice(0, 200) || d.title : d.title;
  const [width, height] = b.width !== undefined ? dims(b.width, b.height) : [d.width, d.height];
  db.prepare('UPDATE designs SET title = ?, width = ?, height = ?, data = ?, thumb = ?, updated_at = unixepoch() WHERE id = ?')
    .run(title, width, height, b.data !== undefined ? String(b.data) : d.data, b.thumb !== undefined ? thumbOk(b.thumb) || d.thumb : d.thumb, d.id);
  if (d.drive_item_id) db.prepare('UPDATE drive_items SET name = ?, updated_at = unixepoch() WHERE id = ?').run(title, d.drive_item_id);
  realtime.publish(ownerId, { type: 'design', id: d.id });
  return { design: getDesign(ownerId, d.id) };
}

const designView = d => {
  const author = d.created_by && getDb().prepare('SELECT name FROM users WHERE id = ?').get(d.created_by);
  return { id: d.id, title: d.title, width: d.width, height: d.height, thumb: d.thumb, templateId: d.template_id, author: author?.name || '',
    driveItemId: d.drive_item_id, updatedAt: d.updated_at, createdAt: d.created_at, url: openUrl(d.owner_id, d.id) };
};

/** Texty z návrhu (hľadanie). */
function textOf(data) {
  const out = [];
  const walk = o => { if (!o || typeof o !== 'object') return; if (typeof o.text === 'string') out.push(o.text); (o.objects || []).forEach(walk); };
  walk(parse(data, {}));
  return out.join(' ');
}

drive.registerRef('design', {
  openUrl,
  text: (ownerId, id) => textOf(getDesign(ownerId, id)?.data),
  destroy(ownerId, id) {
    links.forget(ownerId, 'design', id);
    getDb().prepare('DELETE FROM designs WHERE id = ? AND owner_id = ?').run(id, ownerId);
  },
});

links.registerType('design', {
  label: 'Grafika', icon: '🖼',
  resolve: (ownerId, id) => { const d = liveDesign(ownerId, id); return d ? { title: d.title, url: openUrl(ownerId, id) } : null; },
});

module.exports = { MIME, FONTS, SIZES, BUILTIN, DEFAULT_BRAND, openUrl, brand, saveBrand, templates, template, saveTemplate, getDesign, liveDesign, createDesign, updateDesign, designView, textOf };
