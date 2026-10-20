# Classroom workflow candidate — October 20, 2026

Status: local release candidate on the Cloudflare lane, based on
`3f0c0fb41fd675a90cb9c3f56d3f69226081f560`. This record does not attest to a
deployment, Agustina's course binding, or a real instructor/student sign-in.
Release from `codex/cloudflare-migration`; do not promote this work to Railway's
`main` or use the root Wrangler configuration.

## Creating and sharing class work

New splits default to **Personal**. Select the named course under **New splits
belong to**, then acknowledge that its instructor can review new course splits
and their Listening Guy conversations. Opening a `?course=` link selects an
available course but does not check that acknowledgment. Changing the selected
course clears consent; an import cannot silently finish under a different
selection. Existing personal splits are not converted or backfilled.

Open **Class workspace** to select a currently authorized course. Instructors
can review the paginated roster, including students with no splits, and open
each student's assigned work and read-only Listening Guy session. **My course
splits** also lists the instructor's own course work when the instructor is not
in the student roster. The usage summary counts the roster entries currently
loaded, their assigned splits, and those within the 90-day retention period.
It is not a provider-spend report; load remaining roster pages for full totals.

Create a folder, which starts private, and add a completed split from that same
course. Choose a sharing option and explicitly press **Save sharing**. The
**Class members can listen and add their own notes** option is required for peer
annotations. A read-only folder permits listening and reading existing notes.
The class-folder link still requires current course access; copying it grants
no additional access. Opening a page or creating a split never automatically
changes a folder grant.

Course notes display the server-verified author name and preserve author-only
edit/delete rules. Missing names use the existing safe fallback. **REFRESH
CLASS NOTES** reloads shared notes; visible course mixers also refresh every
three seconds while preserving local playback, controls and drafts. A failed
note submission preserves its draft for an explicit retry. Account changes,
revocation or uncertain course authority conceal private content and stop
playback rather than continuing to show the previous account's work.

The footer's **Report a bug** button opens a compact panel with one description
field after existing CUNY Login verification. Close and Escape preserve the draft
and return focus to the footer button. An explicit send stores a report for the
Lab administrators with verified account attribution, a fixed page category and
the deployment release. No split, transcript or other app content is attached.
An uncertain response retains the reference and original text for an explicit
status check. Same-account sign-in recovery preserves the draft in the open tab;
a different account cannot submit it. See [the report contract](../bug-reports.md).

## Instructor-led listening

Ordinary shared listening remains independent on each device. On a retained,
authorized course split, an instructor explicitly chooses **Start class
session**. Students separately choose **Follow instructor**. The instructor
then publishes play/pause, position, playback rate, instrument focus and section
selection. Followers can leave the session; their mute switches remain local,
and live mode does not change note permissions or reveal anyone's conversation.

This is periodic classroom cue synchronization, not sample-accurate networked
audio. Visible browsers poll every 2.5 seconds and project the server's timestamp
onto their own local playback. Network latency, decoding and browser scheduling
affect convergence. Each session has a 90-second lease, renewed by the active
instructor. A hidden instructor tab pauses leadership; a hidden follower pauses
audio and stops polling. On return, the instructor must resume leadership and a
follower rejoins playing audio through **Join class audio**. Recovery from a
connection outage requires a fresh follow action. The same audio-join control
provides a user gesture when the browser blocks autoplay. Real devices and audio
output still require classroom acceptance.

Only an existing authorized course instructor who can read the recording may
start a session. Only its initiating instructor controls an active lease.
Revision checks reject stale or competing updates. Every read verifies the
viewer; current host membership, course authority and local disablement also
govern whether cues remain active. Expired/deleted audio, revoked folder access,
personal work and public audio-only links never gain session access. Authority
outages fail closed. Existing request limits remain in effect.

## YouTube and Listening Guy limits

