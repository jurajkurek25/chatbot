'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = (() => {
  // Keep backward-compatible filename; rename old file if it exists
  const newPath = path.join(__dirname, '..', 'data', 'neoworkly.db');
  const oldPath = path.join(__dirname, '..', 'data', 'neuradesk.db');
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
  }
  return newPath;
})();

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
      cta_type TEXT NOT NULL DEFAULT 'contact',
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

    CREATE TABLE IF NOT EXISTS shopify_connections (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      shop_name TEXT,
      shop_email TEXT,
      neoworkly_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      widget_id TEXT REFERENCES widgets(id) ON DELETE SET NULL,
      script_tag_id TEXT,
      scan_done INTEGER NOT NULL DEFAULT 0,
      nonce TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Booking system ───────────────────────────────────────── */

    CREATE TABLE IF NOT EXISTS booking_configs (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'Europe/Bratislava',
      slot_duration INTEGER NOT NULL DEFAULT 60,
      buffer_between INTEGER NOT NULL DEFAULT 0,
      min_notice INTEGER NOT NULL DEFAULT 60,
      max_advance_days INTEGER NOT NULL DEFAULT 60,
      confirmation_message TEXT NOT NULL DEFAULT '',
      gcal_access_token TEXT,
      gcal_refresh_token TEXT,
      gcal_calendar_id TEXT NOT NULL DEFAULT 'primary',
      gcal_token_expiry INTEGER,
      gcal_email TEXT,
      design_config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(widget_id)
    );

    CREATE TABLE IF NOT EXISTS booking_schedules (
      id TEXT PRIMARY KEY,
      booking_config_id TEXT NOT NULL REFERENCES booking_configs(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      start_time TEXT NOT NULL DEFAULT '09:00',
      end_time TEXT NOT NULL DEFAULT '17:00',
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(booking_config_id, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS booking_overrides (
      id TEXT PRIMARY KEY,
      booking_config_id TEXT NOT NULL REFERENCES booking_configs(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'closed' CHECK(type IN ('closed','custom')),
      start_time TEXT,
      end_time TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(booking_config_id, date)
    );

    CREATE TABLE IF NOT EXISTS booking_services (
      id TEXT PRIMARY KEY,
      booking_config_id TEXT NOT NULL REFERENCES booking_configs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_mins INTEGER NOT NULL DEFAULT 60,
      price REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      active INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      booking_config_id TEXT NOT NULL REFERENCES booking_configs(id) ON DELETE CASCADE,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK(status IN ('confirmed','cancelled','no_show')),
      notes TEXT NOT NULL DEFAULT '',
      internal_notes TEXT NOT NULL DEFAULT '',
      gcal_event_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Lead Magnets ─────────────────────────────────────────── */

    CREATE TABLE IF NOT EXISTS lead_magnets (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      file_url TEXT,
      ai_content TEXT,
      when_to_recommend TEXT,
      target_audience TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS lead_magnet_leads (
      id TEXT PRIMARY KEY,
      lead_magnet_id TEXT NOT NULL REFERENCES lead_magnets(id) ON DELETE CASCADE,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS lead_magnet_files (
      id TEXT PRIMARY KEY,
      lead_magnet_id TEXT NOT NULL REFERENCES lead_magnets(id) ON DELETE CASCADE,
      lang TEXT NOT NULL,
      file_path TEXT,
      file_url TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(lead_magnet_id, lang)
    );

    /* ── Anonymous conversation trend insights ───────────────── */
    CREATE TABLE IF NOT EXISTS conversation_insights (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      topics TEXT NOT NULL DEFAULT '[]',
      intent TEXT NOT NULL DEFAULT '',
      objection TEXT NOT NULL DEFAULT '',
      urgency TEXT NOT NULL DEFAULT '',
      msg_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Booking: staff, their schedules / time off, service↔staff, sent notifications ── */
    CREATE TABLE IF NOT EXISTS booking_staff (
      id TEXT PRIMARY KEY,
      booking_config_id TEXT NOT NULL REFERENCES booking_configs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      photo_url TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      break_start TEXT,
      break_end TEXT,
      max_per_day INTEGER NOT NULL DEFAULT 0,
      max_minutes_per_day INTEGER NOT NULL DEFAULT 0,
      max_per_week INTEGER NOT NULL DEFAULT 0,
      gcal_access_token TEXT,
      gcal_refresh_token TEXT,
      gcal_token_expiry INTEGER,
      gcal_email TEXT,
      gcal_calendar_id TEXT NOT NULL DEFAULT 'primary',
      ics_token TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS booking_staff_schedules (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL REFERENCES booking_staff(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      start_time TEXT NOT NULL DEFAULT '09:00',
      end_time TEXT NOT NULL DEFAULT '17:00',
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(staff_id, day_of_week)
    );
    CREATE TABLE IF NOT EXISTS booking_time_off (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL REFERENCES booking_staff(id) ON DELETE CASCADE,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'closed',
      start_time TEXT,
      end_time TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS booking_service_staff (
      service_id TEXT NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL REFERENCES booking_staff(id) ON DELETE CASCADE,
      PRIMARY KEY (service_id, staff_id)
    );
    CREATE TABLE IF NOT EXISTS booking_notifications (
      booking_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (booking_id, kind)
    );

    /* ── Questions the bot couldn't answer from the knowledge base ── */
    CREATE TABLE IF NOT EXISTS unanswered_questions (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_unanswered_widget ON unanswered_questions(widget_id, created_at);

    /* ── Facebook Messenger ──────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS facebook_connections (
      id TEXT PRIMARY KEY,
      widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL,
      page_name TEXT,
      page_access_token TEXT NOT NULL,
      keyword_triggers TEXT NOT NULL DEFAULT '[]',
      welcome_msg TEXT NOT NULL DEFAULT '',
      connected_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(widget_id)
    );

    CREATE TABLE IF NOT EXISTS facebook_dm_sessions (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES facebook_connections(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      history TEXT NOT NULL DEFAULT '[]',
      live_agent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(connection_id, sender_id)
    );

    /* ── Team members ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'readonly' CHECK(role IN ('readonly','editor')),
      invite_token TEXT,
      accepted INTEGER NOT NULL DEFAULT 0,
      member_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(owner_user_id, email)
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
    `ALTER TABLE users ADD COLUMN trial_until INTEGER`,
    `ALTER TABLE widgets ADD COLUMN allowed_domains TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE widgets ADD COLUMN widget_side TEXT NOT NULL DEFAULT 'right'`,
    `ALTER TABLE widgets ADD COLUMN offset_x INTEGER NOT NULL DEFAULT 24`,
    `ALTER TABLE widgets ADD COLUMN offset_y INTEGER NOT NULL DEFAULT 24`,
    `ALTER TABLE widgets ADD COLUMN offset_x_mobile INTEGER NOT NULL DEFAULT 12`,
    `ALTER TABLE widgets ADD COLUMN offset_y_mobile INTEGER NOT NULL DEFAULT 12`,
    `ALTER TABLE widgets ADD COLUMN z_index INTEGER NOT NULL DEFAULT 2147483000`,
    `ALTER TABLE widgets ADD COLUMN hide_on_mobile INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN show_on_paths TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE widgets ADD COLUMN off_topic_message TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE widgets ADD COLUMN no_context_message TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE widgets ADD COLUMN handoff_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN handoff_email TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE conversations ADD COLUMN handoff_at INTEGER`,
    `ALTER TABLE booking_configs ADD COLUMN slot_interval INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE booking_configs ADD COLUMN cancel_hours INTEGER NOT NULL DEFAULT 24`,
    `ALTER TABLE booking_configs ADD COLUMN allow_cancel INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE booking_configs ADD COLUMN allow_reschedule INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE booking_configs ADD COLUMN reminders_customer TEXT NOT NULL DEFAULT '[1440,60]'`,
    `ALTER TABLE booking_configs ADD COLUMN reminders_staff TEXT NOT NULL DEFAULT '[60]'`,
    `ALTER TABLE booking_configs ADD COLUMN notify_staff INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE booking_configs ADD COLUMN custom_css TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE booking_configs ADD COLUMN staff_selection TEXT NOT NULL DEFAULT 'choose'`,
    `ALTER TABLE booking_configs ADD COLUMN require_phone INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE booking_services ADD COLUMN buffer_before INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE booking_services ADD COLUMN buffer_after INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE booking_services ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE booking_services ADD COLUMN location_type TEXT NOT NULL DEFAULT 'in_person'`,
    `ALTER TABLE booking_services ADD COLUMN location_detail TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE booking_services ADD COLUMN questions TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE bookings ADD COLUMN staff_id TEXT`,
    `ALTER TABLE bookings ADD COLUMN manage_token TEXT`,
    `ALTER TABLE bookings ADD COLUMN answers TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE bookings ADD COLUMN seats INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE bookings ADD COLUMN start_utc INTEGER`,
    `ALTER TABLE bookings ADD COLUMN end_utc INTEGER`,
    `ALTER TABLE bookings ADD COLUMN buffer_before INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN buffer_after INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN location_type TEXT`,
    `ALTER TABLE bookings ADD COLUMN location_detail TEXT`,
    `ALTER TABLE bookings ADD COLUMN cancelled_by TEXT`,
    `ALTER TABLE bookings ADD COLUMN cancel_reason TEXT`,
    `ALTER TABLE bookings ADD COLUMN reschedule_count INTEGER NOT NULL DEFAULT 0`,
    // Wellbeing: work-life rules set by the owner, health data set privately by the staff member
    `ALTER TABLE booking_staff ADD COLUMN max_consecutive INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE booking_staff ADD COLUMN consecutive_break INTEGER NOT NULL DEFAULT 15`,
    `ALTER TABLE booking_staff ADD COLUMN no_meeting_days TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE booking_staff ADD COLUMN day_end TEXT`,
    `ALTER TABLE booking_staff ADD COLUMN wellbeing_token TEXT`,
    `ALTER TABLE booking_staff ADD COLUMN share_with_owner INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE booking_staff ADD COLUMN cycle_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE booking_staff ADD COLUMN cycle_last_start TEXT`,
    `ALTER TABLE booking_staff ADD COLUMN cycle_length INTEGER NOT NULL DEFAULT 28`,
    `ALTER TABLE booking_staff ADD COLUMN period_length INTEGER NOT NULL DEFAULT 5`,
    `ALTER TABLE booking_staff ADD COLUMN phase_rules TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE booking_staff ADD COLUMN burnout_alert_at INTEGER`,
    `ALTER TABLE booking_time_off ADD COLUMN reason TEXT NOT NULL DEFAULT 'other'`,
    `ALTER TABLE booking_time_off ADD COLUMN private INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN cta_type TEXT NOT NULL DEFAULT 'contact'`,
    `ALTER TABLE widgets ADD COLUMN avatar_url TEXT`,
    `ALTER TABLE widgets ADD COLUMN proactive_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN proactive_delay INTEGER NOT NULL DEFAULT 4`,
    `ALTER TABLE widgets ADD COLUMN proactive_message TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`,
    `ALTER TABLE leads ADD COLUMN notes TEXT`,
    `ALTER TABLE leads ADD COLUMN gdpr_consent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN gdpr_text TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN service_id TEXT`,
    `ALTER TABLE bookings ADD COLUMN service_name TEXT`,
    `ALTER TABLE bookings ADD COLUMN ai_summary TEXT`,
    `ALTER TABLE booking_configs ADD COLUMN design_config TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN insight_done INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN webhook_url TEXT`,
    `ALTER TABLE widgets ADD COLUMN slack_webhook_url TEXT`,
    `ALTER TABLE widgets ADD COLUMN business_hours TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE widgets ADD COLUMN offline_message TEXT NOT NULL DEFAULT 'Momentálne sme offline. Ozveme sa vám čoskoro.'`,
    `ALTER TABLE widgets ADD COLUMN hide_branding INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN welcome_message_b TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE widgets ADD COLUMN ab_test_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN auto_reply_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE widgets ADD COLUMN auto_reply_message TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE widgets ADD COLUMN csat_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE leads ADD COLUMN csat_rating INTEGER`,
    `ALTER TABLE leads ADD COLUMN follow_up_sent_at INTEGER`,
    `ALTER TABLE leads ADD COLUMN ab_variant TEXT NOT NULL DEFAULT 'a'`,
    `ALTER TABLE conversations ADD COLUMN live_agent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversations ADD COLUMN csat_rating INTEGER`,
    `ALTER TABLE widgets ADD COLUMN ecomail_api_key TEXT`,
    `ALTER TABLE widgets ADD COLUMN ecomail_list_id TEXT`,
    `ALTER TABLE widgets ADD COLUMN ecomail_list_name TEXT`,
    `ALTER TABLE users ADD COLUMN subscription_plan TEXT NOT NULL DEFAULT 'pro'`,
    `ALTER TABLE widgets ADD COLUMN suggested_questions_i18n TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE users ADD COLUMN password_reset_token TEXT`,
    `ALTER TABLE users ADD COLUMN password_reset_expires INTEGER`,
    `ALTER TABLE shopify_connections RENAME COLUMN neuradesk_user_id TO neoworkly_user_id`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column exists or not applicable */ }
  }

  // Remove CHECK constraint from widgets.cta_type so 'booking' and future types work
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='widgets'").get();
    if (schema && schema.sql.includes('CHECK')) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE widgets_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          bot_name TEXT NOT NULL DEFAULT 'Asistent',
          welcome_message TEXT NOT NULL DEFAULT 'Ahoj! Ako vám môžem pomôcť?',
          primary_color TEXT NOT NULL DEFAULT '#2563eb',
          goals TEXT NOT NULL DEFAULT '',
          cta_type TEXT NOT NULL DEFAULT 'contact',
          cta_config TEXT NOT NULL DEFAULT '{}',
          suggested_questions TEXT NOT NULL DEFAULT '[]',
          active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          avatar_url TEXT,
          proactive_enabled INTEGER NOT NULL DEFAULT 0,
          proactive_delay INTEGER NOT NULL DEFAULT 4,
          proactive_message TEXT NOT NULL DEFAULT '',
          gdpr_text TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO widgets_new SELECT id,user_id,name,bot_name,welcome_message,primary_color,goals,cta_type,cta_config,suggested_questions,active,created_at,avatar_url,proactive_enabled,proactive_delay,proactive_message,gdpr_text FROM widgets;
        DROP TABLE widgets;
        ALTER TABLE widgets_new RENAME TO widgets;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch { /* already migrated or fresh install */ }

  // Drop the CHECK on bookings.status so new states (e.g. pending payment) are possible
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get();
    if (schema && /CHECK\s*\(\s*status IN/i.test(schema.sql)) {
      const newSql = schema.sql
        .replace(/\s*CHECK\s*\(\s*status IN\s*\([^)]*\)\s*\)/i, '')
        .replace(/CREATE TABLE\s+"?bookings"?/i, 'CREATE TABLE bookings_new');
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(newSql);
        db.exec('INSERT INTO bookings_new SELECT * FROM bookings');
        db.exec('DROP TABLE bookings');
        db.exec('ALTER TABLE bookings_new RENAME TO bookings');
      })();
      db.pragma('foreign_keys = ON');
    }
  } catch (err) { console.error('bookings status migration failed:', err.message); }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookings_staff_date ON bookings(staff_id, date);
           CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_manage_token ON bookings(manage_token);
           CREATE INDEX IF NOT EXISTS idx_bookings_start_utc ON bookings(start_utc);`);

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
