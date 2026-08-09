# Audio analysis service

Private Railway CPU service for server-side Auto routing. It does not separate
audio and never creates instrument-named stems. It downloads one short-lived,
allowlisted source URL into ephemeral storage, decodes at most 45 seconds across
the beginning, middle, and end, and runs the same `public/autosplit.js` role
classifier used in the browser.

The app remains usable if this service is absent. Keep `SERVER_AUTO_ENABLED`
false until the deterministic parity manifest and live Railway shadow gate pass.

## Required configuration

- `AUDIO_ANALYSIS_TOKEN`: private bearer token, at least 32 characters.
- `AUDIO_ANALYSIS_SOURCE_ORIGINS`: comma-separated exact HTTPS origins the
  analyzer may fetch, normally only the active `stem-splitter` Railway origin.

Optional bounded settings are `AUDIO_ANALYSIS_MAX_CONCURRENCY` (1–4, default
1), `AUDIO_ANALYSIS_MAX_SOURCE_BYTES` (maximum 100 MiB),
`AUDIO_ANALYSIS_MAX_SOURCE_SECONDS` (maximum 900),
`AUDIO_ANALYSIS_FETCH_TIMEOUT_MS`, and `AUDIO_ANALYSIS_DECODER_TIMEOUT_MS`.
The two phase timeouts may total at most 28 seconds; keep the app's
`AUDIO_ANALYSIS_TIMEOUT_MS` above their expected total (plus network overhead)
without exceeding the app's 30-second cap.
`AUDIO_ANALYSIS_ALLOW_HTTP=true` exists only for isolated local tests.

`GET /healthz` proves the process is alive. `GET /readyz` returns 200 only when
configuration, the exact FFmpeg/ffprobe pin, and the role classifier are usable.
`POST /v1/analyze` requires the bearer token. Responses and logs never contain
the source URL, token, audio, or raw PCM.

## Local verification

```sh
npm run typecheck:analysis
npm run test:analysis-service
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
