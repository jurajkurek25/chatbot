'use strict';

const { getDb } = require('../db/database');
const { sendHandoffEmail } = require('./email');

// Strip __HANDOFF__ from a bot reply; returns { text, requested }
function takeHandoffToken(text) {
  if (!text || !text.includes('__HANDOFF__')) return { text, requested: false };
  return { text: text.replace(/__HANDOFF__/g, '').trim(), requested: true };
}

// Email the transcript to the widget's handoff address (falls back to the owner's e-mail)
function notifyHandoff(widget, transcript, channel) {
  if (!widget.handoff_enabled) return;
  const to = widget.handoff_email
    || getDb().prepare('SELECT email FROM users WHERE id = ?').get(widget.user_id)?.email;
  if (!to) return;
  sendHandoffEmail({ toEmail: to, widgetName: widget.name, channel, transcript }).catch(() => {});
}

module.exports = { takeHandoffToken, notifyHandoff };