The enabled link-import workflow does not fetch YouTube audio. It uses available
video metadata to suggest an Internet Archive search and offers local file
upload. A missing metadata match falls back to entering the song title. This
candidate does not claim to repair direct YouTube extraction or prove a live
provider import. Local MP3 upload remains a separate supported source path.
This follows the current import rollout in merged
[PR #51](https://github.com/CUNY-AI-Lab/stem-splitter/pull/51) and
[PR #55](https://github.com/CUNY-AI-Lab/stem-splitter/pull/55), which enabled
metadata lookup and Archive alternatives on October 18. Historical extractor
fixes do not supersede that deployed decision.

Listening Guy cue recovery is exercised with synthetic responses, including a
failed stream followed by an explicit retry. Course conversation review makes
no generation request. Successful local tests do not prove current production
model availability, audio separation, or quota headroom.

Signed-in cue and chat now share five successful turns across tabs and songs,
followed by a five-minute pause. Failed replies do not use a turn. The interface
keeps the pending question and exact request identifier, shows the countdown,
and permits continued use when it ends without sending automatically. A lost
fifth reply can still be recovered during the pause. This replaces the old
signed-in per-user daily caps while retaining guest, global cue, and provider
protections. See [Listening Guy pacing and recovery](../listening-pacing.md) for
atomic accounting, bounded uncertainty, retention, and migration 0028.

## Local acceptance evidence

All fixtures use synthetic identities, rosters, local audio and model responses.
No student conversation or real class submission is used.

| Check | Evidence and scope |
| --- | --- |
| Course authorization, privacy and migration compatibility | `cloudflare/classroom.test.ts` plus `cloudflare/live-session.test.ts`: 25 tests passed in the recorded local backend run. |
| Live-session lifecycle | Six backend cases cover explicit start/control/end, wrong-course and personal denial, current-authority revocation, lease expiry, malformed cues, competing revisions, polling limits, and additive migration preservation. |
| Static checks | Root and Cloudflare TypeScript checks passed after the backend change. |
| New-course consent, notes and cue recovery | `cloudflare/course-workflow.spec.mjs` contains the browser acceptance cases; final candidate results belong in the release verification record. |
| Roster, own splits, folders and scoped review | `cloudflare/instructor-acceptance.spec.mjs` covers permitted workflows, course changes, revocation and unavailable authority using local fixtures. |
| Eight browser contexts and browser restrictions | `cloudflare/live-session.spec.mjs` covers explicit follow, playback/focus/section convergence, unavailable authority, autoplay rejection and visibility changes. Eight contexts are not eight physical devices. |
| Report discovery and durable saving | `cloudflare/bug-report.spec.mjs` tests the compact panel, keyboard and phone access, verified attribution and local mock storage, including uncertain outcomes without automatic retries. No real report is sent by these tests. |

Pending live acceptance: verify the exact deployed commit/assets and migration
readback; use an already authorized instructor/test account to confirm the
intended named course and roster; exercise a newly created, explicitly disclosed
course split and comment-granted folder with approved test users; then verify
device playback/focus/section convergence. Agustina's successful signup alone
does not establish instructor ownership or enrollment in the intended course.
Do not inspect student conversations to perform this acceptance or run paid
generation/separation without the required authorization.

## Additive migration and release notes

`migrations/0027-classroom-live.sql` adds only the empty
`course_live_sessions` table and its immutable-identity trigger. It changes no
existing jobs, annotations, conversations, course associations or folder grants.
It is idempotent; the fresh schema and additive migration are checked together.

SHA-256:
`8196cf1d975fe7e512355ac6ed3f0ea401188a9c1e68100981df4c5aadab7503`.

Before the reviewed release, record the current serving Worker version,
deployment, database identity and recovery point. Confirm the destination is
the existing Cloudflare production runtime `cail-stem-splitter-preview`, D1
`ae01c5db-c19e-48c8-91bd-132876276f22`, behind the canonical
`https://stem-splitter.ailab-452.workers.dev/` alias. Apply only the numbered
additive migrations to that verified database, not the full `schema.sql` or old
migrations:

```sh
cd cloudflare
node_modules/.bin/wrangler d1 execute cail-stem-splitter-preview --remote \
  --file ../migrations/0027-classroom-live.sql
node_modules/.bin/wrangler d1 execute cail-stem-splitter-preview --remote \
  --file ../migrations/0028-listening-cycles.sql
```

Read back the table/trigger definitions and confirm the newly added table is
empty before publishing the candidate. Check the new pacing tables and success
trigger too. Preserve existing variables, secrets, bindings, provider/guest/split
limits and course permissions; only the explicitly requested signed-in Listening
Guy turn policy changes. Source CI performs checks and dry
builds; it is not evidence of deployment. Record the exact reviewed commit,
resulting Worker version and production asset/API checks separately. This
candidate needs no new credentials, security grants, paid jobs or spending
changes.
