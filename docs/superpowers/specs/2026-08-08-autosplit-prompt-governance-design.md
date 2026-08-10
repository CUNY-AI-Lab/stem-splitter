# Design: bounded autosplit and governed instructor prompt editing

**Date:** 2026-08-08
**Status:** Implemented locally; Railway release pending

## Goals

1. Make `AUTO` a dependable local-file choice without sending audio anywhere
   merely to choose a separation contract.
2. Preserve deterministic browser fallback for remote imports while giving the
   authoritative server path content-based analysis after import.
3. Let instructors understand the active Listening Guide prompt while keeping
   code-owned guardrails fixed and runtime additions attributable over time.

## Autosplit

The browser decodes at most 45 seconds total, sampled from the beginning,
middle, and end. A dedicated browser analysis worker downmixes the segments,
extracts bounded spectral features, and returns one of the existing
provider-neutral contracts. Analysis never blocks the UI thread and never
creates a new backend model id.

The rules prefer six parts when distinct plucked/key textures are present, two
parts when the signal is primarily voice plus accompaniment, and four parts as
the conservative general-purpose choice. Low-end movement contributes to the
decision so sustained but changing bass is not discarded as mere average
energy. Unsupported decoding, analysis failure, or timeout resolves explicitly
to the catalogue default. The active authoritative path stores an upload,
YouTube import, or Internet Archive import first and then gives the private
Railway analyzer a bounded signed source URL, so remote imports receive the same
content-based routing as uploads. A browser upload first streams into a
job-specific app-owned snapshot outside the browser-writable prefix; analysis
and separation use the same snapshot, so a still-live upload PUT cannot change
the paid input after the decision. Server-fetched imports instead bind the
analyzer response to the SHA-256 and byte count calculated before storage.
Browser-only/shadow mode remains advisory and reports an honest fallback when
it cannot analyze a remote source.

## Prompt ownership boundary

The instructor console displays the deterministic code-owned system prompt as
formatted, read-only text. It opens at the tail, where runtime content is
appended, and an upward caret expands and moves to the top. The browser cannot
rewrite source. A fixed-prompt change passes backward through the repository:
edit `src/assistant/prompt.ts`, increment `SYSTEM_PROMPT_VERSION`, and record
the behavior change in `docs/prompt-changelog.md`.

Provider titles plus student-authored channel labels and timeline notes are
untrusted data inside that fixed prompt, never another instruction layer. The
builder JSON-escapes quotes, control characters, and Unicode line separators so
those values remain on their data line instead of impersonating a heading or
rule block. An injection-shaped policy variant makes that encoding part of the
base/effective fingerprint and guide-cache identity.

Authenticated instructors edit only the dedicated appended class-instructions
field. A changed save requires a concise human note. The same database batch
updates the current amendment, invalidates cached guides, and appends a revision
containing the actor, timestamp, fixed-prompt version, fixed-prompt SHA-256
fingerprint, and effective-prompt fingerprint. Optimistic concurrency rejects
stale editors with HTTP 409. The fingerprints hash a deterministic policy
bundle spanning every current conditional rendering arm rather than the single
readable console example. Guide rows carry the fixed-prompt version, effective
policy fingerprint, and amendment revision; a generation that began before an
edit cannot re-cache stale output after the edit commits, and a content change
cannot reuse an old guide even if its manual version bump is missed. A no-op
creates no revision and does not invalidate cached guides. Database triggers
make the audit rows themselves append-only by rejecting update, delete, and
replacement/conflicting-insert paths on fresh schema, Railway boot upgrades,
and the deferred numbered D1 migration. A companion insert trigger rejects
invalid revision numbers, content/note bounds, policy hashes/versions, and actor
identities before a malformed row can become immutable. A successful response
is assembled from the exact history row inserted by that request, so a later
teacher save cannot mix its amendment with the earlier request's hashes. Access
control still protects the schema because a privileged database administrator
can remove those triggers.
History reads remain bounded without truncating the audit trail: the console
loads the newest 40 revisions and follows an authenticated newest-first keyset
cursor until every retained row is reachable.

## Provisioning

`TEACHER_SEED` remains a secret array of pre-hashed PBKDF2 records and becomes
authoritative on successful reconciliation. The entire seed is validated
before writes. Listed accounts are upserted, omitted accounts are removed,
password changes revoke sessions, and `[]` removes all accounts. A missing
secret leaves D1 alone; a malformed or duplicate seed changes nothing. An
optional display name must be a string no longer than 120 characters; a
non-string value rejects the complete seed before any rename or account write.
Session expiry parses the stored ISO timestamp before comparing it with SQLite
time. A failed logout leaves the console visibly active because the HttpOnly
cookie may still be valid; only confirmed server revocation hides the console
and clears teacher content and credentials from the DOM.

## Acceptance

- Autosplit unit tests cover feature decisions and multi-window sampling.
- Browser E2E proves local AUTO resolution, deterministic browser fallback, and
  authoritative upload/YouTube/Archive analysis after source storage.
- Instructor E2E proves fixed text cannot be edited, caret navigation works,
  change notes are required, revisions persist, hashes join runtime history to
  code history, more than 40 revisions remain reachable without overlap, and
  stale writes fail without overwriting. Server migration tests prove fresh,
  Railway-upgraded, and numbered-migration history rejects direct mutation while
  accepting only well-formed new revisions; seed tests prove malformed display
  metadata cannot partially reconcile an authoritative array. Deterministic
  session and browser tests cover same-day expiry, exact concurrent readback,
  failed logout, confirmed revocation, and DOM scrubbing.
- Typecheck, unit tests, browser E2E, a Node-host boot, and a real rendered-
  browser review must all pass before the Railway release.
- Cloudflare Workers packaging and migration remain deferred until the user
  declares the whole product finished.
