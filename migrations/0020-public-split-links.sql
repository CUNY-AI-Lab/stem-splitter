-- Only explicit owner sharing makes a split publicly readable.
CREATE TABLE IF NOT EXISTS public_split_links (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
