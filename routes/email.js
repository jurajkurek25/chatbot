'use strict';

const express = require('express');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { getPersonResponseText, getChatResponseText } = require('../services/claude');

const router = express.Router();

const SPAM_RE = /^(no-?reply|mailer-?daemon|postmaster|bounce|noreply|auto-?reply|automailer)/i;
const MAX_HISTORY = 20; // pairs

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function nameFromEmail(email) {
  return (email.split('@')[0] || 'Zákazník')
    .replace(/[._+-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// POST /api/email/inbound — called by Cloudflare Email Worker
router.post('/inbound', async (req, res) => {
  // Authenticate via shared secret
  const secret = req.headers['x-neoworkly-secret'];
  if (!secret) return res.status(401).json({ error: 'Missing secret.' });

  const db = getDb();
  const profile = db.prepare(`
    SELECT p.*, w.id AS widget_id, w.goals, w.bot_name, w.cta_config
    FROM person_profiles p
    JOIN widgets w ON w.id = p.widget_id
    WHERE p.email_webhook_secret = ? AND p.email_channel_active = 1
  `).get(secret);
  if (!profile) return res.status(404).json({ error: 'No active email channel found.' });

  const { from = '', to = '', subject = '', messageId = '', inReplyTo = '' } = req.body;
  const body = String(req.body.body || '').slice(0, 20000);

  if (!from || !body.trim()) return res.status(400).json({ error: 'Missing from or body.' });

  // Spam / loop guard
  const fromLocal = (from.split('@')[0] || '').toLowerCase();
  if (SPAM_RE.test(fromLocal)) return res.json({ ok: true, skipped: 'spam' });
  if (profile.email_address && from.toLowerCase() === profile.email_address.toLowerCase()) {
    return res.json({ ok: true, skipped: 'loop' });
  }

  // Thread lookup / create
  const threadId = (inReplyTo || messageId || '').trim() || `new-${uuidv4()}`;
  let conv = db.prepare('SELECT * FROM email_conversations WHERE widget_id = ? AND thread_id = ?').get(profile.widget_id, threadId);

  if (!conv) {
    const convId = uuidv4();
    db.prepare(`
      INSERT INTO email_conversations (id, widget_id, thread_id, from_email, from_name, subject, history)
      VALUES (?, ?, ?, ?, ?, ?, '[]')
    `).run(convId, profile.widget_id, threadId, from, nameFromEmail(from), subject || '(bez predmetu)');
    conv = db.prepare('SELECT * FROM email_conversations WHERE id = ?').get(convId);
  }

  let history = JSON.parse(conv.history || '[]');
  history.push({ role: 'user', content: body.trim() });
  if (history.length > MAX_HISTORY * 2) history = history.slice(-(MAX_HISTORY * 2));

  // Knowledge base
  const knowledgeItems = db.prepare('SELECT * FROM knowledge_items WHERE widget_id = ? AND active = 1').all(profile.widget_id);
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(profile.widget_id);

  let replyText;
  try {
    const prevHistory = history.slice(0, -1);
    if (profile.active) {
      replyText = await getPersonResponseText(widget, profile, knowledgeItems, prevHistory, body.trim());
    } else {
      replyText = await getChatResponseText(widget, knowledgeItems, prevHistory, body.trim());
    }
  } catch (err) {
    console.error('[email/inbound] Claude error:', err.message);
    return res.status(500).json({ error: 'AI error.' });
  }

  history.push({ role: 'assistant', content: replyText });
  db.prepare('UPDATE email_conversations SET history = ?, last_reply_at = unixepoch() WHERE id = ?')
    .run(JSON.stringify(history), conv.id);

  // Send reply via SMTP
  try {
    const fromName = profile.person_name || widget.bot_name || 'AI Asistent';
    const smtpFrom = process.env.SMTP_FROM || process.env.SMTP_USER;
    const replySubject = subject && !subject.startsWith('Re:') ? `Re: ${subject}` : (subject || 'Re:');
    const newMsgId = `<${uuidv4()}@neoworkly.com>`;

    const mailOpts = {
      from: `${fromName} <${smtpFrom}>`,
      to: from,
      subject: replySubject,
      text: replyText,
      headers: { 'Message-ID': newMsgId },
    };
    if (profile.email_address) mailOpts.replyTo = profile.email_address;
    if (messageId) {
      mailOpts.headers['In-Reply-To'] = messageId;
      mailOpts.headers['References'] = [inReplyTo, messageId].filter(Boolean).join(' ');
    }

    await getTransporter().sendMail(mailOpts);
    console.log(`[email] Reply sent to ${from} (widget ${profile.widget_id})`);
  } catch (err) {
    console.error('[email/inbound] SMTP error:', err.message);
    // Non-fatal — response is saved in DB, SMTP failure shouldn't block the 200
  }

  res.json({ ok: true });
});

module.exports = router;
