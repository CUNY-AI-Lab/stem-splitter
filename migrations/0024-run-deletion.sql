-- User deletion is durable; operation accounting is retained independently.
CREATE TABLE IF NOT EXISTS run_deletions (
  job_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('user','failed_session_expiry')),
  content_purged INTEGER NOT NULL DEFAULT 0 CHECK(content_purged IN (0,1))
);
CREATE TABLE IF NOT EXISTS failed_run_sessions (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY(job_id,subject,session_id)
);
CREATE INDEX IF NOT EXISTS run_deletions_cleanup ON run_deletions(content_purged,deleted_at);
