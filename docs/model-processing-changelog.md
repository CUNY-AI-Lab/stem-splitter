# Model-processing changelog

This log tracks classifier and audio-processing changes independently from the
teacher system-prompt changelog. A release entry records exact pins, evaluation
evidence, rollout stage, and known regressions. Entries do not authorize live
promotion on their own.

## v3.2-role-v4-railway-shadow — live shadow accepted — 2026-08-31

- Exact source commit `4c00b32fab96c8f9405095742ce3ca7170ace75b`
  passed CI run `33444030802`, including the source gate and native-amd64
  analyzer image. Production is bound to the private analyzer at
  `audio-analysis.railway.internal`; `SERVER_AUTO_ENABLED=true` and
  `SERVER_AUTO_MODE=shadow`, while instrument discovery and query isolation
  remain disabled.
- Real upload, Internet Archive, and YouTube jobs completed with persisted
  `autosplit-role-v4` decisions and the frozen concrete separation model. The
  YouTube source produced a genuine two-part recommendation, demonstrating
  that imported audio is analyzed rather than silently assigned the four-part
  default; shadow correctly did not apply that recommendation.
- A controlled analyzer outage produced `analysis_unavailable` and still
  completed the concrete four-part separation. Restore deployment
  `41237f5b-88e6-4356-832b-d002c58a6575` reached terminal `SUCCESS`, and a
  fresh 45-second upload then completed with a non-degraded decision in 607 ms.
- Five student job readbacks contained no source key, source hash, isolation,
  vocabulary-classifier, or instrument-discovery field. Four real production
  screenshots cover restored upload, Archive, YouTube, and outage-fallback
  mixers; their JPEG bytes are SHA-256-bound by the strict acceptance validator.
- Observed analyzer CPU peaked at 0.0267 and memory at 0.1105 GB within the
  one-vCPU/one-billion-byte caps. A 141-request app HTTP sample contained zero
  4xx/5xx responses. Instrument discovery made zero provider calls.
- This release accepts shadow and its audience guard only. It does not make
  Auto authoritative, accept a teacher beta, select an instrument classifier,
  or authorize Remixer implementation ahead of the separately ordered
  discovery gate.

## v3.2-role-v4-railway-private — provisioned, accepted, off — 2026-08-31

- Exact source commit `d6a5fc6eec0190db2448fc66a6035a2776a2c9ac`
  passed CI run `33442090951`. Railway service
  `f8e3b4a6-f370-4877-a6fb-64655e43ce25` runs the reviewed
  `audio-analysis/Dockerfile` privately in `us-west2` with one replica, one
  vCPU, 1,000,000,000 bytes of memory, `/readyz`, and `ON_FAILURE` with three
  retries. It has no public domain or persistent volume.
- Private-network readiness reports FFmpeg 8.0.3, `autosplit-role-v4`, and
  `analysis-source-scope-v2`. An unauthenticated analysis returned 401, an
  authenticated malformed request returned 400, and an authenticated same-
  origin but out-of-scope path failed before fetch with
  `source_url_not_scoped`.
- The exact 3,421,199-byte source from the frozen rollback baseline produced a
  non-degraded four-part decision over 45 analyzed seconds. After Railway
  restart deployment `d2734626-d06a-41ba-a90e-9f7d57b09418`, readiness and the
  same real-audio decision passed again. Observed memory peaked at 0.1105 GB
  and CPU at 0.0156 within the configured caps.
- The kill-switch drill deployed shadow at
  `2f52dc83-1a25-446a-af28-609aea3caccb`, observed the advertised shadow mode,
  then deployed off at `8ae0e06a-1106-4892-810b-f01e5e4d6c14`. The off
  endpoint removed the routing field and retained the exact explicit 2/4/6
  catalogue. The drill made zero provider calls and printed no secrets.
- This historical acceptance ended with rollout off. The later shadow entry
  above supersedes that runtime posture without changing the accepted private
  topology. Instrument discovery remained unconfigured/disabled; the rejected
  CLAP candidate received no acceptance from this release.

## v3.2-role-v4-listening — frozen baseline accepted — 2026-08-31

- Zach, acting as teacher, listened to the complete authorized source and every
  frozen `htdemucs_ft` stem and accepted the result for the v3.2 pre-provision
  gate at `2026-08-31T21:28:00.000Z`.
- The canonical review is bound to the exact rollback artifact, job, source
  hash, ordered stem names, byte counts, SHA-256 values, and fixed attestation.
  The validator rejects anonymous, partial, reordered, or drifted claims.
- This clears the human listening prerequisite for the role-v4 analyzer only.
  It does not accept a Railway resource profile, enable server Auto, or promote
  the separately rejected CLAP instrument-discovery candidate.

## v3.2-role-v4-native-amd64 — native analyzer image accepted — 2026-08-31

- GitHub Actions run `33353695281` built and exercised the exact
  `linux/amd64` analyzer image from commit
  `431e21ffd627b1242abec640c09e3e383657ff6f` on Linux x86_64.
- The strict artifact binds image ID
  `sha256:7cb1dc3c9c45dda3144984b4d9484a8023f9f4fda8811ac81c14e34afa05988a`,
  231,074,728-byte size, FFmpeg 8.0.3, `autosplit-role-v4`,
  `analysis-source-scope-v2`, every Docker input, and all constrained smoke
  claims. Repository validation accepts the downloaded JSON without trusting a
  hand-edited boolean.
- Rollout remains off. The attributable whole-source and whole-stem listening
  review is still pending, so the private Railway analyzer must not yet be
  provisioned. The rejected CLAP discovery candidate remains a separate blocked
  component and is not promoted by this evidence.

## vcsl-c1ea7bc-exact-controls-v1 — exact harmonica and pitched-percussion controls — 2026-08-10

- Scope: exact implementation commit
  `e94df1ddcfdab4e1eb97b18a6edcf5e40011c282` adds a VCSL manifest, strict
  individual-object hydrator, and nine-test adversarial suite. It does not add
  the controls to the current evaluation plan, complete human listening, create
  candidate negatives or metrics, select a classifier, alter Auto or the 2/4/6
  core contracts, authorize isolation, provision a service, or change a flag.
- Rights and identity: the manifest freezes repository commit
  `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e`, its observed non-truncated
  4,550-entry tree, and the exact `LICENSE` and `README.md` objects. Full byte
  counts, Git blob SHA-1 values, and SHA-256 values bind repository-level CC0
  1.0 evidence and the source's human-readable instrument naming policy.
- Selection and claim boundary: one normal C4 sustain from a Hohner Special 20
  harmonica and one C4 `ff` xylophone strike with a medium mallet fill the
  harmonica and pitched-percussion source gaps. Exact truth stops at the
  repository-authored `Harmonica` and `Xylophone` labels. The corresponding
  `harmonica` and broader `mallet-percussion` vocabulary mappings remain
  candidates awaiting teacher listening; typicality is also unreviewed.
- Hydration boundary: rights bytes are fetched and validated before audio. Every
  request refuses redirects and encoded bodies, enforces the exact content type,
  disposition, length, timeout, and one-MiB ceiling, and binds both content and
  Git-object digests. Both missing WAVs must download and pass their exact
  24-bit PCM/chunk surfaces before either is installed. Owner-only hard-link
  publication prevents overwrite; offline verification rejects relaxed modes,
  symlinks, altered bytes, and structural drift.
- Evidence and rollout: the real 678,192-byte harmonica and 897,126-byte
  xylophone files hydrated at mode `0600` and passed networkless readback. Exact
  Bun 1.3.14 passes four TypeScript checks; 282 worker, 24 analyzer, 42 Railway
  host/config/migration/terminal, 5 separator, 30 discovery, and 9 YAMNet tests;
  plus 19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser
  journey. No Railway mutation, provider call, deployment, push, or pull request
  occurred.
- Remaining: build and complete a governed VCSL teacher review without inferring
  source-label, typicality, or `Xylophone` to `mallet-percussion` acceptance.
  Traditional-instrument exact-source evidence and a new evaluation-plan version
  remain separate prerequisites; all classifier and rollout gates stay open.

## tinysol-exact-control-review-v1 — governed label and mapping review — 2026-08-10

- Scope: exact implementation commit
  `36ff60edcb3e22d80118e1b9ddc3a04c868bc7eb` adds TinySOL-specific private
  preparation, deidentified finalization, public-schema validation, and seven
  focused regression tests. It does not complete a teacher review, integrate
  the controls into the evaluation plan, create candidate negatives or metrics,
  select a classifier, change Auto or core stems, authorize isolation, provision
  a service, or change a flag.
- Input boundary: preparation revalidates the exact content-hashed TinySOL v6
  manifest and all five hydrated WAVs as owner-only regular files with pinned
  byte counts and SHA-256 values. It writes one no-overwrite mode-`0600`
  worksheet with exact private listening paths. Every source-label and proposed-
  vocabulary judgment begins `unreviewed`; no verdict is inferred from the
  metadata, filename, source label, or mapping.
- Judgment semantics: each control separately records whether the dataset-
  authored label matches the heard audio and whether the proposed classroom-
  vocabulary mapping is approved, rejected, or uncertain. A rejected or
  uncertain review can finalize as evidence, but computed summary fields retain
  source-label, mapping, and specific `Contrabass` to `double-bass` blockers.
  Review completion therefore cannot masquerade as mapping acceptance.
- Human and privacy boundary: finalization requires a bounded attributable
  reviewer, canonical time, fixed full-listening attestation, both completed
  judgments for all five sources, exact control order, and the precise private
  serialized bytes. The public artifact removes reviewer identity and local
  audio paths, records no free-text feedback, and keeps candidate-negative,
  evaluation-plan, candidate-metric, classifier-selection, and promotion claims
  off. Non-owner, oversized, symbolic-link, incomplete, reordered, replaced,
  summary-drifted, blocker-drifted, and claim-escalated inputs fail closed.
- Evidence and rollout: the real preparation command created a 3,083-byte
  mode-`0600` five-control, ten-judgment worksheet. A second preparation refused
  overwrite and incomplete finalization produced no public artifact. Exact Bun
  1.3.14 passes four TypeScript checks; 273 worker, 24 analyzer, 42 Railway host/
  config/migration/terminal, 5 separator, 30 discovery, and 9 YAMNet tests; plus
  19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
  No teacher verdict, Railway mutation, provider call, deployment, push, or pull
  request occurred.
