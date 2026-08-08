-- Teacher accounts, sessions, and the editable Listening Guy prompt amendment.

-- Credentials are seeded from the TEACHER_SEED secret, never from this file:
-- password_hash is PBKDF2-HMAC-SHA256 over a per-user random salt.
CREATE TABLE IF NOT EXISTS teachers (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  salt TEXT NOT NULL,                  -- hex, 16 bytes
  password_hash TEXT NOT NULL,         -- hex, 32 bytes
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only the SHA-256 of the session token is stored, so a database copy does not
-- hand over live sessions.
CREATE TABLE IF NOT EXISTS teacher_sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teacher_sessions_expires ON teacher_sessions (expires_at);

-- Single-row settings table (id is pinned to 1). The amendment is appended to
-- the Listening Guy system prompt; the built-in guardrails still follow it.
CREATE TABLE IF NOT EXISTS assistant_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  amendment TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO assistant_settings (id, amendment) VALUES (1, '') ON CONFLICT(id) DO NOTHING;
