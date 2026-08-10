-- Dormant provider-output serialization and identity. These tables add no
-- execution route and never append query outputs to jobs.stems.
CREATE TABLE IF NOT EXISTS instrument_isolation_ingestion_leases (
  isolation_id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL
    CHECK (
      length(external_id) BETWEEN 1 AND 128
      AND external_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  lease_id TEXT
    CHECK (
      lease_id IS NULL OR (
        length(lease_id) BETWEEN 1 AND 128
        AND lease_id NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 3),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (isolation_id) REFERENCES instrument_isolations(id) ON DELETE CASCADE,
  CHECK (
    (lease_id IS NULL AND lease_expires_at IS NULL)
    OR (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_instrument_isolation_ingestion_deadline
  ON instrument_isolation_ingestion_leases (lease_expires_at);

-- Output identity is separate from both core stems and provider input. Rows
-- can disappear with their owning job, but cannot be rewritten in place.
CREATE TABLE IF NOT EXISTS instrument_isolation_outputs (
  isolation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('target', 'residual')),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 44 AND 104857600),
  content_type TEXT NOT NULL CHECK (content_type = 'audio/wav'),
  retained_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (isolation_id, kind),
  FOREIGN KEY (isolation_id) REFERENCES instrument_isolations(id) ON DELETE CASCADE,
  CHECK (storage_key = 'isolations/' || isolation_id || '/' || kind || '.wav')
);

CREATE INDEX IF NOT EXISTS idx_instrument_isolation_outputs_retention
  ON instrument_isolation_outputs (retained_until, isolation_id);

CREATE TRIGGER IF NOT EXISTS instrument_isolation_outputs_no_update
BEFORE UPDATE ON instrument_isolation_outputs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'instrument isolation output identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS instrument_isolation_outputs_no_replace
BEFORE INSERT ON instrument_isolation_outputs
WHEN EXISTS (
  SELECT 1 FROM instrument_isolation_outputs
  WHERE (isolation_id = NEW.isolation_id AND kind = NEW.kind)
     OR storage_key = NEW.storage_key
)
BEGIN
  SELECT RAISE(ABORT, 'instrument isolation output identity is immutable');
END;
