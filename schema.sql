-- Job tracking for stem separation requests.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source_key TEXT NOT NULL,            -- R2 key of the uploaded original
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  external_id TEXT,                    -- id of the job at the separation backend (e.g. Replicate prediction id)
  stems TEXT,                          -- JSON array: [{ "name": "vocals", "key": "stems/<job>/vocals.mp3" }, ...]
  error TEXT,
  model TEXT,                          -- catalogue contract id (src/separation/options.ts), not a provider model name
                                       -- current: vocals_instrumental (2) | htdemucs_ft (4) | htdemucs_6s (6) | bs_roformer_vocals (2, local)
                                       -- NULL on pre-2026-07 rows; read as htdemucs_ft
  labels TEXT,                         -- JSON map: { "<stem name>": "<display label>" }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);

-- Shared time-anchored notes on a track, shown as seek-bar markers.
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_job ON annotations (job_id);

-- Cached AI listening guides (one per job, generated lazily, class-shared).
CREATE TABLE IF NOT EXISTS guides (
  job_id TEXT PRIMARY KEY,             -- jobs.id
  text TEXT NOT NULL,                  -- the generated guide prose
  model TEXT NOT NULL,                 -- ASSISTANT_MODEL slug that produced it
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
