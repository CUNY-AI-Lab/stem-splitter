-- Provider-start reservations enforce one shared course-semester ceiling.
-- Shadow rows never enter this table because they cannot be claimed.
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
