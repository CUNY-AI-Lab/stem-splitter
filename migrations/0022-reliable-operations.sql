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
  at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS operation_created AFTER INSERT ON app_operations BEGIN
  INSERT INTO operation_events(operation_id,state,phase,fence,code,at)
  VALUES(NEW.id,NEW.state,NEW.phase,NEW.fence,NEW.error_code,NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS operation_changed AFTER UPDATE ON app_operations
WHEN OLD.state<>NEW.state OR OLD.phase<>NEW.phase OR OLD.fence<>NEW.fence BEGIN
  INSERT INTO operation_events(operation_id,state,phase,fence,code,at)
  VALUES(NEW.id,NEW.state,NEW.phase,NEW.fence,NEW.error_code,NEW.updated_at);
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
