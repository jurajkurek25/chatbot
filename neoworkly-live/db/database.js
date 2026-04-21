const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.LIVE_DB_PATH || path.join(__dirname, 'live.db');
let db;

function getDB() {
  if (!db) db = new Database(DB_PATH);
  return db;
}

function initDB() {
  const db = getDB();
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT,
      widget_key TEXT UNIQUE NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'free',
      ai_summary_enabled INTEGER DEFAULT 1,
      language TEXT DEFAULT 'sk',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS operators (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT,
      full_name TEXT,
      photo_url TEXT,
      bio TEXT,
      is_online INTEGER DEFAULT 0,
      is_busy INTEGER DEFAULT 0,
      socket_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      operator_id TEXT,
      visitor_name TEXT DEFAULT 'Anonym',
      visitor_session_id TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (operator_id) REFERENCES operators(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      visitor_session_id TEXT NOT NULL,
      visitor_name TEXT DEFAULT 'Anonym',
      preferred_operator_id TEXT,
      socket_id TEXT,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_chats_client ON chats(client_id);
    CREATE INDEX IF NOT EXISTS idx_operators_client ON operators(client_id);
    CREATE INDEX IF NOT EXISTS idx_queue_client ON queue(client_id);
  `);

  // Migrations
  try { db.exec("ALTER TABLE clients ADD COLUMN widget_config TEXT DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE clients ADD COLUMN logo_url TEXT"); } catch {}

  console.log('Neoworkly Live DB initialized');
}

module.exports = { getDB, initDB };
