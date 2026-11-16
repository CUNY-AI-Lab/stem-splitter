-- Private per-actor listening state. Pending work is stored only as an inert
-- immutable version; it is never installed into the active operation fields.
CREATE TABLE IF NOT EXISTS job_ui_state_records (
  subject TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('listeningDraft','listeningPlayer')),
  revision INTEGER NOT NULL CHECK(revision>=1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_request_id TEXT NOT NULL,
  last_request_digest TEXT NOT NULL,
  PRIMARY KEY(subject,job_id,kind)
);
CREATE INDEX IF NOT EXISTS job_ui_state_actor_expiry ON job_ui_state_records(subject,expires_at);
CREATE INDEX IF NOT EXISTS job_ui_state_job_expiry ON job_ui_state_records(job_id,expires_at);

-- Compact idempotency receipts are payload-free and expire after one hour.
CREATE TABLE IF NOT EXISTS job_ui_state_receipts (
  subject TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('listeningDraft','listeningPlayer','pendingConversation','pendingChat','pendingGuide')),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','already-present','conflict','inert')),
  revision INTEGER,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(subject,job_id,kind,request_id)
);
CREATE INDEX IF NOT EXISTS job_ui_state_receipts_actor ON job_ui_state_receipts(subject,expires_at);

-- Conflict and pending payloads are append-only until the job/state expires.
CREATE TABLE IF NOT EXISTS job_ui_state_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('listeningDraft','listeningPlayer','pendingConversation','pendingChat','pendingGuide')),
  reason TEXT NOT NULL CHECK(reason IN ('conflict','pending')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(subject,job_id,kind,reason,request_id)
);
CREATE INDEX IF NOT EXISTS job_ui_state_versions_actor ON job_ui_state_versions(subject,expires_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS job_ui_state_versions_dedupe ON job_ui_state_versions(subject,job_id,kind,reason,digest);
CREATE TRIGGER IF NOT EXISTS job_ui_state_versions_no_update BEFORE UPDATE ON job_ui_state_versions
BEGIN
  SELECT RAISE(ABORT,'UI state versions are immutable');
END;

-- The byte quota covers active values and retained conflict/pending copies.
CREATE TRIGGER IF NOT EXISTS job_ui_state_records_quota_insert BEFORE INSERT ON job_ui_state_records
WHEN NOT EXISTS(SELECT 1 FROM job_ui_state_records WHERE subject=NEW.subject AND job_id=NEW.job_id AND kind=NEW.kind)
 AND (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM job_ui_state_records WHERE subject=NEW.subject)
   + (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM job_ui_state_versions WHERE subject=NEW.subject)
   + length(CAST(NEW.payload_json AS BLOB)) > 2097152
BEGIN
  SELECT RAISE(ABORT,'ui_state_quota');
END;
CREATE TRIGGER IF NOT EXISTS job_ui_state_records_quota_update BEFORE UPDATE OF payload_json ON job_ui_state_records
WHEN (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM job_ui_state_records WHERE subject=OLD.subject)
   + (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM job_ui_state_versions WHERE subject=OLD.subject)
   - length(CAST(OLD.payload_json AS BLOB)) + length(CAST(NEW.payload_json AS BLOB)) > 2097152
BEGIN
  SELECT RAISE(ABORT,'ui_state_quota');
END;
CREATE TRIGGER IF NOT EXISTS job_ui_state_versions_quota_insert BEFORE INSERT ON job_ui_state_versions
WHEN NOT EXISTS(SELECT 1 FROM job_ui_state_versions WHERE subject=NEW.subject AND job_id=NEW.job_id AND kind=NEW.kind AND reason=NEW.reason AND digest=NEW.digest)
 AND (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM job_ui_state_records WHERE subject=NEW.subject)
   + (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM job_ui_state_versions WHERE subject=NEW.subject)
   + length(CAST(NEW.payload_json AS BLOB)) > 2097152
BEGIN
  SELECT RAISE(ABORT,'ui_state_quota');
END;
CREATE TRIGGER IF NOT EXISTS job_ui_state_receipts_count_insert BEFORE INSERT ON job_ui_state_receipts
WHEN (SELECT COUNT(*) FROM job_ui_state_receipts WHERE subject=NEW.subject) >= 50000
BEGIN
  SELECT RAISE(ABORT,'ui_state_receipt_limit');
END;
