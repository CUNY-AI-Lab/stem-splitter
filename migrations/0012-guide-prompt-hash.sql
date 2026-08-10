-- Bind cached guides to the effective fixed-plus-amendment prompt content.
-- Empty is the deliberately ineligible identity assigned to legacy rows.
ALTER TABLE guides ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT ''
  CHECK (prompt_hash = '' OR (
    length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'
  ));