- Remaining: an authorized teacher must listen to all five controls and
  explicitly decide every source label and vocabulary mapping. An approved
  deidentified artifact and a new evaluation-plan version remain prerequisites
  for candidate metrics; all classifier and rollout gates stay separate.

## tinysol-v6-exact-controls-v1 — exact free-reed and solo-string controls — 2026-08-10

- Scope: exact implementation commit
  `06599a7ee298d82eb639b62b7ed97a4a5c9f3ba3` adds a separately licensed
  TinySOL v6 manifest, strict hydrator, and ten-test adversarial suite. It does
  not change the existing evaluation-plan version, define a classifier
  threshold, alter Auto or the 2/4/6 core contracts, provision a service,
  change a flag, request an isolation, or call a provider.
- Rights and identity: the manifest pins Zenodo record `3685367`, record and
  concept DOI, CC BY 4.0 license, official MD5 values, independent SHA-256
  values, the 317,576-byte 2,913-row metadata file, the 1,026,917,185-byte
  archive, and its complete ordered 2,952-member tar surface. The current v6
  identity is distinct from the older 2,478-sample v3 record.
- Selection and claim boundary: one natural, non-digitally-retuned, ordinary
  `mf` C4 note is selected per dataset-authored Accordion, Cello, Contrabass,
  Viola, and Violin label by lowest instance id and then path. Exact-instrument
  truth is limited to those source labels; the corresponding classroom-
  vocabulary ids remain proposed mappings awaiting human listening. Candidate
  negatives, current-plan use, classifier selection, and promotion are forbidden.
- Hydration boundary: metadata is verified before the large archive request;
  redirects, response drift, byte/hash mismatch, timeout, traversal, links,
  duplicate members, malformed PCM, symlinked output, relaxed permissions, and
  ambiguous local-source modes fail closed. The streaming parser scans the full
  tar surface while retaining only five pinned WAVs, stores them mode `0600`,
  removes temporary partial objects, and supports paired local-source and
  offline verification.
- Evidence and rollout: the real v6 archive and metadata hydrated all five
  controls and passed offline readback. Exact Bun 1.3.14 passes four TypeScript
  checks; 266 worker, 24 analyzer, 42 Railway host/config/migration/terminal,
  5 separator, 30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6
  authoritative-Auto, and 1 isolation-shadow browser journey. No Railway
  mutation, provider call, deployment, push, or pull request occurred.
- Remaining: teacher listening and versioned plan integration remain open;
  harmonica, pitched-percussion, and traditional-instrument exact controls still
  require separate rights and immutable-source review.

## nsynth-family-control-review-v1 — governed listening evidence — 2026-08-10

- Scope: exact implementation commit
  `6bc35d2a4dd380875d6aa29af2726a1c965e1b57` adds separate preparation,
  finalization, schema validation, and regression tests for the staged NSynth
  controls. It does not complete a human review, add those controls to the
  19-source plan, select a classifier, define a threshold, change Auto or core
  stems, authorize an isolation, provision a service, or change a flag.
- Input boundary: preparation revalidates the exact manifest and all 10
  hydrated WAVs as owner-only regular files with pinned byte counts and SHA-256
  values. It creates one no-overwrite mode-`0600` private worksheet containing
  exact local listening paths and 510 initially unreviewed verdicts. Dataset
  family/source metadata stays visible as provenance but cannot become exact
  instrument truth.
- Human and privacy boundary: finalization requires a bounded attributable
  reviewer, canonical time, fixed full-listening attestation, every whole-source
  check, and every 51-label verdict in exact order. It rechecks manifest/audio
  identity, binds the precise private bytes, and strips reviewer identity and
  local paths. Non-owner, oversized, symbolic-link, incomplete, reordered,
  replaced, and schema-drifted inputs fail closed.
- Promotion shield: private and public claim policies are independent copies of
  frozen constants. Attempted exact-instrument, evaluation-plan, candidate-
  metric, or promotion escalation fails without mutating later artifacts. The
  public status is review evidence only and preserves explicit expanded-plan,
  candidate, quality-floor, human-selection, and Railway-shadow blockers.
- Evidence and rollout: the real command created a 52,202-byte mode-`0600`
  10-by-51 template after checking the hydrated controls; a second preparation
  and incomplete finalization both failed closed, and the template was deleted.
  Exact Bun 1.3.14 passes four TypeScript checks; 256 worker, 24 analyzer, 42
  Railway host/config/migration/terminal, 5 separator, 30 discovery, and 9
  YAMNet tests; plus 19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow
  browser journey. No public review, Railway mutation, provider call,
  deployment, push, or pull request occurred.
- Remaining: an authorized teacher must perform the review. Only an approved
  deidentified artifact and a new evaluation-plan version may make the controls
  eligible for candidate metrics; classifier and rollout gates remain separate.

## nsynth-family-controls-v1 — family/source control tranche — 2026-08-10

- Scope: exact implementation commit
  `56b3c38a8640be3639f58265126f58748fab9e80` adds a staged NSynth
  test-split manifest, bounded hydrator, and regression suite. It does not
  change the current 19-source evaluation-plan version, select a classifier,
  define a threshold, alter Auto or the 2/4/6 contracts, provision a service,
  change a flag, request an isolation, or call a provider.
- Rights and identity: the official CC BY 4.0 dataset page, canonical Google
  Cloud object, 349,501,546-byte archive, storage generation, ETag, last-
  modified time, SHA-256, 4,099-member tar surface, `examples.json`, and 10 WAV
  files are exact pins. The selected controls cover every family actually
  present in the test split, with four acoustic, three electronic, and three
  synthetic sources; `synth_lead` remains an explicit unavailable family.
- Claim boundary: the manifest records dataset family/source truth only. It
  forbids exact-instrument assertions, classroom-vocabulary positives,
  candidate negatives, mixed-track use, and promotion before teacher review
  and explicit plan integration. `instrument_str` remains provenance metadata,
  not an exact identity claim.
- Hydration boundary: one HTTPS object is fetched with manual redirects,
  immutable response headers, byte count, timeout, and SHA-256 enforced. The
  gzip/ustar parser bounds decoded bytes, validates checksum, paths, member
  types/counts/sizes/padding, captures only selected members, and checks the
  exact metadata and RIFF/WAVE contracts. Owner-only no-overwrite output,
  symlink refusal, local-archive verification, offline readback, and cleanup of
  private temporary/partial files are regression tested.
- Evidence and rollout: the real pinned archive hydrated all 10 controls and
  passed offline readback. Exact Bun 1.3.14 passes four TypeScript checks; 250
  worker, 24 analyzer, 42 Railway host/config/migration/terminal, 5 separator,
  30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6 authoritative-Auto,
  and 1 isolation-shadow browser journey. Rollout remains off. No Railway
  mutation, provider call, deployment, push, or pull request occurred.
- Remaining: exhaustive teacher listening, a versioned integration into the
  evaluation cohort, candidate scoring under identical preprocessing, and
  separately licensed exact positives for free reeds, solo strings, pitched
  percussion, and traditional instruments remain open.

## instrument-candidate-comparison-v1 — cohort identity gate — 2026-08-10

- Scope: exact implementation commit
  `1aad9ef7e77fbd2a7c9cae7805b5b081b990e317` adds a comparison-only
  classifier cohort report and CLI. It does not select a classifier, define a
  quality floor, provision a service, change a feature flag, route Auto, rename
  a core stem, authorize an isolation, or call a provider.
- Artifact boundary: one deidentified review and one to eight v3 candidate
  artifacts are bounded before read and hashed by exact bytes. Existing review,
  plan, candidate, native-image, source-report, generator, and dependency-lock
  validators run again. Optional report output uses owner-only mode and refuses
  overwrite; `--require-comparable` returns failure when the evidence cohort is
  incomplete.
- Breaking-change shield: each classifier version maps to one exact model,
  vocabulary, preprocessing, classifier-policy, and threshold-policy identity
  within the submitted cohort. Reusing that id after any content change fails
  closed. Reusing a preprocessing, classifier-policy, or threshold-policy
  version with a different SHA-256 also fails. Candidate reports sort by
  classifier id, so caller order cannot change the comparison record.
- Semantics: at least two candidates with definite classified decisions are
  required for `comparable: true`. The abstention-only YAMNet adapter remains
  visible but cannot satisfy this condition. Comparability remains distinct
  from selection: the report always records null selection/quality-floor fields
  and explicit missing license, calibration, latency/memory, human-decision,
  and Railway-shadow evidence.
- Evidence and rollout: exact Bun 1.3.14 passes four TypeScript checks; 240
  worker, 24 analyzer, 42 Railway host/config/migration/terminal, 5 separator,
  30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6 authoritative-Auto,
  and 1 isolation-shadow browser journey. Workflow YAML parsing and
  `git show --check` pass. Rollout remains off. No Railway mutation, provider
  call, deployment, push, or pull request occurred.
- Remaining: a completed deidentified listening review, fresh native-amd64
  candidate reports, at least two candidates with reviewed thresholds, a
  predeclared quality floor, license/calibration/resource evidence, human
  selection, and Railway shadow acceptance still block classifier selection.

## query-isolation-output-v1 — bounded terminal hydration — 2026-08-10

- Scope: exact executable commit
  `885f4abb7b939f7cb029be03df53d64bf774af77` adds dormant provider-output
  hydration, lease serialization, immutable output identity, and numbered
  migration `0016`. It does not add an app route, import the AudioSep provider
  or terminal composer into `src/index.ts`, change a feature flag, start a
  prediction, alter core stems, or expose an output in the UI.
- Transport and media boundary: output must be HTTPS on Replicate's delivery
  origin with no userinfo, fragment, nondefault port, or redirect. One shared
  60-second deadline permits at most three attempts and 100 MiB. Content length
  and streamed bytes are independently bounded; accepted bytes must form one
  complete PCM/float RIFF/WAVE container with consistent format, block alignment,
  byte rate, and nonempty audio data. Provider details and output URLs are not
  persisted or returned.
- Concurrency and failure isolation: a five-minute lease binds the exact
  isolation and provider prediction, serializes webhook/poll observers, and is
  reclaimable at most three times. Metadata insertion, resource completion,
  and lease deletion form one database transaction. Transient network,
  storage, or database failure releases the lease without a second provider-
  start reservation; malformed output and exhausted ingestion fail only the
  optional isolation. Terminal replay retries source-snapshot cleanup, and an
  active ingestion lease blocks generic timeout/failure races.
