# STEM Splitter: next implementation sequence

**Updated:** 2026-08-09

**Active release target:** Railway

**Migration boundary:** Do not deploy to Cloudflare Workers until the user declares the product finished.

**v3.2 implementation branch:** `codex/v3.2-audio-pipeline`

**Current posture:** Phase 0 contracts, fixed corpus metadata, deterministic
browser/server PCM parity, the flag-gated Phase 1B application path, and the
Phase 1A service code are implemented locally. The minimized, digest-pinned
role-v3 image now builds as `linux/amd64` under local emulation and passes its
runtime allowlist, non-root, health, readiness, authentication, eight-format
decode, and eleven-source corpus gates on FFmpeg 8.0.3. The final image contains
one bundled application artifact plus `ffmpeg` and `ffprobe`, rather than the
root project's unused runtime dependencies. Server Auto remains off live and no
additional Railway service has been provisioned. Local FFmpeg, real Chrome, and
the pinned image agree on all eleven authorized v3 routing choices (8 preferred,
3 accepted alternatives). Native CI, manual stem listening, resource-limit
testing, and live Railway acceptance remain gates before authority. See the
[adversarial hardening audit](docs/audits/2026-08-09-audio-pipeline-phase0.md)
and [model-processing changelog](docs/model-processing-changelog.md).

Phase 2 now has a local, flag-off contract seam: a content-hashed 51-label
teacher-reviewable vocabulary, exact CLAP checkpoint/artifact pins, a bounded
private PCM client, fail-lazy discovery traces, student-response redaction, and
a teacher-authenticated analysis read route. A separate Python service,
deterministic aggregation policy, process-fatal inference watchdog, and
digest-pinned image recipe are implemented locally and pass 30
contract/fake-backend/process tests. A matching native arm64 image has started
with networking disabled and a read-only root filesystem and completed real
CLAP inference on a synthetic control; the `linux/amd64` target image also
builds and matches the current source hashes. The eleven-source evaluation and
networkless raw-logit audit reject the current prompt/checkpoint pairing, so it
must not be calibrated or provisioned under the existing classifier ID. A
separate pinned, networkless YAMNet TFLite comparator now covers 36/51
classroom labels and completed the same licensed corpus. It ranked 21/40
eligible reviewed groups in the top five, but placed no reviewed brass,
woodwind, or free-reed group there and retains 15 explicit ontology gaps.
Treat it as a promising comparison baseline, not a selected classifier: no
threshold, feature flag, application dependency, or service was added. Native
amd64 startup/inference, Railway sizing, human-reviewed calibration, and
service provisioning remain open.
A path-scoped, secret-free native-amd64 image workflow is defined locally but
has not yet run on GitHub, and no detection has been promoted. See the
[discovery design](docs/superpowers/specs/2026-08-09-instrument-discovery-design.md)
and [implementation plan](docs/superpowers/plans/2026-08-09-instrument-discovery.md).
The complete local Phase 0 command passes 132 worker, 21 analyzer, 14 Railway
host/migration, 5 separator, 30 discovery, 9 YAMNet contract, 19 flags-off
browser, and 4 authoritative-Auto browser tests. This is source and local-image
evidence only; it does not close native CI or Railway acceptance.

This roadmap extends AutoSplit beyond assumptions inherited from a traditional
rock-band mix. The goal is to recognize and optionally isolate instruments such
as strings, brass, woodwinds, organ, synthesizer, accordion, harp, and regional
or traditional instruments without destabilizing the dependable core split.

The order below is mandatory. A later phase must not become the default merely
because its model or service is available.

## Stable baseline to preserve

- [x] Keep the active Railway `stem-splitter` Node/Railpack service as the app,
  storage, job-control, and webhook authority. Do not substitute the legacy
  Railway `web` service or move unfinished work to a Worker runtime.
- [x] Keep a discrete `INSTRUCTOR` link in the mixer footer. The canonical live
  Railway page renders `/teacher.html` at that link and the target returns 200.
- [x] Keep the current provider-neutral 2-, 4-, and 6-track contracts and the
  pinned Replicate Demucs runner working while experiments are introduced.
- [x] Keep four tracks as the conservative separation default until a new
  routing policy clears the evaluation and release gates below.
- [x] Keep browser AutoSplit classification bounded to the complete source when
  it is at most 45 seconds and to beginning/middle/end windows otherwise, move
  resampling/FFT work off the UI thread, and fail honestly when Web Audio
  decoding or worker analysis exceeds 20 seconds.
- [x] Keep authoritative Auto from decoding uploads in Web Audio at all; the
  stored source is analyzed on Railway. Cap the temporary browser-only/shadow
  path at 5 minutes and 24 MiB before `decodeAudioData`, with a tested honest
  fallback for anything larger.
- [ ] Retire browser shadow decoding after parity calibration or replace it
  with a streaming decoder. Duration/byte caps sharply reduce classroom risk
  but cannot exactly bound decoded PCM for exotic high-rate or multichannel
  compressed files.
