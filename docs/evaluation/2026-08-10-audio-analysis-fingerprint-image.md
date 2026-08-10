# Audio-analysis fingerprint image gate — 2026-08-10

## Scope and identity

This is local native-arm64 container evidence for the fingerprint-capable
audio-analysis service. It is not native-amd64 CI, a registry artifact, a
Railway deployment, or permission to enable a rollout flag.

| Field | Exact value |
|---|---|
| Executable source commit | `10f6b0a` |
| Documentation head at build time | `6f88365` |
| Local image tag | `stem-splitter-audio-analysis:v3.2-shadow-10f6b0a-arm64` |
| Local image ID | `sha256:e2ebd8c3d2452ccd34be371ab9222a8a3f9408faaaf4e7cd7d306bbf45e6838f` |
| Platform | `linux/arm64` |
| Image size | `250948341` bytes |
| Runtime user | `node` |
| Runtime command | `node --max-old-space-size=256 dist/server.mjs` |
| FFmpeg | `8.0.3` |
| Role classifier | `autosplit-role-v3` |

The Docker COPY inputs and smoke script at documentation head `6f88365` are
identical to executable source commit `10f6b0a`; `git diff --quiet` returned
zero for that bounded path set.

## Commands and result

```sh
docker build --platform linux/arm64 --provenance=false \
  -f audio-analysis/Dockerfile \
  -t stem-splitter-audio-analysis:v3.2-shadow-10f6b0a-arm64 .

AUDIO_ANALYSIS_EXPECTED_PLATFORM=linux/arm64 \
  npm run smoke:audio-analysis:image -- \
  stem-splitter-audio-analysis:v3.2-shadow-10f6b0a-arm64
```

The smoke exited zero and returned:

```json
{"status":"passed","ffmpegVersion":"8.0.3","classifierVersion":"autosplit-role-v3","sourceFingerprint":"verified","maximumAnalyzedSeconds":45,"malformed":"rejected","declaredOversize":"rejected","streamedOversize":"rejected","fetchTimeout":"bounded","concurrency":"bounded","temporarySources":"clean"}
```

The final bounded runtime sample was `0.22%` CPU, `61.68 MiB / 1 GiB`, and 11
PIDs. This sample proves only that the constrained run stayed inside its caps;
it is not a peak-resource measurement or a Railway sizing result.

The smoke also proved:

- non-root execution, a read-only root filesystem, dropped capabilities, no
  analyzer mounts, bounded tmpfs, 1 vCPU, 1 GiB RAM, and 64 PIDs;
- an internal-only fixture network and an exact file/pipe protocol allowlist;
- only the six advertised audio demuxers and no video/subtitle decoder;
- authenticated `/v1/analyze` and `/v1/fingerprint` boundaries;
- identical SHA-256 and byte count from full analysis and fingerprint-only
  fetches of the same stored source;
- health/readiness pins, maximum-duration decode, malformed input rejection,
  declared and streamed oversize rejection, fetch timeout, overlap rejection,
  temporary-source cleanup, and token/signed-URL log redaction.

## Bound source hashes

| Source | SHA-256 |
|---|---|
| `audio-analysis/Dockerfile` | `7b4d595b2dae8b17f486d0ab4d9b89bef4390f5e1d366a46aadbb51de04c672d` |
| `audio-analysis/app.ts` | `8417377fbc947e691053562501a0f3bb35cfbbcaacb90ae820fe82e9904a0a95` |
| `audio-analysis/request.ts` | `294f154a139a545176802541b013a1f716b2869c43980f9fd7c2ce88f32f24fa` |
| `audio-analysis/source.ts` | `66e17a5210e7dd83d650efef135515e758806ca330cbbff1a03121813986b77b` |
| `src/analysis/types.ts` | `b2e173bc2caa7b9c3d733db3a419dac4c21ca1d4a61bfcd667aa3e846b897f45` |
| `public/autosplit.js` | `5081d90712d7560734abf789265ddabe07e5d750e93500418084987e098339dd` |
| `scripts/smoke-audio-analysis-image.sh` | `39a71baa77e42dae64c24b396c868454b3108206dcfb88f45fb2d0be24a62e49` |
| `bun.lock` | `9f847ce879c211b0f5986aed5977a868ad8aa75d2af13830a033a08c9dbda571` |

## Remaining promotion boundary

Reproduce this source on a native-amd64 GitHub runner and then on Railway.
Record the immutable amd64 image identity, constrained smoke, deployment
`SUCCESS`, private-network readiness, restart behavior, peak CPU/RAM/PIDs and
ephemeral-disk use, plus an authorized upload/YouTube/Archive shadow journey.
Until those checks pass, keep `SERVER_AUTO_ENABLED=false`,
`INSTRUMENT_DISCOVERY_ENABLED=false`, and `QUERY_ISOLATION_ENABLED=false` live.
