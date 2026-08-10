# Model-processing changelog

This log tracks classifier and audio-processing changes independently from the
teacher system-prompt changelog. A release entry records exact pins, evaluation
evidence, rollout stage, and known regressions. Entries do not authorize live
promotion on their own.

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
  isolation rollout stage while forcing existing rows into `shadow`.
  Railway boot checks both columns additively on every persistent-volume start.
- Local gate: exact Bun 1.3.14 passes all three typechecks plus 152 worker, 22
  analyzer, 21 Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, 19
  flags-off browser, 4 authoritative-Auto browser, and 1 isolation-shadow E2E
  test. Native-arm64 image
  `sha256:e2ebd8c3d2452ccd34be371ab9222a8a3f9408faaaf4e7cd7d306bbf45e6838f`
  also passes the constrained smoke, including analyze/fingerprint hash parity.
  Native-amd64 CI and Railway acceptance must still repeat the image gate.
- Source gate: exact implementation commit `10f6b0a` contains the source that
  passed that literal `test:phase0` command. It is local only: no remote branch,
  pull request, Railway variable, service, migration, or deployment contains
  this version yet.
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
- Candidate-report provenance hardening in the current worktree resolves an
  instrument-discovery tag to one immutable Docker image ID, requires
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
