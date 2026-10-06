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

ALTER TABLE annotations ADD COLUMN author_subject TEXT;
ALTER TABLE annotations ADD COLUMN author_name TEXT;
ALTER TABLE annotations ADD COLUMN provenance TEXT;

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
  kind TEXT NOT NULL CHECK(kind IN ('you','coach','action')),
  provenance TEXT NOT NULL CHECK(provenance IN ('student','server-assistant','server-tool')),
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
