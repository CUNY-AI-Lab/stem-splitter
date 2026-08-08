# Teacher provisioning and prompt governance

The instructor console at `/teacher.html` is protected by teacher accounts, not
by the shared class code. Accounts are provisioned from the `TEACHER_SEED`
secret as pre-hashed records; plaintext passwords must never enter Git, D1,
shell history, command arguments, logs, or screenshots.

## Required database migrations

Existing Cloudflare D1 deployments need both teacher migrations before the
code is deployed:

```sh
bun run db:migrate:4
bun run db:migrate:5
```

Migration 4 creates teacher accounts, sessions, and the current amendment.
Migration 5 adds the append-only prompt revision history. A fresh database uses
`schema.sql` and already contains both.

Railway applies `schema.sql` at boot, so it does not run numbered migrations.

## Generate a teacher record safely

The helper reads the password from standard input and emits only a salted
PBKDF2 record. Use a hidden shell prompt so the plaintext never enters shell
history or the process table:

```sh
STEM_SPLITTER_RECORDS_FILE="$(mktemp)"
chmod 600 "$STEM_SPLITTER_RECORDS_FILE"

read -r -s -p 'Teacher password: ' STEM_SPLITTER_TEACHER_PASSWORD; echo
printf '%s' "$STEM_SPLITTER_TEACHER_PASSWORD" |
  node scripts/hash-teacher-password.mjs instructor "Course Instructor" \
  >> "$STEM_SPLITTER_RECORDS_FILE"
unset STEM_SPLITTER_TEACHER_PASSWORD
```

The helper appends one JSON object. Repeat the hidden-prompt pipeline with a
different username and display name for each additional teacher. The temporary
file then contains one object per line; `jq -s '.'` turns those records into
the authoritative array.

Treat the resulting seed as a secret even though it contains hashes rather than
plaintext: it is still password-verifier material.

## Set the Cloudflare secret

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

For Railway, add `TEACHER_SEED` through the project’s secret-variable UI.
Railway variables and Cloudflare Worker secrets are separate and must be
provisioned independently.

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

## Verify provisioning

1. Open `/teacher.html`; the class code must not grant access.
2. Sign in with the teacher username and password.
3. Confirm the fixed prompt is readable but not editable.
4. Add a small appended instruction and a changelog note, then save.
5. Confirm a revision appears with teacher, timestamp, base prompt version,
   base fingerprint, and effective fingerprint.
6. Reload and confirm both the amendment and history persist.
7. Sign out and confirm `GET /api/teacher/prompt` returns 401.

## Prompt editing and version control

The prompt has two governed layers:

1. **Fixed system prompt** — code-owned in `src/assistant/prompt.ts`. The
   instructor console renders it read-only. Changing it requires a branch,
   review, a `SYSTEM_PROMPT_VERSION` bump, and an entry in
   `docs/prompt-changelog.md`.
2. **Appended class instructions** — runtime content editable by authenticated
   teachers. Every change requires a human changelog note and creates an
   append-only D1 revision.

Each runtime revision stores a monotonic settings revision, the fixed prompt
version and SHA-256 fingerprint it extended, plus the effective prompt
fingerprint. That joins the D1 history
to the Git-controlled prompt changelog without giving the runtime console
permission to rewrite source code.

Saving a changed amendment clears cached guides because they were generated
under an older effective prompt. Saving unchanged content creates no revision
and clears nothing. A stale browser receives HTTP 409 instead of overwriting a
newer teacher’s edit.
