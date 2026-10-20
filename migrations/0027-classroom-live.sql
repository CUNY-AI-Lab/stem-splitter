-- Opt-in live transport only. No existing split, grant, note or conversation is changed.
CREATE TABLE IF NOT EXISTS course_live_sessions (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  host_subject TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision>0),
  playing INTEGER NOT NULL CHECK(playing IN (0,1)),
  position REAL NOT NULL CHECK(position BETWEEN 0 AND 900),
  playback_rate REAL NOT NULL CHECK(playback_rate BETWEEN 0.5 AND 2),
  focus_stem TEXT,
  focus_mode TEXT CHECK(focus_mode IN ('behind','only')),
  selection_start REAL,
  selection_end REAL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK((focus_stem IS NULL AND focus_mode IS NULL) OR (focus_stem IS NOT NULL AND focus_mode IS NOT NULL)),
  CHECK((selection_start IS NULL AND selection_end IS NULL) OR
    (selection_start IS NOT NULL AND selection_end IS NOT NULL AND selection_start>=0 AND selection_end>selection_start AND selection_end<=900))
);
CREATE TRIGGER IF NOT EXISTS course_live_identity_immutable BEFORE UPDATE ON course_live_sessions
WHEN NEW.job_id<>OLD.job_id OR NEW.course_id<>OLD.course_id
BEGIN
  SELECT RAISE(ABORT,'immutable live session identity');
END;
