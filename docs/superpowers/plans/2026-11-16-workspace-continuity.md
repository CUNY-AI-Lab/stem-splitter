# Silent workspace continuity implementation plan

Status: proposed work; documentation does not authorize production changes.
Specification: `../specs/2026-11-16-workspace-continuity.md`. Do not restore the
earlier browser-copy interface, scripts or proof API wholesale. No continuity
messages, banners, links, dialogs, popup or visible page at any stage.

## Stage 0 — Freeze contracts and test fixtures

1. Record source, runtime flags and the spec's complete coverage ledger. Mark
   private listening state as the first implementation subset; preferences,
   rack presentation, form drafts, historical compatibility and unsupported
   memory-only work remain separate entries.
2. Settle typed route schemas, exact per-actor byte quota, version retention and
   job expiry behavior. First-stage logical records are `listeningDraft`,
   `listeningPlayer` and inert pending-work versions; do not use arbitrary keys.
3. Define explicit absent versus cleared values, canonical serialization/digest,
   base revision, idempotency ID, source provenance and acknowledgment. Bound seed
   requests to 64 records/512 KiB with pagination and each pending record to
   256 KiB plus field limits. Reject oversized inputs without truncating originals.
4. Add local fixtures for every acceptance-matrix row before broad integration.
   Include source member+guest dual cookies, account switch after each await,
   old pending transcript after reset, orphan listening keys and competing drafts.
   Fixtures must not read live browser profiles or actual private work.

## Stage 1 — Private typed persistence

Target `src/ui-state.ts`, `src/index.ts`, current identity/access helpers and a new
additive migration selected against the repository's then-current migration list.
Do not assume the removed proof migration was deployed in production.

1. Implement private subject-owned GET/PUT and bounded create-if-missing seed
   operations. Reuse current member/guest authorization and job/course access.
   Add current actor response fencing. No teacher/admin bypass for another
   subject's private state and no provider or workflow mutation in these routes.
2. Store draft and player independently; periodic player writes cannot clobber
   draft revisions. Implement clear tombstones, atomic optimistic writes,
   idempotent acknowledgments and immutable conflict/pending versions.
3. Enforce current retention, byte quotas and known-denial versus authority-outage
   behavior. No payload logging or URLs containing private data or identities.
4. Test SQL atomicity, race winners, reset/clear behavior, replay after lost
   acknowledgment, expiry, capacity failure and exact actor isolation. Verify
   migration compatibility and ordinary operations remain unaffected.

Stage acceptance: service fixtures pass. This stage alone is not browser parity
and should not expose an unused public workflow.

## Stage 2 — Normal listening-state hydration and saves

Target `public/guest-claim.js`, `public/app.js`, `public/session-guard.js` and a
small continuity client module loaded by existing pages if that keeps boundaries
clear. No recovery link or separate visible page.

1. Snapshot actual matching legacy local keys before a new mixer writes defaults.
   Include retained listening keys absent from `jobs:<subject>`. Never enumerate
   other subjects' private namespaces or adopt unscoped `coachChat`.
2. Read server state with a short deadline; fence on actor/generation and field
   edit generation after every await. On failure use local state silently and
   keep the normal interface usable. Do not overwrite focused/current draft text.
3. Hydrate only draft/player fields, validating stems/duration/rates. Do not set
   live pending chat/guide/conversation fields, autoplay or resume live sessions.
4. Debounce future text/player saves independently with revision/idempotency
   control. Preserve the local value until acknowledgment; retain conflicting
   alternatives server-side. Prevent startup empty/default writes from clearing
   either side. Explicit user clears are acknowledged tombstones.
5. Preserve pending objects as inert versions. Confirm that ordinary construction,
   opening Listening Guy, focus, reload and imported guide-open state cannot
   trigger transcript PUT or paid retries from imported pending contents.
6. Add real-page local browser fixtures for local edits during slow hydration,
   quota failure, two tabs, clear/reset, private shared-job drafts and denied
   access. Assert no new UI text/link/dialog and no source deletion.

Stage acceptance: ordinary same-origin app persistence works. Still not initial
cross-origin source-cache continuity; record that explicitly.

## Stage 3 — Atomic guest claim and quiet initial Tools visit

Target `src/guest/claim.ts`, `cloudflare/guest.ts`,
`cloudflare/guest-transfer.ts`, `cloudflare/tools.ts`, `cloudflare/worker.ts`,
existing quiet transfer scripts and their tests. Coordinate any necessary
Doorway route/cookie contract separately; do not alter Doorway speculatively.

