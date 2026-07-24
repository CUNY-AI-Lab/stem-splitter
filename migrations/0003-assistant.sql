-- Additive migration: cached AI listening guides (one per job, class-shared).
CREATE TABLE IF NOT EXISTS guides (
  job_id TEXT PRIMARY KEY,             -- jobs.id
  text TEXT NOT NULL,                  -- the generated guide prose
  model TEXT NOT NULL,                 -- ASSISTANT_MODEL slug that produced it
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
