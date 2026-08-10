# Railway audio-analysis provisioning and shadow rollout

This runbook describes the separate private CPU service required for
server-side Auto. It is a reviewed plan, not evidence that the service exists.
No step here authorizes a deployment or changes the rule that Railway is the
only live target until the product is finished.

## Preconditions

Do not provision the service until all of these are true:

- the branch is committed and its source, analysis-service, flags-off, and
  authoritative-mock suites pass;
- the current digest-pinned image builds on a native amd64 CI runner, passes its
  runtime decoder allowlist, and reports FFmpeg `8.0.3` plus
  `autosplit-role-v4` and `analysis-source-scope-v2` from `/readyz`;
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
  vCPU, and 1 GB RAM (`1,000,000,000` bytes in Railway's limits readback).
  Treat those CPU/RAM values as initial safety caps, not
  validated sizing: exercise maximum-duration, malformed, and concurrent
  requests while watching Railway metrics before accepting them.
- Keep the Docker `256 MiB` Node heap cap. It complements but does not replace
  the Railway replica memory cap because FFmpeg runs in a child process.
- Use restart-on-failure with exactly three retries. Do not enable
  serverless sleep until cold-start readiness and the app timeout are measured
  together.

Railway private networking is automatic within one project/environment, uses
the service's `*.railway.internal` name, and does not require a public domain.

Phase 2 adds a second private service named `instrument-discovery`, but only
after Phase 1 shadow acceptance. Build it from the repository root with
`build.dockerfilePath=instrument-discovery/Dockerfile`. Give it no domain and
no volume; the exact model snapshot is baked into the image and runtime hub
access is disabled. Start with one replica, one-request concurrency, 2 vCPU,
and 4 GiB RAM. Those are conservative test caps, not accepted sizing. The
776 MB weight file, loaded model, resampling workspace, cold start, and peak
RSS must be measured before any flag changes. Use `/readyz` as its deployment
healthcheck so a missing hash-pinned model cannot be promoted.

Phase 3 does not add another Railway service at the outset. Its first candidate
is a dormant, exact-version AudioSep adapter for the external Replicate API.
Do not stage its version variable or enable its feature while provisioning the
analysis/classifier services. The app now has a separate resource and a
teacher-only shadow route, but shadow rows cannot be claimed and the app has no
provider-start path. Its pre-spend seam re-fingerprints the original into an
app-owned immutable snapshot and the provider contract accepts only that
snapshot URL; this guard does not authorize execution. Semester budgets,
checkpoint provenance, and the quality gate remain open. SAM-Audio remains an
evaluation-only community deployment subject to institutional license and
checkpoint review. Banquet, if later justified, becomes its own scale-to-zero
GPU service and never runs inside either warmed Railway CPU service.

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
| `AUDIO_ANALYSIS_FETCH_TIMEOUT_MS` | `10000` in Phase 1; change to `5000` before Phase 2 shadow |
| `AUDIO_ANALYSIS_DECODER_TIMEOUT_MS` | `10000` in Phase 1; change to `8000` before Phase 2 shadow |
| `INSTRUMENT_DISCOVERY_URL` | leave absent in Phase 1; later `http://${{instrument-discovery.RAILWAY_PRIVATE_DOMAIN}}:${{instrument-discovery.PORT}}` |
| `INSTRUMENT_DISCOVERY_TOKEN` | leave absent in Phase 1; later a distinct sealed shared-variable reference |
| `INSTRUMENT_DISCOVERY_TIMEOUT_MS` | `12000` when the Phase 2 service is staged |

The image already pins `AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION=8.0.3`. Do not
override it in Railway.

### Phase 2 `instrument-discovery` service (do not stage during Phase 1)

| Variable | Initial value/posture |
|---|---|
| `PORT` | `8080` |
| `INSTRUMENT_DISCOVERY_TOKEN` | distinct sealed shared-variable reference shared only with `audio-analysis` |
| `INSTRUMENT_DISCOVERY_MAX_CONCURRENCY` | `1` |
| `INSTRUMENT_DISCOVERY_TORCH_THREADS` | `1` |
| `INSTRUMENT_DISCOVERY_INFERENCE_TIMEOUT_SECONDS` | `30` |

Configure this service's restart policy as `ON_FAILURE` with exactly three
retries and record that accepted limit. The inference watchdog deliberately exits
nonzero, so a `NEVER` policy would turn a bounded model failure into an outage.

Do not override the baked model or vocabulary paths. The image pins Python,
uv, every Python package, the Hugging Face revision, model-weight SHA-256,
prompt/scoring policy, and vocabulary content SHA-256. It downloads the model
only while building and forces Hugging Face and Transformers offline at
runtime.

### `stem-splitter` app service

| Variable | Initial value/posture |
|---|---|
| `AUDIO_ANALYSIS_URL` | `http://${{audio-analysis.RAILWAY_PRIVATE_DOMAIN}}:${{audio-analysis.PORT}}` |
| `AUDIO_ANALYSIS_TOKEN` | the same sealed shared-variable reference |
| `AUDIO_ANALYSIS_TIMEOUT_MS` | `25000` in Phase 1; change to `30000` before Phase 2 shadow |
| `SERVER_AUTO_ENABLED` | `false` |
| `SERVER_AUTO_MODE` | `off` |
| `INSTRUMENT_DISCOVERY_ENABLED` | `false` |
| `QUERY_ISOLATION_ENABLED` | `false` |
| `QUERY_ISOLATION_MODE` | `off` |
| `REPLICATE_AUDIOSEP_VERSION` | leave absent through Phases 1-2; review and stage one exact 64-hex version only with the Phase 3 isolation resource |

The app and analyzer both compile the exact `autosplit-role-v4` pin. A response
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
`/readyz` healthcheck with a 120-second timeout, one replica, and `ON_FAILURE`
with three retries. Railway resource overrides use the separate
`serviceInstanceLimitsUpdate` API: set `vCPUs: 1` and `memoryGB: 1`, then require
`serviceInstanceLimitOverride` to return exactly one CPU and
`1,000,000,000` memory bytes. Read back the complete configuration before
committing the staged change, then deploy the analyzer first with app Auto still
off. Never pass a secret value as a command-line argument; use a sealed shared
variable and stdin.

Run the value-free executable gate against the explicit canonical IDs before
provisioning:

```sh
RAILWAY_CALLER=skill:use-railway@1.3.7 \
RAILWAY_AGENT_SESSION=stem-splitter-audio-analysis-preflight \
node scripts/check-railway-audio-analysis.mjs \
  --phase pre-provision \
  --project f070742b-3375-4cba-9a86-335f39273c88 \
  --environment b3381640-1e2f-4765-8e15-15baec599ec2 \
  --app-service f53a2915-087c-493a-a345-7a1fa73e6588
```

After the analyzer reaches terminal `SUCCESS` with app flags still explicitly
off, repeat with `--phase deployed-off`. The script reads secrets only inside
its process to verify token parity; it emits no values and makes no mutations or
provider calls.

## Verification order

1. Observe a terminal `SUCCESS` for the exact analyzer deployment. A queued or
   building deployment is not success.
2. From inside the app service's private network, read `/healthz` and
   `/readyz`. Require readiness to report FFmpeg `8.0.3` and
   `autosplit-role-v4` plus `analysis-source-scope-v2`.
3. Confirm an unauthenticated `POST /v1/analyze` returns `401`, while the app's
   configured token succeeds only with an app-issued, ten-minute signed source
   URL. Exercise both an exact `uploads/<id>/<file>` key and an immutable
   `auto-inputs/v1/<job>` upload snapshot. Reject an Auto snapshot paired with
   YouTube or Archive source type, any extra path segment, stems, and isolation
   paths. Confirm a redirect response degrades to the four-track fallback and
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

For the later Phase 3 demand-shadow gate, keep provider execution absent. Stage
the reviewed `REPLICATE_AUDIOSEP_VERSION`, read it back without printing any
token, then set `QUERY_ISOLATION_ENABLED=true` and
`QUERY_ISOLATION_MODE=shadow` as one reviewed app release. A signed-in teacher
request must make the analyzer fetch the stored bytes through
`POST /v1/fingerprint`, persist no digest in either teacher or student JSON,
normalize the target, deduplicate repeats, and stop at two targets per job.
Verify the row reports `shadowed`, `attempts=0`, and `providerStarted=false`.
Reject the release if any Replicate prediction is created or any shadow row can
transition to processing. This gate records demand only; it does not approve
the still-unverified hosted AudioSep checkpoint.

For the later Phase 2 gate, deploy `instrument-discovery` before adding its
three analyzer variables and keep `INSTRUMENT_DISCOVERY_ENABLED=false` on the
app throughout. Before any teacher-shadow request, change the analyzer fetch
and decoder timeouts to 5,000 and 8,000 ms and the app timeout to 30,000 ms.
Together with the 12,000 ms discovery timeout, the analyzer's bounded phases
total 25,000 ms, leaving the outer request time to return a discovery-only
failure without discarding the core result. Require `/readyz` to report the
exact classifier, weight, vocabulary version, and vocabulary hash; require
unauthenticated and contract-mismatched PCM requests to fail. Then exercise
one-, two-, and three-window authorized fixtures, a transient-only instrument,
timeout, OOM/resource caps, restart, and analyzer fallback. Deliberately block
one inference and prove exit code 70 causes Railway to restart the service,
readiness stays unavailable during warmup, and the next authorized request
succeeds before a teacher-shadow proposal is reviewed.

## Rollback

The immediate rollback is `SERVER_AUTO_ENABLED=false` on the app, followed by
verified app readback. This returns all production routing to the frozen
explicit/browser behavior without a schema rollback or analysis-service
deletion. Preserve the analyzer deployment and logs for diagnosis unless the
user separately approves removal.

Discovery has its own earlier kill switch: keep or restore
`INSTRUMENT_DISCOVERY_ENABLED=false`. That stops all discovery requests without
changing server Auto, the analyzer, stored core decisions, or 2/4/6 jobs. Do
not combine that rollback with a role-classifier or separator release.

Query isolation has an independent rollback: restore
`QUERY_ISOLATION_ENABLED=false` and verify readback. Historical teacher
readback remains available, but no new shadow request can be created. Do not
delete shadow rows during rollback; they are versioned demand evidence and
cannot execute.

Authoritative mode is not part of initial provisioning. It requires the pinned
image, private-service resource tests, real-audio listening, restart,
outage/timeout, and rollback evidence in `TODO.md`.

Railway references: [Dockerfile paths](https://docs.railway.com/builds/dockerfiles),
[private networking](https://docs.railway.com/networking/private-networking),
[healthchecks](https://docs.railway.com/deployments/healthchecks), and
[replica cost limits](https://docs.railway.com/pricing/cost-control).
