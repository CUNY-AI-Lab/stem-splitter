-- Job tracking for stem separation requests.
CREATE TABLE IF NOT EXISTS public_split_links (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- A provider-start reservation is permanent budget evidence even when the
-- provider later fails. It is separate from output caching and core stems.
CREATE TABLE IF NOT EXISTS instrument_isolation_budget_reservations (
  isolation_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 5),
  job_id TEXT NOT NULL,
  cache_key TEXT NOT NULL
    CHECK (
      length(cache_key) = 83
      AND substr(cache_key, 1, 19) = 'query-isolation/v1/'
      AND substr(cache_key, 20) NOT GLOB '*[^0-9a-f]*'
    ),
  requested_by TEXT NOT NULL
    CHECK (
      length(requested_by) BETWEEN 1 AND 64
      AND requested_by NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  course_id TEXT NOT NULL
    CHECK (
      length(course_id) BETWEEN 2 AND 64
      AND substr(course_id, 1, 1) GLOB '[a-z0-9]'
      AND course_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  semester_id TEXT NOT NULL
    CHECK (
      length(semester_id) BETWEEN 2 AND 64
      AND substr(semester_id, 1, 1) GLOB '[a-z0-9]'
      AND semester_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  policy_version TEXT NOT NULL
    CHECK (policy_version = 'course-semester-provider-starts-v1'),
  maximum_provider_starts INTEGER NOT NULL
    CHECK (maximum_provider_starts BETWEEN 1 AND 1000),
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (isolation_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_instrument_isolation_budget_scope
  ON instrument_isolation_budget_reservations (course_id, semester_id, reserved_at);

CREATE TRIGGER IF NOT EXISTS instrument_isolation_budget_reservations_no_update
BEFORE UPDATE ON instrument_isolation_budget_reservations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'instrument isolation budget reservations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS instrument_isolation_budget_reservations_no_delete
BEFORE DELETE ON instrument_isolation_budget_reservations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'instrument isolation budget reservations are immutable');
END;

-- Terminal provider observations are serialized independently from the
-- provider-start attempt. Expired leases can be reclaimed, but acquisition is
-- capped so a broken output cannot loop forever.
CREATE TABLE IF NOT EXISTS instrument_isolation_ingestion_leases (
  isolation_id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL
    CHECK (
      length(external_id) BETWEEN 1 AND 128
      AND external_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  lease_id TEXT
    CHECK (
      lease_id IS NULL OR (
        length(lease_id) BETWEEN 1 AND 128
        AND lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 3),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (isolation_id) REFERENCES instrument_isolations(id) ON DELETE CASCADE,
  CHECK (
    (lease_id IS NULL AND lease_expires_at IS NULL)
    OR (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_instrument_isolation_ingestion_deadline
  ON instrument_isolation_ingestion_leases (lease_expires_at);

-- Output identity is separate from both core stems and provider input. Rows
-- can disappear with their owning job, but cannot be rewritten in place.
CREATE TABLE IF NOT EXISTS instrument_isolation_outputs (
  isolation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('target', 'residual')),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 44 AND 104857600),
  content_type TEXT NOT NULL CHECK (content_type = 'audio/wav'),
  retained_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (isolation_id, kind),
  FOREIGN KEY (isolation_id) REFERENCES instrument_isolations(id) ON DELETE CASCADE,
  CHECK (storage_key = 'isolations/' || isolation_id || '/' || kind || '.wav')
);

CREATE INDEX IF NOT EXISTS idx_instrument_isolation_outputs_retention
  ON instrument_isolation_outputs (retained_until, isolation_id);

CREATE TRIGGER IF NOT EXISTS instrument_isolation_outputs_no_update
BEFORE UPDATE ON instrument_isolation_outputs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'instrument isolation output identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS instrument_isolation_outputs_no_replace
BEFORE INSERT ON instrument_isolation_outputs
WHEN EXISTS (
  SELECT 1 FROM instrument_isolation_outputs
  WHERE (isolation_id = NEW.isolation_id AND kind = NEW.kind)
     OR storage_key = NEW.storage_key
)
BEGIN
  SELECT RAISE(ABORT, 'instrument isolation output identity is immutable');
END;

-- Structured teacher observations about a pinned candidate instrument
-- analysis. These revisions cannot route a split or become training data.
-- Deletion follows the retained job; curation must create a separate,
-- reviewed and de-identified artifact instead of changing these rows in place.
CREATE TABLE IF NOT EXISTS instrument_discovery_feedback (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT '1' CHECK (schema_version = '1'),
  job_id TEXT NOT NULL,
  reviewer TEXT NOT NULL
    CHECK (
      length(reviewer) BETWEEN 1 AND 64
      AND reviewer NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  analysis_sha256 TEXT NOT NULL
    CHECK (length(analysis_sha256) = 64 AND analysis_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_sha256 TEXT NOT NULL
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  classifier_version TEXT NOT NULL CHECK (length(classifier_version) BETWEEN 1 AND 200),
  vocabulary_version TEXT NOT NULL CHECK (length(vocabulary_version) BETWEEN 1 AND 100),
  vocabulary_sha256 TEXT NOT NULL
    CHECK (length(vocabulary_sha256) = 64 AND vocabulary_sha256 NOT GLOB '*[^0-9a-f]*'),
  review_ontology_version TEXT NOT NULL
    CHECK (length(review_ontology_version) BETWEEN 1 AND 100),
  genre_family TEXT NOT NULL CHECK (genre_family IN (
    'unknown', 'rock', 'jazz', 'orchestral-chamber', 'electronic',
    'hip-hop', 'folk-traditional', 'sparse-acoustic', 'other'
  )),
  observations TEXT NOT NULL
    CHECK (
      length(observations) BETWEEN 2 AND 8192
      AND json_valid(observations)
      AND json_type(observations) = 'array'
    ),
  evidence_status TEXT NOT NULL DEFAULT 'unreviewed-candidate'
    CHECK (evidence_status = 'unreviewed-candidate'),
  deidentified INTEGER NOT NULL DEFAULT 0 CHECK (deidentified = 0),
  training_eligible INTEGER NOT NULL DEFAULT 0 CHECK (training_eligible = 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (job_id, reviewer, analysis_sha256, revision)
);

CREATE INDEX IF NOT EXISTS idx_instrument_discovery_feedback_job
  ON instrument_discovery_feedback (job_id, analysis_sha256, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS instrument_discovery_feedback_no_update
BEFORE UPDATE ON instrument_discovery_feedback
BEGIN
  SELECT RAISE(ABORT, 'instrument discovery feedback revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS instrument_discovery_feedback_no_replace
BEFORE INSERT ON instrument_discovery_feedback
WHEN EXISTS (
  SELECT 1 FROM instrument_discovery_feedback
  WHERE id = NEW.id OR (
    job_id = NEW.job_id
    AND reviewer = NEW.reviewer
    AND analysis_sha256 = NEW.analysis_sha256
    AND revision = NEW.revision
  )
)
BEGIN
  SELECT RAISE(ABORT, 'instrument discovery feedback revisions are immutable');
END;

-- Shared time-anchored notes on a track, shown as seek-bar markers.
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  author_subject TEXT,
  author_name TEXT,
  provenance TEXT,
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

-- Instructor folders: named sets of finished splits kept for teaching. Items
-- snapshot filename/model so a folder still lists an entry after the 30-day
-- cleanup removes its job row; the UI shows those as expired.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folder_items (
  folder_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  model TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (folder_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_folder_items_job ON folder_items (job_id);

-- Application roles supplement verified, current CAIL Admission membership.
-- Administrators derive authority from Admission, never from this table.
CREATE TABLE IF NOT EXISTS app_users (
  subject TEXT PRIMARY KEY CHECK (length(subject) = 37 AND subject GLOB 'cail-*'),
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'instructor')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  role_expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_user_events (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL,
  role_expires_at TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subject, revision)
);
CREATE TRIGGER IF NOT EXISTS app_user_events_no_update BEFORE UPDATE ON app_user_events
BEGIN
  SELECT RAISE(ABORT, 'access history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS app_user_events_no_delete BEFORE DELETE ON app_user_events
BEGIN
  SELECT RAISE(ABORT, 'access history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS app_user_events_no_replace BEFORE INSERT ON app_user_events
WHEN EXISTS (SELECT 1 FROM app_user_events WHERE id = NEW.id OR (subject = NEW.subject AND revision = NEW.revision))
BEGIN
  SELECT RAISE(ABORT, 'access history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS app_users_audit AFTER UPDATE ON app_users
BEGIN
  INSERT INTO app_user_events (id, subject, actor, role, disabled, role_expires_at, revision)
  VALUES (lower(hex(randomblob(16))), NEW.subject, NEW.updated_by, NEW.role, NEW.disabled, NEW.role_expires_at, NEW.revision);
END;
CREATE TABLE IF NOT EXISTS job_owners (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES app_users(subject)
);
CREATE INDEX IF NOT EXISTS job_owners_subject ON job_owners(subject);
CREATE TABLE IF NOT EXISTS upload_owners (
  object_key TEXT PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES app_users(subject),
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'uploading', 'ready'))
);
CREATE TABLE IF NOT EXISTS job_attributions (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  attribution TEXT NOT NULL
);
-- Private, account-scoped Listening Guy transcript. Expiry is anchored to the
-- source split's creation time, not extended by later conversation activity.
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
CREATE TABLE IF NOT EXISTS app_request_reservations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES app_users(subject),
  scope TEXT NOT NULL CHECK (scope IN ('split', 'guide')),
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_request_reservations_scope ON app_request_reservations(scope, day, subject);

-- Prospective classroom policy. No existing split or transcript is assigned.
CREATE TABLE IF NOT EXISTS job_courses (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK(policy_version = 'course-work-v1'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS job_courses_member ON job_courses(course_id, member_id, job_id);
CREATE TRIGGER IF NOT EXISTS job_courses_no_update BEFORE UPDATE ON job_courses
BEGIN
  SELECT RAISE(ABORT, 'course assignment is immutable');
END;
CREATE TRIGGER IF NOT EXISTS job_courses_no_replace BEFORE INSERT ON job_courses
WHEN EXISTS(SELECT 1 FROM job_courses WHERE job_id=NEW.job_id)
BEGIN
  SELECT RAISE(ABORT, 'course assignment is immutable');
END;





CREATE TABLE IF NOT EXISTS course_settings (
  course_id TEXT PRIMARY KEY,
  amendment TEXT NOT NULL DEFAULT '' CHECK(length(amendment)<=2000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS course_prompt_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  amendment TEXT NOT NULL CHECK(length(amendment)<=2000),
  change_note TEXT NOT NULL CHECK(length(trim(change_note)) BETWEEN 1 AND 240),
  base_version TEXT NOT NULL,
  base_hash TEXT NOT NULL CHECK(length(base_hash)=64),
  effective_hash TEXT NOT NULL CHECK(length(effective_hash)=64),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id,revision)
);
CREATE TRIGGER IF NOT EXISTS course_prompt_revisions_no_update BEFORE UPDATE ON course_prompt_revisions
BEGIN
  SELECT RAISE(ABORT,'course prompt history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS course_prompt_revisions_no_delete BEFORE DELETE ON course_prompt_revisions
BEGIN
  SELECT RAISE(ABORT,'course prompt history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS course_prompt_revisions_no_replace BEFORE INSERT ON course_prompt_revisions
WHEN EXISTS(SELECT 1 FROM course_prompt_revisions WHERE id=NEW.id OR (course_id=NEW.course_id AND revision=NEW.revision))
BEGIN
  SELECT RAISE(ABORT,'course prompt history is immutable');
END;
CREATE TABLE IF NOT EXISTS course_guides (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  base_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(job_id,course_id)
);

CREATE TABLE IF NOT EXISTS course_conversations (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  pending_turn TEXT,
  pending_expires_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(job_id,subject)
);
CREATE TABLE IF NOT EXISTS course_turns (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  input TEXT NOT NULL CHECK(length(input) BETWEEN 1 AND 2000),
  state TEXT NOT NULL CHECK(state IN ('pending','complete','failed')),
  reply TEXT,
  tools TEXT,
  finish_reason TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(job_id,subject,turn_id)
);
CREATE TABLE IF NOT EXISTS course_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('you','coach','action','status')),
  provenance TEXT NOT NULL CHECK(provenance IN ('student','server-assistant','server-tool','server-status')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS course_messages_page ON course_messages(job_id,subject,seq);

CREATE TABLE IF NOT EXISTS course_folders (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  created_by TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'private' CHECK(permission IN ('private','read','comment')),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS course_folders_course ON course_folders(course_id,id);
CREATE TABLE IF NOT EXISTS course_folder_items (
  folder_id TEXT NOT NULL REFERENCES course_folders(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  model TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(folder_id,job_id)
);
CREATE TABLE IF NOT EXISTS course_folder_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  permission TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(folder_id,revision)
);
CREATE TRIGGER IF NOT EXISTS course_folder_events_no_update BEFORE UPDATE ON course_folder_events
BEGIN
  SELECT RAISE(ABORT,'folder history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS course_folder_events_no_delete BEFORE DELETE ON course_folder_events
BEGIN
  SELECT RAISE(ABORT,'folder history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS course_folder_events_no_replace BEFORE INSERT ON course_folder_events
WHEN EXISTS(SELECT 1 FROM course_folder_events WHERE id=NEW.id OR (folder_id=NEW.folder_id AND revision=NEW.revision))
BEGIN
  SELECT RAISE(ABORT,'folder history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS course_folders_audit AFTER UPDATE OF permission ON course_folders
BEGIN
  INSERT INTO course_folder_events(folder_id,course_id,actor,permission,revision)
VALUES(NEW.id,NEW.course_id,NEW.created_by,NEW.permission,NEW.revision);
END;
-- Deliberately separate from historical app_request_reservations. No inferred
-- successful charges/backfill. Apply only with the queue-drain rollback plan.
CREATE TABLE IF NOT EXISTS app_operations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES app_users(subject),
  course_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('split','chat','guide')),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  day TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','starting','processing','reconciling','succeeded','partial','failed','cancelled')),
  phase TEXT NOT NULL CHECK(phase IN ('fetch','split','chat','guide')),
  job_id TEXT,
  request_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  provider_id TEXT,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  fence INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL DEFAULT 0,
  deadline INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject,kind,idempotency_key)
);
CREATE INDEX IF NOT EXISTS app_operations_allowance ON app_operations(subject,kind,day,state);
CREATE INDEX IF NOT EXISTS app_operations_queue ON app_operations(kind,phase,state,not_before,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS app_operations_split_job ON app_operations(job_id) WHERE kind='split';
CREATE TABLE IF NOT EXISTS operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES app_operations(id),
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  fence INTEGER NOT NULL,
  code TEXT,
  at INTEGER NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'lifecycle',
  attempt_id TEXT,
  kind TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  fallback INTEGER NOT NULL DEFAULT 0,
  quota_effect TEXT NOT NULL DEFAULT 'none'
);
CREATE TRIGGER IF NOT EXISTS operation_created AFTER INSERT ON app_operations BEGIN
  INSERT INTO operation_events(operation_id,state,phase,fence,code,at,kind,duration_ms,quota_effect)
  VALUES(NEW.id,NEW.state,NEW.phase,NEW.fence,NEW.error_code,NEW.updated_at,NEW.kind,
    MAX(0,NEW.updated_at-NEW.created_at),'reserved');
END;
CREATE TRIGGER IF NOT EXISTS operation_changed AFTER UPDATE ON app_operations
WHEN OLD.state<>NEW.state OR OLD.phase<>NEW.phase OR OLD.fence<>NEW.fence BEGIN
  INSERT INTO operation_events(operation_id,state,phase,fence,code,at,kind,duration_ms,quota_effect)
  VALUES(NEW.id,NEW.state,NEW.phase,NEW.fence,NEW.error_code,NEW.updated_at,NEW.kind,
    MAX(0,NEW.updated_at-NEW.created_at),CASE WHEN NEW.state IN ('succeeded','partial') THEN 'charged'
    WHEN NEW.state IN ('failed','cancelled') THEN 'released' ELSE 'none' END);
END;
CREATE TRIGGER IF NOT EXISTS operation_terminal_fence BEFORE UPDATE ON app_operations
WHEN OLD.state IN ('succeeded','partial','failed','cancelled') AND NEW.state<>OLD.state
BEGIN SELECT RAISE(ABORT,'terminal operation'); END;
CREATE TRIGGER IF NOT EXISTS operation_identity_fence BEFORE UPDATE ON app_operations
WHEN NEW.subject<>OLD.subject OR NEW.kind<>OLD.kind OR NEW.day<>OLD.day OR
 NEW.fingerprint<>OLD.fingerprint OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.course_id IS NOT OLD.course_id
BEGIN SELECT RAISE(ABORT,'immutable operation identity'); END;
CREATE TABLE IF NOT EXISTS operation_attempts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES app_operations(id),
  phase TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  outcome TEXT NOT NULL,
  external_id TEXT,
  http_status INTEGER,
  code TEXT,
  -- Provider spend is separate from allowance. NULL means unreported, not free.
  usage_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS operation_attempts_operation ON operation_attempts(operation_id,phase,created_at);
CREATE TABLE IF NOT EXISTS operation_fairness (
  subject TEXT NOT NULL,
  phase TEXT NOT NULL,
  last_started INTEGER NOT NULL,
  PRIMARY KEY(subject,phase)
);
CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL
);
-- Only same subject AND exact authorized course may coalesce/reuse imports.
-- Sources with no affirmative rights evidence (including YouTube) never cache.
CREATE TABLE IF NOT EXISTS import_cache (
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES app_operations(id),
  object_key TEXT,
  metadata_json TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(scope,source)
);
CREATE TRIGGER IF NOT EXISTS operation_job_done_guard BEFORE UPDATE OF status ON jobs
WHEN NEW.status='done' AND EXISTS(SELECT 1 FROM app_operations o WHERE o.job_id=NEW.id AND o.kind='split'
 AND (o.state IN ('failed','cancelled') OR o.cancel_requested=1))
BEGIN SELECT RAISE(ABORT,'operation no longer accepts success'); END;
CREATE TRIGGER IF NOT EXISTS operation_job_delete_guard BEFORE DELETE ON jobs
WHEN EXISTS(SELECT 1 FROM app_operations WHERE job_id=OLD.id AND kind='split'
 AND state NOT IN ('succeeded','partial','failed','cancelled'))
BEGIN SELECT RAISE(ABORT,'cancel and reconcile operation before deleting job'); END;
CREATE TRIGGER IF NOT EXISTS operation_job_settlement AFTER UPDATE OF status ON jobs
WHEN NEW.status IN ('done','failed') BEGIN
 UPDATE app_operations SET state=CASE WHEN NEW.status='done' THEN 'succeeded'
   WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END,
   lease_owner=NULL,lease_until=0,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE job_id=NEW.id AND kind='split' AND state NOT IN ('succeeded','partial','failed','cancelled');
END;

-- Attempts and lifecycle events are in the same transaction as their evidence.
-- No body, transcript, filename, source URL, name, email or credential is copied.
CREATE TRIGGER IF NOT EXISTS operation_attempt_created AFTER INSERT ON operation_attempts BEGIN
 INSERT INTO operation_events(operation_id,state,phase,fence,code,at,event_type,attempt_id,kind,duration_ms,model,fallback)
 SELECT NEW.operation_id,NEW.outcome,NEW.phase,o.fence,NEW.code,NEW.created_at,'attempt_start',NEW.id,o.kind,0,NEW.model,
  CASE WHEN NEW.provider='cail-gateway' AND EXISTS(SELECT 1 FROM operation_attempts a WHERE a.operation_id=NEW.operation_id AND a.id<>NEW.id) THEN 1 ELSE 0 END
 FROM app_operations o WHERE o.id=NEW.operation_id;
END;
CREATE TRIGGER IF NOT EXISTS operation_attempt_changed AFTER UPDATE ON operation_attempts
WHEN NEW.outcome<>OLD.outcome BEGIN
 INSERT INTO operation_events(operation_id,state,phase,fence,code,at,event_type,attempt_id,kind,duration_ms,model,fallback)
 SELECT NEW.operation_id,NEW.outcome,NEW.phase,o.fence,NEW.code,NEW.updated_at,'attempt_end',NEW.id,o.kind,
  MAX(0,NEW.updated_at-NEW.created_at),NEW.model,
  CASE WHEN NEW.provider='cail-gateway' AND NEW.model='deepseek-v4-flash-0731' THEN 1 ELSE 0 END
 FROM app_operations o WHERE o.id=NEW.operation_id;
END;
CREATE INDEX IF NOT EXISTS operation_events_retention ON operation_events(at);
CREATE TABLE IF NOT EXISTS usage_events (
 event_id TEXT PRIMARY KEY,
 actor_key TEXT NOT NULL,
 actor_class TEXT NOT NULL CHECK(actor_class IN ('member','guest','anonymous')),
 event_type TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('client','server')),
 job_id TEXT,
 outcome TEXT NOT NULL,
 code TEXT,
 http_status INTEGER,
 duration_ms INTEGER,
 position_bucket INTEGER,
 at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_retention ON usage_events(at);
CREATE INDEX IF NOT EXISTS usage_events_actor ON usage_events(actor_key,at);
