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

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database on startup
initDatabase();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (dashboard, widget, css, js)
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/widget', chatRoutes);

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Dedicated widget.js route (served from public/widget.js via static)
// This is already handled by express.static but explicitly noted here

app.listen(PORT, () => {
  console.log(`NeuraDeskApp running on http://localhost:${PORT}`);
});
