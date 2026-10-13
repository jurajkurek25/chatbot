'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = (() => {
  // Tests run against an in-memory database
  if (process.env.NEOWORKLY_DB_FILE) return process.env.NEOWORKLY_DB_FILE;
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
    CREATE TABLE IF NOT EXISTS shop_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      store_name TEXT NOT NULL DEFAULT '',
      primary_color TEXT NOT NULL DEFAULT '#5b4fff',
      support_email TEXT NOT NULL DEFAULT '',
      custom_css TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS digital_products (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'file',
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      cover_url TEXT NOT NULL DEFAULT '',
      access_days INTEGER NOT NULL DEFAULT 0,
      thank_you TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_digital_products_user ON digital_products(user_id);
    CREATE TABLE IF NOT EXISTS course_modules (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES digital_products(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS course_lessons (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES digital_products(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      free_preview INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS digital_files (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES digital_products(id) ON DELETE CASCADE,
      lesson_id TEXT REFERENCES course_lessons(id) ON DELETE CASCADE,
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS membership_includes (
      membership_id TEXT NOT NULL REFERENCES digital_products(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES digital_products(id) ON DELETE CASCADE,
      PRIMARY KEY (membership_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login_at INTEGER,
      UNIQUE (user_id, email)
    );
    CREATE TABLE IF NOT EXISTS member_login_tokens (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES digital_products(id) ON DELETE SET NULL,
      product_title TEXT NOT NULL DEFAULT '',
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL DEFAULT 0,
      amount_refunded INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT,
      stripe_payment_intent TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      paid_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
    CREATE TABLE IF NOT EXISTS product_access (
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES digital_products(id) ON DELETE CASCADE,
      order_id TEXT,
      granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (member_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS lesson_progress (
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
      completed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (member_id, lesson_id)
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

    -- Úlohy (podľa Vikunja): projekty, stĺpce kanbanu, úlohy, riešitelia, štítky, komentáre
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#5b4fff',
      description TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS task_buckets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      is_done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      bucket_id TEXT,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      done_at INTEGER,
      due_at INTEGER,
      start_at INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      percent INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      repeat_days INTEGER NOT NULL DEFAULT 0,
      remind_at INTEGER,
      reminded INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, bucket_id, position);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(owner_id, due_at);
    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      PRIMARY KEY (task_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#9b8cff',
      UNIQUE(owner_id, name)
    );
    CREATE TABLE IF NOT EXISTS task_labels (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    );
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Kalendár (FullCalendar): udalosti tímu, účastníci, videohovor
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#5b4fff',
      repeat TEXT NOT NULL DEFAULT 'none' CHECK(repeat IN ('none','daily','weekly','monthly','yearly')),
      repeat_until INTEGER,
      meeting_room TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_events_owner ON calendar_events(owner_id, start_at);
    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE
    );

    -- Rýchle poznámky (podľa Memos) a dokumenty (BlockNote, obsah v yjs_docs)
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'workspace' CHECK(visibility IN ('workspace','private')),
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_id, created_at);
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Bez názvu',
      icon TEXT NOT NULL DEFAULT '📄',
      drive_item_id TEXT,
      text TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Upozornenia v aplikácii (pridelenie úlohy, komentár, pozvánka, zmienka…)
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      read_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

    -- Spolupráca v reálnom čase: stav zdieľaných dokumentov (Yjs) a prepojenia medzi položkami modulov
    CREATE TABLE IF NOT EXISTS yjs_docs (
      name TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS item_links (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      a_type TEXT NOT NULL,
      a_id TEXT NOT NULL,
      b_type TEXT NOT NULL,
      b_id TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(owner_id, a_type, a_id, b_type, b_id)
    );
    CREATE INDEX IF NOT EXISTS idx_links_a ON item_links(owner_id, a_type, a_id);
    CREATE INDEX IF NOT EXISTS idx_links_b ON item_links(owner_id, b_type, b_id);

    -- Tímový chat (podľa Zulipu): kanály s témami, súkromné kanály a priame správy (kind = 'dm')
    CREATE TABLE IF NOT EXISTS chat_streams (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'stream' CHECK(kind IN ('stream','dm')),
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      private INTEGER NOT NULL DEFAULT 0,
      dm_key TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(owner_id, dm_key)
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      stream_id TEXT NOT NULL REFERENCES chat_streams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      PRIMARY KEY (stream_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stream_id TEXT NOT NULL REFERENCES chat_streams(id) ON DELETE CASCADE,
      topic TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '[]',
      meeting_room TEXT,
      edited_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages ON chat_messages(stream_id, topic, id);
    CREATE TABLE IF NOT EXISTS chat_reactions (
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    -- Tabule (Excalidraw): obsah je Yjs dokument „board:<priestor>:<id>“, na Disku položka s odkazom
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Tabuľa',
      drive_item_id TEXT,
      text TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Grafika zo šablón (podľa Aktivisda): značka tímu, tímové šablóny a návrhy (fabric.js JSON)
    CREATE TABLE IF NOT EXISTS brand_kits (
      owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      colors TEXT NOT NULL DEFAULT '{}',
      fonts TEXT NOT NULL DEFAULT '{}',
      logos TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS design_templates (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Tím',
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      data TEXT NOT NULL,
      thumb TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS designs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Návrh',
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      data TEXT NOT NULL DEFAULT '',
      template_id TEXT,
      thumb TEXT NOT NULL DEFAULT '',
      drive_item_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Formuláre (podľa HeyForm): polia a nastavenia v JSON, verejný odkaz /form/:token
    CREATE TABLE IF NOT EXISTS forms (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT 'Nový formulár',
      description TEXT NOT NULL DEFAULT '',
      fields TEXT NOT NULL DEFAULT '[]',
      settings TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS form_responses (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      email TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_form_responses ON form_responses(form_id, created_at);

    -- Videohovory (Jitsi Meet) založené z chatu alebo úlohy; udalosti kalendára majú vlastné meeting_room
    CREATE TABLE IF NOT EXISTS meetings (
      room TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Prečítané: posledná prečítaná správa v kanáli/téme
    CREATE TABLE IF NOT EXISTS chat_reads (
      user_id TEXT NOT NULL,
      stream_id TEXT NOT NULL REFERENCES chat_streams(id) ON DELETE CASCADE,
      topic TEXT NOT NULL DEFAULT '',
      last_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, stream_id, topic)
    );

    -- E-mail marketing (Resend): kontakty so súhlasom, kampane, automatické série
    CREATE TABLE IF NOT EXISTS email_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      from_name TEXT NOT NULL DEFAULT '',
      from_local TEXT NOT NULL DEFAULT 'info',
      reply_to TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      widget_optin INTEGER NOT NULL DEFAULT 1,
      domain TEXT,
      domain_id TEXT,
      domain_status TEXT,
      domain_records TEXT
    );
    CREATE TABLE IF NOT EXISTS email_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'subscribed' CHECK(status IN ('subscribed','unsubscribed','bounced','complained')),
      source TEXT NOT NULL DEFAULT 'manual',
      tags TEXT NOT NULL DEFAULT '[]',
      consent_at INTEGER,
      unsubscribe_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, email)
    );
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      preheader TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      button_text TEXT NOT NULL DEFAULT '',
      button_url TEXT NOT NULL DEFAULT '',
      segment TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','sent','failed')),
      error TEXT,
      scheduled_at INTEGER,
      sent_at INTEGER,
      recipients INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS email_sends (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      contact_id TEXT NOT NULL REFERENCES email_contacts(id) ON DELETE CASCADE,
      campaign_id TEXT,
      sequence_id TEXT,
      step_index INTEGER,
      resend_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      opened_at INTEGER,
      clicked_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(campaign_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_sends_resend ON email_sends(resend_id);
    CREATE INDEX IF NOT EXISTS idx_email_sends_user ON email_sends(user_id, created_at);
    CREATE TABLE IF NOT EXISTS email_sequences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      trigger TEXT NOT NULL CHECK(trigger IN ('contact_added','lead_magnet','purchase','tag')),
      trigger_ref TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      steps TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS email_enrollments (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES email_contacts(id) ON DELETE CASCADE,
      step INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','stopped')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(sequence_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_enroll_due ON email_enrollments(status, next_at);

    -- Disk: priečinky a súbory účtu (tím podľa team_members), kôš cez trashed_at
    CREATE TABLE IF NOT EXISTS drive_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('folder','file')),
      name TEXT NOT NULL,
      stored_name TEXT,
      mime TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      system TEXT,
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      member_upload INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      trashed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_drive_parent ON drive_items(owner_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_drive_member ON drive_items(member_id);
    CREATE TABLE IF NOT EXISTS drive_shares (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      allow_upload INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      expires_at INTEGER,
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      revoked_at INTEGER,
      downloads INTEGER NOT NULL DEFAULT 0
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
    // Payments (paid bookings)
    `ALTER TABLE booking_services ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE booking_services ADD COLUMN deposit_amount REAL`,
    `ALTER TABLE booking_configs ADD COLUMN refund_policy TEXT NOT NULL DEFAULT 'full'`,
    `ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE bookings ADD COLUMN amount_due INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN amount_paid INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN amount_refunded INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN currency TEXT`,
    `ALTER TABLE bookings ADD COLUMN stripe_session_id TEXT`,
    `ALTER TABLE bookings ADD COLUMN stripe_payment_intent TEXT`,
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
    `ALTER TABLE leads ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE leads ADD COLUMN source TEXT`,
    `ALTER TABLE orders ADD COLUMN withdrawal_waiver_at INTEGER`,
    `ALTER TABLE drive_items ADD COLUMN ref TEXT`,
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
