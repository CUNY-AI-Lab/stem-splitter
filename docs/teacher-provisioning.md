# Teacher provisioning and prompt governance

The instructor console at `/teacher.html` is protected by teacher accounts, not
by the shared class code. Accounts are provisioned from the `TEACHER_SEED`
secret as pre-hashed records; plaintext passwords must never enter Git, D1,
shell history, command arguments, logs, or screenshots.

## Active Railway storage and provisioning

Railway is the active host until the product is finished. Its Node service
opens the SQLite database on the existing persistent app volume, applies the
fresh schema plus additive Node migrations at boot, and retains teacher
accounts, sessions, the current amendment, and prompt revision history across
restarts. The same boot path creates the additive candidate instrument-feedback
table independently of the discovery feature flag, so historical reviews
remain readable while inference is off. Do not run a D1 migration for Railway.

Before provisioning a teacher, confirm the canonical app service is the
Node/Railpack service identified in `server/CLAUDE.md`, not the legacy
same-named workerd project, and confirm its persistent `/data` volume is still
attached.

Add `TEACHER_SEED` in that service's Railway Variables panel, mark it sealed,
and confirm the Dashboard explicitly shows a staged change before proceeding.
If it does not, stop: Railway variable edits otherwise trigger a redeployment
by default. Deploy or restart the canonical app only after the target and diff
are reviewed so boot-time reconciliation runs. Do not pass the seed as a CLI
argument: even pre-hashed password-verifier material does not belong in shell
history or process output.

## Deferred Cloudflare migrations

Cloudflare is not an active release target. When the finished product is later
migrated, an existing D1 deployment will need the applicable numbered
migrations before the corresponding code is deployed:

```sh
bun run db:migrate:4
bun run db:migrate:5
```

Migration 4 creates teacher accounts, sessions, and the current amendment.
Migration 5 adds the append-only prompt revision history. Migration 7 binds
cached guides to the fixed-prompt version and amendment revision that generated
them. Migration 12 adds the effective policy SHA-256 so a content change also
invalidates a cached guide when a manual version bump is missed. Migration 13
adds database triggers that reject updates, deletes, and replacement inserts
against existing prompt-history identities:

```sh
bun run db:migrate:7
bun run db:migrate:12
bun run db:migrate:13
bun run db:migrate:14
```

Migration 14 adds append-only, source-bound candidate instrument feedback. It
does not enable discovery, select a classifier, create a training dataset, or
change a core split.

A fresh database uses `schema.sql` and already contains all six changes.
Migration 6 belongs to the separate Auto-routing feature and retains its own
release gate.

These commands must not be run merely to validate unfinished Railway work.

## Generate a teacher record safely

The helper reads the password from standard input and emits only a salted
PBKDF2 record. Use a hidden shell prompt so the plaintext never enters shell
history or the process table:

```sh
STEM_SPLITTER_RECORDS_FILE="$(mktemp)"
chmod 600 "$STEM_SPLITTER_RECORDS_FILE"

bash -c '
  set -euo pipefail
  IFS= read -r -s -p "Teacher password: " teacher_password
  printf "\n"
  printf "%s" "$teacher_password" |
    node scripts/hash-teacher-password.mjs instructor "Course Instructor" >> "$1"
  unset teacher_password
' _ "$STEM_SPLITTER_RECORDS_FILE"
```

The explicit Bash subshell makes the hidden prompt behave the same from the
workspace's default Zsh and from Bash; the plaintext exists only in that
short-lived subprocess. The helper bounds password input, validates the same
username/display-name shape accepted by seed reconciliation, and appends one
JSON object. Repeat the hidden-prompt pipeline with a different username and
display name for each additional teacher. The temporary file then contains one
object per line;
`jq -s '.'` turns those records into the authoritative array.

Treat the resulting seed as a secret even though it contains hashes rather than
plaintext: it is still password-verifier material.

## Set the seed

### Railway — active

Use the canonical app service's Variables panel to set the complete JSON array
produced by `jq -s '.'`. Confirm the exact project, production environment, and
Node app service before entry, mark the variable sealed, and verify that the
Dashboard is showing a staged change before leaving the form. Railway CLI
variable changes are different: they redeploy by default. If the CLI is used,
the value must enter through stdin and the command must include
`--skip-deploys`, explicit project/environment/service IDs, and a separate
review of the target. Never put `TEACHER_SEED=<value>` on the command line.
Restarting or deploying after the reviewed change reconciles the authoritative
array; an absent seed intentionally leaves existing rows untouched.

Delete the temporary verifier files only after the Railway value has been
entered and the staged change reviewed:

```sh
rm -f "$STEM_SPLITTER_RECORDS_FILE"
unset STEM_SPLITTER_RECORDS_FILE
```

### Cloudflare — deferred migration only

Use a restricted temporary file so the JSON does not become a command-line
argument:

