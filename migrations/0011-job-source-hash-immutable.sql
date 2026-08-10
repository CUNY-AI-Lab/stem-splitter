-- Exact source identity is write-once after the first server verification.
-- Repeating the same digest is harmless; clearing or rebinding it is rejected.
CREATE TRIGGER IF NOT EXISTS jobs_source_hash_immutable
BEFORE UPDATE OF source_hash ON jobs
FOR EACH ROW
WHEN OLD.source_hash IS NOT NULL AND NEW.source_hash IS NOT OLD.source_hash
BEGIN
  SELECT RAISE(ABORT, 'jobs.source_hash is immutable once set');
END;

-- The digest identifies the bytes at this locator. Once identity exists, the
-- storage key and source class cannot be rebound underneath it.
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
