-- Shadow requests record demand and cache identity but cannot be claimed by a
-- provider runner. Existing resource rows migrate into the non-executable stage.
ALTER TABLE instrument_isolations
  ADD COLUMN rollout_stage TEXT NOT NULL DEFAULT 'shadow'
  CHECK (rollout_stage IN ('shadow', 'teacher_beta'));
