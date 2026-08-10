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
restarts. Do not run a D1 migration for Railway.

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
migrated, an existing D1 deployment will need both teacher migrations before
the corresponding code is deployed:

```sh
bun run db:migrate:4
bun run db:migrate:5
```

Migration 4 creates teacher accounts, sessions, and the current amendment.
Migration 5 adds the append-only prompt revision history. A fresh database uses
`schema.sql` and already contains both.

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
- changing a teacher’s salt/hash/iteration tuple revokes that teacher’s active sessions;
- teachers omitted from a valid seed are deprovisioned and their sessions removed;
- an explicit empty array `[]` deprovisions every teacher;
- an absent secret leaves existing rows untouched;
- malformed entries abort reconciliation without changing any accounts.

After changing the seed, redeploy or restart the host so a fresh isolate
reconciles it.

## Login boundary

Teacher login and prompt-save requests accept only byte- and time-bounded,
uncompressed JSON. A body that does not finish within five seconds is cancelled.
Usernames and password inputs are length-limited before password work begins,
at most two PBKDF2 checks may run concurrently, and an unknown username still
performs the same PBKDF2 class of work as a known account. The current
single-replica Railway host also applies a bounded process-local failure window:
five failures block that normalized username for two minutes. Successful login
clears the window, and every teacher API response is `Cache-Control: no-store`.

The process-local throttle resets on restart and is not globally shared across
replicas. Before increasing the Railway replica count or performing the deferred
Cloudflare migration, add and test a distributed edge rate limit without
logging usernames, passwords, verifier material, or session cookies.

## Verify provisioning

1. Open `/teacher.html`; the class code must not grant access.
2. Sign in with the teacher username and password.
3. Confirm the fixed prompt is readable but not editable.
4. Add a small appended instruction and a changelog note, then save.
5. Confirm a revision appears with teacher, timestamp, base prompt version,
   base fingerprint, and effective fingerprint.
6. Reload and confirm both the amendment and history persist.
7. Restart the canonical Railway app service, sign in again, and confirm the
   amendment plus revision history still persist. A successful save before the
   restart is not sufficient acceptance.
8. Sign out and confirm `GET /api/teacher/prompt` returns 401.
9. Confirm teacher API responses use `Cache-Control: no-store`, an oversized
   login body returns 413, a stalled body returns 408, and a bounded
   failed-login burst returns 429 with `Retry-After` without revealing whether
   the username exists.

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
   deferred migration).

Each runtime revision stores a monotonic settings revision, the fixed prompt
version and SHA-256 fingerprint it extended, plus the effective prompt
fingerprint. That joins the database history
to the Git-controlled prompt changelog without giving the runtime console
permission to rewrite source code.

Saving a changed amendment clears cached guides because they were generated
under an older effective prompt. Saving unchanged content creates no revision
and clears nothing. A stale browser receives HTTP 409 instead of overwriting a
newer teacher’s edit.
