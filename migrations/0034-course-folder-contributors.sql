-- Existing folders were instructor-created, but `created_by` may now be the
-- most recent sharing-audit actor. No immutable creator provenance exists, so
-- legacy folders remain instructor-managed instead of guessing an owner.
ALTER TABLE course_folders ADD COLUMN creator_subject TEXT NOT NULL DEFAULT '';

-- Item authorship is also unrecoverable; existing items remain manageable by
-- instructors and any known folder creator, while peer removal starts with
-- newly recorded contributions.
ALTER TABLE course_folder_items ADD COLUMN added_by TEXT NOT NULL DEFAULT '';
