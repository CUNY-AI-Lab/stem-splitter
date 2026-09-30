# STEM Splitter — completion checklist

Updated September 29, 2026. This is the current progression. Work is
Cloudflare-only; preserve Railway and its `main` release path.

## Released baseline

Canonical application: https://stem-splitter.ailab-452.workers.dev/

Release branch: `codex/cloudflare-migration`. PRs #11 and #13–16 are merged.
Latest deployed marker: `cloudflare-playback-retention-20260929`; Worker version
`be74510a-f837-4fa5-8269-a500d0841d88`; merged source `be7b8b4` (PR #16).
The alias serves the same Worker/data, not a second installation.

- [x] CUNY WorkerIdentity handoff, current Admission checks and account-owned saves.
- [x] Server-side rack recovery, pagination and local cross-account tests.
- [x] Ten submitted runs per signed-in person per UTC day; no shared class run cap.
- [x] Listening Guide through CAIL Gateway with the signed-in person's identity.
- [x] 90-day Cloudflare audio retention, account listing and bucket lifecycle readback.
- [x] Instructor grants, optional end date and governed prompt revisions.
- [x] Crate below the workspace, expanded YouTube input and current subtitle.
- [x] Mixer timer/playback-race repairs and desktop/mobile regression tests.
- [x] Canonical asset hashes, signed-in rack reload and existing four-stem playback verified after PR #16.

These receipts do not establish a fresh student/provider journey or classroom
stress qualification. Remixer, server Auto, discovery and isolation remain off.
Visitor paid runs are not implemented or enabled.

## 1. Reliable sign-in and recovery

- [ ] Reproduce the reported first-attempt failure with its site/stage identified.
  Bounded Doorway logs show successful authentication followed by stale
  callbacks, but cannot establish the person or the cause of the first failure.
- [ ] Resolve repeated/stale callback recovery in its owning service without
  replaying codes, accepting invalid state or bypassing Admission.
  [Doorway PR #279](https://github.com/CUNY-AI-Lab/cail-tools-admission/pull/279)
  redirects an already verified session to the Lab tools home without
  granting/renewing access.
  Local tests pass; the shared source gate is blocked by the dependency audit
  already addressed in prerequisite PR #278. Review, release and fresh CUNY
  acceptance remain required.
- [ ] Release state-aware STEM sign-in recovery: verified sessions return home;
  expired sessions get CUNY Login; unavailable verification gets Retry; denied
  access gets Lab help. Local implementation: `codex/classroom-readiness-20260929`,
  not deployed.
- [ ] Verify fresh CUNY login, app logout, expiry, revocation and shared-device
  switching. Existing Doorway-session reuse is not fresh CUNY MFA acceptance.

## 2. Classroom acceptance

- [ ] Actual student: sign in → authorized source → completed split → playback →
  note/rename → Guide/chat → logout → login → account recovery/export.
- [ ] Actual instructor: correct access and prompt-history readback. Do not edit
  app-wide teaching instructions just to produce a test receipt.
- [ ] Class-only membership, expired/revoked membership, second-student isolation
  and exhausted daily runs. Do not spend a real class's allowance just to force
  the limit; synthetic tests and live acceptance stay separate.
- [ ] Record exact release, source provenance, browser and result; keep personal
  identifiers and private audio out of Git.

## 3. Three daily visitor runs

- [ ] Provision/verify Turnstile for exact hosts through its approved credential
  path. Latest setup probe: API token absent. No widget/secret was created.
- [ ] Separate private visitor sessions/ownership, atomic three-run reservations,
  bounded import/concurrency, abuse protection and expiry.
- [ ] Exhausted-state CUNY Login / request-access / reset-time UI.
- [ ] Real challenge success and replay denial; fourth-run, concurrency,
  cookie-reset, visitor/member isolation and provider-failure tests.
- [ ] Promote only after those checks. Do not invent CAIL subjects, downgrade
  denied members to guests or advertise the tier before it is live.

See [daily allowance contract](docs/superpowers/specs/2026-09-29-daily-split-allowances.md).

## 4. Class-specific tools and unified accounting

- [ ] Resolve class context through Admission; add class-scoped Guide settings,
  revision/cache keys and cross-class tests. Current instructions are app-wide.
- [ ] Define explicit submissions and instructor/course ownership before
  exposing student recordings to a class.
- [ ] Authorized directory-backed admin labels, not inferred email/subject
  mapping or a second roster/password store.
- [ ] Shared Gateway asynchronous Replicate contract and real cost settlement,
  including idempotent callbacks, failures, cancellations and uncertain starts.
- [ ] Prove per-person allowance drawdown and rejection before new paid work.

Existing Replicate billing remains approved and unchanged. Daily counts are
not monetary accounting. See [class access and usage](docs/class-access-and-usage.md).

## 5. Legacy recordings

- [ ] Authorized inventory and recoverable source backup.
- [ ] Verified destination identity and explicit ownership; resolve shared or
  ambiguous records rather than assigning the whole class to an instructor.
- [ ] Journaled/idempotent import and batch-only rollback, preserving dates,
  provenance, notes, prompt history and applicable source retention.
- [ ] Destination reload/playback/export and isolation acceptance with the person.

No legacy transfer has been performed. See [migration readiness](docs/account-migration-readiness.md).

## 6. Remixer release

- [ ] Validate existing gated Crate → layers → edit → record → download on live
  desktop/mobile, including stem handoff, Archive delivery, memory bounds and credits.
- [ ] Prove license-conflict/unknown-license handling before enabling the flag.
- [ ] Account project persistence: ownership, schema, versioned arrangement/media
  references, expiry and recovery. Browser-session layers/takes are not account saves.
- [ ] Student acceptance and explicit feature promotion.

## 7. Auto and instrument discovery

- [ ] Reviewed Worker-reachable authenticated analyzer connection; a Railway
  private hostname cannot be used directly by this Worker.
- [ ] Upload/YouTube/Archive parity, frozen 2/4/6 choice, outage fallback and
  evidence before shadow → teacher beta → authoritative Auto.
- [ ] Human-reviewed corpus/negative controls; select exactly one replacement
  classifier and calibrate family thresholds/abstention. Rejected CLAP evidence
  is not permission to provision it.
- [ ] Then evaluate optional AudioSep/SAM-Audio isolation with license, quality,
  cost, concurrency and output-integrity gates.
- [ ] Broaden genre/instrument coverage while rerunning the frozen baseline.
  Coherent long-tail multi-stem research is a later decision.

Exact pins and reviews remain in the [historical roadmap](docs/archive/roadmap-through-2026-09-29.md),
[processing changelog](docs/model-processing-changelog.md) and acceptance files.

## 8. Final qualification and retirement decision

- [ ] Real provider 2/4/6 splits across upload/authorized import types, webhooks
  and polling, Guide streams/tools and safe upstream failures.
- [ ] Large files, classroom concurrency, memory, leases/retries, storage expiry
  and operational alerts under the actual Worker runtime.
- [ ] Backup/restore, ownership-aware migration rehearsal and rollback including
  reconciliation of new Cloudflare writes—not just a URL switch.
- [ ] Classroom/soak acceptance. Railway retirement needs separate approval and
  confirmation that no retained analyzer/service depends on it.