- Persistence and retention: app-owned target/residual keys live outside
  `jobs.stems`. Immutable metadata binds storage key, SHA-256, byte count,
  `audio/wav`, canonical creation time, and a 30-day deadline. Fresh schema,
  Railway boot schema, and migration `0016` carry identical table/index/trigger
  SQL; migration tests prove idempotence, immutability, and cascading cleanup.
- Evidence and rollout: exact Bun 1.3.14 passes all four TypeScript checks; 235
  worker, 24 analyzer, 42 Railway host/config/migration/terminal, 5 separator,
  30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6 authoritative-Auto,
  and 1 isolation-shadow browser journey. Rollout remains off. A value-free,
  read-only Railway check found only the canonical `stem-splitter` service and
  its unchanged `SUCCESS` deployment `7f4bc330…` from 2026-08-08; no analyzer
  service exists, and the live separation-options response retains the old
  2/4/6 shape without Auto routing. No Railway mutation, provider call,
  deployment, push, or pull request occurred.
- Remaining: hosted checkpoint/license provenance, native-amd64 and named
  listening evidence, source-preparation resource sizing, exact live course/
  semester/budget acceptance, provider-start/webhook composition, common
  quality/cost evaluation, UI labels, live retention, canary, and rollback
  evidence still block teacher beta.

## query-isolation-budget-v1 — atomic course-semester spend ceiling — 2026-08-10

- Scope: exact implementation commit
  `d207d4b7aedf6a9f9e9feeb869de18d5a0e27647` adds a dormant,
  versioned course-semester provider-start budget. It does not add a provider-
  start route, import the AudioSep adapter into the app, stage a provider pin or
  budget variable, change a feature flag, alter a core stem, or make a paid
  request.
- Authorization boundary: every future teacher-beta claim must supply the exact
  `course-semester-provider-starts-v1` policy. Missing, incomplete, malformed,
  out-of-range, or changed configuration fails closed. The reservation insert
  and queued-to-processing compare-and-set execute in one database batch, so
  concurrent teachers cannot cross the shared course-semester ceiling.
- Accounting semantics: a permanent immutable row records the isolation,
  attempt, core job, cache identity, requesting teacher, course, semester,
  policy, ceiling, and timestamp. Each retry consumes another provider start;
  provider failure and ordinary job deletion do not refund it. A new semester
  receives a new scope, while changing the ceiling or policy after the first
  reservation is rejected. Shadow rows remain unclaimable and create no budget
  evidence.
- Migration and configuration: fresh schema, Railway boot migration, and
  numbered migration `0015` carry byte-identical table/index/trigger SQL.
  `/healthz` reports only `unconfigured`, `incomplete`, `invalid`, or
  `configured`; all three variables remain optional and fail-lazy. The Phase 1
  Railway gate rejects them if staged early.
- Evidence and rollout: the exact clean commit passes all four TypeScript
  checks; 228 worker, 24 analyzer, 33 Railway host/config/migration, 5
  separator, 30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6
  authoritative-Auto, and 1 isolation-shadow browser journey under Bun 1.3.14.
  Rollout remains off. Checkpoint provenance, exact live scope/ceiling,
  provider orchestration, output hydration/retention, quality/cost evaluation,
  and Railway acceptance remain mandatory. A value-free readback of the
  explicit canonical Railway IDs reports the analyzer absent, feature posture
  off, zero secrets printed, zero mutations, and zero provider calls. The local
  provisioning action gate rejects advancement on exactly missing manual
  listening and native-amd64 image evidence. No live migration, Railway
  mutation, provider call, push, pull request, or deployment occurred.

## yamnet-candidate-capture-v1 — native report adapter — 2026-08-10

- Scope: exact implementation commit
  `5f9a8ad1bb554b085c64bef8ddd1b2f7eaec4ff4` adds a model-specific
  evidence adapter for comparison-only YAMNet. It does not select YAMNet, set a
  threshold, add an application dependency, provision a service, change a flag,
  route a split, or alter the frozen 2/4/6 stem contracts.
- Input contract: an owner-only, no-overwrite preparation command binds one
  fresh schema-v2 real-mix report and one schema-v1 isolated-control report by
  repository path and SHA-256. Capture re-reads both and requires the same
  immutable native non-emulated `linux/amd64` image, exact model/mapping/
  vocabulary/scoring pins, current dependency lock and evaluator sources, exact
  source order and hashes, internally consistent score rankings and PCM window
  plans, and the current 19-source evaluation plan. Historical arm64 evidence,
  emulation, symlinks, replacement, mismatch, and drift fail closed.
- Output semantics: no teacher-cleared YAMNet threshold exists. The adapter
  content-addresses its preprocessing, classifier, and review-pending threshold
  policies and emits all 19 observations as
  `abstained`/`no-label-cleared-threshold` with zero detections. It cannot turn
  abstention into instrument absence, calibration, selection, or promotion.
- Evidence: the exact commit passes four TypeScript checks; 227 worker, 24
  analyzer, 31 Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet
  tests; plus 19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser
  journey under Bun 1.3.14. Four focused adapter tests and all 12 combined
  adapter/comparator tests pass; the workflow also parses as YAML. `actionlint`
  was unavailable in this shell and is not claimed.
- Remaining and rollout: off. Fresh native-amd64 corpus/control reports,
  exhaustive listening, a reviewed threshold, candidate observations from real
  evidence, classifier selection, a quality floor, and Railway shadow evidence
  remain open. No Railway mutation, provider call, push, pull request, or
  deployment occurred.

## instrument-evaluation-v3 — candidate execution provenance — 2026-08-10

- Miss: candidate v2 pinned classifier/model/vocabulary identities and policy
  version strings, but not preprocessing or policy content. It also did not bind
  the observations to the exact source report, conversion/generator code,
  dependency lock, immutable image, or native execution platform that produced
  them.
- Contract: exact implementation commit
  `41e66e9027101b9339ab7d3366030b22515019b4` advances the evaluation plan,
  candidate observations, and metrics to v3. Candidate identity now requires
  SHA-256 pins for preprocessing, classifier policy, and threshold policy. A
  separate evidence envelope requires an exact report/schema/hash, repository
  generator/hash, recognized dependency lock/hash, immutable image digest, and
  native non-emulated `linux/amd64` image and host declarations. Metrics carry
  the validated envelope unchanged.
- File and schema safety: every evidence path must be relative, repository-
  contained, nonempty, regular, no larger than 16 MiB, and free of symbolic-link
  components. Current bytes must match every digest; source-report JSON's
  `$schema` must equal its declared versioned schema ID. V1 and v2 candidate
  artifacts fail closed. The v2 `classified`/`abstained`/`degraded` distinction
  and selective metric semantics remain unchanged.
- Evidence: the exact commit passes four TypeScript checks; 223 worker, 24
  analyzer, 31 Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet
  tests; plus 19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser
  journey under Bun 1.3.14. The nine focused candidate/evaluation tests cover
  policy pins, report/generator/lock drift, floating images, platform/emulation
  mismatch, symlinks, oversized files, and provenance carry-through.
- Remaining and rollout: off. The envelope validates supplied evidence but does
  not yet adapt and cross-check a model-specific native classifier report. That
  capture adapter, exhaustive listening, candidate observations, quality floor,
  classifier selection, threshold, native report, service, and Railway shadow
  evidence remain open. No route, stem contract, feature flag, Railway topology,
  provider call, push, pull request, or deployment changed.

## instrument-evaluation-v2 — selective outcome semantics — 2026-08-10

- Miss: candidate v1 represented sources only as `complete` or `degraded`.
  Therefore an empty complete response silently meant all 51 labels were absent,
  even when the model had abstained, while a degraded request also accumulated
  false negatives and true negatives. Both paths corrupted musical metrics.
- Contract: exact implementation commit
  `558708fdb3962326306da40cdb76389e4598730a` advances the evaluation plan,
  candidate observations, and metrics to v2 before any candidate/review artifact
  exists. Every source now declares `classified`, `abstained`, or `degraded`
  with a compatible fixed reason family. Abstained and degraded sources cannot
  report detections; the ambiguous v1 candidate schema fails closed.
- Metrics: precision and recall include only definite classified decisions.
  The report adds selective coverage and separately counts label uncertainty,
  source abstention, and service failures by kind, genre, family, instrument,
  and corpus kind. An empty classified result remains an explicit negative
  decision; an empty abstention and an outage never become absence claims.
- Evidence: the exact commit passes four TypeScript checks; 221 worker, 24
  analyzer, 31 Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet
  tests; plus 19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser
  journey under Bun 1.3.14. The 11 focused evaluation/review tests cover v1
  rejection, source/order/pin drift, outcome/reason mismatch, detections after
  abstention/failure, conditional confusion metrics, and separate rates.
- Rollout: off. No review, candidate, quality floor, classifier selection,
  threshold, service, route, flag, Railway mutation, provider call, push, pull
  request, or deployment changed.

## instrument-evaluation-v1 — genre-diverse evidence gate — 2026-08-10

- Scope: exact implementation commit
  `65278281ecc8420aaf2ab73b4c3dbd9141696ddc` adds a strict evaluation plan,
  private-to-public listening workflow, candidate schema, and metrics engine.
  It adds no classifier selection, threshold, service, provider call, stem,
  isolation request, flag change, or live rollout.
- Corpus and coverage: the plan binds all 11 authorized real mixes and eight
  ChoraleBricks isolated controls to exact manifest/source hashes. It requires
  seven real-mix genres, all 10 vocabulary families, and the three distinct
  review kinds while keeping real, isolated, and future synthetic partitions
  separate. Slakh2100 and MedleyDB are not yet included.
- Review and privacy: an owner-only, no-overwrite worksheet requires full-source
  listening and all 51 verdicts for every source. The finalizer refuses drift,
  partial review, unsafe input permissions, symbolic links, and mismatched
  serialized bytes, then removes reviewer identity and binds the exact private
  worksheet by SHA-256. No completed listening artifact exists yet.
- Candidate and metrics: candidate input requires exact classifier, model,
  vocabulary, preprocessing, threshold, source, and ordering pins. Reports
  expose precision, recall, abstention, and service failure by review kind,
  genre, specific-instrument family, instrument, and corpus kind. The
  overlapping all-label aggregate is diagnostic and explicitly forbidden for
  promotion. Degraded inference and review uncertainty stay visible.
- Evidence: the exact commit passes four TypeScript checks; 220 worker, 24
  analyzer, 31 Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet
  tests; plus 19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow
  browser journey under Bun 1.3.14. Focused review/evaluator coverage passes
  10/10 and exercises completeness, identity stripping, byte binding, file
  safety, pin drift, ordering, outage, uncertainty, and overlapping labels.
