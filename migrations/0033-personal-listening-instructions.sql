-- Personal Listening Guy policy never grants class or administrator authority.
CREATE TABLE IF NOT EXISTS personal_prompt_settings (
  subject TEXT PRIMARY KEY REFERENCES app_users(subject),
  amendment TEXT NOT NULL DEFAULT '' CHECK(length(amendment)<=2000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS personal_prompt_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL REFERENCES app_users(subject),
  revision INTEGER NOT NULL CHECK(revision>0),
  amendment TEXT NOT NULL CHECK(length(amendment)<=2000),
  change_note TEXT NOT NULL CHECK(length(trim(change_note)) BETWEEN 1 AND 240),
  base_version TEXT NOT NULL,
  base_hash TEXT NOT NULL CHECK(length(base_hash)=64),
  effective_hash TEXT NOT NULL CHECK(length(effective_hash)=64),
  actor TEXT NOT NULL CHECK(actor=subject),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subject,revision)
);
CREATE TRIGGER IF NOT EXISTS personal_prompt_revisions_no_update BEFORE UPDATE ON personal_prompt_revisions
BEGIN
  SELECT RAISE(ABORT,'personal prompt history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS personal_prompt_revisions_no_delete BEFORE DELETE ON personal_prompt_revisions
BEGIN
  SELECT RAISE(ABORT,'personal prompt history is immutable');
END;
CREATE TRIGGER IF NOT EXISTS personal_prompt_revisions_no_replace BEFORE INSERT ON personal_prompt_revisions
WHEN EXISTS(SELECT 1 FROM personal_prompt_revisions WHERE id=NEW.id OR (subject=NEW.subject AND revision=NEW.revision))
BEGIN
  SELECT RAISE(ABORT,'personal prompt history is immutable');
END;
CREATE TABLE IF NOT EXISTS personal_guides (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES app_users(subject),
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  base_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(job_id,subject)
);
CREATE INDEX IF NOT EXISTS personal_guides_subject ON personal_guides(subject);
