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
- [x] Expose a deterministic versioned base prompt and fingerprints.
- [x] Render its tail read-only with formatted text and upward navigation.
- [x] Keep appended class instructions in a distinct editor with required
  notes, optimistic concurrency, append-only D1 history, and cache invalidation.
- [x] Make teacher-seed reconciliation authoritative, atomic, and session-safe.
- [x] Document secure Cloudflare, Railway, and local teacher provisioning plus
  the fixed-prompt changelog workflow.
- [x] Pass typecheck, unit tests, complete browser E2E, Node-host boot, and
  desktop/mobile rendered-browser acceptance.
- [x] Deploy the Node host to the canonical Railway service and prove live
  health, schema readiness, static assets, auth boundaries, and the free smoke
  suite.
- [ ] With a real teacher credential, save one live revision, restart Railway,
  and confirm that revision survives. Never retrieve or expose the credential
  merely to automate this acceptance check.
- [ ] After the user declares the full product finished, migrate to Cloudflare
  Workers, apply migrations 4/5, provision Worker secrets, and prove that
  separate production journey. Do not take this step early.
