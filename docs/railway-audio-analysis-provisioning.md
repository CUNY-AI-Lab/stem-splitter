# Railway audio-analysis provisioning and shadow rollout

This runbook describes the separate private CPU service required for
server-side Auto. It is a reviewed plan, not evidence that the service exists.
No step here authorizes a deployment or changes the rule that Railway is the
only live target until the product is finished.

## Preconditions

Do not provision the service until all of these are true:

- the branch is committed and its source, analysis-service, flags-off, and
  authoritative-mock suites pass;
- the current digest-pinned image builds on amd64 and reports FFmpeg `8.0.3`
  plus `autosplit-role-v3` from `/readyz`;
- a rollback baseline has recorded one authorized four-track job, output
  hashes, latency, and exact Replicate versions;
- the canonical app service has an exact `REPLICATE_YT_MODEL_VERSION` staged
  as part of the same coordinated release input;
- `SERVER_AUTO_ENABLED`, `INSTRUMENT_DISCOVERY_ENABLED`, and
  `QUERY_ISOLATION_ENABLED` remain false.

Use the canonical project, production environment, and app-service IDs in
`server/CLAUDE.md`. The checkout's current Railway link points to a different,
legacy same-named project, so no name-only command is safe.

## Service topology

Create one service named `audio-analysis` in the same Railway project and
environment as `stem-splitter`.

- Keep the repository root as the build context because the service imports
  `public/autosplit.js` and shared `src/analysis` contracts.
- Configure the service with typed settings `build.builder=DOCKERFILE` and
  `build.dockerfilePath=audio-analysis/Dockerfile`; do not use a
  `RAILWAY_DOCKERFILE_PATH` variable and do not set the service root directory
  to `audio-analysis/`.
- Do not generate a public domain or TCP proxy. The app calls the service over
  `http://audio-analysis.railway.internal:8080`.
- Attach no volume. Every fetched source is private, bounded, temporary, and
  deleted after decode.
- Configure `/readyz` as the deployment healthcheck. `/healthz` is liveness
  only and must not promote a deployment whose decoder or classifier is
  unavailable.
- Start with one replica, a one-request application concurrency limit, one
  vCPU, and 1 GiB RAM. Treat those CPU/RAM values as initial safety caps, not
  validated sizing: exercise maximum-duration, malformed, and concurrent
  requests while watching Railway metrics before accepting them.
- Keep the Docker `256 MiB` Node heap cap. It complements but does not replace
  the Railway replica memory cap because FFmpeg runs in a child process.
- Use restart-on-failure with a small bounded retry count. Do not enable
  serverless sleep until cold-start readiness and the app timeout are measured
  together.

Railway private networking is automatic within one project/environment, uses
the service's `*.railway.internal` name, and does not require a public domain.

## Variables

Create one long random token of at least 32 non-control characters as a sealed
shared variable. Reference it from both services; never copy it into a
committed file or print it during verification.

### `audio-analysis` service

| Variable | Initial value/posture |
|---|---|
| `PORT` | `8080` |
| `AUDIO_ANALYSIS_TOKEN` | sealed shared-variable reference |
| `AUDIO_ANALYSIS_SOURCE_ORIGINS` | exact `https://` public origin of the canonical app only |
| `AUDIO_ANALYSIS_MAX_CONCURRENCY` | `1` |
| `AUDIO_ANALYSIS_MAX_SOURCE_BYTES` | `104857600` |
| `AUDIO_ANALYSIS_MAX_SOURCE_SECONDS` | `900` |
| `AUDIO_ANALYSIS_FETCH_TIMEOUT_MS` | `10000` |
| `AUDIO_ANALYSIS_DECODER_TIMEOUT_MS` | `10000` |

The image already pins `AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION=8.0.3`. Do not
override it in Railway.

### `stem-splitter` app service

| Variable | Initial value/posture |
|---|---|
| `AUDIO_ANALYSIS_URL` | `http://${{audio-analysis.RAILWAY_PRIVATE_DOMAIN}}:${{audio-analysis.PORT}}` |
| `AUDIO_ANALYSIS_TOKEN` | the same sealed shared-variable reference |
| `AUDIO_ANALYSIS_TIMEOUT_MS` | `25000` |
| `SERVER_AUTO_ENABLED` | `false` |
| `SERVER_AUTO_MODE` | `off` |
| `INSTRUMENT_DISCOVERY_ENABLED` | `false` |
| `QUERY_ISOLATION_ENABLED` | `false` |

The app and analyzer both compile the exact `autosplit-role-v3` pin. A response
from any other role-classifier version fails the analysis contract and takes
the explicit four-track fallback; changing a Railway variable cannot bypass
that compatibility gate.

The app accepts analyzer HTTP only for loopback or a `*.railway.internal`
origin; every other analyzer origin must use HTTPS. It rejects embedded URL
credentials, non-root paths, queries, fragments, and redirects before any
redirect target can receive the bearer token or a signed source URL.

Railway variable edits trigger a redeployment by default; they are not
implicitly staged. When this runbook is authorized for execution, scope every
command with the canonical project, environment, and service IDs and use
`railway variable set --skip-deploys` while assembling each reviewed variable
batch. Use `railway environment edit ... --stage` for the typed Dockerfile,
healthcheck, replica, and restart-policy configuration. Read back the complete
configuration before committing the staged change, then deploy the analyzer
first with app Auto still off. Never pass a secret value as a command-line
argument; use a sealed shared variable and stdin.

## Verification order

1. Observe a terminal `SUCCESS` for the exact analyzer deployment. A queued or
   building deployment is not success.
2. From inside the app service's private network, read `/healthz` and
   `/readyz`. Require readiness to report FFmpeg `8.0.3` and
   `autosplit-role-v3`.
3. Confirm an unauthenticated `POST /v1/analyze` returns `401`, while the app's
   configured token succeeds only with an app-issued, ten-minute signed source
   URL. Confirm a redirect response degrades to the four-track fallback and
   receives no followed request carrying the bearer token.
4. Exercise malformed media, declared and streamed size limits, maximum source
   duration, analyzer timeout, and two overlapping requests. Confirm one job
   runs, excess concurrency receives `503` plus `Retry-After`, temporary files
   disappear, and CPU/RAM stay within the chosen replica caps.
5. Enable `SERVER_AUTO_ENABLED=true` with `SERVER_AUTO_MODE=shadow` only. For
   uploads, the existing browser choice still controls paid separation; remote
   sources retain the default while analyzer results are recorded for review.
6. Run authorized upload, YouTube, and Internet Archive journeys. Prove the
   analyzer can fetch stored bytes before the separator call, decisions and
   versions persist, and outage/timeout still complete the four-track job.
7. Repeat the eleven-source manifest and listening checklist by genre. Keep
   raw feature diagnostics local and do not store source URLs or signatures.
8. Restart both Railway services and repeat readiness plus one shadow job.

## Rollback

The immediate rollback is `SERVER_AUTO_ENABLED=false` on the app, followed by
verified app readback. This returns all production routing to the frozen
explicit/browser behavior without a schema rollback or analysis-service
deletion. Preserve the analyzer deployment and logs for diagnosis unless the
user separately approves removal.

Authoritative mode is not part of initial provisioning. It requires the pinned
image, private-service resource tests, real-audio listening, restart,
outage/timeout, and rollback evidence in `TODO.md`.

Railway references: [Dockerfile paths](https://docs.railway.com/builds/dockerfiles),
[private networking](https://docs.railway.com/networking/private-networking),
[healthchecks](https://docs.railway.com/deployments/healthchecks), and
[replica cost limits](https://docs.railway.com/pricing/cost-control).
