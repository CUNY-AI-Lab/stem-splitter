-- Additive migration: per-job model choice, shared stem labels, time annotations.
-- Run once against an existing DB (ALTER TABLE fails if re-run — that's expected).
ALTER TABLE jobs ADD COLUMN model TEXT;
ALTER TABLE jobs ADD COLUMN labels TEXT;

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_job ON annotations (job_id);
