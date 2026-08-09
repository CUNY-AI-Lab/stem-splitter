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
digest-pinned image recipe are implemented locally and pass 22
contract/fake-backend/process tests. The model image has not been built, actual
CLAP inference and offline startup have not run, no ML service has
been provisioned, and no detection has been calibrated or promoted. See the
[discovery design](docs/superpowers/specs/2026-08-09-instrument-discovery-design.md)
and [implementation plan](docs/superpowers/plans/2026-08-09-instrument-discovery.md).

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
- [ ] Complete the remaining live teacher-console acceptance check from
  `docs/superpowers/plans/2026-08-08-autosplit-prompt-governance.md`: save one
  revision with an authorized real teacher account, restart Railway, and prove
  that the revision persists. Never retrieve or expose the credential to
  automate this check.
- [ ] Capture a new baseline before pipeline work: commit SHA, full test result,
  live `/healthz`, one authorized real-audio 4-track job, output hashes, latency,
  and provider/model version. This is the rollback comparison point.
- [x] Record the canonical Railway project, environment, and service IDs and
  replace name-based release commands. The current local Railway link resolves
  to a same-named legacy workerd project and must never be treated as authority.
- [ ] Before this branch can be deployed, stage an exact
  `REPLICATE_YT_MODEL_VERSION` on the canonical Railway service without
  triggering an unrelated release. The live service currently has the model
  name but not the new required version pin.

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
- [x] Freeze a separate discovery wire contract and analyzer client with exact
  schema, classifier revision, weight hash, vocabulary version/content hash,
  PCM rate/window, response-size, timeout, private-origin, and redirect pins.
  Discovery failure or drift gets its own trace and cannot change a validated
  core Auto decision; student responses strip labels and private pins.
- [ ] Spike LAION CLAP inside a separate private `instrument-discovery` service
  as the first flexible zero-shot classifier. Load the exact music checkpoint
  during image build, verify its checksum, and prove offline startup; do not
  pull a floating checkpoint during container boot. The bounded service,
  offline-only image recipe, dependency lock, exact download revision, and
  eight-artifact content verifier now exist locally; the large image build and
  real-model offline-start proof remain open.
- [x] Add a process-fatal watchdog so a timed-out synchronous inference clears
  readiness and exits instead of monopolizing capacity indefinitely. Regression
  tests cover the permitted two-request race and prove the real fatal callback
  terminates a child process with exit code 70; they do not load PyTorch.
- [ ] Prove the discovery container restarts cleanly after the watchdog kills a
  deliberately stuck real PyTorch inference. This requires the built model
  image plus Railway restart/readiness evidence before shadow traffic.
- [ ] Compare Essentia/MTG-Jamendo on the same manifest only after documenting
  whether its noncommercial model license fits the intended classroom and
  institutional use.
- [x] Score multiple windows independently, then aggregate. On multi-window
  material, a sound confined to one window cannot become a track-level
  detection under the tested minimum-support rule; the documented one-window
  source exception still requires calibration. Fixed-corpus calibration
  against real CLAP output remains open.
- [ ] Calibrate per-family thresholds and an `uncertain` state. Do not force
  every track into the nearest available label.
- [ ] Keep detection advisory: display “possible instruments” and confidence
  only to authorized testers. Do not change the Demucs model because a
  long-tail instrument was detected.
- [ ] Specifically test similar-timbre confusions: electric guitar versus
  synthesizer, bass guitar versus double bass, piano versus mallet instruments,
  saxophone versus brass, solo strings versus string section, and pitched
  percussion versus keys.
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
