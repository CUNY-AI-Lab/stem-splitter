-- Job tracking for stem separation requests.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source_key TEXT NOT NULL,            -- R2 key of the uploaded original
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  external_id TEXT,                    -- id of the job at the separation backend (e.g. Replicate prediction id)
  stems TEXT,                          -- JSON array: [{ "name": "vocals", "key": "stems/<job>/vocals.mp3" }, ...]
  error TEXT,
  model TEXT,                          -- catalogue contract id (src/separation/options.ts), not a provider model name
                                       -- current: vocals_instrumental (2) | htdemucs_ft (4) | htdemucs_6s (6) | bs_roformer_vocals (2, local)
                                       -- NULL on pre-2026-07 rows; read as htdemucs_ft
  labels TEXT,                         -- JSON map: { "<stem name>": "<display label>" }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);

-- Shared time-anchored notes on a track, shown as seek-bar markers.
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_job ON annotations (job_id);

-- Cached AI listening guides (one per job, generated lazily, class-shared).
CREATE TABLE IF NOT EXISTS guides (
  job_id TEXT PRIMARY KEY,             -- jobs.id
  text TEXT NOT NULL,                  -- the generated guide prose
  model TEXT NOT NULL,                 -- ASSISTANT_MODEL slug that produced it
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