- Rollout: off and ineligible. Exhaustive deidentified listening, one complete
  candidate artifact, a selected quality floor, a reviewed candidate decision,
  native-amd64 evidence for the chosen image, and Railway shadow evidence
  remain open. The value-free canonical Railway pre-provision audit passes with
  the analyzer absent and all features off; the repository action gate remains
  blocked only by manual listening and native-amd64 role-v4 image evidence. No
  Railway mutation, push, pull request, provider call, or deployment occurred.

## instrument-discovery-feedback-v1 — governed candidate evidence — 2026-08-10

- Scope: exact implementation commit
  `d710fe9d81ba7adec039b5ab6a62d9d5d3ec2e6e` adds structured teacher feedback
  to the existing private discovery review. It adds no classifier selection,
  threshold, discovery request, provider call, stem, isolation request, flag
  change, or live rollout.
- Ontology and review: `instrument-review-ontology-v1` classifies every pinned
  vocabulary label as a specific instrument/voice, family/ensemble, or
  production texture. The console displays those kinds separately, requires a
  confirmed/absent verdict for every surfaced label, limits missed observations
  to omitted pinned labels, records genre context, and tells downstream review
  not to double-count overlapping parent and child evidence.
- Storage and provenance: additive schema 14 and the Railway boot migration add
  immutable, append-only per-teacher revisions. Each insert is compare-and-swap
  guarded and bound to the exact stored analysis bytes, source SHA-256,
  classifier version, vocabulary version/content hash, ontology version, job,
  teacher, and prior revision. Concurrent next-revision attempts yield one
  winner; deleting the retained job cascades its feedback.
- Privacy and non-interference: caller-supplied source or analysis identity is
  rejected. Teacher API summaries omit reviewer and source fingerprints;
  student job responses expose neither observations nor verdicts. Database
  constraints permanently mark the rows identified, `unreviewed-candidate`,
  and training-ineligible. Feedback cannot change the concrete 2/4/6 model or
  start an isolation; any future ground truth requires a separately reviewed
  and de-identified artifact.
- Evidence: Bun 1.3.14 Phase 0 passes 210 worker, 24 analyzer, 31 Railway
  host/migration, 5 separator, 30 discovery, and 9 YAMNet tests plus 19
  flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey. The
  instructor E2E covers authentication, complete verdicts, filter behavior,
  exact readback, malformed/injected/stale requests, logout scrubbing, and
  unchanged core routing. Its first visibility assertion caught author CSS
  overriding the HTML `hidden` attribute; an explicit hidden-state rule fixed
  the rendered leak before the full gate passed.
- Visual QA: the exact latest files passed an in-app desktop/mobile journey.
  Revision 1 survived server readback; filtering showed only Trumpet; verdict
  targets measured 44 pixels; the 390×844 layout had no horizontal overflow;
  and no dialog overlay, console warning, or console error appeared.
- Rollout: off. Discovery, query isolation, and server Auto remain false in the
  live environment. Classifier calibration, human corpus review, native-amd64
  evidence, manual core-stem listening, and Railway analyzer provisioning
  remain separate open gates. No Railway mutation, push, pull request, provider
  call, or deployment occurred.

## instrument-discovery-teacher-review-v1 — advisory UI boundary — 2026-08-10

- Scope: exact implementation commit
  `671c2628178f9757afb3417b0a0ee7fad788d89b` adds a teacher-only review panel
  over the existing authenticated stored-analysis route. It adds no discovery
  inference, model candidate, threshold, stem, isolation request, provider
  call, database field, flag change, or live rollout.
- Honest states: the panel renders the concrete core route separately from
  possible/uncertain instrument detections, confidence, window support and
  classifier/vocabulary provenance. It calls an empty complete result an
  abstention rather than proof of absence, and it displays discovery timeout
  while retaining the successful core route.
- Privacy and isolation: bounded job IDs reject path-like input before fetch;
  all dynamic values use text nodes; source SHA-256 and model-weight SHA-256 are
  not rendered. The page has no isolation control and states that the 2/4/6
  contract is unchanged. A failed logout preserves the still-active console;
  only confirmed logout clears the job ID, result, detection nodes and status.
  Class-code and signed-out requests remain unauthorized, and student job
  payloads remain label- and pin-redacted.
- Evidence: the targeted instructor browser journey covers invalid input,
  abstention, discovery timeout, possible detection, provenance, hash
  non-disclosure, absent isolation controls, failed logout and confirmed
  scrubbing. The complete Bun 1.3.14 Phase 0 gate passes 207 worker, 24 analyzer,
  28 Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet tests plus
  19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
  In-app browser QA at 1280×720 and 390×844 found no horizontal overflow,
  framework error, console warning, or console error; the load control retains
  a 44-pixel minimum target.
- Rollout: off. The current CLAP prompt/checkpoint remains rejected, YAMNet
  remains comparison-only, Essentia remains license-blocked, and instrument
  discovery remains teacher-review evidence rather than a selected service.
  No Railway mutation, push, pull request, provider call, or deployment
  occurred.

## audio-pipeline-acceptance-evidence-v1 — human and native gates — 2026-08-10

- Miss: the promotion manifest correctly blocked provisioning on human
  listening and native-amd64 image evidence, but no executable boundary tied a
  listening decision to the exact frozen Railway bytes or a native image claim
  to an exact GitHub run and every image input. Either condition could otherwise
  collapse into a hand-edited boolean.
- Contract: exact implementation commit
  `1aa63d9c3e7bedfe90fe4df10c778137d040f14d` adds separate strict schemas and
  canonical paths for listening and native-image evidence. The promotion
  loader must successfully load the corresponding artifact before either
  manifest condition may be true; missing, partial, extra, stale, reordered, or
  drifted evidence fails closed.
- Listening boundary: a read-only exporter requires and verifies the hydrated
  authorized source and re-reads the already-completed canonical Railway job.
  It verifies the live catalogue and job, guarded same-origin/no-redirect
  downloads, ordered MP3 frame validity, sizes and SHA-256 values before
  writing a private,
  gitignored mode-`0600` bundle. Acceptance requires a named teacher or domain
  reviewer, full source and stem listening, every usability check, exact stem
  identity, a post-baseline UTC timestamp, and the fixed attestation. The
  exporter reports zero jobs created and zero provider calls.
- Native boundary: the path-scoped CI job now checks out the exact PR head or
  push SHA, proves a Linux x86_64 runner and Docker host, builds and smokes
  `linux/amd64`, captures the non-root command, size, runtime/classifier/source
  pins and smoke claims, hashes every Docker/smoke/workflow input, and uploads a
  commit-named artifact through the digest-pinned official upload action. The
  capture refuses a dirty checkout and the canonical loader rehashes the
  current repository inputs.
- Evidence: `actionlint` v1.7.12, `git diff --check`, the audio-pipeline
  TypeScript check, and the full repository test command pass. A clean exact
  `1aa63d9` Phase 0 run under Bun 1.3.14 passes 207 worker, 24 analyzer, 28
  Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet tests, plus
  19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
  The private bundle independently matched the frozen source and all four stem
  hashes without creating a job or calling a provider.
- Current result: `manualListening` and `nativeAmd64Image` remain false. The
  pre-provision gate still fails on exactly `manual-listening-missing` and
  `native-amd64-image-missing`; all processing flags remain off.
- Remaining: obtain attributable listening acceptance and a successful native
  GitHub artifact, then add each canonical JSON record through review before
  provisioning. No push, pull request, Railway mutation, provider call, or
  deployment occurred.

## railway-rollback-baseline-v1 — immutable promotion binding — 2026-08-10

- Miss: the schema-v2 manifest treated the Railway baseline as absent even
  though an authorized four-track rollback artifact already recorded a
  successful canonical Railway job. A bare evidence boolean also did not prove
  which artifact, source, deployment, or provider pins supported it.
- Contract: exact implementation commit
  `ba556213a10dc3b9e8347d9c90fe0a64eedb8e74` adds a strict loader for
  `docs/acceptance/2026-08-09-v3.2-rollback-baseline/baseline.json` and pins its
  SHA-256 to `e2369d661e0e0ee11072e5d6877171ce9ec894aab6398e404beb409368dd4827`.
  The promotion manifest can carry `railwayBaseline: true` only while that
  artifact matches its exact schema, canonical origin and Railway IDs,
  executable `htdemucs_ft` contract, authorized CC corpus source, job timing,
  ordered distinct stems, deployed commit/image, and exact provider evidence.
  Hydrated local audio must additionally match its recorded byte count and
  content SHA-256; CI remains reproducible without committing the licensed
  audio bytes.
- Current result: the pre-provision action gate now fails on exactly two
  conditions—native-amd64 role-v4 image evidence and manual listening. The
  ordinary shadow gate has five blockers: those two plus analyzer absence,
  Railway resource acceptance, and Railway rollback reproduction. Every
  processing flag and rollout mode remains off.
- Evidence: clean exact commit `ba55621` passes the literal Phase 0 gate under
  Bun 1.3.14: all three TypeScript checks; 198 worker, 24 analyzer, 28 Railway
  host/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus 19
  flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
  The exact commit remains clean and passes `git show --check`. A separate
  value-free live Railway readback still matched deployment
  `7f4bc330-4c52-4257-8762-3b85a24b2d07` and image digest
  `sha256:cf04a8a3d2b369009a9a0fe79cdda166c92937d117d5559cd00ed6b8807853ca`;
  that current-state check remains distinct from the immutable artifact.
- Remaining: obtain current native-amd64 image evidence and human listening
  acceptance before provisioning. No analyzer service, variable, provider
  call, deployment, remote branch, or pull request was created.

## audio-pipeline-promotion-v2 — pre-mutation provisioning gate — 2026-08-10

- Miss: promotion v1 verified exact historical commits, but CI used a
  depth-one checkout that could not contain those commits. It also had only a
  next-stage gate, whose analyzer-absent, Railway-resource, and Railway-rollback
  blockers necessarily remain true before the analyzer can be provisioned.
- Contract: CI now fetches repository history, and schema v2 adds an explicit
  `provision-audio-analysis` action gate. Before service creation it requires
  the committed Phase 0/core/corpus/browser evidence plus native-amd64 image,
  manual-listening, and frozen Railway baseline evidence. It rejects a non-off
  rollout or an already-provisioned analyzer. Resource and rollback acceptance
  remain mandatory for `shadow`, but no longer create a circular provisioning
  prerequisite.