- [x] Keep the fixed teacher system prompt code-owned and read-only in the
  editor. Open its Markdown-formatted view at the tail, provide an interactive
  upward caret to inspect the top, and isolate teacher-appended instructions in
  a dedicated field. Require a change note and retain teacher, timestamp, base
  prompt version/SHA, effective SHA, and amendment snapshot in revision history
  so prompt changes remain traceable without letting a browser edit fixed
  guardrails.
- [x] Document Railway-first teacher provisioning, deprovisioning, rotation,
  rollback, and acceptance. Generate verifier records through a hidden prompt
  in an explicit Bash subprocess so the documented command is safe from the
  workspace's default Zsh as well as Bash. The helper bounds/validates stdin and
  seed identity fields before PBKDF2, with direct regressions. This documentation
  does not replace the authorized live persistence check below.
- [ ] Complete the remaining live teacher-console acceptance check from
  `docs/superpowers/plans/2026-08-08-autosplit-prompt-governance.md`: save one
  revision with an authorized real teacher account, restart Railway, and prove
  that the revision persists. An isolated Node/SQLite save-login-restart-login
  readback now passes locally at revision 1; it does not substitute for the
  real Railway/volume check. A value-free canonical-service readback confirms
  the `TEACHER_SEED` key is present, but key presence does not prove account
  reconciliation or persistence. Never retrieve or expose the credential to
  automate that live check.
- [x] Bound teacher login/prompt JSON by bytes and read time, equalize
  unknown-account PBKDF2 work,
  cap concurrent password checks, throttle failure bursts on the current
  single-replica Railway process, and make teacher responses `no-store`.
- [x] Preserve the prompt/history/cache transaction under concurrent Railway
  requests. A direct reproduction showed the Node D1 shim allowed a second
  `batch()` to issue `BEGIN` while the first batch was suspended; each
  synchronous SQLite batch now runs without an internal await. Prompt update,
  append-only revision, and guide-cache deletion share one rollback boundary,
  only the winning compare-and-swap may invalidate guides, and the save response
  reads back its exact revision instead of whichever revision is newest.
  Concurrent-batch, losing-CAS, and concurrent-save regressions pass at
  `821f5e1`.
- [x] Prevent stale guide generations from undoing prompt governance. Each
  cached guide records the code-owned `SYSTEM_PROMPT_VERSION` and monotonic
  amendment revision; its single-statement upsert succeeds only while that
  revision remains current. A guide begun before a teacher edit can finish for
  its original caller but cannot repopulate the shared cache, and guides from an
  older fixed prompt regenerate lazily. Railway's additive migration preserves
  legacy rows with a deliberately ineligible cache identity. Focused tests also
  prove transaction rollback when invalidation fails.
- [x] Fail closed on prompt-history drift. A pre-existing row for the next
  settings revision must raise an integrity error and roll back the setting,
  cache invalidation, and attempted history write; it may never be silently
  reused as the audit record for a different amendment. The compare-and-swap,
  required append, and winning-request-only invalidation now form a chained
  transaction, with a direct corruption/restore regression.
- [x] Pin the active Railpack host and CI to exact Node `22.23.1` instead of a
  floating `>=22.5`, declare matching Node types directly, and statically check
  `server/` plus shared `src/`. This catches Railway-adapter errors that the
  Worker-only typecheck cannot see. The package/runtime/typecheck slice is
  committed at `821f5e1`.
- [ ] Add a distributed teacher-login edge limit before increasing Railway
  replicas or performing the deferred Cloudflare migration; the process-local
  throttle intentionally does not claim cross-replica protection.
- [x] Capture a new baseline before pipeline work: commit SHA, full test result,
  live `/healthz`, one authorized real-audio 4-track job, output hashes, latency,
  and provider/model version. This is the rollback comparison point. The live
  evidence is recorded under
  `docs/acceptance/2026-08-09-v3.2-rollback-baseline/`; all four outputs had
  valid MP3 headers and distinct hashes. The complete `test:phase0` source gate
  passes on committed source `d4c5781`: 105 worker, 21 analyzer, 5
  server/migration, 5 separator, 24 discovery, 19 browser E2E, and 4
  server-authoritative Auto E2E tests, including the oversized-job-body gate.
  Manual listening remains a release gate.
- [x] Make the repeatable baseline capture fail closed before it handles a class
  code or audio: HTTPS-only remote origin, exact ready health/default contract,
  bounded requests/responses and polling, no redirects, no reflected error
  bodies, same-origin credential-free output URLs, real MPEG-frame evidence,
  exact metadata shapes, and immutable `0600` output. Four focused regressions
  cover the secret, transport, and false-positive audio boundaries.
- [x] Bind the passing full-gate result above to committed source `d4c5781`
  before opening a PR or deploying. Documentation-only follow-up commits do
  not change that tested source identity.
