-- Append-only audit history for instructor prompt amendments.
--
-- The fixed system prompt remains code-owned. Each runtime amendment records
-- the code prompt version and fingerprint it extended, plus an effective
-- fingerprint, teacher, timestamp, and human changelog note.
ALTER TABLE assistant_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS assistant_prompt_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settings_revision INTEGER NOT NULL UNIQUE,
  amendment TEXT NOT NULL,
  change_note TEXT NOT NULL,
  base_prompt_version TEXT NOT NULL,
  base_prompt_hash TEXT NOT NULL,
  effective_prompt_hash TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompt_revisions_created
  ON assistant_prompt_revisions (created_at DESC, id DESC);
