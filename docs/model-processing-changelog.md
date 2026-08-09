# Model-processing changelog

This log tracks classifier and audio-processing changes independently from the
teacher system-prompt changelog. A release entry records exact pins, evaluation
evidence, rollout stage, and known regressions. Entries do not authorize live
promotion on their own.

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
  protocols; network support remains disabled. The exact allowlist configures,
  compiles, and decodes the real WAV fixture against official FFmpeg 8.0.3
  source on arm64.
- Evidence: `docs/evaluation/autosplit-role-v3-candidate.md`.
- Known risks: the observed synth boundary is narrow, only one corpus source
  selects six, manual stem listening is incomplete, and neither the pinned
  FFmpeg 8.0.3 image nor Railway/amd64 has run this version.
- Image status: the only successful local image smoke used role v1. The v3
  FFmpeg source build now succeeds with the minimized allowlist, but the current
  image must still build and pass readiness, auth, corpus, and resource-limit
  gates before shadow rollout.
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
