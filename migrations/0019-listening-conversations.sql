-- Listening Guy conversation history is private to one CUNY account and one
-- split. Retention follows the split's fixed 90-day lifetime.
CREATE TABLE IF NOT EXISTS listening_conversations (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES app_users(subject),
  entries TEXT NOT NULL CHECK (json_valid(entries) AND json_type(entries) = 'array'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (job_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_listening_conversations_expiry ON listening_conversations(expires_at);