```sh
STEM_SPLITTER_SEED_FILE="$(mktemp)"
chmod 600 "$STEM_SPLITTER_SEED_FILE"
jq -s '.' "$STEM_SPLITTER_RECORDS_FILE" > "$STEM_SPLITTER_SEED_FILE"

bun run wrangler -- secret put TEACHER_SEED < "$STEM_SPLITTER_SEED_FILE"
rm -f "$STEM_SPLITTER_RECORDS_FILE" "$STEM_SPLITTER_SEED_FILE"
unset STEM_SPLITTER_RECORDS_FILE STEM_SPLITTER_SEED_FILE
```

Confirm only that the secret name exists; never print or read back its value:

```sh
bun run wrangler -- secret list
```

Railway variables and Cloudflare Worker secrets are separate. A later migration
must provision the Cloudflare secret deliberately; it does not inherit the
active Railway value.

For local development, place the JSON array in the gitignored `.dev.vars`
file. Do not add a real seed to `.dev.vars.example`.

## Seed reconciliation semantics

A valid `TEACHER_SEED` array is authoritative:

- listed teachers are inserted or updated;
- an optional `name`, when supplied, must be a JSON string no longer than 120
  characters; the helper emits a non-empty 1-120-character display name, and a
  non-string value makes the entire seed invalid before any account changes;
- changing a teacher’s salt/hash/iteration tuple revokes that teacher’s active sessions;
- teachers omitted from a valid seed are deprovisioned and their sessions removed;
- an explicit empty array `[]` deprovisions every teacher;
- an absent secret leaves existing rows untouched;
- malformed entries abort reconciliation without changing any accounts.

After changing the seed, redeploy or restart the host so a fresh process
reconciles it.

## Rotation, deprovisioning, and rollback

To rotate a password, generate a new verifier for the same normalized username,
replace that account in the complete authoritative array, stage the sealed
Railway variable, review the target, and restart or deploy once. Reconciliation
revokes every session for that username when its salt, hash, or iteration count
changes. To deprovision one teacher, omit that username from the next valid
array; use `[]` only when the reviewed intent is to remove every teacher.

Keep the last accepted seed only in an approved secret manager, never in this
repository or an audit artifact. If a seed rotation must be rolled back, restore
that complete prior array through the same staged Railway procedure and restart
the canonical service. If the prior verifier is unavailable, issue a new
password; do not print or reconstruct verifier material from the application
database, logs, or shell history.

Prompt history is append-only. The API transaction requires a unique new row,
and database triggers reject direct row updates, deletes, and replacement or
conflicting inserts. A separate insert guard rejects malformed revision
numbers, content and note bounds, prompt versions/hashes, and actor identities
before those values can become immutable evidence. Fresh databases receive the
triggers through
`schema.sql`; Railway installs them idempotently at boot; the deferred D1 path
uses migration 13. The authenticated API and console expose the newest 40 rows
first, then use a bounded keyset cursor to load earlier pages; every retained
revision remains reachable without sending an unbounded response. Keep database
credentials restricted: a privileged schema administrator could still remove
the triggers. To restore an earlier runtime amendment, load earlier pages as
needed, copy its amendment text from the authenticated revision history into the
appended instructions field, and save it with a new change note such as “Restore
revision 3 after classroom review.” This creates a new monotonic revision; never
delete or rewrite the intervening rows. Reverting fixed prompt behavior also
moves forward: restore the desired source text in a reviewed branch, assign a
new `SYSTEM_PROMPT_VERSION`, and add a new changelog entry. Do not decrement or
reuse an old version string.

A Railway code rollback does not roll back the persistent SQLite volume. Review
the code version and current prompt revision as separate state, preserve the
volume, and use a new governed amendment revision if the runtime content also
needs restoration.

Candidate instrument feedback follows a separate append-only evidence boundary.
Only an authenticated teacher reviewing a stored, complete Auto analysis may
record it. Every surfaced label must be marked confirmed or absent; missed
labels must come from the pinned review vocabulary; and the reviewer records a
genre context. Each row binds the teacher, exact source and analysis SHA-256,
classifier and vocabulary pins, review-ontology version, and monotonic prior
revision. API summaries omit reviewer and source identity. Database constraints
keep every row identified, `unreviewed-candidate`, and training-ineligible, and
prevent update or replacement; deletion follows the retained source job. These
observations cannot change the concrete 2/4/6 model or request an isolation. A
future training or evaluation dataset must be a separately reviewed and
de-identified artifact, never a mutation or direct export of these rows.

## Login boundary

Teacher login and prompt-save requests accept only byte- and time-bounded,
uncompressed JSON. A body that does not finish within five seconds is cancelled.
Usernames and password inputs are length-limited before password work begins,
at most two PBKDF2 checks may run concurrently, and an unknown username still
performs the same PBKDF2 class of work as a known account. The current
single-replica Railway host also applies a bounded process-local failure window:
five failures block that normalized username for two minutes. Successful login
clears the window, and every teacher API response is `Cache-Control: no-store`.
Session expiry parses the stored ISO value instead of comparing it lexically
with SQLite's differently formatted clock. A failed logout does not hide the
console or claim the HttpOnly session was revoked; a confirmed logout clears
the amendment, preview, history, prompt metadata, and form credentials from the
page before returning to sign-in.

