-- Sky First Workspace expansion
ALTER TABLE users ADD COLUMN cover_key TEXT;
ALTER TABLE users ADD COLUMN profile_status TEXT NOT NULL DEFAULT 'available';
ALTER TABLE users ADD COLUMN allow_signature_change INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN allow_theme_change INTEGER NOT NULL DEFAULT 1;

ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_user_id, email),
  FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mailbox_id INTEGER,
  name TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_labels (
  message_id INTEGER NOT NULL,
  label_id INTEGER NOT NULL,
  PRIMARY KEY(message_id, label_id),
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mailbox_id INTEGER,
  name TEXT NOT NULL,
  sender_contains TEXT,
  subject_contains TEXT,
  action_folder TEXT,
  action_star INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  body TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS managed_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'configured',
  receive_enabled INTEGER NOT NULL DEFAULT 1,
  send_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO managed_domains(domain,status,receive_enabled,send_enabled)
VALUES('skyfirst.io.vn','configured',1,0);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_user_id, display_name);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rules_user ON mail_rules(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id, name);