- [x] Bound inbound app JSON and outbound Archive/YouTube bodies by media type,
  declared and streamed bytes, read time, and redirect policy. Reject malformed
  prediction identities, non-audio provider bodies, unsupported licence URLs,
  incomplete Archive duration/size metadata, and unapproved redirect origins;
  cancel rejected streams and log only safe error names/codes.
- [x] Apply one wall-clock budget across Archive retry, redirect, header, and
  body work and across each YouTube provider's session, prediction start/body,
  polling, and output header/body. Map arbitrary provider stream and
  playability errors to fixed local messages rather than reflecting provider
  text. Focused regressions prove the Archive and Replicate phase budgets plus
  safe stream-error normalization.
- [x] Close the remaining Innertube transport boundary before remote Auto is a
  release candidate. The injected fetch restricts requests and manually
  validated redirects to the reviewed `www.youtube.com` session/player paths,
  the exact `youtubei.googleapis.com/youtubei/*` alternate, and
  `*.googlevideo.com/videoplayback`; it strips bearer, cookie, proxy, and
  Google/YouTube identity headers on cross-origin hops, bounds internal
  session/player bodies to 16 MiB, and retains the outer 100 MB streamed-audio
  limit plus the shared 45-second deadline. Six focused regressions pass, and a
  read-only live control imported the known 19-second video as 309,288 bytes.
- [x] Bind the post-baseline timeout/error-normalization work to exact commits
  `c367e23` and `fe112ef` and rerun the complete gate against intermediate source
  `fe112ef`: 121 worker, 21 analyzer, 5 server/migration, 5 separator, 29
  discovery, 19 browser E2E, and 4 authoritative Auto E2E tests pass. The
  verification shell initially lacked the repository-pinned Bun executable, so
  this intermediate gate ran directly through Node/npm/npx/uv; the later
  `821f5e1` gate closes the local Bun-wrapper gap. Native GitHub remains open.
- [x] Bind the Innertube transport boundary to exact executable-source commit
  `fce98cf` and repeat its complete gate: 127 worker, 21 analyzer, 5
  server/migration, 5 separator, 29 discovery, 19 browser E2E, and 4
  authoritative Auto E2E tests pass through the underlying commands. This
  committed-source result and one live control import do not constitute native
  GitHub, Railway, or release acceptance.
- [x] Bind the combined Railway transaction/runtime and import hardening to
  exact executable-source commit `821f5e1`. An ephemeral exact Bun `1.3.14`
  verified the frozen 160-package lock with no changes, then the literal
  `test:phase0` passed all three typechecks plus 127 worker, 21 analyzer, 9
  server/migration, 5 separator, 29 discovery, 19 browser E2E, and 4
  authoritative Auto E2E tests. Native GitHub and Railway acceptance remain
  separate gates.
- [x] Bind the prompt-aware guide-cache follow-up to exact executable-source
  commit `e640c72` and repeat the literal Bun `1.3.14` phase-zero gate. All
  three typechecks plus 127 worker, 21 analyzer, 13 server/migration, 5
  separator, 29 discovery, 19 browser E2E, and 4 authoritative Auto E2E tests
  pass. Native GitHub and Railway acceptance remain separate open gates; this
  local commit is not present on `origin` and has no pull request.
- [x] Bind the prompt-history integrity follow-up to exact executable-source
  commit `4a3fbf1` and repeat the literal local Bun `1.3.14` phase-zero gate.
  All three typechecks plus 127 worker, 21 analyzer, 14 server/migration, 5
  separator, 29 discovery, 19 browser E2E, and 4 authoritative Auto E2E tests
  pass. Native GitHub, Railway, and authorized teacher persistence remain open;
  no remote branch or pull request contains this commit.
- [x] Record the canonical Railway project, environment, and service IDs and
  replace name-based release commands. The current local Railway link resolves
  to a same-named legacy workerd project and must never be treated as authority.
- [x] Before this branch can be deployed, stage an exact
  `REPLICATE_YT_MODEL_VERSION` on the canonical Railway service without
  triggering an unrelated release. Version `bcd3b512…` passed the importer
  schema guard and was staged with `--skip-deploys`; deployment
  `7f4bc330…` remained active and unchanged. Local runtime/config guards now
  accept only the exact 64-hex version form; the staged value is not claimed as
  active in the still-running old deployment.

## Service and dependency order

| Order | Component | Deployment posture | May affect the default split? |
|---|---|---|---|
| 0 | Existing `stem-splitter` app | Already active on Railway; preserve it | Yes, but only through reviewed app releases |
| 1 | Versioned audio-analysis API | New private Railway CPU service | No; shadow/advisory first |
| 2 | Instrument classifier | New private Railway ML service, reachable only by the analyzer after parity | No; detection metadata only at first |
| 3 | AudioSep query separator | New pinned Replicate integration | No; explicit optional isolation only |
| 4 | SAM-Audio comparison | Evaluation-only pinned Replicate integration | No until selected through review |
| 5 | Banquet/Query-Bandit | Future private Cog or GPU service | No until a separate multi-stem design is accepted |

