'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDatabase } = require('./db/database');
const authRoutes = require('./routes/auth');
const widgetRoutes = require('./routes/widgets');
const knowledgeRoutes = require('./routes/knowledge');
const chatRoutes = require('./routes/chat');
const stripeRoutes = require('./routes/stripe');
const instagramRoutes = require('./routes/instagram');

const app = express();
const PORT = process.env.PORT || 3000;

initDatabase();

app.use(cors());

// Stripe webhook MUST receive raw body — mount before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/widget', chatRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/instagram', instagramRoutes);

// Page routes
app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);
app.get('/onboarding', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'))
);

app.listen(PORT, () => {
  console.log(`NeuraDeskApp running on http://localhost:${PORT}`);
});
