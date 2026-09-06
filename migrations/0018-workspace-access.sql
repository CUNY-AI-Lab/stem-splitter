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
BEGIN SELECT RAISE(ABORT, 'access history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS app_user_events_no_delete BEFORE DELETE ON app_user_events
BEGIN SELECT RAISE(ABORT, 'access history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS app_user_events_no_replace BEFORE INSERT ON app_user_events
WHEN EXISTS (SELECT 1 FROM app_user_events WHERE id = NEW.id OR (subject = NEW.subject AND revision = NEW.revision))
BEGIN SELECT RAISE(ABORT, 'access history is immutable'); END;
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
CREATE TABLE IF NOT EXISTS app_request_reservations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES app_users(subject),
  scope TEXT NOT NULL CHECK (scope IN ('split', 'guide')),
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_request_reservations_scope ON app_request_reservations(scope, day, subject);
