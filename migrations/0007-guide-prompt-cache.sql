-- Bind each cached guide to the code-owned prompt version and runtime
-- amendment revision that generated it. Existing rows intentionally receive
-- a non-current identity and are regenerated lazily.
ALTER TABLE guides ADD COLUMN prompt_version TEXT NOT NULL DEFAULT '';
ALTER TABLE guides ADD COLUMN prompt_revision INTEGER NOT NULL DEFAULT -1;