- Result at exact implementation commit `959940b`: the action gate exited
  nonzero on exactly three missing
  preconditions—native-amd64 image, manual listening, and Railway baseline.
  The shadow gate was non-promotable with six blockers: those three plus
  analyzer absence, Railway resource acceptance, and Railway rollback.
- Evidence: exact implementation commit `959940b` passes the schema-v2
  typecheck/CLI and literal Phase 0 gate from a clean detached checkout under
  Bun 1.3.14: all three application typechecks; 194 worker, 24 analyzer, 28
  Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus
  19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
  `actionlint`, `git diff --check`, clean worktree readback, and
  `git show --check` pass. The value-free live Railway pre-provision audit also
  passes against the explicit canonical IDs with the analyzer absent, all
  features off, zero mutations, zero provider calls, and no secrets printed.
- Remaining at that commit: the local Docker engine did not become responsive
  after a bounded Docker Desktop restart attempt. No role-v4 image,
  native-amd64 CI, manual
  listening, Railway baseline, service, variable, provider call, deployment,
  remote branch, or pull request was claimed or created.

## audio-pipeline-promotion-v1 — executable release ordering — 2026-08-10

- Scope: a strict manifest and CLI now turn the phased processing roadmap into
  a checked release contract. They add no audio processing, service, variable,
  credential, migration, provider call, deployment, or live rollout.
- Candidate binding: release `v3.2-autosplit-role-v4` records exact base
  `86cd50b` and candidate `8901902`, one `role-classifier` change axis,
  `autosplit-role-v4+analysis-source-scope-v2`, and the compiled AudioSep and
  SAM-Audio version pins. Floating versions and pin drift fail closed.
- Stable contract: the manifest is compared directly with the executable
  Replicate 2/4/6 catalogue, including every literal stem name. Instrument
  discovery remains metadata, AudioSep remains contract-only, SAM-Audio remains
  evaluation-only and license-blocked, and Banquet remains research-only.
- Ordering and rollback: components must proceed as audio analysis → instrument
  discovery → AudioSep → SAM-Audio → Banquet. A dependency cannot be accepted
  on paper: it must be provisioned, enabled, externally exercised, and free of
  blockers. Rollout may advance only one stage through `off`, `shadow`, teacher
  beta, student canary, and default, with a tested false kill switch and no
  schema rollback.
- Current result: the exact manifest remains at `off`; all three feature flags
  and modes remain disabled. Its computed blockers before `shadow` are the
  absent analyzer service plus missing native-amd64 image, manual listening,
  Railway resource acceptance, and Railway rollback evidence.
- Evidence: exact implementation commit `ddd6236` passes the promotion
  typecheck/CLI and literal Phase 0 gate from a clean detached checkout under
  Bun 1.3.14: all three application typechecks; 193 worker, 24 analyzer, 28
  Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus
  19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
  The checkout stayed clean and `git show --check` passed. Exact HEAD also
  repeats the eleven-source FFmpeg corpus at 8 preferred, 3 accepted
  alternatives, and 0 mismatches, with Chrome/FFmpeg decisions agreeing 11/11.
- Remaining: native-amd64 image CI, manual listening, Railway resource and
  restart acceptance, private analyzer provisioning, authorized shadow
  journeys, stored live-decision readback, and rollback reproduction. No remote
  branch or pull request contains this local evidence.

## autosplit-role-v4 — short-source codec parity — 2026-08-10

- Miss: a real app-plus-analyzer composition test routed the same sustained
  two-second source to two tracks as upload/Archive WAV but four tracks after a
  YouTube-shaped AAC/M4A transcode. One codec-boundary peak counted as roughly
  0.5 onsets per second and manufactured repeating-attack evidence.
- Contract: onset-derived routing features now remain zero until at least two
  refractory-separated peaks exist. Once supported, the full event count and
  all existing duration-normalized thresholds apply unchanged. The analysis
  schema, `analysis-source-scope-v2`, provider pins, and concrete 2/4/6 stem
  contracts do not change.
- Version and rollback: browser, app, analyzer, corpus expectations,
  query-isolation provenance, E2E fixtures, and image smoke move together to
  exact `autosplit-role-v4`. A stale v3 analyzer fails the compiled contract and
  uses the frozen default. `SERVER_AUTO_ENABLED=false` remains the immediate
  rollback; live posture is still off.
- Evidence: the focused classifier suite passes 23/23. The composed test uses
  the real analyzer, signed stored-source fetch, FFmpeg decode, classifier,
  hashing, and cleanup for upload, YouTube AAC/M4A, and Archive, then proves
  three non-degraded v4 decisions and three concrete two-stem provider inputs.
  Local FFmpeg 8.1.2 repeats the fixed corpus at 8 preferred, 3 accepted
  alternatives, and 0 mismatches, with no v3 choice changed. Headless Chrome
  151 agrees with the FFmpeg decisions on all 11 sources under v4. See
  `docs/evaluation/autosplit-role-v4-candidate.md`.
- Exact source: commit `8901902` passes the frozen Bun 1.3.14 install and
  literal `test:phase0` from a clean detached checkout: all three typechecks;
  184 worker, 24 analyzer, 28 Railway host/migration, 5 separator, 30 discovery,
  and 9 YAMNet tests; plus 19 flags-off, 6 authoritative-Auto, and 1
  isolation-shadow browser journey. The checkout stayed clean and
  `git show --check` passed.
- Remaining: current v4 image/native-amd64 CI, pinned-image decoder
  reproduction, manual listening, Railway resource and restart acceptance,
  private-service provisioning, and shadow journeys. No service, variable,
  provider call, migration, or deployment changed.

## analysis-source-scope-v2 — shared authoritative source allowlist — 2026-08-10

- Miss: authoritative upload Auto signed the app-owned
  `auto-inputs/v1/<job>` snapshot, but the real analyzer accepted only
  `uploads/...`. Mocked browser E2E exercised the decision contract without
  running the service's URL policy, so a deployed request would have degraded
  to the frozen four-track fallback.
- Contract: app and analyzer now compile one source-scope module. It accepts
  only canonical `uploads/<id>/<file>` keys and exact
  `auto-inputs/v1/<job>` snapshots; Auto snapshots require upload source type.
  The app refuses to mint analyzer URLs for stems, query-isolation
  inputs/outputs, malformed encodings, over-deep keys, or arbitrary internal
  objects.
- Version and rollback: `/readyz` reports `analysis-source-scope-v2`; the
  constrained image gate requires that exact value and an actual analysis over
  the authoritative-snapshot path. Older analyzers remain safely fail-lazy but
  cannot pass the new release gate. `SERVER_AUTO_ENABLED=false` remains the
  immediate rollback, without a schema change.
- Evidence: exact executable-source commit `86cd50b` passes the frozen Bun
  1.3.14 install and literal `test:phase0` from a clean detached worktree: all
  three typechecks; 183 worker, 23 analyzer, 28 Railway/migration, 5 separator,
  30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6 authoritative-Auto,
  and 1 isolation-shadow browser journey. A value-free audit of the explicit
  canonical Railway IDs passes the pre-provision gate with the analyzer absent,
  feature posture off, zero mutations, zero provider calls, and no secrets
  printed. Docker was installed locally but its daemon was not running, so the
  revised image smoke did not run. Native-amd64 image, Railway
  resource/restart, real-source shadow, and listening acceptance remain open.
  No service, variable, provider call, migration, or deployment changed.

## authoritative-auto-upload-snapshot-v1 — immutable upload handoff — 2026-08-10

- Scope: authoritative upload Auto now freezes the current stored upload into
  an app-owned `auto-inputs/v1/<job>` object before analysis. No live flag,
  classifier, provider model/version, core stem contract, migration, Railway
  variable, service, or deployment changed; explicit and flags-off requests
  keep their existing source path.
- Contract: browser upload routes can address only `uploads/`. The analyzer and
  separator receive separately signed URLs for the same frozen key, and the
  analyzer's authenticated byte count must equal the snapshot's stored size
  before its recommendation can route. The private analyzer SHA remains the
  job digest; neither key nor digest enters student JSON.
- Resource boundary: the Railway filesystem adapter streams writes through
  unique temporary files and serializes writers per key, so snapshotting the
  supported 100 MiB maximum does not first assemble an application-heap buffer.
  The shared storage path supplies a known-length stream where the object-store
  runtime requires one. A 60-second total copy deadline, recorded-size bound,
  collision check, committed-size verification, and pre-job rollback fail closed.
- Compatibility: authoritative mode freezes both current `model: auto` requests
  and the older valid explicit-model plus `routingRequest: auto` shape. Because
  the completed job now retains its app-owned snapshot key, the optional
  teacher-isolation source guard accepts that exact key family without widening
  to arbitrary internal storage paths.
- Evidence: exact executable-source commit `e9f7ed9` passes the literal
  `test:phase0` gate from a clean detached worktree under Bun 1.3.14: all three
  typechecks; 165/165 worker, 22/22 analyzer, and 22/22 Railway/migration tests;
  5/5 separator, 30/30 discovery, and 9/9 YAMNet-comparator tests; plus 19/19
  baseline, 6/6 authoritative-Auto, and 1/1 isolation-shadow browser scenarios.
  The adversarial browser case reuses the original PUT both before analyzer
  fetch and after analysis, then proves the separator still downloads the
  initial snapshot bytes. `git show --check` also passes. This evidence is local
  only: no push, PR, Railway mutation, or deployment occurred.
- Combined-tree evidence at the time of this entry: the earlier prompt-history
  pagination tree passed a
  selected-path manifest at `1a398b27…`, but that inherited recipe was later
  found to omit executable scripts and service/config trees. The widened guard
  then rejected two otherwise-green commands because source changed during
  execution (`fccaf815…` to `5e3adcd5…`, then `f059739f…` to `45f2d503…`).
  Combined acceptance was then bound to exact commit `fe0a5ff`: a
  clean detached checkout passes all three typechecks; 181 worker, 22 analyzer,
  28 Railway, 5 separator, 30 discovery, and 9 YAMNet tests; plus 19/6/1 browser
  journeys. `git diff --check` passes and the checkout remains clean. Separate
  desktop/mobile in-app QA verifies the governed teacher editor, versioned
  assets, true top-of-prompt navigation, revision provenance, and logout
  scrubbing. Commit `86cd50b` and the entry above supersede this combined gate
  without rewriting it. This remains local evidence only: no push, PR, Railway
  mutation, provider call, or deployment occurred.
