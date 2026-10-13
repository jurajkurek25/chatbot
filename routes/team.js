'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendTeamInvite } = require('../services/email');

const router = express.Router();

const APP_URL = () => (process.env.APP_URL || 'https://neoworkly.com').replace(/\/$/, '');

router.get('/', requireAuth, (req, res) => {
  const members = getDb().prepare(
    'SELECT id, email, role, accepted, created_at FROM team_members WHERE owner_user_id = ? ORDER BY created_at DESC'
  ).all(req.userId);
  res.json(members);
});

router.post('/invite', requireAuth, async (req, res) => {
  const { email, role } = req.body;
  if (!email?.includes('@')) return res.status(400).json({ error: 'Neplatný email.' });
  if (!['readonly','editor'].includes(role)) return res.status(400).json({ error: 'Neplatná rola.' });
  const owner = getDb().prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  const token = uuidv4();
  try {
    getDb().prepare(`INSERT INTO team_members (id, owner_user_id, email, role, invite_token, accepted) VALUES (?,?,?,?,?,0)`).run(uuidv4(), req.userId, email.trim().toLowerCase(), role, token);
  } catch {
    return res.status(409).json({ error: 'Tento email je už pozvaný.' });
  }
  res.json({ ok: true });
  setImmediate(async () => {
    try { await sendTeamInvite({ toEmail: email.trim(), ownerName: owner?.name || 'Váš kolega', inviteUrl: `${APP_URL()}/team/accept/${token}` }); } catch {}
  });
});

// Tímy, do ktorých patrí prihlásený používateľ (prístup k ich Disku podľa roly)
router.get('/memberships', requireAuth, (req, res) => {
  res.json(getDb().prepare(`SELECT t.owner_user_id AS ownerId, t.role, u.name, u.email FROM team_members t
                             JOIN users u ON u.id = t.owner_user_id WHERE t.member_user_id = ? AND t.accepted = 1`).all(req.userId));
});

// Prijatie pozvánky prihláseným používateľom (token z e-mailu dokazuje prístup k pozvanej adrese)
router.post('/accept', requireAuth, (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM team_members WHERE invite_token = ? AND accepted = 0').get(String(req.body?.token || ''));
  if (!member) return res.status(404).json({ error: 'Pozvánka je neplatná alebo už bola prijatá.' });
  if (member.owner_user_id === req.userId) return res.status(400).json({ error: 'Nemôžete prijať pozvánku do vlastného tímu.' });
  db.prepare('UPDATE team_members SET accepted = 1, invite_token = NULL, member_user_id = ? WHERE id = ?').run(req.userId, member.id);
  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(member.owner_user_id);
  res.json({ ok: true, ownerId: member.owner_user_id, ownerName: owner?.name || '' });
});

router.delete('/:memberId', requireAuth, (req, res) => {
  getDb().prepare('DELETE FROM team_members WHERE id = ? AND owner_user_id = ?').run(req.params.memberId, req.userId);
  res.json({ ok: true });
});

// Odkaz z e-mailu (bez prihlásenia): pozvánku prijme dashboard po prihlásení / registrácii
router.get('/accept/:token', (req, res) => {
  res.redirect(`/dashboard?team_invite=${encodeURIComponent(req.params.token)}`);
});

module.exports = router;
