-- V12: provider-independent domain transport + verification metadata.
ALTER TABLE managed_domains ADD COLUMN transport TEXT NOT NULL DEFAULT 'resend';
ALTER TABLE managed_domains ADD COLUMN verification_token TEXT;
ALTER TABLE managed_domains ADD COLUMN verified_at TEXT;
ALTER TABLE managed_domains ADD COLUMN last_checked_at TEXT;
ALTER TABLE managed_domains ADD COLUMN health_json TEXT;
ALTER TABLE managed_domains ADD COLUMN inbound_adapter TEXT NOT NULL DEFAULT 'cloudflare_email_routing';
CREATE INDEX IF NOT EXISTS idx_managed_domains_status ON managed_domains(status,send_enabled,receive_enabled);