1. Extend the existing D1 claim transaction with UI-state copy/version inserts
   gated by the same verified guest/member and exact `guest_job_claims`. Existing
   member values win active slots; guest conflicts remain immutable. Test
   all-or-nothing rollback, repeat claims, different members and transcript resets.
2. Define the source guest seed's server-verified context separately from member
   `/api/account`. Test both cookies present, different members across origins,
   claimed/expired/revoked guest cookies and partial signed credentials. Browser
   subject/job strings confer no access.
3. At the existing original-host transition route, seed first-party local data
   with a minimal script-bearing response and no UI/editor initialization, then
   continue the existing guest handoff. Keep current fixed destinations,
   nonce/expiry/replay protections and origin checks. Private state travels only
   in same-origin authenticated bodies, never fragments/query strings or logs.
4. Bound seeding to eight seconds and return to the normal app on all failures.
   Keep one-shot session guards and blocked-storage fallbacks. Do not create a
   new popup, frame embedding, login requirement or guest-choice screen.
5. Target initialization reads its own server state after the normal identity
   handoff/claim. A source member seed stays with that member; a guest seed follows
   only accepted ownership mapping. Do not merge distinct active guests.
6. Preserve late local guest seeds only through a separately reviewed exact claim
   mapping and verified proof. If that proof is unavailable, defer; do not infer
   ownership because the user knows a guest subject string.
7. Exercise initial Tools guest, existing Tools guest, target member, source member
   only, source member+guest, mismatched members, guest collision and source
   outage. Include storage denied, missing/corrupt state, timeouts and reloads.

Stage acceptance: initial same-identity listening-state continuity works without
prompts, and guest claims preserve it atomically. Other ledger families remain
unimplemented until their stages pass.

## Stage 4 — Preferences, rack and private form drafts

1. Implement exact typed preferences for current model, sample rotation, enabled
   tab and selected class; legacy device preferences seed only missing values.
   Fresh capability/catalogue checks must not set sharing acknowledgment.
2. Add rack presentation/order/collapse separately from authoritative job metadata.
   Persist explicit suppression so remove/404/folder move is not undone on reload.
3. Add normal private drafts for annotation/label/title, folder creation/rename,
   and instructor forms with the correct subject/job/course/settings-revision
   scopes. Never submit or publish those forms during hydration.
4. If historical removed-version archives need support, parse exact bounded
   schemas and embedded subject, preserve corrupt raw bytes, reauthorize every
   referenced job and retain inert pending/suppression. Keep all old UI absent.
5. Expose conflicting/inert versions through existing private exports only if
   needed for usable preservation; no new recovery UI. Document unresolved active
   draft conflicts honestly rather than silently concatenating or discarding text.

Stage acceptance: mark each implemented family individually. Do not treat a
settings endpoint as proof that editor drafts, uploads or report text are covered.

## Stage 5 — Explicitly unresolved families

- Older open tabs with DOM-only text: leave untouched; no reload-based extraction.
- Anonymous report drafts: retain current memory-only privacy contract pending a
  deliberate product decision. Do not associate them with a member silently.
- Legacy unscoped transcripts/rack: no verified owner; preserve without adopting.
- Pending split/session/usage bookkeeping: preserve necessary inert references,
  not operational authority or historical telemetry; never replay submissions.
- Selected files, upload bytes and disabled Remixer takes: require separate
  binary/operation persistence if made part of a later implementation. Blob URLs
  cannot fulfill this requirement.
- Live playback, host/follower grants, passwords/class code and other transient
  authority: do not synchronize into active state.

These are coverage limits, not hidden exclusions. Report them with each release
until a safe agreed treatment is implemented. The first listening-state release
must not be described as complete all-browser-data parity.

## Release and acceptance gates

1. Independent review of account fencing, source read-only capture, conflict
   retention, pending-operation isolation, guest transaction and initial visit.
2. Run relevant unit/migration/browser tests, then required Cloudflare local
   release gates on the exact coherent commit. Keep shared/private dependency pins
   intact; use the user-confirmed author/committer identity when authorized to
   commit. No unrelated cleanup or deployments.
3. Apply the reviewed additive schema before dependent code, preserving old-code
   compatibility and a code rollback path. A rollback never deletes state.
4. Under the existing Dev-first release policy, verify disposable real member and
   guest workflows at both addresses, current access, normal split/playback and
   no continuity UI. Do not manipulate original user tabs or drafts. Synthetic
   fixtures do not replace actual authenticated acceptance.
5. Record exact source/tree/version and the acceptance matrix per covered family.
   Production requires its own authorized promotion and ordinary-browser checks.
   Keep source tests, deployment receipts, data-preservation evidence and provider
   acceptance distinct. This plan itself performs none of those operations.
