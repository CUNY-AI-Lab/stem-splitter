# Prospective classroom work

This candidate uses the existing private `AdmissionResolver` binding. The wire
contract and byte-for-byte fixture are pinned to cail-tools-admission commit
`5f13f332c120c6712aead2a355b3cf5bcc6dae58`,
`packages/admission-contract/src/course.ts` and
`packages/admission-contract/fixtures/stem-course-v1.json`. No public registry
endpoint, roster import, new binding, or app-wide instructor promotion is added.

## Authority and disclosure

The production default accepts only
`msh-245-the-american-musical-experience-fall-2026-01`. The trusted
`CAIL_COURSE_IDS` configuration can explicitly allow additional courses; it does
not replace the exact target-class student entry requirement. A student enrolled
only in another configured course cannot enter the workspace. A current verified
course owner can use their independent teaching relationship. The existing
Admission/app suspension and separately granted app operational roles remain.

Every protected request checks current identity, Admission, local disablement,
and exact course authority. Responses are private/no-store. An unavailable,
malformed, expired, scheduled, or stale authority receipt never grants access.
`X-Stem-Course` is a selector. A resource's stored `job_courses.course_id` takes
precedence over it. Course owners do not become app instructors or admins.
`X-Stem-Account` identifies only the requesting account so a restored or changed
browser session can discard the previous account's visible state.
An identity recheck immediately hides and disables the private view and pauses
its audio. An outage keeps the view concealed with a Retry action. Only a
verified same-account response restores its drafts; account changes clear them.
Course selections also have independent request generations: pending/failed
loads clear and disable prior course data, and late reads or writes cannot
replace the newly selected course's prompt, history, roster or folder state.

New work defaults to Personal. Course work requires explicit selection and the
`course-work-v1` disclosure acknowledgment before creation. Job ownership and
course association are inserted together. Associations are immutable. Existing
jobs, annotations, and `listening_conversations` documents are never assigned,
backfilled, copied to the course store, or disclosed to an instructor. No endpoint
changes an existing personal split to course work.

| Actor | Personal/unassigned work | Assigned course work | Conversation | Course settings/folders |
| --- | --- | --- | --- | --- |
| Current job owner | Existing operational access | Read, notes, own work actions | Own read/chat/reset | Current participant may read granted folders |
| Current course owner | No access to another owner's work | Read retained course work; comment as self | Separate read-only review; no generation or reset | Edit only their course prompt and folder grants |
| Current course participant | No access to another owner's work | Read only through a read/comment folder grant; comment only with comment grant | Never a classmate's conversation | Read granted folders only |
| App instructor only | Existing own-work and legacy instructor scope | No added course privilege | No added access | No course prompt/roster privilege |
| App admin only | Existing operational job/media scope retained | No course bypass | Personal transcript remains owner-only | No course-owner bypass |
| Anonymous/public link | Existing explicit audio-only projection | Same explicit audio-only projection | None | None |

Course owners create folders; private folders are visible only to current course
owners. Read/comment grants admit current participants of that same course.
Every item is checked independently for the same course, retained audio, and
completed status. Revocation applies to subsequent folder, job, note, and media
requests. Course work cannot be placed into a legacy app folder. Expired items
remain labeled placeholders; folder references do not extend audio retention.
There are no anonymous folder shares. Existing owner-created public audio links
retain their prior policy and never expose notes, labels, names, or transcripts.

## Messages, names, and prompts

The roster comes from paginated Admission membership, including students with
zero splits. Course/app-scoped opaque member IDs join it to prospective work;
no student's raw subject, digest, or email is returned. Split lists, message
pages, and prompt history are bounded and scoped before reading.

New course messages are append-only within the current conversation generation.
The server stores accepted student text and produces assistant/tool records.
Client-supplied assistant history is ignored. A message ID identifies a logical
turn; a separate random server claim fences concurrent attempts and late output.
A stale revision returns a recoverable 409. A pending claim has a 120-second
lease, longer than the model deadline. After a process/storage failure, a
fenced recovery records a visible server status and an interrupted receipt
without erasing earlier messages or rerunning uncertain inference. Reusing that
message ID returns 409; a new message can continue after reload. Expired claims
cannot publish late replies or note effects. Reset removes messages and replay
turns for all viewers, advances the revision, and prevents an old completion from
restoring content even if a client reuses its former message ID. Student and
instructor reads expire with the source split at 90 days; the scheduled purge
also deletes message/turn text and guide caches. The historical 60-entry document
is still private and is not represented as a recoverable complete archive.

