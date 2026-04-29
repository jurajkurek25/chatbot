'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All CRUD endpoints require auth; process endpoint is public (called by cron)
// We apply requireAuth per-route below instead of router.use() so that POST /process stays public.

function createTransport(smtpSettings) {
  // smtpSettings: { host, port, user, pass } — owner's SMTP or fall back to env
  const host = smtpSettings?.host || process.env.SMTP_HOST;
  const port = parseInt(smtpSettings?.port || process.env.SMTP_PORT || '587', 10);
  const user = smtpSettings?.user || process.env.SMTP_USER;
  const pass = smtpSettings?.pass || process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

// GET /api/sequences/:widgetId — get sequence for widget (or null)
router.get('/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const { widgetId } = req.params;

  // Verify widget belongs to this user
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const seq = db.prepare('SELECT * FROM followup_sequences WHERE widget_id = ?').get(widgetId);
  if (!seq) return res.json({ sequence: null });

  res.json({
    sequence: {
      id: seq.id,
      widget_id: seq.widget_id,
      name: seq.name,
      enabled: Boolean(seq.enabled),
      steps: JSON.parse(seq.steps || '[]'),
      created_at: seq.created_at,
    },
  });
});

// PUT /api/sequences/:widgetId — create or update sequence
router.put('/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const { widgetId } = req.params;

  // Verify widget belongs to this user
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  const { name, enabled, steps } = req.body;

  if (!Array.isArray(steps) || steps.length > 5) {
    return res.status(400).json({ error: 'Steps must be an array with at most 5 items.' });
  }

  // Validate each step
  for (const step of steps) {
    if (typeof step.delay_hours !== 'number' || step.delay_hours < 0) {
      return res.status(400).json({ error: 'Each step must have a non-negative delay_hours.' });
    }
    if (!step.subject || !step.message) {
      return res.status(400).json({ error: 'Each step must have subject and message.' });
    }
  }

  const existing = db.prepare('SELECT id FROM followup_sequences WHERE widget_id = ?').get(widgetId);

  if (existing) {
    db.prepare(
      'UPDATE followup_sequences SET name = ?, enabled = ?, steps = ? WHERE widget_id = ?'
    ).run(
      name || 'Automatická sekvencia',
      enabled ? 1 : 0,
      JSON.stringify(steps),
      widgetId
    );
    const updated = db.prepare('SELECT * FROM followup_sequences WHERE widget_id = ?').get(widgetId);
    return res.json({
      sequence: {
        id: updated.id,
        widget_id: updated.widget_id,
        name: updated.name,
        enabled: Boolean(updated.enabled),
        steps: JSON.parse(updated.steps || '[]'),
        created_at: updated.created_at,
      },
    });
  }

  const seqId = uuidv4();
  db.prepare(
    'INSERT INTO followup_sequences (id, widget_id, name, enabled, steps) VALUES (?, ?, ?, ?, ?)'
  ).run(seqId, widgetId, name || 'Automatická sekvencia', enabled ? 1 : 0, JSON.stringify(steps));

  const created = db.prepare('SELECT * FROM followup_sequences WHERE id = ?').get(seqId);
  res.json({
    sequence: {
      id: created.id,
      widget_id: created.widget_id,
      name: created.name,
      enabled: Boolean(created.enabled),
      steps: JSON.parse(created.steps || '[]'),
      created_at: created.created_at,
    },
  });
});

// DELETE /api/sequences/:widgetId — delete sequence
router.delete('/:widgetId', requireAuth, (req, res) => {
  const db = getDb();
  const { widgetId } = req.params;

  // Verify widget belongs to this user
  const widget = db.prepare('SELECT id FROM widgets WHERE id = ? AND user_id = ?').get(widgetId, req.userId);
  if (!widget) return res.status(404).json({ error: 'Widget nenájdený.' });

  db.prepare('DELETE FROM followup_sequences WHERE widget_id = ?').run(widgetId);
  res.json({ ok: true });
});

