CREATE TABLE IF NOT EXISTS send_operations (
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'preparing',storage_key TEXT,provider_id TEXT,response_json TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id));
CREATE INDEX IF NOT EXISTS idx_send_operations_user ON send_operations(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0,window_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inbound_receipts (mailbox_id INTEGER NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(mailbox_id,digest));
