-- Deliberately separate from historical app_request_reservations. No inferred
-- successful charges/backfill. Apply only with the queue-drain rollback plan.
-- Guest authority is app-local. Never insert anonymous identities into app_users.
CREATE TABLE IF NOT EXISTS guest_sessions (
  subject TEXT PRIMARY KEY CHECK(length(subject)=70 AND subject GLOB 'guest-*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+604800000),
  verified_day TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE TRIGGER IF NOT EXISTS guest_session_identity_fence BEFORE UPDATE ON guest_sessions
WHEN NEW.subject<>OLD.subject OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'immutable guest session'); END;
CREATE TABLE IF NOT EXISTS guest_challenges (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_job_owners (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES guest_sessions(subject)
);
CREATE INDEX IF NOT EXISTS guest_job_owners_subject ON guest_job_owners(subject);
CREATE TRIGGER IF NOT EXISTS guest_job_separation BEFORE INSERT ON guest_job_owners
WHEN EXISTS(SELECT 1 FROM job_owners WHERE job_id=NEW.job_id) OR EXISTS(SELECT 1 FROM job_courses WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'guest work cannot be course or member work'); END;
CREATE TRIGGER IF NOT EXISTS member_job_separation BEFORE INSERT ON job_owners
WHEN EXISTS(SELECT 1 FROM guest_job_owners WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'guest work cannot be member work'); END;
CREATE TRIGGER IF NOT EXISTS guest_course_separation BEFORE INSERT ON job_courses
WHEN EXISTS(SELECT 1 FROM guest_job_owners WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'guest work cannot be course work'); END;

CREATE TABLE IF NOT EXISTS guest_upload_owners (
  object_key TEXT PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES guest_sessions(subject),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','uploading','ready'))
);
CREATE TABLE IF NOT EXISTS guest_listening_conversations (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES guest_sessions(subject),
  entries TEXT NOT NULL CHECK(json_valid(entries) AND json_type(entries)='array'),
  revision INTEGER NOT NULL CHECK(revision>=1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY(job_id,subject)
);
-- Accounting provenance is not an access grant. Live session/Admission checks
-- still run before requests and delayed paid starts. Keep member/guest FKs separate.
CREATE TABLE IF NOT EXISTS operation_principals (
  subject TEXT PRIMARY KEY,
  quota_class TEXT NOT NULL CHECK(quota_class IN ('member','guest')),
  member_subject TEXT UNIQUE REFERENCES app_users(subject),
  guest_subject TEXT UNIQUE REFERENCES guest_sessions(subject),
  UNIQUE(subject,quota_class),
  CHECK((quota_class='member' AND member_subject IS NOT NULL AND member_subject=subject AND guest_subject IS NULL)
    OR (quota_class='guest' AND guest_subject IS NOT NULL AND guest_subject=subject AND member_subject IS NULL))
);
INSERT OR IGNORE INTO operation_principals(subject,quota_class,member_subject)
  SELECT subject,'member',subject FROM app_users;
CREATE TRIGGER IF NOT EXISTS member_operation_principal AFTER INSERT ON app_users BEGIN
  INSERT INTO operation_principals(subject,quota_class,member_subject) VALUES(NEW.subject,'member',NEW.subject);
END;
CREATE TRIGGER IF NOT EXISTS guest_operation_principal AFTER INSERT ON guest_sessions BEGIN
  INSERT INTO operation_principals(subject,quota_class,guest_subject) VALUES(NEW.subject,'guest',NEW.subject);
END;
CREATE TRIGGER IF NOT EXISTS operation_principal_immutable BEFORE UPDATE ON operation_principals
BEGIN SELECT RAISE(ABORT,'immutable operation principal'); END;

CREATE TABLE IF NOT EXISTS app_operations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  quota_class TEXT NOT NULL DEFAULT 'member' CHECK(quota_class IN ('member','guest')),
  course_id TEXT CHECK(quota_class<>'guest' OR course_id IS NULL),
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
  UNIQUE(subject,kind,idempotency_key),
  FOREIGN KEY(subject,quota_class) REFERENCES operation_principals(subject,quota_class)
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
WHEN NEW.subject<>OLD.subject OR NEW.quota_class<>OLD.quota_class OR NEW.kind<>OLD.kind OR NEW.day<>OLD.day OR
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
