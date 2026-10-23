-- Supplemental aggregate identity matching never grants classroom access.
CREATE TABLE IF NOT EXISTS course_usage_accounts (
  course_id TEXT NOT NULL,
  subject TEXT NOT NULL REFERENCES app_users(subject) ON DELETE CASCADE,
  member_id TEXT,
  next_lookup_at INTEGER NOT NULL,
  PRIMARY KEY(course_id,subject)
);
CREATE INDEX IF NOT EXISTS course_usage_accounts_member ON course_usage_accounts(course_id,member_id);