The analysis service comes first because remote Auto needs decoded audio before
it can make an honest decision. The classifier comes next because the system
must identify a plausible target before paying a query separator. AudioSep and
SAM-Audio follow as optional extraction providers. Banquet is a later option if
the product needs a coherent long-tail multi-stem decomposition rather than
individual target isolations.

## Phase 0 — freeze contracts and establish regression gates

- [x] Write a short decision record defining three distinct concepts:
  `core split`, `instrument detection`, and `query isolation`. Never use these
  names interchangeably in API fields, database rows, logs, or UI copy.
- [x] Make `auto` a routing request, not a separation-model identifier. Store
  the resolved core model separately from the request that caused it.
- [x] Freeze the existing core response contract: job state and the meanings of
  `vocals`, `instrumental`, `drums`, `bass`, `other`, `guitar`, and `piano` must
  not change during classifier work.
- [x] Define a versioned analysis response before building another service,
  including at minimum:
  - schema version;
  - role-classifier version;
  - vocabulary/classifier version when present;
  - resolved core model, confidence, features, and human-readable reason;
  - detected instruments with independent confidence values;
  - timing and explicit degraded/fallback state.
- [x] Add provider-neutral interfaces for analysis and query isolation. Shared
  application code must not import a Railway-, Replicate-, Python-, or
  Node-specific implementation.
- [x] Add feature flags with safe false defaults:
  `SERVER_AUTO_ENABLED`, `INSTRUMENT_DISCOVERY_ENABLED`, and
  `QUERY_ISOLATION_ENABLED`.
- [x] Make every new persistent schema change additive. Update `schema.sql`,
  the Railway `node:sqlite` migration path, its regression tests, and a future
  numbered D1 migration together.
- [x] Build a fixed, authorized eleven-source evaluation manifest spanning rock,
  jazz, orchestral/chamber, electronic, hip-hop, folk/traditional, and sparse
  acoustic music. Record source rights and expected audible instruments.
- [x] Add contract tests proving that all new flags disabled produce the exact
  pre-change catalogue, job routing, stem names, and UI behavior.

**Gate:** no additional service is provisioned until the versioned contracts,
fixtures, fallback behavior, and flag-off regression tests exist.

**Local gate evidence:** contracts, deterministic 2/4/6 PCM parity fixtures,
authorized corpus metadata, fallback tests, and flag-off tests now exist and
pass. This permits service provisioning to be planned; it does not authorize a
deployment or enablement.

## Phase 1 — server-authoritative Auto for every source type

### 1A. New Railway `audio-analysis` service

- [x] Implement a small authenticated analysis API in a separate container.
  It adds no FFmpeg, Python ML dependencies, or model weights to the warmed
  `stem-splitter` app container.
- [ ] Provision that container as a separate private Railway CPU service with
  no public domain. Keep the existing app service and its volume unchanged.
  Follow `docs/railway-audio-analysis-provisioning.md`; Railway variable edits
  redeploy by default, so assemble the reviewed batch with `--skip-deploys`.
- [x] Give the service a least-privilege way to read one short-lived source URL;
  do not mount or share the app's persistent `/data` volume.
- [x] Decode only bounded beginning, middle, and end windows with FFmpeg and
  enforce byte, duration, phase-timeout, output, and concurrency limits.
- [ ] Set and verify the Railway service's CPU, memory, restart, and ephemeral
  disk limits. Exercise malformed media and maximum-size concurrent requests;
  the Node heap cap alone does not bound the FFmpeg child process.
- [x] Port the existing role features and 2/4/6 decision rules first, then
  version every subsequent calibration change. Use the same golden PCM
  fixtures to prove deterministic browser/server parity.
- [x] Expose liveness and readiness separately. Readiness must remain false
  until the decoder and classifier are actually usable.
- [x] Define a non-root service image with digest-pinned Node and Bun bases,
  checksum-pinned FFmpeg 8.0.3, the frozen dependency lock, and a pinned
  classifier version. Log versions and timings, never source URLs, class codes,
  raw features, audio, or credentials.
- [x] Build the current role-v3 image as `linux/amd64` and run its non-root,
  runtime allowlist, `/healthz`, `/readyz`, authentication, eight advertised
  audio-format, and eleven-source corpus checks on pinned FFmpeg 8.0.3. The
  local emulated run produced 8 preferred choices, 3 accepted alternatives,
  and 0 rejected choices.
- [x] Add one reusable constrained-image smoke used locally and by native CI.
  It runs with a read-only root, dropped capabilities, no analyzer mounts, an
  internal-only fixture network, 1 vCPU, 1 GiB RAM, 64 PIDs, and bounded `/tmp`;
  then proves readiness/auth, real short and 15-minute audio, declared and
  streamed oversize rejection, malformed-media rejection, source timeout,
  overlap `503` plus `Retry-After`, temporary-file cleanup, and secret-free
  logs. The current native arm64 image passed at a final 59.81 MiB sample; the
  existing emulated amd64 image passed at 253.4 MiB. These snapshots are not
  peak Railway metrics.
