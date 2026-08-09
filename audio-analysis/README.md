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
configuration, the exact FFmpeg/ffprobe pin, and the role classifier are usable.
`POST /v1/analyze` requires the bearer token. Responses and logs never contain
the source URL, token, audio, or raw PCM.

## Local verification

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
docker build -f audio-analysis/Dockerfile .
```

The staged private-service topology, variables, resource caps, verification,
and rollback order are in
[`docs/railway-audio-analysis-provisioning.md`](../docs/railway-audio-analysis-provisioning.md).

Do not provision or enable the Railway service until the Phase 0 fixtures,
current-image smoke, and Phase 1A parity gates in `TODO.md` are complete. The
CI image job validates FFmpeg/classifier readiness and the authentication
boundary; it does not replace the private Railway resource-limit or real-audio
shadow checks.
