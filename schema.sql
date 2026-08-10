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
  routing_request TEXT,                -- NULL for legacy/explicit jobs; "auto" when server analysis was requested
  source_type TEXT,                    -- upload | youtube | archive for analyzed jobs
  source_hash TEXT                     -- server-verified lowercase SHA-256 of stored source bytes
    CHECK (source_hash IS NULL OR (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    )),
  analysis TEXT,                       -- versioned AutoRoutingDecision JSON; never source audio/URL/credentials
  labels TEXT,                         -- JSON map: { "<stem name>": "<display label>" }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);

-- Once recorded, exact source identity may be repeated but never rebound to
-- different bytes or cleared. Legacy rows can still transition NULL -> hash.
CREATE TRIGGER IF NOT EXISTS jobs_source_hash_immutable
BEFORE UPDATE OF source_hash ON jobs
FOR EACH ROW
WHEN OLD.source_hash IS NOT NULL AND NEW.source_hash IS NOT OLD.source_hash
BEGIN
  SELECT RAISE(ABORT, 'jobs.source_hash is immutable once set');
END;

-- A stored digest identifies the bytes at this exact source locator. Neither
-- the object key nor its source class may be rebound underneath that digest.
CREATE TRIGGER IF NOT EXISTS jobs_source_locator_immutable
BEFORE UPDATE OF source_key, source_type ON jobs
FOR EACH ROW
WHEN OLD.source_hash IS NOT NULL
  AND (
    NEW.source_key IS NOT OLD.source_key
    OR NEW.source_type IS NOT OLD.source_type
  )
BEGIN
  SELECT RAISE(ABORT, 'jobs source locator is immutable once source_hash is set');
END;

-- Independently queried long-tail targets. These rows never alter jobs.stems,
-- and their cache identity binds the source bytes, prompt, and exact provider.
CREATE TABLE IF NOT EXISTS instrument_isolations (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT '1' CHECK (schema_version = '1'),
  job_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  source_hash TEXT NOT NULL
    CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'youtube', 'archive')),
  normalized_target TEXT NOT NULL CHECK (length(normalized_target) BETWEEN 2 AND 80),
  analysis_vocabulary_version TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  provider_version TEXT NOT NULL
    CHECK (length(provider_version) = 64 AND provider_version NOT GLOB '*[^0-9a-f]*'),
  provider_contract_version TEXT NOT NULL,
  cache_key TEXT NOT NULL
    CHECK (
      length(cache_key) = 83
      AND substr(cache_key, 1, 19) = 'query-isolation/v1/'
      AND substr(cache_key, 20) NOT GLOB '*[^0-9a-f]*'
    ),
  rollout_stage TEXT NOT NULL DEFAULT 'shadow'
    CHECK (rollout_stage IN ('shadow', 'teacher_beta')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  external_id TEXT,
  target_key TEXT,
  residual_key TEXT,
  failure_code TEXT,
  failure_retryable INTEGER CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
  deadline_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (job_id, cache_key),
  CHECK (attempts <= max_attempts),
  CHECK (status <> 'queued' OR (external_id IS NULL AND deadline_at IS NULL)),
  CHECK (status <> 'processing' OR deadline_at IS NOT NULL),
  CHECK (status <> 'succeeded' OR target_key IS NOT NULL),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL),
  CHECK (
    target_key IS NULL
    OR substr(target_key, 1, length('isolations/' || id || '/')) = 'isolations/' || id || '/'
  ),
  CHECK (
    residual_key IS NULL
    OR substr(residual_key, 1, length('isolations/' || id || '/')) = 'isolations/' || id || '/'
  )
);

CREATE INDEX IF NOT EXISTS idx_instrument_isolations_job
  ON instrument_isolations (job_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_instrument_isolations_cache
  ON instrument_isolations (cache_key, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instrument_isolations_one_processing_per_job
  ON instrument_isolations (job_id) WHERE status = 'processing';

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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  prompt_version TEXT NOT NULL DEFAULT '', -- code-owned SYSTEM_PROMPT_VERSION
  prompt_revision INTEGER NOT NULL DEFAULT -1, -- assistant_settings.revision
  prompt_hash TEXT NOT NULL DEFAULT '' -- effective multi-variant policy SHA-256
    CHECK (prompt_hash = '' OR (
      length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'
    ))
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revision INTEGER NOT NULL DEFAULT 0
);

INSERT INTO assistant_settings (id, amendment) VALUES (1, '') ON CONFLICT(id) DO NOTHING;

-- Append-only prompt amendment history. The base prompt is versioned in
-- src/assistant/prompt.ts; every revision stores that version and fingerprint
-- so runtime changes can be matched to the code/changelog that governed them.
CREATE TABLE IF NOT EXISTS assistant_prompt_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settings_revision INTEGER NOT NULL UNIQUE,
  amendment TEXT NOT NULL,
  change_note TEXT NOT NULL,
  base_prompt_version TEXT NOT NULL,
  base_prompt_hash TEXT NOT NULL,
  effective_prompt_hash TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompt_revisions_created
  ON assistant_prompt_revisions (created_at DESC, id DESC);

-- History is not merely API-append-only. Prevent direct mutation, deletion,
-- and INSERT OR REPLACE from rewriting an existing audit identity.
CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_validate_insert
BEFORE INSERT ON assistant_prompt_revisions
WHEN typeof(NEW.settings_revision) <> 'integer'
  OR NEW.settings_revision < 1
  OR length(NEW.amendment) > 2000
  OR length(trim(NEW.change_note)) < 1
  OR length(NEW.change_note) > 240
  OR length(NEW.base_prompt_version) < 1
  OR length(NEW.base_prompt_version) > 80
  OR length(NEW.base_prompt_hash) <> 64
  OR NEW.base_prompt_hash GLOB '*[^0-9a-f]*'
  OR length(NEW.effective_prompt_hash) <> 64
  OR NEW.effective_prompt_hash GLOB '*[^0-9a-f]*'
  OR length(NEW.updated_by) < 1
  OR length(NEW.updated_by) > 64
  OR NEW.updated_by GLOB '*[^A-Za-z0-9._-]*'
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history row is invalid');
END;

CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_no_update
BEFORE UPDATE ON assistant_prompt_revisions
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_no_delete
BEFORE DELETE ON assistant_prompt_revisions
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_no_replace
BEFORE INSERT ON assistant_prompt_revisions
WHEN EXISTS (
  SELECT 1 FROM assistant_prompt_revisions
  WHERE id = NEW.id OR settings_revision = NEW.settings_revision
)
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history is append-only');
END;
