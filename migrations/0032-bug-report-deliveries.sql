-- Additive fallback report record. Do not drop on rollback: receipt continuity
-- prevents duplicate delivery. Contact fields and raw identity/IP are omitted.
CREATE TABLE IF NOT EXISTS bug_report_deliveries (
  owner TEXT NOT NULL,
  report_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  description TEXT NOT NULL CHECK(length(description) BETWEEN 10 AND 4000),
  path TEXT NOT NULL,
  release TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK(delivery IN ('redmine','email')),
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','unknown')),
  rate_key TEXT NOT NULL,
  PRIMARY KEY(owner,report_id)
);
CREATE INDEX IF NOT EXISTS bug_report_deliveries_owner_time ON bug_report_deliveries(owner,created_at);
CREATE INDEX IF NOT EXISTS bug_report_deliveries_rate_time ON bug_report_deliveries(rate_key,created_at);