- Remaining: native-amd64 CI, actual Railway resource/restart acceptance,
  parity calibration, genre listening, and live shadow/rollback evidence remain
  gates before authoritative promotion.

## server-auto-source-identity-v1 — imported-byte authority gate — 2026-08-10

- Scope: server-owned source identity is now an authority prerequisite for
  YouTube and Internet Archive Auto recommendations. No feature flag, Railway
  variable, service, migration, deployment, classifier rule, core stem name, or
  explicit 2/4/6 request changed.
- Contract: the app calculates SHA-256 and byte count from each server-fetched
  import before storage and passes that private expectation only to its routing
  boundary. A successful analyzer response must report the exact same identity;
  missing, malformed, hash-drifted, or length-drifted identity degrades to the
  existing backend default with code `source_identity_mismatch`.
- Failure isolation: a response whose core analysis contract fails can no
  longer contribute a parsed fingerprint. The server-owned import digest
  remains private and write-once, while the separator receives neither `auto`
  nor the analyzer's mismatched recommendation.
- Evidence: exact executable-source commit `4b86991` passes the literal
  `test:phase0` gate from a clean detached worktree under Bun 1.3.14: all three
  typechecks; 157/157 worker, 22/22 analyzer, and 22/22 Railway/migration tests;
  5/5 separator, 30/30 discovery, and 9/9 YAMNet-comparator tests; plus 19/19
  baseline, 5/5 authoritative-Auto, and 1/1 isolation-shadow browser scenarios.
  The E2E exercises both YouTube and Archive drift and reads back the
  independently calculated private digest. `git show --check` also passes for
  that implementation commit. This evidence is local only: no push, PR,
  Railway mutation, or deployment occurred.
- Remaining: native-amd64 CI, Railway resource and restart acceptance, genre
  listening, and live shadow/rollback evidence remain gates before
  authoritative promotion. Browser-upload mutability is closed separately by
  `authoritative-auto-upload-snapshot-v1` above.

## query-isolation-source-guard-v1 — immutable pre-spend input — 2026-08-10

- Scope: a dormant pre-spend source guard, app-owned input snapshot, fresh
  15-minute provider URL, provider-contract enforcement, and cleanup seam. No
  provider-start route, Replicate prediction, flag, Railway variable, migration,
  deployment, core stem, Auto threshold, or student/teacher payload changed.
- Race closure: the app reads the stored original at the spend boundary,
  bounds that read by stored byte count and a 60-second deadline, fingerprints
  those exact bytes, compares them with the write-once job digest, and publishes
  only matching bytes under
  `isolation-inputs/v1/<isolation>/<sha256>`. Browser PUT routes accept only the
  separate `uploads/` prefix. Replacing the original before verification fails;
  replacing it afterward cannot affect the immutable provider input.
- Contract: query-isolation requests now reject ordinary upload URLs and require
  the source URL path to bind the same isolation id and SHA-256 as the request.
  This prevents a future app route from bypassing the snapshot seam while using
  the existing dormant AudioSep adapter.
- Evidence: four Railway filesystem-adapter regressions cover different-digest
  and post-check overwrites, deletion, 30-day retention expiry, 15-minute URL
  expiry, stored-metadata/body-length drift, byte-identical retry, snapshot
  persistence, and narrow cleanup. The targeted source/AudioSep suite passes
  11/11. Full Phase 0 evidence is recorded only after all remaining gates
  complete against one stable committed tree; passing a combined dirty working
  tree is not durable release evidence.
- Source binding: exact executable-source commit `15e782a` passes the literal
  `test:phase0` command from a clean detached worktree under Bun 1.3.14: all
  three typechecks, 156 worker, 22 analyzer, 22 Railway host/migration, 5
  separator, 30 discovery, 9 YAMNet, 19 flags-off browser, 4 authoritative-Auto
  browser, and 1 isolation-shadow test. Its commit whitespace check also passes.
  This is commit-only local evidence, not native CI, a remote branch, a PR, a
  Railway release, or live paid-provider approval.
- Remaining: hosted checkpoint/license provenance, semester budgets,
  provider-start/webhook orchestration, output hydration/retention, common
  quality/cost evaluation, native-amd64 and Railway acceptance, and rollback
  evidence remain mandatory before paid execution.

## query-isolation-shadow-v1 — verified identity and demand only — 2026-08-10

- Scope: authenticated stored-source fingerprinting, private job identity,
  additive isolation rollout state, and a teacher-only shadow-create route.
  No provider-start, webhook, output hydration, separator selection, core stem,
  Auto threshold, Railway variable, or live deployment changed.
- Source identity: the analyzer streams the exact allowlisted source into its
  bounded temporary file while incrementally calculating SHA-256. Analysis can
  return that identity out of band; `/v1/fingerprint` performs the same fetch
  without decode. Both paths share authentication, redirect/origin checks,
  byte/concurrency/time limits, cleanup, and log redaction. The app stores only
  the lowercase digest and never includes it in student or teacher JSON.
- Shadow boundary: only literal `QUERY_ISOLATION_ENABLED=true` plus absent or
  literal `QUERY_ISOLATION_MODE=shadow` opens creation. Invalid modes fail off.
  The route accepts only bounded `{target}` JSON from a signed-in teacher,
  normalizes the target server-side, binds the authenticated username, requires
  a completed core job and verified source identity, and records the reviewed
  AudioSep contract identity without constructing its provider adapter.
- Spend shield: shadow resources persist with `rollout_stage=shadow`; the claim
  compare-and-set requires `teacher_beta`. Requests are idempotent by complete
  cache identity and stop at two distinct targets. The response states
  `providerStarted=false`, attempts stay zero, and the false-default regression
  proves the route remains absent when the flags are omitted.
- Migration: `0009` adds nullable constrained `jobs.source_hash`; `0010` adds
  isolation rollout stage while forcing existing rows into `shadow`; `0011`
  makes a non-null job digest and its source locator immutable while still
  permitting the first legacy `NULL` to verified-hash transition.
  Railway boot adds missing columns and installs the identity triggers on every
  persistent-volume start.
- Adversarial identity follow-up: resource creation no longer trusts a valid-
  looking digest supplied by its caller. Its one conditional insert requires
  the completed job's exact source type and stored digest to match, so a race,
  legacy null, or future internal caller cannot create cache metadata for
  different bytes. Idempotent reads rejoin the same job identity and recheck
  every stored cache-material/provider field; database triggers freeze the key
  and type once the digest exists. The first-hash compare-and-set also binds the
  fingerprinted source key, type, and completed state. The provider-start phase
  must still re-fingerprint the object immediately before spend to detect
  object replacement after job creation.
- Local gate: exact Bun 1.3.14 passes all three typechecks plus 152 worker, 22
  analyzer, 22 Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, 19
  flags-off browser, 4 authoritative-Auto browser, and 1 isolation-shadow E2E
  test. Native-arm64 image
  `sha256:e2ebd8c3d2452ccd34be371ab9222a8a3f9408faaaf4e7cd7d306bbf45e6838f`
  also passes the constrained smoke, including analyze/fingerprint hash parity.
  Native-amd64 CI and Railway acceptance must still repeat the image gate.
- Source gate: exact commit `10f6b0a` preserves the prior verified-fingerprint
  and shadow-route baseline. Exact commit `4cf452e` adds the write-once digest
  and locator triggers, atomic repository/cache-material identity checks, and
  expanded evaluator provenance; it passed the updated literal `test:phase0`
  command above. No remote branch, pull request, Railway variable, service,
  migration, or deployment contains this follow-up yet.
- Image evidence:
  `docs/evaluation/2026-08-10-audio-analysis-fingerprint-image.md` binds the
  local image identity, source hashes, command, result, resource sample, and
  remaining promotion boundary.
- Remaining gate: do not add `teacher_beta` mode or import the provider-start
  adapter until the hosted checkpoint/license provenance, semester budget,
  output hydration/retention, common quality/cost evaluation, and live Railway
  rollback evidence all pass.

## audiosep-replicate-contract-v1 — dormant adapter and resource — 2026-08-10

- Scope: query-isolation contract, offline provider guard, additive persistence,
  and teacher-only historical readback. No create/start route, provider
  prediction, Railway change, feature-flag change, separator selection, stem
  label, or 2/4/6 contract changed.
- Candidate: community Replicate model `cjwbw/audiosep`, exact version
  `f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8`.
  The adapter requires that pin through `REPLICATE_AUDIOSEP_VERSION`; it never
  accepts an owner/model alias or floating `latest`.
- Contract: `audio_file` plus canonical `text` input to one target URI. The
  adapter declares no residual, never writes to core stems, accepts output
  only from HTTPS Replicate delivery hosts, and replaces raw provider failures
  with bounded app-owned codes.
- Cache identity: source SHA-256, normalized target, analysis-vocabulary
  version, provider, model, exact provider version, and adapter-contract
  version. Expiring source/webhook URLs and transport job ids do not alter the
  signal/model identity.
- Resource boundary: each row belongs to a completed core job but never changes
  `jobs.stems`. A conditional insert atomically caps a track at two distinct
  requests while returning a duplicate cache identity idempotently. A partial
  unique index and compare-and-swap transitions permit one processing attempt
  per track, two total attempts per request, and a 15-minute deadline. Failure
  and timeout remain local to the isolation row. The signed-in teacher summary
  labels the result “Optional instrument isolation,” reports exact provider
  identity and overlap/reconstruction limitations, and exposes no storage key.
- Provenance: AudioSep's official repository is MIT licensed and was reviewed
  at `944583f18b84589dc965de3ad77525c945334252`. Replicate attributes its
  separate community build to the `chenxwh/AudioSep` fork at
  `e3bd8d4631206a1c1870ece762a8fa21da8794f7`, whose tree has no Cog wrapper,
  predictor, or checkpoint. The wrapper first appears at later commit
  `5fa5394910971d256beb8875f29e6f3aabcf1a8d` and loads
  `checkpoint/audiosep_base_4M_steps.ckpt`, but that file is absent from Git.
  The hosted bytes and their license therefore remain unverifiable; source
  MIT or a separate mirror's Apache-2.0 metadata cannot close that chain.
- Comparison disposition: SAM-Audio remains evaluation-only because its
  checkpoints are gated, its custom SAM License still needs institutional
  review, and the available Replicate implementation is community-hosted.
  Banquet remains Phase 5 because its documented query input is audio and its
  coherent long-tail multi-stem semantics need a separate design.
