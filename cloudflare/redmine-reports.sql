CREATE TABLE IF NOT EXISTS bug_report_receipts (
  owner TEXT NOT NULL,
  report_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','saved','rejected','retryable')),
  issue_id INTEGER,
  PRIMARY KEY(owner, report_id)
);
CREATE INDEX IF NOT EXISTS bug_report_receipts_owner_time ON bug_report_receipts(owner, created_at);

CREATE TABLE IF NOT EXISTS bug_report_guest_receipts (
  owner TEXT NOT NULL,
  report_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','saved','rejected','retryable')),
  issue_id INTEGER,
  rate_key TEXT NOT NULL,
  PRIMARY KEY(owner, report_id)
);
CREATE INDEX IF NOT EXISTS bug_report_guest_receipts_owner_time ON bug_report_guest_receipts(owner, created_at);
CREATE INDEX IF NOT EXISTS bug_report_guest_receipts_rate_time ON bug_report_guest_receipts(rate_key, created_at);
