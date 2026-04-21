require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db/database');
const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const operatorRoutes = require('./routes/operators');
const chatRoutes = require('./routes/chat');
const statsRoutes = require('./routes/stats');
const stripeRoutes = require('./routes/stripe');
const { initSocket } = require('./services/socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
// Raw body for Stripe webhooks before JSON parser
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/operators', operatorRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/stripe', stripeRoutes);

// SPA fallback for known pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/operator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operator.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

initDB();
initSocket(io);

const PORT = process.env.LIVE_PORT || 4000;
server.listen(PORT, () => console.log(`Neoworkly Live running on port ${PORT}`));
