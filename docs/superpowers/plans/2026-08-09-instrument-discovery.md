# Instrument discovery implementation plan — v3.2 Phase 2

## Contract first

- [x] Freeze classifier, weight, vocabulary content, PCM, and response-schema pins in
  shared types.
- [x] Add strict response validation for complete and unavailable discovery.
- [x] Extend detections with `possible|uncertain` and window support.
- [x] Prove malformed labels and discovery drift cannot alter the core model or
  append/rename a core stem.
- [x] Redact discovery labels and private pins from student job responses.
- [x] Add and exercise a teacher-authenticated analysis read endpoint. The E2E
  gate proves class-code and signed-out denial, full signed-in metadata
  readback, and redacted student job responses.

## Private discovery service

- [x] Add the candidate vocabulary and a content-hash/schema test. Teacher
  review and calibration remain promotion gates.
- [x] Accept only authenticated, bounded f32le PCM with explicit sample/window
  headers; reject URLs, redirects, multipart input, and excess bytes.
- [x] Load the exact CLAP revision and verify all eight model/processor artifacts
  during image build and startup; run offline and non-root. Pickled weights are
  loaded with explicit `weights_only=True` and remote code disabled. A matching
  native arm64 image passed the network-disabled, read-only smoke and real-model
  control inference. Native amd64 and Railway remain separate gates below.
- [x] Score windows independently and aggregate with family thresholds,
  support, uncertainty, and output caps.
- [x] Keep health process-only and readiness model/vocabulary-specific.
- [x] Log versions, timings, counts, and state only—never PCM, prompts,
  embeddings, filenames, URLs, or credentials.

## Analyzer integration

- [x] Add fail-lazy private URL/token/timeout configuration.
- [x] Split decoded material into at most three 15-second discovery windows
  without changing role-classifier PCM.
- [x] Bound request and response bytes, reject redirects and version drift, and
  use an independent timeout.
- [x] Merge advisory results without changing the role decision or degraded
  state; discovery failure gets its own trace.
- [x] Include value-free discovery configuration in readiness and logs.

## Evaluation and rollout

- [x] Add deterministic aggregation, malformed-contract, duplicate-header,
  rejected `Expect: 100-continue`, non-finite-PCM, bounded connection/body
  capacity, slow-header timeout, and model-warmup failure tests.
- [x] Add an independently tracked, process-fatal watchdog for every permitted
  concurrent inference. Prove a fast second call cannot disarm a stuck first
  call and prove the production fatal path exits a child process with code 70.
- [ ] Extend the authorized corpus with reviewed instrument truth and explicit
  unknowns; do not manufacture negatives from missing annotations.
- [ ] Run CLAP on the fixed corpus and record per-label/per-genre metrics,
  confusion pairs, abstention, latency, and memory.
- [ ] Compare one- versus two-alias labels and negative-prompt controls so the
  max-over-synonyms policy cannot silently reward labels with more prompts.
- [ ] Decide how parent categories, child instruments, and non-instrument
  production/timbre labels are reviewed and displayed without double-counting.
- [ ] Implement Essentia ONNX as an offline-only comparison after written
  licence review; use the identical windows and manifest.
- [x] Define a path-scoped native-amd64 workflow that builds the exact current
  image and reuses the offline, read-only real-model smoke under explicit
  platform, size, resource, privilege, mount, authentication, and inference
  checks. It remains local-only until a GitHub run succeeds.
- [ ] Smoke the current image on native amd64. The 2.11 GB `linux/amd64` target
  builds locally and matches the current source hashes, but emulated startup
  crossed the image health window and cannot close this gate.
- [ ] Either retain the content-pinned weights-only pickle with an accepted
  risk record or produce a tensor-equivalent safetensors artifact under a new
  hash and classifier id; rerun every model and corpus gate after conversion.
- [ ] Exercise a deliberately stuck real-model inference in the built container
  and prove the Railway restart path recovers capacity and readiness after the
  analyzer abandons its timed-out request.
- [ ] Provision a private Railway service with no domain or volume, explicit
  resource limits, and all application flags false.
- [ ] Promote `off -> teacher shadow` only after the audit and rollback plan are
  accepted. Student visibility and routing remain off.