- [ ] Reproduce the image on a native amd64 GitHub runner and Railway. Keep the
  CI runtime audit that permits only the six advertised demuxers, audio
  decoders, and file/pipe protocols; then exercise Railway CPU, memory, child
  process, concurrency, timeout, and ephemeral-disk limits. Local emulation is
  not production resource evidence.
- [x] Keep credentials fail-lazy in the app: if analysis is unavailable, upload,
  playback, annotations, and explicit 2/4/6 splitting must still work.

### 1B. Integrate without changing defaults

- [x] Let `/api/jobs` accept `model: "auto"` for uploads, YouTube, and Internet
  Archive, but resolve it only after the source has been fetched and stored.
- [x] Run the analysis service in shadow mode for local uploads first. Compare
  its result with the browser result while continuing to honor the browser's
  existing choice.
- [x] Record shadow disagreement, timeout, source type, chosen fallback, and
  versioned reason in job metadata. Do not log raw feature arrays if they could
  fingerprint copyrighted recordings.
- [x] Treat the analyzer endpoint and bearer token as a fail-closed transport
  boundary: require HTTPS except for loopback or `*.railway.internal`, reject
  embedded credentials and non-root URL paths/queries/fragments, require at
  least 32 token characters, reject redirects without forwarding credentials,
  and cap streamed JSON responses at 64 KiB.
- [ ] Calibrate parity on the fixed manifest and investigate systematic
  disagreement before allowing server results to route a paid separation.
  Local role-v3 is 11/11 accepted (8 preferred, 3 alternatives), and real Chrome,
  local FFmpeg, and the pinned FFmpeg 8.0.3 image agree on all 11 choices. Keep
  this gate open until native CI/Railway and the manual stem listening checks
  pass; decision agreement alone does not establish musical usefulness.
- [ ] Make the server decision authoritative for all source types only after the
  parity gate passes. Keep the old catalogue default as an explicit fallback,
  never an implicit claim that remote audio was analyzed.
- [ ] Prove upload, YouTube, and Archive journeys end-to-end on Railway,
  including analyzer outage and timeout cases.

**Gate:** remote Auto is complete only when all source types are actually
analyzed after ingestion, every decision is attributable to a classifier
version, and an analyzer failure degrades to the old split without losing the
job.

## Phase 2 — broaden instrument discovery without routing separation

- [x] Add a versioned, teacher-reviewable instrument vocabulary covering at
  least strings, violin, viola, cello, double bass, brass, trumpet, trombone,
  horn, saxophone, clarinet, flute, oboe, organ, electric piano, synthesizer,
  pad, accordion, harmonica, harp, percussion, and selected traditional
  instruments represented in the evaluation corpus. The uncalibrated
  `classroom-instruments-v1` candidate has 51 unique labels in 10 families and
  is locked to a content hash by a schema/integrity test.
- [x] Define a pinned candidate evaluation mapping for all eleven licensed file
  sources: reviewed corpus terms map to one or more vocabulary ids, explicit
  hard negatives, and six named confusion trials. A contract test requires
  exact classifier/weight/vocabulary pins, complete one-to-one corpus coverage,
  known label ids, and real positive/negative evidence for every claimed
  bidirectional trial. Its status is deliberately
  `candidate-baseline-not-a-release-gate`; it contains no model scores.
- [x] Freeze a separate discovery wire contract and analyzer client with exact
  schema, classifier revision, weight hash, vocabulary version/content hash,
  PCM rate/window, response-size, timeout, private-origin, and redirect pins.
  Discovery failure or drift gets its own trace and cannot change a validated
  core Auto decision; student responses strip labels and private pins.
- [x] Spike LAION CLAP inside a separate `instrument-discovery` image
  as the first flexible zero-shot classifier. Load the exact music checkpoint
  during image build, verify its checksum, and prove offline startup; do not
  pull a floating checkpoint during container boot. The current native arm64
  image passed a network-disabled, read-only, non-root smoke with exact
  readiness pins and real inference; a three-second synthetic control completed
  in 258–394 ms, while post-warm container-memory observations ranged roughly
  405–745 MiB across repeated local runs.
  This is implementation evidence, not musical calibration or Railway sizing.
- [ ] Start and infer with the current `linux/amd64` image on a native amd64
  runner and Railway. The 2.11 GB target image builds locally and its runtime
  source hashes match the working tree, but local emulation crossed the image's
  health window during vocabulary embedding and is not production timing
  evidence.
- [ ] Decide whether to convert the pinned PyTorch pickle to safetensors before
  teacher shadow. If converted, verify every tensor name, shape, dtype, and
  value against the pinned source; assign a new artifact hash and classifier
  id; and rerun the full corpus. Never replace the current weight artifact
  under its existing provenance record.
