# Audio analysis service

Private Railway CPU service for server-side Auto routing. It does not separate
audio and never creates instrument-named stems. It downloads one short-lived,
allowlisted source URL into ephemeral storage, decodes at most 45 seconds across
the beginning, middle, and end, and runs the same `public/autosplit.js` role
classifier used in the browser.

The app remains usable if this service is absent. Keep `SERVER_AUTO_ENABLED`
false until the deterministic parity manifest and live Railway shadow gate pass.

## Required configuration

- `AUDIO_ANALYSIS_TOKEN`: private bearer token, at least 32 non-whitespace
  characters.
- `AUDIO_ANALYSIS_SOURCE_ORIGINS`: comma-separated exact HTTPS origins the
  analyzer may fetch, normally only the active `stem-splitter` Railway origin.

Optional bounded settings are `AUDIO_ANALYSIS_MAX_CONCURRENCY` (1–4, default
1), `AUDIO_ANALYSIS_MAX_SOURCE_BYTES` (maximum 100 MiB),
`AUDIO_ANALYSIS_MAX_SOURCE_SECONDS` (maximum 900),
`AUDIO_ANALYSIS_FETCH_TIMEOUT_MS`, and `AUDIO_ANALYSIS_DECODER_TIMEOUT_MS`.
Without discovery, the two core phase timeouts may total at most 28 seconds.
Once discovery is configured, all three timeouts together must remain at or
below 28 seconds; an over-budget discovery configuration stays fail-lazy and
is reported as invalid without taking down core analysis. Keep the app's
`AUDIO_ANALYSIS_TIMEOUT_MS` above that total plus network/classifier overhead,
without exceeding the app's 30-second cap.
`AUDIO_ANALYSIS_ALLOW_HTTP=true` exists only for isolated local tests.

Instrument discovery is an optional second private-service hop. It stays
fail-lazy even when partly or incorrectly configured:

- `INSTRUMENT_DISCOVERY_URL`: loopback or the root origin of a
  `*.railway.internal` service only;
- `INSTRUMENT_DISCOVERY_TOKEN`: a separate bearer token of at least 32 safe
  characters;
- `INSTRUMENT_DISCOVERY_TIMEOUT_MS`: 1,000–20,000 ms, default 12,000.

The recommended Phase 2 budget is 5,000 ms fetch + 8,000 ms decode + 12,000 ms
discovery, with the app's outer timeout set to 30,000 ms. That leaves discovery
time to fail on its own boundary and return the already-computed core decision.

The analyzer sends only its bounded 22,050 Hz mono f32le windows—not the
source URL, filename, class code, job id, or storage credential. Discovery is
called only when the app's separately compiled false-default flag requests it.
Its success or failure cannot change the role classifier's core decision.

`GET /healthz` proves the process is alive. `GET /readyz` returns 200 only when
configuration, the exact FFmpeg/ffprobe pin, and the role classifier are usable;
it also reports the compiled `analysis-source-scope-v2` contract. That scope
accepts only the app's canonical three-segment `uploads/<id>/<file>` keys and
immutable `auto-inputs/v1/<job>` snapshots. Auto snapshots are valid only for
`sourceType: "upload"`. Stems, isolation inputs/outputs, arbitrary app paths,
extra path segments, and noncanonical encodings fail before any fetch.
`POST /v1/analyze` and `POST /v1/fingerprint` require the bearer token. Both
stream the same allowlisted stored bytes through the same byte, time,
concurrency, and cleanup boundary. The fingerprint route skips decode and
returns only a versioned lowercase SHA-256 plus byte count. The app persists
the digest privately; student payloads and service logs never contain the
digest, source URL, token, audio, or raw PCM.

## Local verification

Start the Railway-shaped Node app, the host analyzer, and the pinned candidate
discovery service together on loopback:

```sh
npm run dev:auto
```

Add `-- --with-separator` to complete local stem jobs through Audio Separator,
or `-- --without-discovery` to exercise only core Auto without Docker. The
runner generates ephemeral service tokens, disables cloud-provider credentials,
publishes the offline discovery image to loopback only, and runs it as a
foreground `--rm` child so terminal shutdown removes the container. The image
proves the private PCM transport and response contract only: its CLAP
prompt/checkpoint pairing is still rejected for musical usefulness and must not
be presented as calibrated instrument detection.

With the stack running, exercise the real app upload and signed-source path.
Add `--wait-for-stems` only when the stack was started with the local separator:

```sh
npm run smoke:auto:local -- tests/fixtures/audio/source.wav
npm run smoke:auto:local -- tests/fixtures/audio/source.wav --wait-for-stems
```

For a completed local job, rank long-tail instrument candidates from its
separated `other` (or two-track `instrumental`) stem with the pinned, offline
YAMNet comparison image:

```sh
npm run inspect:instruments:local -- <completed-job-id>
```

This post-separation view reduces masking from vocals and drums, but it remains
explicitly threshold-free comparison evidence. It does not write detections to
the job, alter Auto, rename a stem, or promote YAMNet.

```sh
npm run typecheck:analysis
npm run test:analysis-service
npm run test:instrument-discovery
npm run eval:auto
npm run eval:auto:browser
```

The two corpus evaluators require the authorized gitignored audio to be
hydrated. The browser evaluator independently decodes each MP3 in Chrome and
FFmpeg and exits nonzero on routing disagreement or a reviewed rejection.

The container must be built from the repository root:

```sh
docker build -f audio-analysis/Dockerfile -t stem-splitter-audio-analysis:local .
npm run smoke:audio-analysis:image -- stem-splitter-audio-analysis:local
```

The smoke uses an internal-only fixture network and gives the analyzer no bind
mounts. It verifies the image/runtime allowlist and limits, readiness/auth,
source-fingerprint parity, authoritative-snapshot scope, short and
maximum-duration decoding, malformed media, declared and streamed size
enforcement, source-fetch timeout, concurrency rejection, temporary-file
cleanup, and log redaction. A passing local run is not native amd64 CI or
Railway resource evidence.

The staged private-service topology, variables, resource caps, verification,
and rollback order are in
[`docs/railway-audio-analysis-provisioning.md`](../docs/railway-audio-analysis-provisioning.md).

Do not provision or enable the Railway service until the Phase 0 fixtures,
current-image smoke, and Phase 1A parity gates in `TODO.md` are complete. The
CI runs the same constrained-image smoke on native amd64. It does not replace
the private Railway restart/resource/ephemeral-disk or real-audio shadow checks.
