-- Private typed presentation preferences. Values never confer job, course,
-- model, sharing or instructor authority.
CREATE TABLE IF NOT EXISTS account_preferences (
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('classChoice','modelChoice','benchTab','sampleRotation','rackLayout')),
  revision INTEGER NOT NULL CHECK(revision>=1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_request_id TEXT NOT NULL,
  last_request_digest TEXT NOT NULL,
  PRIMARY KEY(subject,kind)
);
CREATE INDEX IF NOT EXISTS account_preferences_expiry ON account_preferences(expires_at);

CREATE TABLE IF NOT EXISTS account_preference_receipts (
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('classChoice','modelChoice','benchTab','sampleRotation','rackLayout')),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','already-present','conflict')),
  revision INTEGER,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(subject,kind,request_id)
);
CREATE INDEX IF NOT EXISTS account_preference_receipts_expiry ON account_preference_receipts(expires_at);

CREATE TABLE IF NOT EXISTS account_preference_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('classChoice','modelChoice','benchTab','sampleRotation','rackLayout')),
  reason TEXT NOT NULL CHECK(reason IN ('conflict','claim-conflict')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(subject,kind,reason,digest)
);
CREATE INDEX IF NOT EXISTS account_preference_versions_expiry ON account_preference_versions(expires_at,id);
CREATE TRIGGER IF NOT EXISTS account_preference_versions_no_update BEFORE UPDATE ON account_preference_versions
BEGIN
  SELECT RAISE(ABORT,'account preference versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS account_preferences_quota_insert BEFORE INSERT ON account_preferences
WHEN NOT EXISTS(SELECT 1 FROM account_preferences WHERE subject=NEW.subject AND kind=NEW.kind)
 AND (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM account_preferences WHERE subject=NEW.subject)
   + (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM account_preference_versions WHERE subject=NEW.subject)
   + length(CAST(NEW.payload_json AS BLOB)) > 262144
BEGIN
  SELECT RAISE(ABORT,'account_preference_quota');
END;
CREATE TRIGGER IF NOT EXISTS account_preferences_quota_update BEFORE UPDATE OF payload_json ON account_preferences
WHEN (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM account_preferences WHERE subject=OLD.subject)
   + (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM account_preference_versions WHERE subject=OLD.subject)
   - length(CAST(OLD.payload_json AS BLOB)) + length(CAST(NEW.payload_json AS BLOB)) > 262144
BEGIN
  SELECT RAISE(ABORT,'account_preference_quota');
END;
CREATE TRIGGER IF NOT EXISTS account_preference_versions_quota_insert BEFORE INSERT ON account_preference_versions
WHEN NOT EXISTS(SELECT 1 FROM account_preference_versions WHERE subject=NEW.subject AND kind=NEW.kind AND reason=NEW.reason AND digest=NEW.digest)
 AND (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM account_preferences WHERE subject=NEW.subject)
   + (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM account_preference_versions WHERE subject=NEW.subject)
   + length(CAST(NEW.payload_json AS BLOB)) > 262144
BEGIN
  SELECT RAISE(ABORT,'account_preference_quota');
END;
CREATE TRIGGER IF NOT EXISTS account_preference_receipt_limit BEFORE INSERT ON account_preference_receipts
WHEN (SELECT COUNT(*) FROM account_preference_receipts WHERE subject=NEW.subject) >= 50000
BEGIN
  SELECT RAISE(ABORT,'account_preference_receipt_limit');
END;
