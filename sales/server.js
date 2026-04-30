'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDatabase } = require('./db/database');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/training',  require('./routes/training'));
app.use('/api/prospects', require('./routes/prospects'));
app.use('/api/advisor',   require('./routes/advisor'));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDatabase();
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Neoworkly Sales running on :${PORT}`));
