# Model-processing changelog

This log tracks classifier and audio-processing changes independently from the
teacher system-prompt changelog. A release entry records exact pins, evaluation
evidence, rollout stage, and known regressions. Entries do not authorize live
promotion on their own.

## instrument-discovery-v1 — contract/client candidate, rollout off — 2026-08-09

- Scope: advisory detection metadata only. No separator model, stem label,
  2/4/6 contract, or role-classifier threshold changed.
- Candidate classifier: `laion/larger_clap_music` revision
  `a0b4534a14f58e20944452dff00a22a06ce629d1`; weight SHA-256
  `5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1`.
- Scoring policy: `pairwise-presence-v1` is included in the app classifier id;
  the positive/negative prompt policy and synonym aggregation cannot change
  under the same claimed classifier version. Its outputs remain uncalibrated
  candidate signals.
- Candidate vocabulary: `classroom-instruments-v1`, 51 labels in 10 families;
  content SHA-256
  `72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140`.
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
- Evidence: 80 worker tests and 21 analyzer tests pass locally, including
  vocabulary integrity, content pins, private-origin/redirect controls,
  bounded window transport, parent abort, malformed responses, and non-mutating
  core routing.
- Locally tested: 22 discovery-service contract/process tests cover authentication,
  readiness failure, pin drift, duplicate HTTP framing, rejected expectation
  handshakes, bounded pre-auth connections, slow-header timeout, pre-body
  capacity reservation, bounded PCM, non-finite samples, abstention, two-window
  support, uncertainty, pairwise prompt scoring, independent concurrent
  watchdog generations, and a real child-process exit with code 70 without
  loading PyTorch or model weights. The 29-package lock resolves and explicitly
  pins the direct Hugging Face build dependency.
- Not yet proven: a complete CLAP image build, real-model inference,
  offline-start readback, container/Railway restart and readiness recovery after
  a real PyTorch inference outlives its client timeout, calibration, authorized
  truth labels, metrics, a dedicated discovery-review UI, listening review,
  resource/cost measurement,
  native image CI, or any Railway service.
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
- Browser memory policy: authoritative mode sends the stored source directly
  to server analysis without a redundant Web Audio decode. Browser-only and
  shadow modes preflight metadata and skip sources over 5 minutes or 24 MiB;
  the standalone parity evaluator intentionally bypasses that production cap.
- Analyzer transport policy: the app accepts HTTPS plus loopback/private
  Railway HTTP origins only, validates a minimum-length bearer token, rejects
  URL credentials/path/query/fragment, uses Workerd-compatible manual redirect
  handling without following any 3xx, and caps streamed JSON at 64 KiB.
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
- Evidence: `docs/evaluation/autosplit-role-v3-candidate.md`.
- Known risks: the observed synth boundary is narrow, only one corpus source
  selects six, manual stem listening is incomplete, and native CI/Railway
  resource behavior has not run this version.
- Image status: local emulated amd64 gates pass. Native CI, Railway sizing,
  concurrency, timeout, listening, and rollback gates remain before shadow.
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
