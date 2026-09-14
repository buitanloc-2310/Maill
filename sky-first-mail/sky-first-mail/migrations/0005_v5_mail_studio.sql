-- Sky First Mail V5: HTML Mail Studio, templates, richer drafts and delivery metadata
ALTER TABLE compose_drafts ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE compose_drafts ADD COLUMN body_html TEXT;
ALTER TABLE compose_drafts ADD COLUMN sender_address TEXT;
ALTER TABLE compose_drafts ADD COLUMN reply_to_message_id INTEGER;

CREATE TABLE IF NOT EXISTS mail_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'personal',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mail_templates_user ON mail_templates(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  provider TEXT NOT NULL DEFAULT 'resend',
  provider_message_id TEXT,
  event_type TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_delivery_events_message ON delivery_events(message_id, created_at DESC);
