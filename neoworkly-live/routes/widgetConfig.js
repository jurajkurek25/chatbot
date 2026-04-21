const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');

const DEFAULT_CONFIG = {
  primaryColor: '#0d9488',
  secondaryColor: '#0891b2',
  bgColor: '#0f172a',
  textColor: '#f1f5f9',
  mutedColor: '#94a3b8',
  userBubbleColor: '#0d9488',
  opBubbleColor: 'rgba(255,255,255,0.08)',
  borderRadius: 'normal',
  buttonShape: 'circle',
  font: 'system',
  position: 'right'
};

// Public – widget fetches this by widget_key
router.get('/:widget_key', (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT widget_config, language, logo_url FROM clients WHERE widget_key = ?').get(req.params.widget_key);
  if (!client) return res.status(404).json({ error: 'Not found' });
  let config = DEFAULT_CONFIG;
  try { config = { ...DEFAULT_CONFIG, ...JSON.parse(client.widget_config || '{}') }; } catch {}
  res.json({ config, language: client.language || 'sk', logoUrl: client.logo_url || null });
});

module.exports = { router, DEFAULT_CONFIG };
