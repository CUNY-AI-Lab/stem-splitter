# Design: bounded autosplit and governed instructor prompt editing

**Date:** 2026-08-08
**Status:** Implemented locally; Railway release pending

## Goals

1. Make `AUTO` a dependable local-file choice without sending audio anywhere
   merely to choose a separation contract.
2. Preserve deterministic behavior for remote imports that cannot be decoded
   in the browser before job creation.
3. Let instructors understand the active Listening Guide prompt while keeping
   code-owned guardrails fixed and runtime additions attributable over time.

## Autosplit

The browser decodes at most 45 seconds total, sampled from the beginning,
middle, and end. A dedicated Worker downmixes the segments, extracts bounded
spectral features, and returns one of the existing provider-neutral contracts.
Analysis never blocks the UI thread and never creates a new backend model id.

The rules prefer six parts when distinct plucked/key textures are present, two
parts when the signal is primarily voice plus accompaniment, and four parts as
the conservative general-purpose choice. Low-end movement contributes to the
decision so sustained but changing bass is not discarded as mere average
energy. Unsupported decoding, Worker failure, or timeout resolves explicitly
to the catalogue default. YouTube and Internet Archive imports also use that
fallback because their bytes are not locally available at selection time; the
status text says so rather than implying content analysis occurred.

## Prompt ownership boundary

The instructor console displays the deterministic code-owned system prompt as
formatted, read-only text. It opens at the tail, where runtime content is
appended, and an upward caret expands and moves to the top. The browser cannot
rewrite source. A fixed-prompt change passes backward through the repository:
edit `src/assistant/prompt.ts`, increment `SYSTEM_PROMPT_VERSION`, and record
the behavior change in `docs/prompt-changelog.md`.

Authenticated instructors edit only the dedicated appended class-instructions
field. A changed save requires a concise human note. The same D1 batch updates
the current amendment and appends a revision containing the actor, timestamp,
fixed-prompt version, fixed-prompt SHA-256 fingerprint, and effective-prompt
fingerprint. Optimistic concurrency rejects stale editors with HTTP 409. A
no-op creates no revision and does not invalidate cached guides.

## Provisioning

`TEACHER_SEED` remains a secret array of pre-hashed PBKDF2 records and becomes
authoritative on successful reconciliation. The entire seed is validated
before writes. Listed accounts are upserted, omitted accounts are removed,
password changes revoke sessions, and `[]` removes all accounts. A missing
secret leaves D1 alone; a malformed or duplicate seed changes nothing.

## Acceptance

- Autosplit unit tests cover feature decisions and multi-window sampling.
- Browser E2E proves local AUTO resolution and the remote fallback contract.
- Instructor E2E proves fixed text cannot be edited, caret navigation works,
  change notes are required, revisions persist, hashes join runtime history to
  code history, and stale writes fail without overwriting.
- Typecheck, unit tests, browser E2E, a Node-host boot, and a real rendered-
  browser review must all pass before the Railway release.
- Cloudflare Workers packaging and migration remain deferred until the user
  declares the whole product finished.
