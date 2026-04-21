const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db/database');

const JWT_SECRET = process.env.LIVE_JWT_SECRET || 'live_secret_change_me';

function initSocket(io) {
  // Namespace for operators (authenticated)
  const opNS = io.of('/operators');
  opNS.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.role !== 'operator') return next(new Error('Forbidden'));
      socket.operatorId = payload.id;
      socket.clientId = payload.clientId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  opNS.on('connection', (socket) => {
    const db = getDB();
    console.log(`Operator connected: ${socket.operatorId}`);

    // Mark operator online
    db.prepare('UPDATE operators SET is_online = 1, socket_id = ? WHERE id = ?').run(socket.id, socket.operatorId);
    broadcastOperatorList(io, socket.clientId);
    socket.join(`client:${socket.clientId}`);

    // Send current queue immediately so operator sees waiting visitors on connect
    socket.emit('queue:updated', getQueueList(db, socket.clientId));

    // Operator goes offline manually
    socket.on('operator:status', ({ online }) => {
      db.prepare('UPDATE operators SET is_online = ? WHERE id = ?').run(online ? 1 : 0, socket.operatorId);
      broadcastOperatorList(io, socket.clientId);
    });

    // Operator sends message
    socket.on('operator:message', ({ chatId, content }) => {
      if (!content?.trim()) return;
      const db = getDB();
      const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND operator_id = ? AND status = 'active'").get(chatId, socket.operatorId);
      if (!chat) return;

      const op = db.prepare('SELECT nickname, full_name FROM operators WHERE id = ?').get(socket.operatorId);
      const msgId = uuidv4();
      const ts = new Date().toISOString();
      db.prepare('INSERT INTO messages (id, chat_id, sender_type, sender_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(msgId, chatId, 'operator', op.nickname || op.full_name || 'Operátor', content.trim(), ts);

      const msg = { id: msgId, chat_id: chatId, sender_type: 'operator', sender_name: op.nickname || op.full_name || 'Operátor', content: content.trim(), created_at: ts };
      socket.emit('chat:message', msg);
      io.of('/visitors').to(`chat:${chatId}`).emit('chat:message', msg);
    });

    // Operator ends chat
    socket.on('operator:end_chat', ({ chatId }) => {
      const db = getDB();
      const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND operator_id = ?").get(chatId, socket.operatorId);
      if (!chat) return;
      db.prepare("UPDATE chats SET status = 'ended', ended_at = ? WHERE id = ?").run(new Date().toISOString(), chatId);
      db.prepare('UPDATE operators SET is_busy = 0 WHERE id = ?').run(socket.operatorId);

      socket.emit('chat:ended', { chatId });
      io.of('/visitors').to(`chat:${chatId}`).emit('chat:ended', { chatId });

      broadcastOperatorList(io, socket.clientId);
      // Check queue for this operator's client
      processQueue(io, socket.clientId);
    });

    // Operator accepts from queue
    socket.on('operator:accept_queue', ({ queueId }) => {
      const db = getDB();
      const op = db.prepare('SELECT * FROM operators WHERE id = ?').get(socket.operatorId);
      if (op.is_busy) return socket.emit('error', { message: 'You are already in a chat' });

      const entry = db.prepare('SELECT * FROM queue WHERE id = ? AND client_id = ?').get(queueId, socket.clientId);
      if (!entry) return;

      const chatId = uuidv4();
      db.prepare('INSERT INTO chats (id, client_id, operator_id, visitor_name, visitor_session_id, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(chatId, socket.clientId, socket.operatorId, entry.visitor_name, entry.visitor_session_id, 'active');
      db.prepare('UPDATE operators SET is_busy = 1 WHERE id = ?').run(socket.operatorId);
      db.prepare('DELETE FROM queue WHERE id = ?').run(queueId);

      const opData = db.prepare('SELECT id, nickname, full_name, photo_url, bio FROM operators WHERE id = ?').get(socket.operatorId);
      socket.emit('chat:started', { chatId, visitorName: entry.visitor_name, messages: [] });
      if (entry.socket_id) {
        io.of('/visitors').to(entry.socket_id).emit('chat:started', { chatId, operator: opData, messages: [] });
      }

      broadcastOperatorList(io, socket.clientId);
      broadcastQueue(io, socket.clientId);
    });

    socket.on('disconnect', () => {
      const db = getDB();
      db.prepare('UPDATE operators SET is_online = 0, socket_id = NULL WHERE id = ?').run(socket.operatorId);
      broadcastOperatorList(io, socket.clientId);
    });
  });

  // Namespace for visitors (anonymous)
  const visNS = io.of('/visitors');

  visNS.on('connection', (socket) => {
    let currentChatId = null;
    let currentClientId = null;
    let visitorSessionId = uuidv4();
    let visitorName = 'Anonym';

    // Visitor connects with widget key
    socket.on('visitor:connect', ({ widget_key, visitor_name }) => {
      const db = getDB();
      const client = db.prepare('SELECT id FROM clients WHERE widget_key = ?').get(widget_key);
      if (!client) return socket.emit('error', { message: 'Invalid widget key' });

      currentClientId = client.id;
      visitorName = visitor_name?.trim() || 'Anonym';
      socket.join(`client_visitors:${currentClientId}`);

      const ops = db.prepare('SELECT id, nickname, full_name, photo_url, bio, is_online, is_busy FROM operators WHERE client_id = ? AND is_online = 1').all(client.id);
      socket.emit('operators:list', ops);
    });

    // Visitor selects specific operator
    socket.on('visitor:select_operator', ({ operator_id, visitor_name }) => {
      if (!currentClientId) return;
      const db = getDB();
      visitorName = visitor_name?.trim() || visitorName;

      const op = db.prepare('SELECT * FROM operators WHERE id = ? AND client_id = ? AND is_online = 1').get(operator_id, currentClientId);
      if (!op) return socket.emit('error', { message: 'Operator not available' });

      if (op.is_busy) {
        return socket.emit('operator:busy', { operator_id, message: 'Operátor je momentálne zaneprázdnený.' });
      }

      startChat(io, socket, db, currentClientId, op, visitorName, visitorSessionId, (chatId) => {
        currentChatId = chatId;
      });
    });

    // Visitor clicks AUTO
    socket.on('visitor:auto', ({ visitor_name }) => {
      if (!currentClientId) return;
      const db = getDB();
      visitorName = visitor_name?.trim() || visitorName;

      const op = db.prepare('SELECT * FROM operators WHERE client_id = ? AND is_online = 1 AND is_busy = 0 ORDER BY RANDOM() LIMIT 1').get(currentClientId);
      if (!op) {
        return socket.emit('no_operators', { message: 'Žiadny operátor nie je dostupný.' });
      }

      startChat(io, socket, db, currentClientId, op, visitorName, visitorSessionId, (chatId) => {
        currentChatId = chatId;
      });
    });

    // Visitor joins queue
    socket.on('visitor:join_queue', ({ visitor_name, preferred_operator_id }) => {
      if (!currentClientId) return;
      const db = getDB();
      visitorName = visitor_name?.trim() || visitorName;

      // Avoid duplicate queue entries
      db.prepare('DELETE FROM queue WHERE visitor_session_id = ? AND client_id = ?').run(visitorSessionId, currentClientId);

      const queueId = uuidv4();
      db.prepare('INSERT INTO queue (id, client_id, visitor_session_id, visitor_name, preferred_operator_id, socket_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(queueId, currentClientId, visitorSessionId, visitorName, preferred_operator_id || null, socket.id);

      const position = db.prepare('SELECT COUNT(*) as n FROM queue WHERE client_id = ? AND joined_at <= (SELECT joined_at FROM queue WHERE id = ?)').get(currentClientId, queueId).n;
      socket.emit('queue:joined', { queueId, position });

      // Notify operators in this client's room
      io.of('/operators').to(`client:${currentClientId}`).emit('queue:updated', getQueueList(db, currentClientId));
    });

    // Visitor sends message
    socket.on('visitor:message', ({ chatId, content }) => {
      if (!content?.trim() || chatId !== currentChatId) return;
      const db = getDB();
      const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND status = 'active'").get(chatId);
      if (!chat) return;

      const msgId = uuidv4();
      const ts = new Date().toISOString();
      db.prepare('INSERT INTO messages (id, chat_id, sender_type, sender_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(msgId, chatId, 'visitor', visitorName, content.trim(), ts);

      const msg = { id: msgId, chat_id: chatId, sender_type: 'visitor', sender_name: visitorName, content: content.trim(), created_at: ts };
      socket.emit('chat:message', msg);

      // Find operator socket and emit
      if (chat.operator_id) {
        const opDB = db.prepare('SELECT socket_id FROM operators WHERE id = ?').get(chat.operator_id);
        if (opDB?.socket_id) {
          io.of('/operators').to(opDB.socket_id).emit('chat:message', msg);
        }
      }
    });

    // Visitor ends chat
    socket.on('visitor:end_chat', ({ chatId }) => {
      if (chatId !== currentChatId) return;
      const db = getDB();
      const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND status = 'active'").get(chatId);
      if (!chat) return;

      db.prepare("UPDATE chats SET status = 'ended', ended_at = ? WHERE id = ?").run(new Date().toISOString(), chatId);
      db.prepare('UPDATE operators SET is_busy = 0 WHERE id = ?').run(chat.operator_id);
      currentChatId = null;

      socket.emit('chat:ended', { chatId });
      if (chat.operator_id) {
        const opDB = db.prepare('SELECT socket_id FROM operators WHERE id = ?').get(chat.operator_id);
        if (opDB?.socket_id) {
          io.of('/operators').to(opDB.socket_id).emit('chat:ended', { chatId });
        }
      }
      broadcastOperatorList(io, currentClientId);
      processQueue(io, currentClientId);
    });

    socket.on('disconnect', () => {
      if (currentClientId) {
        const db = getDB();
        db.prepare('DELETE FROM queue WHERE visitor_session_id = ? AND client_id = ?').run(visitorSessionId, currentClientId);
        // If active chat, mark as ended
        if (currentChatId) {
          const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND status = 'active'").get(currentChatId);
          if (chat) {
            db.prepare("UPDATE chats SET status = 'ended', ended_at = ? WHERE id = ?").run(new Date().toISOString(), currentChatId);
            db.prepare('UPDATE operators SET is_busy = 0 WHERE id = ?').run(chat.operator_id);
            if (chat.operator_id) {
              const opDB = db.prepare('SELECT socket_id FROM operators WHERE id = ?').get(chat.operator_id);
              if (opDB?.socket_id) {
                io.of('/operators').to(opDB.socket_id).emit('chat:ended', { chatId: currentChatId, reason: 'visitor_left' });
              }
            }
            broadcastOperatorList(io, currentClientId);
            processQueue(io, currentClientId);
          }
        }
        io.of('/operators').to(`client:${currentClientId}`).emit('queue:updated', getQueueList(db, currentClientId));
      }
    });
  });
}

function startChat(io, socket, db, clientId, op, visitorName, visitorSessionId, onStarted) {
  const chatId = uuidv4();
  db.prepare('INSERT INTO chats (id, client_id, operator_id, visitor_name, visitor_session_id, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, clientId, op.id, visitorName, visitorSessionId, 'active');
  db.prepare('UPDATE operators SET is_busy = 1 WHERE id = ?').run(op.id);

  const opData = { id: op.id, nickname: op.nickname, full_name: op.full_name, photo_url: op.photo_url, bio: op.bio };
  socket.join(`chat:${chatId}`);
  socket.emit('chat:started', { chatId, operator: opData, messages: [] });

  if (op.socket_id) {
    io.of('/operators').to(op.socket_id).emit('chat:started', { chatId, visitorName, messages: [] });
  }

  broadcastOperatorList(io, clientId);
  onStarted(chatId);
}

function broadcastOperatorList(io, clientId) {
  const db = getDB();
  const ops = db.prepare('SELECT id, nickname, full_name, photo_url, bio, is_online, is_busy FROM operators WHERE client_id = ?').all(clientId);
  io.of('/visitors').to(`client_visitors:${clientId}`).emit('operators:list', ops);
}

function broadcastQueue(io, clientId) {
  const db = getDB();
  io.of('/operators').to(`client:${clientId}`).emit('queue:updated', getQueueList(db, clientId));
}

function getQueueList(db, clientId) {
  return db.prepare('SELECT * FROM queue WHERE client_id = ? ORDER BY joined_at ASC').all(clientId);
}

function processQueue(io, clientId) {
  if (!clientId) return;
  const db = getDB();
  const freeOp = db.prepare('SELECT * FROM operators WHERE client_id = ? AND is_online = 1 AND is_busy = 0 LIMIT 1').get(clientId);
  if (!freeOp) return;

  const entry = db.prepare('SELECT * FROM queue WHERE client_id = ? ORDER BY joined_at ASC LIMIT 1').get(clientId);
  if (!entry) return;

  const chatId = uuidv4();
  db.prepare('INSERT INTO chats (id, client_id, operator_id, visitor_name, visitor_session_id, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(chatId, clientId, freeOp.id, entry.visitor_name, entry.visitor_session_id, 'active');
  db.prepare('UPDATE operators SET is_busy = 1 WHERE id = ?').run(freeOp.id);
  db.prepare('DELETE FROM queue WHERE id = ?').run(entry.id);

  const opData = { id: freeOp.id, nickname: freeOp.nickname, full_name: freeOp.full_name, photo_url: freeOp.photo_url, bio: freeOp.bio };

  if (freeOp.socket_id) {
    io.of('/operators').to(freeOp.socket_id).emit('chat:started', { chatId, visitorName: entry.visitor_name, messages: [] });
  }
  if (entry.socket_id) {
    io.of('/visitors').to(entry.socket_id).emit('chat:started', { chatId, operator: opData, messages: [] });
  }

  broadcastOperatorList(io, clientId);
  broadcastQueue(io, clientId);
}

module.exports = { initSocket };