- [x] Add a process-fatal watchdog so a timed-out synchronous inference clears
  readiness and exits instead of monopolizing capacity indefinitely. Regression
  tests cover the permitted two-request race and prove the real fatal callback
  terminates a child process with exit code 70; they do not load PyTorch.
- [x] Define a path-scoped native-amd64 CI image gate that verifies the pinned
  image platform, non-root command, size ceiling, runtime surface, offline
  readiness pins, empty mount surface, dropped capabilities, bounded CPU/RAM/
  PIDs, authentication, and real synthetic-control inference. The workflow is
  local-only until a remote branch/PR run proves it on GitHub infrastructure.
  `actionlint` passes; the earlier fresh native arm64 container run remains the
  local evidence, while a remote branch/PR run is still required.
- [ ] After a replacement classifier passes local musical-usefulness and human
  review, prove that selected discovery container restarts cleanly after the
  watchdog kills a deliberately stuck real inference. Do not spend Railway
  acceptance effort on the rejected CLAP prompt/checkpoint pairing. The chosen
  image still requires Railway restart/readiness evidence before shadow traffic.
- [x] Audit the Essentia/MTG-Jamendo license boundary before downloading a
  candidate. Official MTG sources conflict between CC BY-NC-SA and CC BY-NC-ND,
  the model-directory license is internally inconsistent, and the exact
  40-class instrument metadata has no resolving license field. Treat the model
  as not cleared for Railway/container use; see
  `docs/audits/2026-08-09-essentia-license-gate.md`.
- [ ] Compare Essentia/MTG-Jamendo on the same manifest only after written MTG
  clarification and institutional review cover the exact weight file,
  noncommercial classroom inference, container distribution, and the AGPL
  boundary if the Essentia runtime is used. Pin and hash the cleared artifact
  before an offline bake-off; never infer approval from the educational intent.
- [x] Implement and run a fixed-label YAMNet baseline offline, without a new
  service. The comparator pins Google's official unquantized TFLite version 1,
  Kaggle model/instance/version and Apache 2.0 metadata, archive/model bytes and
  SHA-256 values, TensorFlow Models revision and 521-class map, exact LiteRT/
  NumPy/SciPy lock, 16 kHz preprocessing, scoring policy, vocabulary, and
  36-label mapping. Fifteen unsupported labels stay explicit. Every corpus
  source runs by immutable image ID in a distinct networkless, read-only,
  non-root, resource-bounded container, and the report binds the image, lock,
  source, corpus, expectation, and mapping identities. The eleven-source run
  ranked 16/40 eligible reviewed groups in the top 3, 21/40 in the top 5, and
  31/40 in the top 10, with a 3,507-basis-point mean reciprocal rank. No
  threshold was selected and no precision claim is available. See
  `docs/audits/2026-08-09-yamnet-comparator-gate.md` and the bound report under
  `docs/acceptance/2026-08-09-yamnet-comparator/`.
- [ ] Extend the YAMNet comparison with authorized, teacher-reviewed
  single-instrument positives and exhaustive negatives. Recalculate family
  ranking, precision/recall, calibration, abstention, latency, and memory on
  native amd64. Its current 0/2 brass, 0/3 woodwind, and 0/1 free-reed top-five
  results, fifteen ontology gaps, failed confusion directions, two missing
  confusion trials, and non-exhaustive annotations block classifier selection
  and threshold calibration.
- [ ] Choose exactly one replacement discovery classifier after the CLAP,
  YAMNet, and any license-cleared Essentia evidence is comparable. Give every
  prompt policy, checkpoint, label map, or preprocessing change a new
  classifier ID; never inherit `instrument-discovery-v1` thresholds. Only the
  selected candidate may proceed to a new private Railway service, and it stays
  advisory until human-reviewed shadow evidence passes.
- [x] Score multiple windows independently, then aggregate. On multi-window
  material, a sound confined to one window cannot become a track-level
  detection under the tested minimum-support rule; the documented one-window
  source exception still requires calibration. Fixed-corpus calibration
  against real CLAP output remains open.
- [x] Add a pin-checked, non-mutating licensed-corpus evaluator for the CLAP
  candidate. The manifest maps every reviewed corpus annotation to vocabulary
  IDs, preserves directional hard negatives, reports candidate group coverage,
  abstentions, family/genre summaries, latency, parent/child overlaps, and
  confusion evidence, and refuses unknown labels or pin drift. Electric guitar
  versus synthesizer and bass guitar versus double bass have bidirectional
  corpus trials; piano versus mallet percussion and saxophone versus brass are
  one-direction trials; solo strings versus section strings and pitched
  percussion versus keys remain explicit corpus gaps. The runner makes no
  precision claim and cannot change thresholds, Auto routing, or stem names.
  The first constrained native-arm64 run completed all 11 sources but returned
  no labels: 11 abstentions and 0/42 reviewed groups surfaced in 9,604 ms of
  aggregate service time. Treat that as a failed usefulness gate and keep the
  service off; inspect pre-threshold scores and prompt-policy bias before any
  threshold change. Evidence is recorded in
  `docs/audits/2026-08-09-instrument-discovery-candidate.md`.
  A separate local amd64-on-arm64 attempt remained in vocabulary embedding
  until the image's baked health policy marked it unhealthy; the runner
  rejected the run and removed its container/network. That cross-architecture
  cold-start failure is diagnostic only and supplies no native-amd64 evidence.
  The image runner uses an ephemeral token, a per-run no-masquerade bridge with
  an automatically allocated loopback port, a read-only/non-root container,
  dropped capabilities, bounded CPU/RAM/swap/PIDs, and exclusive `0600`
  evidence files.