- Gate: bind exact checkpoint/license provenance, add server-verified source
  hashing, semester budgets, create/start/webhook and output-retention paths,
  signed-source lifetime tests, a common evaluation manifest, and a quality/cost
  decision before importing the adapter into an app route.
  Keep `QUERY_ISOLATION_ENABLED=false` until then.
- Evidence: `docs/evaluation/2026-08-10-query-isolation-provider-review.md` and
  the offline contract regressions in `tests/isolation.test.mts`.
- Source gate: exact implementation commit `6fc8175` passes the literal
  `test:phase0` command under Bun 1.3.14: all three typechecks plus 148 worker,
  21 analyzer, 17 Railway-host/migration, 5 separator, 30 discovery, 9 YAMNet,
  19 flags-off browser E2E, and 4 authoritative-Auto E2E tests. The authenticated
  remote OpenAPI readback was not run because no local Replicate token was read;
  `npm run check:isolation` remains a pre-release gate and starts no prediction.

## yamnet-fixed-v1 — offline comparator, not selected — 2026-08-09

- Scope: candidate evaluation only. No application dependency, feature flag,
  service, separator model, stem label, 2/4/6 contract, or role-classifier
  threshold changed.
- Classifier: Google's official unquantized YAMNet TFLite version 1 with
  classifier id
  `google-yamnet-tflite-v1-max-class-top3-patch-mean-second-window-v1@kaggle-version-763`.
  The exact Kaggle model/instance/version, Apache 2.0 metadata, archive and
  model byte lengths/SHA-256 values, TensorFlow Models revision, 521-class map,
  Python dependency lock, and preprocessing contract are pinned and checked.
- Ontology: 36 of 51 `classroom-instruments-v1` labels map only to exact
  AudioSet classes. Fifteen labels remain explicit gaps; the comparator does
  not infer narrower labels from broad or combined YAMNet classes.
- Scoring: maximum across mapped classes, top-three-patch mean, and the
  second-highest analysis window with a single-window exception. No threshold,
  calibration, `possible`, or `uncertain` policy was selected.
- Isolation: each source runs by immutable image ID in a distinct non-root,
  networkless, read-only, resource-bounded container. The image bakes the exact
  dependency-lock and source hashes; the report binds those identities plus
  the corpus, reviewed expectations, mapping, and local decoder versions.
- Evaluator provenance follow-up: schema v2 binds a before/after-stable SHA-256
  for every hydrated input, the exact decoded PCM/window sample plan, the Node
  runtime, TypeScript configuration and dependency locks, and every transitive
  host-side source that can change loading, decoding, windowing, contracts, or
  scoring. The native-amd64 workflow watches the same paths. Existing arm64
  schema-v1 reports retain their original source hashes as immutable historical
  evidence and need a new
  v2 run; they are not rewritten when the evaluator changes.
- Licensed-corpus result: 11 sources, 40 eligible reviewed groups, and 2
  unsupported groups. Top-3/top-5/top-10 coverage was 16/21/31; mean reciprocal
  rank was 3,507 basis points. Voice and keys ranked strongly, but brass,
  woodwind, and free-reed placed 0/2, 0/3, and 0/1 groups in the top five.
  Several directional confusions failed and two remain corpus gaps.
- Isolated-control extension: a separately versioned ChoraleBricks v1 manifest
  pins eight CC BY 4.0 performed tracks across flute, oboe, clarinet, trumpet,
  French horn, trombone, alto saxophone, and tuba. Its same-origin one-redirect
  hydrator enforces exact type, length, SHA-256, no-clobber output, and offline
  verification while keeping audio gitignored. Dataset labels remain
  `dataset-authored-awaiting-teacher-listening`; exhaustive non-positive labels
  are candidate negatives and cannot support precision yet.
- Isolated-control result: six exact positives are supported; four ranked
  first and all six ranked in the top three (8,056-basis-point MRR). Oboe and
  tuba remain unsupported. Oboe strongly surfaced trumpet/brass, horn ranked
  behind trombone, and tuba surfaced double bass behind broad brass. The report
  records 278 candidate-negative annotations, selects no threshold, and makes
  no precision claim.
- Evidence: `docs/audits/2026-08-09-yamnet-comparator-gate.md` and
  `docs/acceptance/2026-08-09-yamnet-comparator/native-arm64-corpus.json`
  (SHA-256
  `b59d4f7d32bfb999263a26bd7abb3313afe49111c96e23f7d162d4efba09fe93`).
  The control report is
  `docs/acceptance/2026-08-09-yamnet-comparator/native-arm64-controls.json`
  (SHA-256
  `67d133c03c2e28221acc0d458e0dc137ee28987ef5c622bec4e93d46a5e663c0`).
  A native arm64 image completed the full corpus; an emulated amd64 image
  completed a one-source numeric-parity check. Neither supplies native-amd64 or
  Railway sizing evidence.
- Disposition: promising comparison baseline, not selected. Complete human
  listening review of the isolated positives and candidate negatives, add
  missing ontology/family controls, calibrate abstention, and produce native-
  amd64 evidence before reconsidering it.
  Keep discovery off and provision no service.
- Source gate: exact Bun 1.3.14 running the literal `test:phase0` command passes 141 worker,
  21 analyzer, 14 Railway-host/migration, 5 separator, 30 discovery, 9 YAMNet,
  19 flags-off browser E2E, and 4 authoritative-Auto E2E tests. Local arm64 and
  emulated amd64 image evidence remain distinct from native-amd64 and Railway
  acceptance.

## instrument-discovery-v1 — contract/client candidate, rollout off — 2026-08-09

- Scope: advisory detection metadata only. No separator model, stem label,
  2/4/6 contract, or role-classifier threshold changed.
- Candidate classifier: `laion/larger_clap_music` revision
  `a0b4534a14f58e20944452dff00a22a06ce629d1`; weight SHA-256
  `5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1`.
- Scoring policy: `pairwise-presence-rand-trunc-v1` is included in the app
  classifier id; the positive/negative prompt policy, synonym aggregation, and
  deterministic non-fusion ten-second crop cannot change under the same claimed
  classifier version. Its outputs remain uncalibrated candidate signals.
- Real-model correction: the first image request exposed that this checkpoint
  has fusion disabled; sending the earlier four-mel fusion input failed with a
  channel-shape error despite successful warmup. The candidate id was advanced
  before deployment, inference now uses the pinned processor's `rand_trunc`
  path, and readiness refuses fusion, sample-rate, crop-mode, or crop-length
  drift.
- Candidate vocabulary: `classroom-instruments-v1`, 51 labels in 10 families;
  content SHA-256
  `72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140`.
- Candidate evaluation mapping: all eleven licensed file sources map their
  corpus terms to reviewed vocabulary ids plus explicit hard negatives. Six
  confusion trials record four currently evidence-backed directions and two
  corpus gaps. A contract test binds the mapping to the exact classifier,
  weight, vocabulary, sample-rate, and corpus terms. The mapping contains no
  model scores and is not ground truth until human listening review.
- Candidate disposition: reject this prompt/checkpoint pairing and keep rollout
  off. The native-arm64 image completed all eleven licensed sources but
  abstained on all 11 and surfaced 0/42 reviewed groups. A networkless
  diagnostic then found the best expected-group pairwise means compressed to
  `0.499894`–`0.500002`; positive-only ranking placed an accepted label in the
  top 12 for only 13/42 groups (mean best rank 25.67 of 51). Lowering thresholds
  cannot repair this result. Any prompt-policy or checkpoint replacement gets
  a new classifier ID and repeats the corpus/human-review gates.
- Replacement comparison: the separately versioned `yamnet-fixed-v1` offline
  comparator completed the same corpus and is recorded above. It ranks far
  better than this rejected CLAP pairing but remains unselected because of
  family failures, ontology gaps, incomplete controls, and absent calibration.
  Essentia remains license-blocked.
- Boundary: the analyzer may send at most three bounded 15-second 22,050 Hz
  mono f32le windows only to loopback or Railway private networking. It sends
  no source URL, storage credential, filename, class code, job id, or volume.
  Shared service tokens reject padding, control characters, and interior
  whitespace at every hop instead of silently normalizing configuration.
- Runtime candidate: a separate standard-library HTTP service now validates
  authenticated f32le bodies and exact cross-service pins, resamples to the
  checkpoint's 48 kHz input, scores each window independently, and aggregates
  only supported mean scores. Its digest-pinned, non-root image recipe freezes
  a 29-package Python lock, downloads the exact model revision during build,
  verifies the content hash of all eight model/processor artifacts, forces
  runtime hub access offline, disables remote code, and explicitly loads the
  pinned pickle checkpoint in weights-only mode.
- Failure behavior: missing configuration, timeout, outage, malformed metadata,
  or pin drift produces a discovery-only unavailable trace. Tests prove those
  cases do not change a valid core Auto decision or its degraded state.
- Visibility: full candidate metadata is persisted privately; student job
  responses remove detections and classifier/vocabulary pins. An
  application-level E2E proves the teacher analysis route rejects the class
  code and signed-out sessions while returning full metadata to a signed-in
  fixture teacher.
- Evidence source: evaluator, mapping, diagnostic, and research-gate files are
  committed at `ccf7f53`; the raw-score report binds the committed
  `score_audit.py` and `clap_backend.py` SHA-256 values. Final executable source
  `e640c72` passes 127 worker tests and 21 analyzer tests, including
  vocabulary integrity, content pins, private-origin/redirect controls,
  bounded window transport, parent abort, malformed responses, non-mutating
  core routing, and candidate evaluation-map integrity. Native GitHub/image
  evidence remains absent; the earlier constrained-image evidence is separately
  bound to `d4c5781`.
- Locally tested: 29 discovery-service contract/process/diagnostic tests cover authentication,
  readiness failure, pin drift, duplicate HTTP framing, rejected expectation
  handshakes, bounded pre-auth connections, slow-header timeout, pre-body
  capacity reservation, bounded PCM, non-finite samples, abstention, two-window
  support, uncertainty, pairwise prompt scoring, independent concurrent
  watchdog generations, a real child-process exit with code 70 without loading
  PyTorch or model weights, evaluator isolation/cleanup, and raw-logit
  diagnostic parity. The 29-package lock resolves and explicitly
  pins the direct Hugging Face build dependency. Model startup additionally
  rejects any directory entry beyond the eight content-pinned artifacts and
  the exact provenance manifest, including symlinks.
