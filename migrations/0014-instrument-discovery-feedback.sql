-- Additive teacher-only candidate feedback. Rows remain unreviewed,
-- identified, and permanently ineligible for training; curation must create a
-- separate reviewed and de-identified artifact.
CREATE TABLE IF NOT EXISTS instrument_discovery_feedback (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT '1' CHECK (schema_version = '1'),
  job_id TEXT NOT NULL,
  reviewer TEXT NOT NULL
    CHECK (
      length(reviewer) BETWEEN 1 AND 64
      AND reviewer NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  analysis_sha256 TEXT NOT NULL
    CHECK (length(analysis_sha256) = 64 AND analysis_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_sha256 TEXT NOT NULL
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  classifier_version TEXT NOT NULL CHECK (length(classifier_version) BETWEEN 1 AND 200),
  vocabulary_version TEXT NOT NULL CHECK (length(vocabulary_version) BETWEEN 1 AND 100),
  vocabulary_sha256 TEXT NOT NULL
    CHECK (length(vocabulary_sha256) = 64 AND vocabulary_sha256 NOT GLOB '*[^0-9a-f]*'),
  review_ontology_version TEXT NOT NULL
    CHECK (length(review_ontology_version) BETWEEN 1 AND 100),
  genre_family TEXT NOT NULL CHECK (genre_family IN (
    'unknown', 'rock', 'jazz', 'orchestral-chamber', 'electronic',
    'hip-hop', 'folk-traditional', 'sparse-acoustic', 'other'
  )),
  observations TEXT NOT NULL
    CHECK (
      length(observations) BETWEEN 2 AND 8192
      AND json_valid(observations)
      AND json_type(observations) = 'array'
    ),
  evidence_status TEXT NOT NULL DEFAULT 'unreviewed-candidate'
    CHECK (evidence_status = 'unreviewed-candidate'),
  deidentified INTEGER NOT NULL DEFAULT 0 CHECK (deidentified = 0),
  training_eligible INTEGER NOT NULL DEFAULT 0 CHECK (training_eligible = 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE (job_id, reviewer, analysis_sha256, revision)
);

CREATE INDEX IF NOT EXISTS idx_instrument_discovery_feedback_job
  ON instrument_discovery_feedback (job_id, analysis_sha256, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS instrument_discovery_feedback_no_update
BEFORE UPDATE ON instrument_discovery_feedback
BEGIN
  SELECT RAISE(ABORT, 'instrument discovery feedback revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS instrument_discovery_feedback_no_replace
BEFORE INSERT ON instrument_discovery_feedback
WHEN EXISTS (
  SELECT 1 FROM instrument_discovery_feedback
  WHERE id = NEW.id OR (
    job_id = NEW.job_id
    AND reviewer = NEW.reviewer
    AND analysis_sha256 = NEW.analysis_sha256
    AND revision = NEW.revision
  )
)
BEGIN
  SELECT RAISE(ABORT, 'instrument discovery feedback revisions are immutable');
END;
