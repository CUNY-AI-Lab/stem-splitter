/**
 * Additive query-isolation storage shared by the Railway SQLite adapter and
 * the future D1 runtime. Query outputs are deliberately separate from jobs.stems.
 */
export const INSTRUMENT_ISOLATIONS_SCHEMA_SQL = `
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
`;
