'use strict';
/**
 * Formuláre (podľa HeyForm): typy polí, podmienené zobrazenie, overenie odpovede
 * a napojenie na ostatné moduly – e-mail marketing (so súhlasom), úlohy, Disk, upozornenia.
 */
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const links = require('./links');
const realtime = require('./realtime');
const notifications = require('./notifications');
const workspace = require('./workspace');

const TYPES = {
  text: 'Krátky text', textarea: 'Dlhý text', email: 'E-mail', phone: 'Telefón', number: 'Číslo', url: 'Webová adresa',
  choice: 'Jedna možnosť', checkbox: 'Viac možností', select: 'Rozbaľovací zoznam', date: 'Dátum', rating: 'Hodnotenie',
  yesno: 'Áno / Nie', consent: 'Súhlas', file: 'Nahratie súboru', statement: 'Text / nadpis',
};
const CHOICES = ['choice', 'checkbox', 'select'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const appUrl = () => (process.env.APP_URL || process.env.BASE_URL || 'https://neoworkly.com').replace(/\/$/, '');

const DEFAULT_SETTINGS = {
  layout: 'classic', theme: 'light', color: '#5b4fff', submitLabel: 'Odoslať',
  thankYou: 'Ďakujeme, odpoveď sme prijali.', redirect: '', notify: true,
  marketing: { enabled: false, tags: [] }, task: { enabled: false, projectId: null },
};

/** Vyčistí definíciu polí z editora (neznáme typy a vlastnosti zahodí). */
function cleanFields(list) {
  const ids = new Set();
  return [].concat(list || []).slice(0, 100).filter(f => f && TYPES[f.type]).map(f => {
    let id = String(f.id || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomBytes(5).toString('hex');
    while (ids.has(id)) id = crypto.randomBytes(5).toString('hex');
    ids.add(id);
    const out = { id, type: f.type, label: String(f.label || '').slice(0, 300), help: String(f.help || '').slice(0, 500), required: !!f.required && f.type !== 'statement' };
    if (CHOICES.includes(f.type)) out.options = [...new Set([].concat(f.options || []).map(o => String(o).trim().slice(0, 200)).filter(Boolean))].slice(0, 50);
    if (['text', 'textarea', 'email', 'phone', 'number', 'url'].includes(f.type)) out.placeholder = String(f.placeholder || '').slice(0, 120);
    if (f.type === 'rating') out.max = [5, 10].includes(Number(f.max)) ? Number(f.max) : 5;
    if (f.showIf && f.showIf.field) out.showIf = { field: String(f.showIf.field).slice(0, 40), value: String(f.showIf.value ?? '').slice(0, 200) };
    return out;
  });
}

function cleanSettings(s, prev = DEFAULT_SETTINGS) {
  const b = s || {};
  const out = { ...DEFAULT_SETTINGS, ...prev };
  if (['classic', 'steps'].includes(b.layout)) out.layout = b.layout;
  if (['light', 'dark'].includes(b.theme)) out.theme = b.theme;
  if (/^#[0-9a-f]{6}$/i.test(b.color || '')) out.color = b.color;
  for (const k of ['submitLabel', 'thankYou']) if (b[k] !== undefined) out[k] = String(b[k]).slice(0, k === 'thankYou' ? 2000 : 60);
  if (b.redirect !== undefined) out.redirect = /^https?:\/\//i.test(b.redirect) ? String(b.redirect).slice(0, 500) : '';
  if (b.notify !== undefined) out.notify = !!b.notify;
  if (b.marketing) out.marketing = { enabled: !!b.marketing.enabled, tags: [].concat(b.marketing.tags || []).map(t => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 10) };
  if (b.task) out.task = { enabled: !!b.task.enabled, projectId: b.task.projectId ? String(b.task.projectId) : null };
  return out;
}

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const formOf = row => row && { ...row, fields: parse(row.fields, []), settings: { ...DEFAULT_SETTINGS, ...parse(row.settings, {}) } };
const get = (ownerId, id) => formOf(getDb().prepare('SELECT * FROM forms WHERE id = ? AND owner_id = ?').get(id, ownerId));
const byToken = token => formOf(getDb().prepare('SELECT * FROM forms WHERE token = ?').get(String(token || '')));

const TEMPLATES = {
  blank: { title: 'Nový formulár', fields: [] },
  contact: { title: 'Kontaktný formulár', fields: [
    { type: 'text', label: 'Meno', required: true }, { type: 'email', label: 'E-mail', required: true },
    { type: 'textarea', label: 'Správa', required: true }, { type: 'consent', label: 'Chcem dostávať novinky e-mailom' }] },
  feedback: { title: 'Spätná väzba', fields: [
    { type: 'rating', label: 'Ako ste boli spokojný/á?', required: true, max: 5 }, { type: 'textarea', label: 'Čo môžeme zlepšiť?' },
    { type: 'yesno', label: 'Odporučili by ste nás?' }, { type: 'email', label: 'E-mail (ak chcete odpoveď)' }] },
  registration: { title: 'Registrácia na podujatie', fields: [
    { type: 'text', label: 'Meno a priezvisko', required: true }, { type: 'email', label: 'E-mail', required: true }, { type: 'phone', label: 'Telefón' },
    { type: 'choice', label: 'Ktorý termín?', required: true, options: ['Dopoludnia', 'Popoludní'] }, { type: 'consent', label: 'Súhlasím so spracovaním osobných údajov', required: true }] },
  order: { title: 'Objednávka / dopyt', fields: [
    { type: 'text', label: 'Meno / firma', required: true }, { type: 'email', label: 'E-mail', required: true },
    { type: 'checkbox', label: 'O čo máte záujem?', options: ['Služba A', 'Služba B', 'Konzultácia'] }, { type: 'number', label: 'Rozpočet (€)' },
    { type: 'file', label: 'Podklady (nepovinné)' }, { type: 'textarea', label: 'Poznámka' }] },
};

function create(ownerId, { title, template }, userId) {
  const t = TEMPLATES[template] || TEMPLATES.blank;
  const id = uuidv4();
  getDb().prepare('INSERT INTO forms (id, owner_id, token, title, fields, settings, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, ownerId, crypto.randomBytes(9).toString('base64url'), String(title || t.title).slice(0, 200), JSON.stringify(cleanFields(t.fields)), JSON.stringify(DEFAULT_SETTINGS), userId);
  return get(ownerId, id);
}

/** Je pole zobrazené pri daných odpovediach? (podmienka „zobraziť, ak pole X = hodnota“) */
function shown(field, data) {
  if (!field.showIf) return true;
  const v = data[field.showIf.field];
  return Array.isArray(v) ? v.includes(field.showIf.value) : String(v ?? '') === field.showIf.value;
}

/**
 * Overí a normalizuje odpoveď. `files` = { fieldId: [{ id, name }] } (už uložené na Disku).
 * Vráti { data, email, name, consent, errors }.
 */
function validate(form, body, files = {}) {
  const data = {};
  const errors = {};
  for (const f of form.fields) {
    if (f.type === 'statement') continue;
    let v = body[f.id];
    if (f.type === 'file') v = files[f.id] || [];
    else if (f.type === 'checkbox') v = [].concat(v ?? []).map(String).filter(x => f.options.includes(x));
    else if (f.type === 'consent') v = v === true || v === 'true' || v === 'on' || v === '1';
    else if (f.type === 'yesno') v = v === 'yes' || v === 'no' ? v : '';
    else v = String(v ?? '').trim().slice(0, f.type === 'textarea' ? 10000 : 500);
    data[f.id] = v;
  }
  for (const f of form.fields) {
    if (f.type === 'statement') continue;
    if (!shown(f, data)) { delete data[f.id]; continue; }
    const v = data[f.id];
    const empty = v === '' || v === false || (Array.isArray(v) && !v.length);
    if (empty) { if (f.required) errors[f.id] = 'Povinné pole.'; continue; }
    if (f.type === 'email' && !EMAIL.test(v)) errors[f.id] = 'Neplatný e-mail.';
    if (f.type === 'number' && !Number.isFinite(Number(v))) errors[f.id] = 'Zadajte číslo.';
    if (f.type === 'url' && !/^https?:\/\/\S+\.\S+/i.test(v)) errors[f.id] = 'Zadajte adresu začínajúcu https://';
    if (f.type === 'phone' && !/^[+\d][\d\s()/-]{5,}$/.test(v)) errors[f.id] = 'Neplatné telefónne číslo.';
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.id] = 'Neplatný dátum.';
    if ((f.type === 'choice' || f.type === 'select') && !f.options.includes(v)) errors[f.id] = 'Vyberte jednu z možností.';
    if (f.type === 'rating' && !(Number(v) >= 1 && Number(v) <= (f.max || 5))) errors[f.id] = 'Vyberte hodnotenie.';
    if (f.type === 'number') data[f.id] = Number(v);
    if (f.type === 'rating') data[f.id] = Number(v);
  }
  const emailField = form.fields.find(f => f.type === 'email' && data[f.id]);
  const nameField = form.fields.find(f => f.type === 'text' && /meno|name/i.test(f.label) && data[f.id]);
  const consentField = form.fields.find(f => f.type === 'consent');
  return {
    data, errors, email: emailField ? String(data[emailField.id]).toLowerCase() : null,
    name: nameField ? data[nameField.id] : '', consent: consentField ? !!data[consentField.id] : false,
  };
}

/** Text odpovede pre e-mail, úlohu a export. */
function answerText(f, v) {
  if (v === undefined || v === null || v === '') return '';
  if (f.type === 'consent') return v ? 'Áno' : 'Nie';
  if (f.type === 'yesno') return v === 'yes' ? 'Áno' : 'Nie';
  if (f.type === 'file') return v.map(x => x.name).join(', ');
  if (Array.isArray(v)) return v.join(', ');
  if (f.type === 'rating') return `${v}/${f.max || 5}`;
  return String(v);
}
const summary = (form, data) => form.fields.filter(f => f.type !== 'statement' && data[f.id] !== undefined && answerText(f, data[f.id]) !== '')
  .map(f => `${f.label || TYPES[f.type]}: ${answerText(f, data[f.id])}`).join('\n');

/** Uloží odpoveď a spustí napojenia (upozornenie, marketing, úloha). */
function submit(form, v) {
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO form_responses (id, form_id, owner_id, data, email) VALUES (?, ?, ?, ?, ?)').run(id, form.id, form.owner_id, JSON.stringify(v.data), v.email);
  const text = summary(form, v.data);
  const url = `/dashboard?view=forms&form=${form.id}&ws=${form.owner_id}`;
  const s = form.settings;
  if (s.notify) {
    const editors = workspace.members(form.owner_id).filter(m => m.role !== 'readonly').map(m => m.id);
    const people = form.created_by && editors.includes(form.created_by) ? [form.owner_id, form.created_by] : [form.owner_id];
    notifications.notify(people, { ownerId: form.owner_id, type: 'form.response', title: `Nová odpoveď: ${form.title}`, body: text.slice(0, 900), url, email: true });
  }
  if (s.marketing?.enabled && v.email) {
    require('./marketing').upsertContact(form.owner_id, { email: v.email, name: v.name, source: 'form', consent: v.consent, tags: ['formular', ...(s.marketing.tags || [])] });
  }
  let taskId = null;
  if (s.task?.enabled) {
    const r = require('./tasks').createTask(form.owner_id, { projectId: s.task.projectId, title: `${form.title}: ${v.name || v.email || 'nová odpoveď'}`.slice(0, 300), description: `${text}\n\nOdpoveď z formulára ${appUrl()}${url}` }, null);
    if (r.task) { taskId = r.task.id; links.link(form.owner_id, { type: 'form', id: form.id }, { type: 'task', id: taskId }, null); }
  }
  realtime.publish(form.owner_id, { type: 'form', id: form.id, response: id });
  return { id, taskId };
}

/** Prehľad odpovedí po poliach: počty možností, priemer hodnotenia, posledné texty. */
function stats(form) {
  const rows = getDb().prepare('SELECT data FROM form_responses WHERE form_id = ? ORDER BY created_at DESC').all(form.id).map(r => parse(r.data, {}));
  return {
    total: rows.length,
    fields: form.fields.filter(f => f.type !== 'statement').map(f => {
      const vals = rows.map(r => r[f.id]).filter(v => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
      const out = { id: f.id, label: f.label, type: f.type, answered: vals.length };
      if (CHOICES.includes(f.type)) out.counts = Object.fromEntries(f.options.map(o => [o, vals.filter(v => (Array.isArray(v) ? v.includes(o) : v === o)).length]));
      else if (f.type === 'yesno') out.counts = { Áno: vals.filter(v => v === 'yes').length, Nie: vals.filter(v => v === 'no').length };
      else if (f.type === 'consent') out.counts = { Áno: vals.filter(v => v === true).length, Nie: rows.length - vals.filter(v => v === true).length };
      else if (f.type === 'rating' || f.type === 'number') { const n = vals.map(Number); out.avg = n.length ? Math.round((n.reduce((a, b) => a + b, 0) / n.length) * 10) / 10 : null; if (f.type === 'rating') out.max = f.max || 5; }
      else out.latest = vals.slice(0, 5).map(v => answerText(f, v));
      return out;
    }),
  };
}

function csv(form) {
  const rows = getDb().prepare('SELECT * FROM form_responses WHERE form_id = ? ORDER BY created_at').all(form.id);
  const fields = form.fields.filter(f => f.type !== 'statement');
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Čas', ...fields.map(f => f.label || TYPES[f.type])].map(q).join(';')];
  for (const r of rows) {
    const d = parse(r.data, {});
    lines.push([new Date(r.created_at * 1000).toISOString().replace('T', ' ').slice(0, 16), ...fields.map(f => answerText(f, d[f.id]))].map(q).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

/** Formulár zmazaný: odpovede zmiznú (kaskáda), nahrané súbory zostanú na Disku. */
function remove(form) {
  links.forget(form.owner_id, 'form', form.id);
  getDb().prepare('DELETE FROM forms WHERE id = ?').run(form.id);
}

const unlink = files => (files || []).forEach(f => fs.unlink(f.path, () => {}));

links.registerType('form', {
  label: 'Formulár', icon: '📝',
  resolve(ownerId, id) {
    const f = getDb().prepare('SELECT title FROM forms WHERE id = ? AND owner_id = ?').get(id, ownerId);
    return f ? { title: f.title, url: `/dashboard?view=forms&form=${id}&ws=${ownerId}` } : null;
  },
});

module.exports = { TYPES, TEMPLATES, DEFAULT_SETTINGS, cleanFields, cleanSettings, get, byToken, create, shown, validate, answerText, summary, submit, stats, csv, remove, unlink };
