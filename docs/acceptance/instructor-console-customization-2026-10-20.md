# Instructor Console customization acceptance

The two Stem instructor pages use the same **Instructor Console** name and the
existing page, button, form, section and history-list components. Course work is
at `/classroom.html`; Listening Guy settings are at `/teacher.html`. Their
navigation preserves the selected course. This is a local fixture acceptance
record, not proof of a production CUNY Login or a real instructor assignment.

## Course work and folders

`cloudflare/instructor-acceptance.spec.mjs` uses synthetic enrolled students,
course owners, completed runs, notes and saved conversations in local D1. It
does not generate audio or model replies.

| Visible control or behavior | Acceptance |
| --- | --- |
| Class picker | Clears old state and fences late responses when changed |
| Roster, usage and selected student | Includes zero-run students and only assigned course runs; excludes personal runs |
| My course splits | Shows the instructor's assigned runs, including classmates' attributed notes |
| Review annotations | Reads the selected completed run through the existing authorized job API; verifies its exact course before rendering |
| Review Listening Guy session | Reads saved course messages with pagination; makes no guide/chat request |
| New folder name / Create private folder | Creates an instructor-only folder; shared permission requires a separate save |
| Folder selection / Add to folder | Adds a completed course run to an explicitly selected class folder |
| Private, read, comment / Save sharing | Each grant persists after reload; read and comment describe the student permissions distinctly |
| Unsaved folder controls | Names, sharing choices and per-run folder destinations survive automatic refresh without a write; sharing preserves its original revision so concurrent changes cause a conflict |
| Class folder link | Uses the selected course and requires current enrollment |
| Refresh class work | Refreshes roster, loaded run/message pages, selected notes and folder views |
| Automatic refresh | Runs while visible at 15 seconds or slower, scaled by loaded pages; reads only the selected run's notes and pauses in hidden tabs |
| Revocation, 503, network failure, invalid JSON | Conceals and clears private course work; explicit retry can recover |
| Mismatched course or personal notes response | Clears the view without rendering that response |

Refresh never assigns historical work to a course and never changes folder
grants. Shared notes retain the server's author attribution. The console is
read-only for annotations; an author manages their own notes in the split.

## Listening Guy settings

The existing settings inventory includes an amendment, required change note,
save, preview, fixed-prompt top/end navigation, paginated history, and restoration
of a course history entry as a new revision. Clearing the amendment and saving
with a change note is the existing reset operation.

Scoped settings requests conceal private values while pending and have an
eight-second deadline. Denial clears them; uncertain failures keep them hidden
until a successful current-course access recheck. Late or concurrent successful
responses cannot reopen an uncertain view. Drafts retain their original
revision, and access recovery never replays an uncertain save.

Global song examples separately expose enabled, reshuffle, hold/cadence timing,
Archive search, add/remove/reorder, save and reload controls. They remain hidden
in course scope because course ownership does not grant app-wide customization.
The focused local coverage is `cloudflare/instructor-settings.spec.mjs`; existing
Archive search/order coverage is `cloudflare/song-samples.spec.mjs`.

No production student content, credentials, enrollment grants, quotas or paid
provider calls are part of this acceptance. Production access for the intended
instructor and the deployed commit still require the release owner's readback.