- [x] Add a networkless, offline-image raw-score audit that keeps diagnostic
  arrays out of the service HTTP contract and deletes temporary decoded PCM on
  exit. Across the first 33 real-audio windows, every expected, hard-negative,
  and unreviewed score collapsed around `0.5`; the 42 best expected-group means
  spanned only `0.499894`–`0.500002`. This rejects the current pairwise score as
  a calibration basis and makes blind threshold lowering unsafe. Positive-only
  ranking also failed: just 13/42 reviewed groups placed an accepted label in
  the top 12, with a 25.67 mean best rank and repeated unrelated koto/sitar/
  mallet-percussion leaders. Reject this prompt/checkpoint pairing rather than
  tuning it into production.
- [x] Make every future candidate evaluator/report self-bind the executing
  Docker image ID, exact `linux/amd64` promotion platform, and dependency-lock
  identity in addition to classifier/weight/vocabulary and evaluation-source
  hashes. Both image runners resolve a mutable tag once and execute the
  immutable image ID, reject other platforms, compare the repository lock to a
  lock hash derived and baked inside that image, and pass an exact provenance
  object into version-bumped reports. Exact-schema and baked-lock mismatch
  regressions pass. The rejected CLAP JSON remains historical non-self-contained
  evidence; this hardening applies to the required YAMNet/replacement reruns.
- [ ] Calibrate per-family thresholds and an `uncertain` state. Do not force
  every track into the nearest available label.
- [x] Measure prompt-policy bias before accepting the CLAP candidate. Twenty-nine
  labels currently take the maximum of two prompt aliases while twenty-two use
  one, and CLAP-style text encoders may not treat “without” as reliable
  negation. Compare matched prompt counts and control/negation formulations on
  positive and hard-negative audio; any change requires a new classifier id.
  The networkless raw-logit audit found matching negative prompts usually
  outranked positives, while positive-only ranking still performed poorly and
  showed strong label priors. The current candidate is rejected; a redesigned
  prompt policy or replacement checkpoint must use a new ID and rerun all
  evidence rather than inheriting these thresholds.
- [ ] Review the vocabulary ontology and teacher display policy for overlapping
  parent/child results (`brass` plus `trumpet`, `strings` plus `violin`, or
  `percussion` plus `drum-kit`) and for production/timbre labels such as
  `sampler` and `pad`. Do not double-count or present them as equivalent kinds
  of evidence.
- [ ] Keep detection advisory: display “possible instruments” and confidence
  only to authorized testers. Do not change the Demucs model because a
  long-tail instrument was detected.
- [ ] Specifically test similar-timbre confusions: electric guitar versus
  synthesizer, bass guitar versus double bass, piano versus mallet instruments,
  saxophone versus brass, solo strings versus string section, and pitched
  percussion versus keys. The candidate mapping identifies four currently
  evidence-backed directions and explicitly records corpus gaps for solo
  strings and pitched-percussion positives; do not check this off until actual
  model scores and human listening verify the positive and hard-negative claims.
- [ ] Have an authorized teacher/domain reviewer verify every candidate positive
  and hard-negative annotation before using it to calculate precision/recall.
  Corpus metadata and rationale are testable provenance, not ground truth by
  themselves.
- [ ] Add teacher feedback controls for confirmed, absent, and missed
  instruments without treating those reports as training labels until they are
  reviewed and de-identified.

**Gate:** choose a discovery classifier only after reporting per-instrument and
per-genre precision/recall, calibration, abstention rate, latency, memory, and
license status. Overall accuracy alone is insufficient.

## Phase 3 — optional long-tail instrument isolation

### 3A. AudioSep pilot

- [ ] Add a separately pinned AudioSep Replicate runner and version variable.
  Extend the Replicate contract guard so a schema or version drift fails CI.
- [ ] Create a separate `instrument_isolations` job/resource. Never append a
  query output to the core `stems` array or imply that independently queried
  outputs sum back to the original mixture.
- [ ] Require an explicit normalized target prompt selected from detected
  candidates or entered by an authorized teacher/tester.
- [ ] Preserve the completed core split when an isolation is slow, empty,
  rejected, or fails. Query failure must be local to the query job.
- [ ] Cache by source hash, normalized target, provider, exact model version,
  and analysis-vocabulary version.
- [ ] Enforce per-track concurrency, semester budget, timeout, retry, and
  maximum-isolation limits before enabling the paid endpoint.
