-- Sky First Mail V13: Verification (Blue Tick & BIMI), Recall & Undo Send, Anti-Spam Queue & Suppression, Send-As Delegation, Security Alerts
ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE users ADD COLUMN department TEXT;
ALTER TABLE users ADD COLUMN verified_at TEXT;
ALTER TABLE users ADD COLUMN verified_by INTEGER;
ALTER TABLE users ADD COLUMN verification_reason TEXT;
ALTER TABLE users ADD COLUMN expires_at TEXT;
ALTER TABLE users ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT 1073741824;
ALTER TABLE users ADD COLUMN daily_send_limit INTEGER NOT NULL DEFAULT 200;
ALTER TABLE users ADD COLUMN hourly_send_limit INTEGER NOT NULL DEFAULT 50;
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_secret TEXT;

ALTER TABLE user_preferences ADD COLUMN undo_send_seconds INTEGER NOT NULL DEFAULT 10;

ALTER TABLE managed_domains ADD COLUMN dkim_selector TEXT NOT NULL DEFAULT 'resend';
ALTER TABLE managed_domains ADD COLUMN bimi_logo_url TEXT DEFAULT 'https://mail.skyfirst.io.vn/bimi-logo.svg';
ALTER TABLE managed_domains ADD COLUMN bimi_vmc_url TEXT;
ALTER TABLE managed_domains ADD COLUMN external_verification_status TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE managed_domains ADD COLUMN daily_send_limit INTEGER NOT NULL DEFAULT 2000;

ALTER TABLE messages ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN snoozed_until TEXT;
ALTER TABLE messages ADD COLUMN content_sha256 TEXT;
ALTER TABLE messages ADD COLUMN hash_recorded_at TEXT;
ALTER TABLE messages ADD COLUMN recalled_at TEXT;
ALTER TABLE messages ADD COLUMN recall_reason TEXT;
ALTER TABLE messages ADD COLUMN email_category TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE messages ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN inbound_auth_json TEXT;
ALTER TABLE messages ADD COLUMN actor_user_id INTEGER;

CREATE TABLE IF NOT EXISTS verification_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'personal',
  department TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_history_user ON verification_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS send_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id INTEGER NOT NULL,
  grantee_user_id INTEGER NOT NULL,
  allowed_address TEXT NOT NULL COLLATE NOCASE,
  permission_mode TEXT NOT NULL DEFAULT 'send_as',
  purpose TEXT,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  UNIQUE(grantee_user_id, allowed_address),
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY(grantee_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_send_delegations_grantee ON send_delegations(grantee_user_id, is_active);

CREATE TABLE IF NOT EXISTS send_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  mailbox_id INTEGER NOT NULL,
  sender_address TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  reply_to TEXT,
  in_reply_to TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  email_category TEXT NOT NULL DEFAULT 'personal',
  storage_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_flags_json TEXT NOT NULL DEFAULT '[]',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  deliver_after TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue(status, deliver_after);
CREATE INDEX IF NOT EXISTS idx_send_queue_user ON send_queue(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_recalls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  operation_id TEXT,
  requester_user_id INTEGER NOT NULL,
  sender_address TEXT NOT NULL,
  reason TEXT,
  overall_status TEXT NOT NULL,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  recalled_count INTEGER NOT NULL DEFAULT 0,
  external_count INTEGER NOT NULL DEFAULT 0,
  already_read_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(requester_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_recalls_message ON message_recalls(message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppression_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  reason TEXT NOT NULL DEFAULT 'manual_block',
  source TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_suppression_email ON suppression_list(email);

CREATE TABLE IF NOT EXISTS security_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL DEFAULT 'medium',
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail_json TEXT,
  user_id INTEGER,
  is_resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY(resolved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_security_alerts_open ON security_alerts(is_resolved, created_at DESC);

INSERT OR IGNORE INTO settings(key, value_json) VALUES
  ('official_domain', '"mail.skyfirst.io.vn"'),
  ('spam_policy', '{"maxRecipientsPerMessage":50,"defaultHourlyLimit":50,"defaultDailyLimit":200,"newAccountHourlyLimit":20,"riskBlockThreshold":80,"riskHoldThreshold":60,"bounceAlertThresholdPct":10,"complaintAlertThresholdPct":0.5}');
