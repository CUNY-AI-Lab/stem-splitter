# Instructor folders, console head controls, and coach reset — design

Date: 2026-08-19

## What

Three session-management features, split by audience:

1. **Console head controls (everyone).** Each finished split's console head
   gains, alongside EXPORT and the collapse caret: `+ FOLDER` (instructor only)
   and `DELETE`. Failed cards get `DELETE` too. Destructive buttons use a
   two-step confirm (`armThenRun`): first press arms the button as `SURE?` for
   3 seconds, second press fires. No blocking dialogs.
2. **Listening Guy conversation reset (everyone).** A `RESET` button in the
   coach form clears the model context (`chatHistory`), the live log, and the
   per-song localStorage archive (`coachChat:<jobId>`). The cached opening
   guide is class-shared and paid-for, so it stays.
3. **Class folders (instructor only).** Server-side named sets of finished
   splits, for saving results and repopulating any rack later (new machine,
   projector, next semester). Teacher-gated because the class code is a shared
   student secret and cannot own curation.

## Contracts

- `DELETE` on a split is **local**: it removes the rack entry, mixer, and chat
  archive from this browser only. The server copy (stems, labels, notes,
  guide) stays; a `?job=` link or a folder load brings it back.
- Folder tables: `folders` (id, name ≤80 chars, created_by, created_at) and
  `folder_items` (folder_id+job_id PK, snapshotted filename/model, added_by,
  added_at). Snapshots keep an entry listable after the 30-day cleanup removes
  its job row; the UI shows those as `EXPIRED`.
- Routes (all `requireTeacher`; the class code must 401):
  `GET/POST /api/teacher/folders`, `GET/DELETE /api/teacher/folders/:id`,
  `POST /api/teacher/folders/:id/items` (finished jobs only, 409 otherwise;
  idempotent, replies `{already}`), `DELETE .../items/:jobId`.
- `GET /api/teacher/me` now returns 200 with `{teacher: {...} | null}` instead
  of 401 — the student page probes it on every load to decide whether to
  reveal instructor controls, and a 401 would console-error for every visitor.
- Loading a folder reuses the shared-link hydration path (`adoptJobById`), so
  folder loads and `?job=` links cannot drift apart.

## Prompt change (2026-08-19.1)

The guide's opening beat (b) and teaching-approach rule 2 both effectively
mandated "mute everything but one channel" every turn. Both now present
isolation as one tool among several (mute one part to hear what disappears,
play two channels together, listen for one part inside the full mix) chosen to
fit the song. Version bumped; cached guides regenerate lazily.
