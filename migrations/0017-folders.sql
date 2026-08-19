-- Instructor folders: named sets of finished splits kept for teaching. Items
-- snapshot filename/model so a folder still lists an entry after the 30-day
-- cleanup removes its job row; the UI shows those as expired.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folder_items (
  folder_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  model TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (folder_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_folder_items_job ON folder_items (job_id);
