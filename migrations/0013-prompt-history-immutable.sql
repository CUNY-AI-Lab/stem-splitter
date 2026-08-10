-- Enforce the append-only instructor audit promise below the API layer.
CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_validate_insert
BEFORE INSERT ON assistant_prompt_revisions
WHEN typeof(NEW.settings_revision) <> 'integer'
  OR NEW.settings_revision < 1
  OR length(NEW.amendment) > 2000
  OR length(trim(NEW.change_note)) < 1
  OR length(NEW.change_note) > 240
  OR length(NEW.base_prompt_version) < 1
  OR length(NEW.base_prompt_version) > 80
  OR length(NEW.base_prompt_hash) <> 64
  OR NEW.base_prompt_hash GLOB '*[^0-9a-f]*'
  OR length(NEW.effective_prompt_hash) <> 64
  OR NEW.effective_prompt_hash GLOB '*[^0-9a-f]*'
  OR length(NEW.updated_by) < 1
  OR length(NEW.updated_by) > 64
  OR NEW.updated_by GLOB '*[^A-Za-z0-9._-]*'
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history row is invalid');
END;

CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_no_update
BEFORE UPDATE ON assistant_prompt_revisions
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_no_delete
BEFORE DELETE ON assistant_prompt_revisions
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS assistant_prompt_revisions_no_replace
BEFORE INSERT ON assistant_prompt_revisions
WHEN EXISTS (
  SELECT 1 FROM assistant_prompt_revisions
  WHERE id = NEW.id OR settings_revision = NEW.settings_revision
)
BEGIN
  SELECT RAISE(ABORT, 'assistant prompt history is append-only');
END;