// POST /api/sequences/process — internal cron only; protected by secret or localhost
router.post('/process', async (req, res) => {
  const remoteIp = req.socket.remoteAddress || '';
  const isLocal = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
  const secret = process.env.INTERNAL_SECRET;
  if (!isLocal && (!secret || req.headers['x-internal-secret'] !== secret)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Find up to 50 due jobs
  const jobs = db.prepare(
    'SELECT * FROM followup_jobs WHERE sent_at IS NULL AND failed = 0 AND send_at <= ? LIMIT 50'
  ).all(now);

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      // Get lead
      const lead = db.prepare('SELECT name, email FROM leads WHERE id = ?').get(job.lead_id);
      if (!lead) {
        db.prepare('UPDATE followup_jobs SET failed = 1 WHERE id = ?').run(job.id);
        failed++;
        continue;
      }

      // Get widget
      const widget = db.prepare('SELECT name, bot_name, user_id FROM widgets WHERE id = ?').get(job.widget_id);
      if (!widget) {
        db.prepare('UPDATE followup_jobs SET failed = 1 WHERE id = ?').run(job.id);
        failed++;
        continue;
      }

      // Get owner
      const owner = db.prepare('SELECT name, email FROM users WHERE id = ?').get(widget.user_id);
      if (!owner) {
        db.prepare('UPDATE followup_jobs SET failed = 1 WHERE id = ?').run(job.id);
        failed++;
        continue;
      }

      // Get sequence
      const seq = db.prepare('SELECT * FROM followup_sequences WHERE id = ?').get(job.sequence_id);
      if (!seq) {
        db.prepare('UPDATE followup_jobs SET failed = 1 WHERE id = ?').run(job.id);
        failed++;
        continue;
      }

      const steps = JSON.parse(seq.steps || '[]');
      const step = steps[job.step_index];
      if (!step) {
        db.prepare('UPDATE followup_jobs SET failed = 1 WHERE id = ?').run(job.id);
        failed++;
        continue;
      }

      // Replace {{name}} placeholder
      const message = (step.message || '').replace(/\{\{name\}\}/g, lead.name);
      const subject = (step.subject || '').replace(/\{\{name\}\}/g, lead.name);

      const transport = createTransport(null); // use env SMTP settings
      if (!transport) {
        console.log('[sequences] SMTP not configured, skipping job', job.id);
        // Don't mark as failed — will retry when SMTP is configured
        continue;
      }

      const from = process.env.SMTP_FROM || process.env.SMTP_USER;
      const widgetName = widget.name || widget.bot_name;

      const html = `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:24px 32px">
      <div style="font-size:20px;font-weight:800;color:white">${widgetName}</div>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 16px">Ahoj <strong>${lead.name}</strong>,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 24px;white-space:pre-line">${message.replace(/\n/g, '<br>')}</p>
      <p style="color:#64748b;font-size:13px;margin:0">S pozdravom,<br><strong>${owner.name}</strong></p>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
      Neoworkly · <a href="https://neoworkly.com" style="color:#94a3b8">neoworkly.com</a>
    </div>
  </div>
</body></html>`;

      await transport.sendMail({
        from: `"${owner.name}" <${from}>`,
        to: lead.email,
        subject,
        html,
        text: message,
      });

      db.prepare('UPDATE followup_jobs SET sent_at = ? WHERE id = ?').run(now, job.id);
      console.log(`[sequences] Follow-up sent to ${lead.email} (job ${job.id}, step ${job.step_index})`);
      processed++;
    } catch (err) {
      console.error(`[sequences] Job ${job.id} failed:`, err.message);
      db.prepare('UPDATE followup_jobs SET failed = 1 WHERE id = ?').run(job.id);
      failed++;
    }
  }

  res.json({ ok: true, processed, failed, total: jobs.length });
});

module.exports = router;