- [ ] Label outputs “optional instrument isolations,” with model/version and
  limitations available in the UI. Do not call them mutually exclusive stems.

### 3B. SAM-Audio bake-off

- [ ] Add SAM-Audio only to the evaluation harness at first; do not expose two
  paid implementations in the student interface.
- [ ] Complete institutional review of the SAM license, gated checkpoint terms,
  and the operational risk of any community-hosted Replicate deployment.
- [ ] Compare target isolation, leakage, residual usefulness, span prompting,
  latency, failure rate, and cost against AudioSep on the exact same manifest.
- [ ] Select one default query provider through a documented decision. Keep the
  other disabled but retain its fixtures and adapter tests if it is a useful
  fallback.

**Gate:** a query provider may reach teacher-only beta after it beats the
accepted quality floor, stays within the cost ceiling, and passes a pinned live
canary. Student access remains off.

## Phase 4 — iterative optimization beyond rock-band mixes

- [ ] Establish an evaluation loop using authorized classroom tracks plus
  instrument-rich subsets of Slakh2100 and MedleyDB. Keep synthetic and real
  results separate in reports.
- [ ] Measure detection precision/recall, abstention, SI-SDR/SDR improvement,
  target leakage, residual/reconstruction error where applicable, latency,
  provider errors, cache hit rate, cost, and blinded teacher listening ratings.
- [ ] Review results by genre and instrument family so abundant drums, bass,
  guitar, and vocals cannot hide failures on reeds, bowed strings, brass,
  keyboards, electronic textures, or traditional instruments.
- [ ] Tune one dimension at a time—vocabulary, thresholds, window placement,
  prompt wording, or separator version—and record the before/after manifest,
  metrics, model pins, and commit.
- [ ] Promote changes through `off` → `shadow` → `teacher beta` → bounded
  student canary → default. Every step needs a rollback flag that does not
  require a schema rollback.
- [ ] Automatically request at most one or two high-confidence additional
  isolations only after manual-query evidence supports it. Until then,
  discovery may suggest but must not spend.
- [ ] Re-run the frozen rock-band regression set on every optimization. Broader
  coverage is not acceptable if it silently worsens the current dependable
  paths.
- [ ] Publish a model-processing changelog containing classifier vocabulary,
  thresholds, checkpoint/version pins, evaluation summary, rollout stage, and
  known regressions for every promoted change.

## Phase 5 — coherent long-tail multi-stem research, only if needed

- [ ] Evaluate Banquet/Query-Bandit after the optional-isolation beta. Decide
  first whether users actually need simultaneous, reconstructable long-tail
  stems rather than occasional target extraction.
- [ ] If justified, package it as a private Replicate Cog or a separate
  scale-to-zero GPU service. Do not place it in the Railway app service or the
  CPU analysis service.
- [ ] Define overlap, ordering, residual, and reconstruction semantics before
  allowing recursive separation. Target-plus-residual recursion is
  order-dependent and must not be presented as objective ground truth.
- [ ] Run the same pinning, schema-contract, cost, failure-isolation, canary,
  licensing, and rollback gates used for AudioSep/SAM-Audio.

## Breaking-change shields required throughout

- [ ] Never use a floating provider `latest` version in a live path.
- [ ] Never let a classifier label create a stem name that the selected
  separator contract does not guarantee.
- [ ] Never rename or reinterpret stored core stems in place; introduce a new
  versioned contract or isolation resource.
- [ ] Never make a new service credential boot-critical unless every request
  path truly requires that service.
- [ ] Never couple the app to a Railway-only import or filesystem assumption;
  keep provider calls behind shared interfaces for the eventual migration.
- [ ] Never combine a classifier rollout, separator-model change, schema
  migration, and default-routing change in one release.
- [ ] Never consider a Railway build or `SUCCESS` status sufficient evidence.
  Verify health, analysis readiness, one full authorized source journey, output
  media bytes, stored decision metadata, persistence, and rollback behavior.
- [ ] Never migrate or deploy this unfinished pipeline to Cloudflare Workers.

## Research references

- [AudioSep](https://github.com/Audio-AGI/AudioSep) — open-domain,
  text-queried target separation; first Replicate integration candidate.
- [SAM-Audio](https://github.com/facebookresearch/sam-audio) — text/span target
  plus residual; evaluation candidate subject to license and hosting review.
- [Banquet / Query-Bandit](https://github.com/kwatcharasupat/query-bandit) —
  query-based separation beyond fixed four/six-stem taxonomies.
- [LAION CLAP](https://github.com/LAION-AI/CLAP) — flexible audio-text
  classification candidate; not itself a separator.
- [Essentia models](https://essentia.upf.edu/models.html) — useful fixed
  instrument taxonomy with a model-license review requirement.
- [Slakh2100](https://www.slakh.com/) and
  [MedleyDB](https://medleydb.weebly.com/) — complementary synthetic and real
  multitrack evaluation sources.
