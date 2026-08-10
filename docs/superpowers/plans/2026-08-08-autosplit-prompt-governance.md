# Implementation plan: bounded autosplit and prompt governance

**Date:** 2026-08-08
**Design:** `../specs/2026-08-08-autosplit-prompt-governance-design.md`

## Work

- [x] Reconcile GitHub PRs, branches, worktrees, staged files, and dirty local
  precursors; branch from the clean current `origin/main` implementation.
- [x] Port the strongest autosplit implementation and bound it to 45 seconds
  across beginning/middle/end windows in a Web Worker.
- [x] Add honest timeout, decode-error, unsupported-browser, YouTube, and
  Internet Archive fallback behavior.
- [x] Add unit and browser E2E coverage for selection and fallback semantics.
- [x] Freeze authoritative browser uploads into an app-owned streamed snapshot
  before analysis, give analysis and separation the same key, reject analyzer
  byte-count drift, and preserve later teacher-isolation compatibility.
- [x] Expose a deterministic versioned base prompt and multi-variant policy
  fingerprints covering every current conditional rendering arm.
- [x] Escape provider titles plus student-authored labels and notes before they
  enter the system message, label them as untrusted data, and include an
  injection-shaped variant in the governed fingerprint.
- [x] Render its tail read-only with formatted text and upward navigation.
- [x] Keep appended class instructions in a distinct editor with required
  notes, optimistic concurrency, append-only D1 history, and cache invalidation.
- [x] Enforce append-only history with idempotent database triggers in fresh
  schema, Railway boot upgrades, and numbered migration 13; directly test
  update, delete, and replacement rejection without blocking new revisions.
- [x] Page the authenticated runtime changelog by immutable row id so bounded
  40-row responses still expose every retained revision; cover both the server
  cursor boundary and a complete 42-revision browser journey.
- [x] Require cached guides to match the current effective policy SHA-256 plus
  version and amendment revision, with Railway and numbered additive migration
  regressions for legacy rows.
- [x] Make teacher-seed reconciliation authoritative, atomic, and session-safe,
  including rejection of a supplied non-string display name before any write.
- [x] Parse session expiry across ISO/SQLite timestamp formats, bind each save
  response to its own immutable revision under a forced later-save race, and
  keep the console visibly active when server logout fails. Scrub teacher data
  from the DOM only after confirmed revocation.
- [x] Bound teacher JSON bodies by bytes and read time, equalize known/unknown
  password work, cap concurrent PBKDF2 checks, add a bounded single-process
  failure throttle, and mark every teacher API response `no-store`.
- [x] Document secure Cloudflare, Railway, and local teacher provisioning plus
  the fixed-prompt changelog workflow.
- [x] Pass typecheck, unit tests, complete browser E2E, Node-host boot, and
  desktop/mobile rendered-browser acceptance.
- [x] Save an amendment through an isolated Node/SQLite host, stop and restart
  that host against the same data directory, sign in again, and read back the
  same revision/history with `Cache-Control: no-store`.
- [x] Deploy the Node host to the canonical Railway service and prove live
  health, schema readiness, static assets, auth boundaries, and the free smoke
  suite.
- [ ] With a real teacher credential, save one live revision, restart Railway,
  and confirm that revision survives. Never retrieve or expose the credential
  merely to automate this acceptance check.
- [ ] Before adding Railway replicas or migrating to Cloudflare, replace the
  process-local login throttle with a tested distributed edge limit.
- [ ] After the user declares the full product finished, migrate to Cloudflare
  Workers, apply migrations 4/5/7/12/13, provision Worker secrets, and prove
  that separate production journey. Do not take this step early.
