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
- [ ] Load the exact CLAP revision and verify all eight model/processor artifacts
  during image build and startup; run offline and non-root. Pickled weights are
  loaded with explicit `weights_only=True` and remote code disabled. The image
  and offline-only code are implemented; the large build and real-model startup
  proof remain open.
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
- [ ] Implement Essentia ONNX as an offline-only comparison after written
  licence review; use the identical windows and manifest.
- [ ] Build and smoke the current image on amd64.
- [ ] Exercise a deliberately stuck real-model inference in the built container
  and prove the Railway restart path recovers capacity and readiness after the
  analyzer abandons its timed-out request.
- [ ] Provision a private Railway service with no domain or volume, explicit
  resource limits, and all application flags false.
- [ ] Promote `off -> teacher shadow` only after the audit and rollback plan are
  accepted. Student visibility and routing remain off.
