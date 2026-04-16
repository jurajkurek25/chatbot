'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendTeamInvite } = require('../services/email');

const router = express.Router();
router.use(requireAuth);

const APP_URL = () => (process.env.APP_URL || 'https://neoworkly.com').replace(/\/$/, '');

router.get('/', (req, res) => {
  const members = getDb().prepare(
    'SELECT id, email, role, accepted, created_at FROM team_members WHERE owner_user_id = ? ORDER BY created_at DESC'
  ).all(req.userId);
  res.json(members);
});

router.post('/invite', async (req, res) => {
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

router.delete('/:memberId', (req, res) => {
  getDb().prepare('DELETE FROM team_members WHERE id = ? AND owner_user_id = ?').run(req.params.memberId, req.userId);
  res.json({ ok: true });
});

// Public accept route — no auth
router.get('/accept/:token', (req, res) => {
  const member = getDb().prepare('SELECT id FROM team_members WHERE invite_token = ? AND accepted = 0').get(req.params.token);
  if (!member) return res.redirect('/?team_error=1');
  getDb().prepare('UPDATE team_members SET accepted = 1, invite_token = NULL WHERE id = ?').run(member.id);
  res.redirect('/dashboard?team_joined=1');
});

module.exports = router;
