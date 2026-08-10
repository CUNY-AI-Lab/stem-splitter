/**
 * A job's source digest is a write-once identity. Optional isolation cache
 * material must never be rebound to different bytes after the core split.
 */
export const JOB_SOURCE_IDENTITY_IMMUTABILITY_SQL = `
CREATE TRIGGER IF NOT EXISTS jobs_source_hash_immutable
BEFORE UPDATE OF source_hash ON jobs
FOR EACH ROW
WHEN OLD.source_hash IS NOT NULL AND NEW.source_hash IS NOT OLD.source_hash
BEGIN
  SELECT RAISE(ABORT, 'jobs.source_hash is immutable once set');
END;

CREATE TRIGGER IF NOT EXISTS jobs_source_locator_immutable
BEFORE UPDATE OF source_key, source_type ON jobs
FOR EACH ROW
WHEN OLD.source_hash IS NOT NULL
  AND (
    NEW.source_key IS NOT OLD.source_key
    OR NEW.source_type IS NOT OLD.source_type
  )
BEGIN
  SELECT RAISE(ABORT, 'jobs source locator is immutable once source_hash is set');
END;
`;
