# Instructor folders, console head controls, and coach reset — plan

Date: 2026-08-19 · Spec: `../specs/2026-08-19-folders-console-controls-design.md`

## Steps (all landed in one change)

1. Schema: `folders` + `folder_items` appended to `schema.sql` (Railway applies
   on boot) and mirrored as `migrations/0017-folders.sql` with
   `db:migrate:17[:local]` scripts for the deferred D1 target. New tables, no
   column changes, so no Node additive migration is needed.
2. Server (`src/index.ts`): teacher-folder routes after the prompt routes; no
   FK cascade — folder deletion removes items explicitly in one batch.
   `/api/teacher/me` reshaped to 200-with-null (consumers updated: `teacher.js`
   init, `app.js` detect). `teacher.html` asset version bumped.
3. Client (`public/app.js`): `armThenRun` two-step confirm; `deleteJob` local
   removal; `resetCoachConversation`; head buttons (`+ FOLDER`, `DELETE`);
   failed-card `DELETE`; instructor detection (`body.instructor` CSS gate);
   folders rack section with lazy item loading, per-item and whole-folder
   loads via the extracted `adoptJobById`; save-to-folder popover with inline
   folder creation. Styles appended to `styles.css`.
4. Prompt: de-determinized single-stem isolation in `src/assistant/prompt.ts`,
   version `2026-08-19.1`, changelog entry added.
5. Tests: e2e folder API flow + class-code 401 in the instructor test; reset
   and delete UI coverage plus student-hidden folder button in the main flow
   test; version literals updated. Gates: typecheck, typecheck:server,
   282 worker, 42 server, 19/19 e2e.

## Deferred

- Synthesizing live teacher prompt amendments into the fixed prompt awaits a
  read of `assistant_prompt_revisions` on the Railway volume (session tooling
  could not read production data; needs a user-run query or teacher console
  copy). Ship as a follow-up version bump.
- Folder ordering/renaming and student-visible "class sets" are out of scope.
