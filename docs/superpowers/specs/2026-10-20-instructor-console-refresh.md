# Instructor Console course review and customization

Both instructor pages use **Instructor Console** as their title and heading.
Retain the existing components and course-preserving navigation: course work
and shared folders live in `classroom.html`, while Listening Guy settings live
in `teacher.html`.

An instructor can review the selected completed course run's saved annotations,
including notes classmates add to an instructor-owned shared run. Use the
existing authorized job read; validate the response's exact course before
rendering text and server-provided author names. Do not fetch every run's full
body, change note ownership, backfill historical jobs, or add access grants.

Visible course views refresh automatically at a minimum 15-second cadence,
slowed according to the number of loaded pages to budget at most 24 automatic
reads per minute. Refresh preserves loaded pagination and unsaved folder
settings, pauses in hidden tabs, avoids overlapping refreshes, and rechecks on
return. Pending authority reads conceal private content without collapsing the
page layout; revocation and uncertain authority clear it. A pending grant edit
retains its original revision through refresh, so a concurrent change returns
a conflict rather than being overwritten.

Exercise existing customization controls with local synthetic identities:
folder create/add/private/read/comment, prompt save/preview/reset/history
restore, and global song examples. Course ownership must not expose global
controls. Account changes and late responses cannot restore previous private
settings. Unavailable song-settings readback must prevent saving guessed
defaults. No test may create paid provider work or read student conversations.

Acceptance details and limits are recorded in
`docs/acceptance/instructor-console-customization-2026-10-20.md`.
