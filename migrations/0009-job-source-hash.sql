-- Private exact-byte identity for isolation caching. It is never returned in
-- the student job payload and remains nullable for legacy/unfingerprinted jobs.
ALTER TABLE jobs ADD COLUMN source_hash TEXT
  CHECK (source_hash IS NULL OR (
    length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
  ));