Notes record the trusted initiating subject and a bounded display-name snapshot.
The source mapping is Admission's verified profile name, with the optional
verified identity `name` as a fallback; there is no assumed `preferred_name`
claim. Missing usable names show “Student.” Historical unknown authors show
“Author unavailable.” Browser rendering escapes text, and exports retain names.
Assistant-created notes retain the initiating author and server provenance.
Only an author can edit/delete their notes; no implicit instructor moderation.

Each course has an independent prompt revision and immutable audit history.
Optimistic revision checks prevent lost edits; a no-op does not create history.
Guide caches include course, base prompt version/hash, and amendment revision.
Publishing an older in-flight result fails its current-prompt check. Personal
work uses the shared base prompt, and the Railway singleton remains separate.

## Migration and release rehearsal

Fresh databases use `schema.sql`; existing Cloudflare databases through baseline
`e1918da3cb6fc37f9715d4cd143af5a5c6c880c6` use
`migrations/0021-classroom.sql` once. The additive migration preserves all old
rows and leaves new associations empty. It adds nullable author columns,
prospective course tables, scoped indexes, and immutable assignment/prompt/grant
history triggers. It contains no data backfill. The `ALTER TABLE` statements are
intentionally one-time: do not replay the raw file or apply it to a fresh schema.
Record its checksum and migration receipt in the deployment journal.

Local tests apply the old schema with private jobs/notes/transcripts, migrate it,
and compare table/column contracts with a fresh database. They assert unchanged
private history and zero manufactured associations. Fresh schema reapplication
is supported; accidental raw migration replay fails at the duplicate column
without rewriting historical content. Workerd browser tests use fresh D1.
The old schema is a digest-checked fixture with its baseline commit recorded in
`cloudflare/fixtures/pre-classroom-schema.md`, so this test also works in shallow
CI checkouts without fetching repository history.

For a separate authorized rehearsal, from `cloudflare/` use isolated local state:

```sh
node_modules/.bin/wrangler d1 execute cail-stem-splitter-preview --local --persist-to /tmp/stem-classroom-d1 --file /tmp/stem-baseline.sql
node_modules/.bin/wrangler d1 execute cail-stem-splitter-preview --local --persist-to /tmp/stem-classroom-d1 --file ../migrations/0021-classroom.sql
node_modules/.bin/wrangler deploy --config wrangler.jsonc --dry-run --outdir /tmp/stem-classroom-build
```

These are local/dry-run commands. A production migration or service release is a
separate authorization gate. Before that gate, record the exact serving Worker
version, D1 identity, migration journal, backup/time-travel recovery point,
row-count checks, and a restore rehearsal in a separate database. Apply the
migration only to the Cloudflare candidate database; never the root legacy
Worker database or Railway. Release the private Admission methods first, then
the receiving Stem authorization, then the portal destination. Missing private
methods fail closed during that sequence. Run real approved-account acceptance
before claiming the classroom is live.

`CAIL_CLASSROOM_ENABLED=false` is a narrow maintenance pause, tested locally.
It stops new course creation/writes/model starts, queued course starts through
`authorizeStoredCourseWork`, instructor review, and folder sharing. Assigned
work remains readable only through its exact owner's protected paths; existing
explicit public audio links retain their existing audio-only policy. It does
not erase associations, retention deadlines, or audit history. Re-enabling
restores current-authority checks. No live setting is changed by this PR.

Do not roll back to pre-classroom code after course work exists: older admin and
folder readers do not understand course boundaries. Use the tested pause on a
schema-aware build while correcting forward. Before any later code rollback,
drain or explicitly settle queued/in-flight work, preserve the migration and
operation journals, and verify the rollback build applies the same private
read policy. PR3's success ledger/queue has an additional migration and drain
procedure; old attempt accounting must never reinterpret it. Already-started
provider work may still finish; neither pause nor rollback promises to cancel
external work or refund it. Retention continues during a pause.

## Verification scope

All committed fixtures use synthetic identities, rosters, model output, and
local D1/audio. Browser coverage includes widths 320–1440, PR27 annotation
spacing, preserved audio/control/draft state through Refresh, separate public
Refresh requests, account changes, instructor review and folder controls.
Screenshots are review evidence outside the repository. Native Chromium zoom
and CSS layout zoom are recorded separately. These checks do not establish a
live CUNY MFA callback, actual classroom roster, or paid provider result.
