'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'neuradesk.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      stripe_customer_id TEXT,
      subscription_id TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'inactive',
      onboarding_done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS widgets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      bot_name TEXT NOT NULL DEFAULT 'Asistent',
      welcome_message TEXT NOT NULL DEFAULT 'Ahoj! Ako vám môžem pomôcť?',
      primary_color TEXT NOT NULL DEFAULT '#2563eb',
      goals TEXT NOT NULL DEFAULT '',
      cta_type TEXT NOT NULL DEFAULT 'contact'
        CHECK(cta_type IN ('call','contact','purchase','order','custom','none')),
      cta_config TEXT NOT NULL DEFAULT '{}',
      suggested_questions TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'text'
        CHECK(source_type IN ('text','pdf','url')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title, content,
      content='knowledge_items',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content)
        VALUES ('delete', old.rowid, old.title, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content)
        VALUES ('delete', old.rowid, old.title, old.content);
      INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS instagram_connections (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      ig_user_id TEXT NOT NULL,
      ig_username TEXT,
      page_id TEXT NOT NULL,
      page_name TEXT,
      page_access_token TEXT NOT NULL,
      keyword_triggers TEXT NOT NULL DEFAULT '[]',
      dm_welcome_msg TEXT,
      connected_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(widget_id)
    );

    CREATE TABLE IF NOT EXISTS instagram_dm_sessions (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES instagram_connections(id) ON DELETE CASCADE,
      igsid TEXT NOT NULL,
      sender_username TEXT,
      history TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(connection_id, igsid)
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      session_id TEXT,
      chat_summary TEXT,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN ('new','contacted','closed')),
      notes TEXT,
      gdpr_consent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'service'
        CHECK(type IN ('digital','physical','service','consultation','course','ticket','lead_magnet')),
      description TEXT NOT NULL DEFAULT '',
      for_whom TEXT NOT NULL DEFAULT '',
      benefits TEXT NOT NULL DEFAULT '',
      price REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      stripe_link TEXT,
      cta_text TEXT NOT NULL DEFAULT 'Zistiť viac',
      landing_url TEXT,
      recommend_when TEXT NOT NULL DEFAULT '',
      not_recommend_when TEXT NOT NULL DEFAULT '',
      faq TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Migrations: add columns for existing DBs
  const migrations = [
    `ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`,
    `ALTER TABLE users ADD COLUMN subscription_id TEXT`,
    `ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'inactive'`,
    `ALTER TABLE users ADD COLUMN onboarding_done INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN referral_code TEXT`,
    `ALTER TABLE users ADD COLUMN referral_credits REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN referred_by TEXT`,
    `ALTER TABLE users ADD COLUMN credits_redeem_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN free_until INTEGER`,
    `ALTER TABLE users ADD COLUMN ai_responses_this_month INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN ai_responses_reset_at INTEGER`,
    `ALTER TABLE users ADD COLUMN extra_response_credits INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN usage_notified_80 INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN usage_notified_100 INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN cta_type TEXT NOT NULL DEFAULT 'contact'`,
    `ALTER TABLE widgets ADD COLUMN avatar_url TEXT`,
    `ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`,
    `ALTER TABLE leads ADD COLUMN notes TEXT`,
    `ALTER TABLE leads ADD COLUMN gdpr_consent INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column exists */ }
  }

  console.log('Database initialized.');
}

function searchKnowledge(widgetId, query, limit = 6) {
  const db = getDb();
  try {
    const clean = query.replace(/[^\w\sáäčďéíľĺňóôŕšťúýžÁÄČĎÉÍĽĹŇÓÔŔŠŤÚÝŽ]/g, ' ').trim();
    if (clean) {
      const rows = db.prepare(`
        SELECT ki.id, ki.title, ki.content, ki.source_type
        FROM knowledge_fts
        JOIN knowledge_items ki ON ki.rowid = knowledge_fts.rowid
        WHERE knowledge_fts MATCH ? AND ki.widget_id = ?
        LIMIT ?
      `).all(clean, widgetId, limit);
      if (rows.length > 0) return rows;
    }
  } catch { /* FTS failed */ }

  return db.prepare(
    `SELECT id, title, content, source_type FROM knowledge_items
     WHERE widget_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(widgetId, limit);
}

module.exports = { getDb, initDatabase, searchKnowledge };