- Real-model local smoke: a matching arm64 image ran as uid/gid `65532:65532`
  with networking disabled, a read-only root filesystem, a bounded tmpfs, two
  CPUs, 4 GB RAM, and 128 PIDs. The hardened reusable smoke now also drops all
  Linux capabilities, forbids swap, checks the empty mount surface, and freezes
  the image platform, size, command, and application surface. It returned the
  exact readiness pins and scored a three-second synthetic control in 258–394
  ms; post-warm container-memory observations ranged roughly 405–745 MiB across
  repeated runs. The same current source builds as a 2.11 GB `linux/amd64`
  image, but
  emulated vocabulary warmup crossed its configured health window; that is a
  deployment risk signal, not native performance evidence.
- Native CI definition: a path-scoped, read-only-permission workflow now builds
  the exact `linux/amd64` source and reuses the hardened smoke with a 2.15 GiB
  image ceiling, exact runtime surface/command, no mounts, and explicit
  privilege/resource assertions. It has not run on GitHub and therefore is not
  native-amd64 evidence yet.
- Not yet proven: native amd64 startup/inference, container/Railway restart and
  readiness recovery after a real PyTorch inference outlives its client
  timeout, calibration, human-verified truth labels, metrics, a dedicated
  discovery-review UI, listening review, production resource/cost measurement,
  a successful native image CI run, or any Railway service.
- Rollout: off. No Railway variable, service, or deployment change.

## autosplit-role-v3 — candidate, rollout off — 2026-08-09

- Base: `autosplit-role-v2`; no separator model, stem contract, or provider pin
  changed.
- Change: raise the evidence threshold for a six-track recommendation from 0.8
  to 1.0 pitched attacks per second. This prevents harmonic synthesizer attacks
  from being treated as sufficient evidence for useful guitar/piano channels.
- Corpus change: add two more arrangements from the original MT-32 album and
  one independently authored CC0 house/electro control. Authorized local audio
  is gitignored and verified against recorded Archive hashes where available.
- Local FFmpeg 8.1.2 result: 8/11 preferred, 3/11 accepted alternatives, 0/11
  rejected.
- Real-browser comparison: Headless Chrome 151 and the FFmpeg service path
  agreed on all 11 routing choices after independently decoding the source
  MP3s. Individual feature values were close but not identical. The executable
  gate is `npm run eval:auto:browser`.
- Compatibility pin: the app rejects analyzer and browser summaries whose
  role-classifier version differs from the compiled `autosplit-role-v3` pin;
  a separately deployed service cannot silently change paid routing.
- Import-version boundary: the Railway configuration plane now holds an exact
  schema-checked `milwrite/yt-audio` version while the old deployment remains
  active. Local runtime and readiness code reject descriptive, floating, or
  whitespace-padded YouTube version strings; only a 64-hex Replicate version
  id enables the fallback. This is staged configuration, not live activation.
- Browser memory policy: authoritative mode sends the stored source directly
  to server analysis without a redundant Web Audio decode. Browser-only and
  shadow modes preflight metadata and skip sources over 5 minutes or 24 MiB;
  the standalone parity evaluator intentionally bypasses that production cap.
- Analyzer transport policy: the app accepts HTTPS plus loopback/private
  Railway HTTP origins only, validates a minimum-length bearer token, rejects
  URL credentials/path/query/fragment, uses Workerd-compatible manual redirect
  handling without following any 3xx, and caps streamed JSON at 64 KiB.
- Import transport hardening: commits `c367e23` and `fe112ef` apply a single
  wall-clock budget across Archive retry/redirect/header/body work and across
  Replicate prediction start/body, polling, and output header/body work.
  Innertube session, client lookup, and audio download share their own bounded
  outer deadline. Arbitrary provider stream and playability errors are
  normalized to fixed local messages rather than reflected. These changes do
  not alter a classifier, separator, stem name, or 2/4/6 routing contract.
- Innertube transport follow-up: exact commit `fce98cf` restricts the library's
  injected fetch to reviewed `www.youtube.com` session/player paths, the exact
  `youtubei.googleapis.com/youtubei/*` alternate, and
  `*.googlevideo.com/videoplayback`. It manually validates at most three
  redirects, strips bearer/cookie/proxy and Google/YouTube identity headers
  across origins, and caps internally parsed session/player bodies at 16 MiB
  while retaining the 100 MB streamed-audio cap and shared 45-second deadline.
  Six focused regressions and a read-only 19-second/309,288-byte live control
  pass; this does not establish Railway or musical-routing acceptance.
- Railway host gate: exact commit `821f5e1` pins the active Node/Railpack host
  and CI to Node 22.23.1, adds a dedicated host/shared-source typecheck, prevents
  interleaved SQLite batches, and makes prompt update, winning-request guide
  invalidation, and exact revision history one transaction. This changes no
  classifier, separator, stem name, or 2/4/6 routing contract.
- Decoder build policy: FFmpeg explicitly disables unused codec and format
  component families, then enables only the required audio
  demuxers/decoders/parsers, `aresample`, f32le output, and local file/pipe
  protocols; network support remains disabled. The final runtime ships only a
  Bun-bundled application artifact plus `ffmpeg` and `ffprobe`, not development
  files or the root project's unused dependency tree.
- Pinned image result: a local emulated `linux/amd64` build on FFmpeg 8.0.3
  passed readiness/auth, the runtime allowlist, eight audio format/codec
  variants, and the full corpus at 8 preferred, 3 accepted alternatives, and 0
  rejected.
- Evidence: `docs/evaluation/autosplit-role-v3-candidate.md`. Committed source
  `d4c5781` passes the complete source gate: 105 worker,
  21 analyzer, 5 server/migration, 5 separator, 24 discovery, 19 browser E2E,
  and 4 authoritative Auto E2E tests.
- Post-baseline evidence: exact source `fe112ef` passes focused import
  regressions and the complete command set behind `test:phase0`: 121 worker, 21
  analyzer, 5 server/migration, 5 separator, 29 discovery, 19 browser E2E, and
  4 authoritative Auto E2E tests. The verification shell lacked the pinned Bun
  executable, so the underlying scripts ran directly through Node/npm/npx/uv.
  This superseded `d4c5781` as the local source gate, but not as constrained
  image evidence; later exact-Bun evidence supersedes it again.
- Final executable-source evidence: exact commit `4a3fbf1` passes
  `bun@1.3.14 install --frozen-lockfile` with no changes and the literal
  `test:phase0`: app, Railway-host/shared, and analyzer typechecks; 127 worker,
  21 analyzer, 14 server/migration, 5 separator, 29 discovery, 19 browser E2E,
  and 4 authoritative Auto E2E tests. It supersedes `e640c72`, `fe112ef`, and
  `fce98cf` as the complete committed-source gate. The final follow-up makes a
  pre-existing next-revision prompt-history row abort and roll back setting,
  history, and cache mutations instead of silently adopting unrelated audit
  history. These prompt-integrity changes alter no classifier, separator, stem
  name, or 2/4/6 routing contract; the native GitHub/image run remains open.
- Candidate-report provenance hardening committed at exact `1c3af0c` resolves
  an instrument-discovery tag to one immutable Docker image ID, requires
  `linux/amd64`, verifies a dependency-lock SHA derived inside that image
  against the repository lock, and version-bumps both threshold and raw-score
  report schemas. The reports also bind every evaluation/diagnostic source that
  shapes their results. This does not make the rejected historical CLAP JSON
  promotion evidence and changes no classifier, threshold, routing choice, or
  stem contract.
- Constrained image evidence: both the existing emulated amd64 image and the
  current native arm64 build passed the reusable internal-network smoke with a
  read-only root, no analyzer mounts, 1 vCPU, 1 GiB RAM, real short and
  15-minute audio, malformed/oversized/slow/overlapping requests, cleanup, and
  log-redaction checks. Final sampled memory was 253.4 MiB under emulation and
  59.81 MiB natively; neither value is a peak or Railway sizing result.
- Known risks: the observed synth boundary is narrow, only one corpus source
  selects six, manual stem listening is incomplete, and native CI/Railway
  resource behavior has not run this version.
- Image status: local emulated amd64 and native arm64 gates pass. Native amd64
  CI, Railway sizing/restart/ephemeral-disk evidence, listening, and rollback
  gates remain before shadow.
- Rollout: off. No Railway variable, service, or deployment change.

## autosplit-role-v2 — superseded local candidate, rollout off — 2026-08-09

- Base: `autosplit-role-v1`; no separator model, stem contract, or provider pin
  changed.
- Decoder contract: FFmpeg 8.0.3, 22,050 Hz mono, at most 45 seconds across
  beginning/middle/end windows.
- Change: add a conjunctive diffuse-rhythm cue requiring modest onset activity,
  sustained low energy, and broadband percussive energy. This keeps a live
  reeds+bass+drums ensemble out of the two-track route without treating low
  orchestral sustain as percussion.
- Preprocessing: normalize browser analysis to 22,050 Hz with bounded
  anti-aliased downsampling. Linear interpolation alone folded above-Nyquist
  energy into the pitch/percussion bands.
- Evidence required before shadow: deterministic PCM parity, all unit and
  flags-off tests, eight-source authorized corpus, pinned-container build, and
  browser/service real-audio comparison.
- Rollout: off. No Railway variable or deployment change.
- Local authorized-corpus result with FFmpeg 8.1.2: 4/8 preferred, 3/8 accepted
  alternatives, 1/8 rejected. Evidence:
  `docs/evaluation/autosplit-role-v2-candidate.md`.
- Known risks: spoken-word or noisy field recordings could satisfy the new cue;
  synthwave still routes to six because harmonic programmed attacks resemble
  evidence for guitar/piano-trained channels. This failure prompted the
  additional electronic controls evaluated in v3; six was never redefined as
  acceptable for the failing source.
- Image status: a v1 arm64 image built and passed readiness/auth smoke, but that
  image predates v2 and v3.

## autosplit-role-v1 — baseline, superseded locally — 2026-08-09

- Decoder used for exploratory corpus baseline: local FFmpeg 8.1.2. Target
  service pin remains FFmpeg 8.0.3.
- Six of eight reviewed genre cases landed in the current accepted 2/4/6
  ranges (3 preferred, 3 accepted alternatives).
- Known regressions: `jazz-sax` chose two tracks even though audible bass and
  drums require four; `synthwave` chose six even though harmonic synth attacks
  do not establish useful guitar/piano channels.
- Evidence: `docs/evaluation/autosplit-role-v1-baseline.md`.
- Rollout: browser-only historical behavior; server authority remained off.