The process-local throttle resets on restart and is not globally shared across
replicas. Before increasing the Railway replica count or performing the deferred
Cloudflare migration, add and test a distributed edge rate limit without
logging usernames, passwords, verifier material, or session cookies.

## Verify provisioning

1. Open `/teacher.html`; the class code must not grant access.
2. Sign in with the teacher username and password.
3. Confirm the fixed prompt opens at its end, is readable but not editable,
   and the upward caret brings its true first line into the viewport.
4. Add a small appended instruction and a changelog note, then save.
5. Confirm a revision appears with teacher, timestamp, base prompt version,
   base fingerprint, and effective fingerprint. If the course has more than 40
   revisions, use **LOAD EARLIER REVISIONS** until it disappears and confirm the
   oldest expected revision is present; the newest page alone is not a complete
   persistence check.
6. Generate or load a listening guide before a second prompt change, save that
   change, and confirm the next guide is regenerated under the new revision
   rather than reusing the prior cache.
7. Reload and confirm both the amendment and history persist.
8. Restart the canonical Railway app service, sign in again, and confirm the
   amendment plus revision history still persist. A successful save before the
   restart is not sufficient acceptance.
9. Sign out and confirm `GET /api/teacher/prompt` returns 401 and no amendment,
   preview, history, or actor text remains in the page DOM. If logout transport
   fails, the console must remain visible with an explicit warning until a
   retry confirms server revocation.
10. Confirm teacher API responses use `Cache-Control: no-store`, an oversized
   login body returns 413, a stalled body returns 408, and a bounded
   failed-login burst returns 429 with `Retry-After` without revealing whether
   the username exists.
11. If a completed reviewable Auto job is available, load its advisory analysis,
    record a complete confirmed/absent review plus any genuinely missed
    instruments, reload it, and confirm the revision persists while the core
    model and isolation state remain unchanged. Treat this only as candidate
    evidence; it does not close classifier calibration or human corpus-review
    gates.

## Prompt editing and version control

The prompt has two governed layers:

1. **Fixed system prompt** — code-owned in `src/assistant/prompt.ts`. The
   instructor console renders its tail read-only at first so the boundary with
   appended instructions is visible. An upward caret expands the complete
   Markdown-formatted prompt and jumps to its top. Presentation never grants
   edit authority: changing fixed text requires a branch, source review, a
   `SYSTEM_PROMPT_VERSION` bump, and an entry in `docs/prompt-changelog.md`.
2. **Appended class instructions** — runtime content editable by authenticated
   teachers. Every change requires a human changelog note and creates an
   append-only database revision row (SQLite on Railway; D1 only after the
   deferred migration). Row-level database triggers prevent direct update,
   delete, and replacement of an existing revision identity and reject malformed
   new audit rows. The console pages
   backward through that immutable history by row id, 40 revisions at a time,
   until the complete trail has been loaded.

Each runtime revision stores a monotonic settings revision, the fixed prompt
version and SHA-256 fingerprint it extended, plus the effective prompt
fingerprint. That joins the database history
to the Git-controlled prompt changelog without giving the runtime console
permission to rewrite source code.

The readable Markdown prompt in the console is one deterministic guide-mode
example, not the hash input. Base and effective hashes use the versioned
multi-variant policy bundle in `src/assistant/prompt.ts`, which covers every
current conditional fixed-prompt arm: guide/chat, `other`/`instrumental`,
empty/populated notes, known/unknown duration, canonical/custom labels, and
injection-shaped title/label/note data. Provider titles and student labels/notes
are escaped and marked untrusted before entering the system message; only the
authenticated appended class layer can supply runtime instructions.
When code introduces another conditional prompt arm, the same reviewed commit
must add a deterministic fingerprint variant and its regression coverage.

Saving a changed amendment atomically updates the setting, appends history, and
clears cached guides because they were generated under an older effective
prompt. A failure in any operation rolls back all three. Every new guide cache
row stores its fixed-prompt version, effective policy SHA-256, and amendment
revision. An old generation that finishes after a teacher save may finish
streaming to the request that started it, but its revision-guarded write cannot
repopulate the class-wide cache. A mismatched version or policy SHA also makes
an older guide ineligible and it regenerates lazily, including when a future
fixed-prompt edit accidentally misses its required version bump.

Saving unchanged content creates no revision and clears nothing. A losing
concurrent save cannot clear a guide regenerated after the winner commits, and
a stale browser receives HTTP 409 instead of overwriting a newer teacher’s
edit. A winning response is read from the immutable row created by that request,
so a later save cannot splice newer amendment text into the earlier response's
version and hashes.
