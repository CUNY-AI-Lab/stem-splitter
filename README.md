# Stem Splitter

A stem-separation web app for music students. Upload a song — or paste a
YouTube link, or pull an openly licensed track from the Internet Archive —
and get back isolated stems as MP3s (2-stem vocals / instrumental, 4-stem
adding drums / bass / other, or 6-stem adding guitar + piano), played in a
synchronized in-browser mixer with per-stem mute, shared renameable channel
labels, shared timestamped notes, and **Listening Guy**: the Listening Guide,
an AI listening companion that writes a per-song listening guide and answers
questions in a chat that can drive the mixer itself (solo/mute channels, jump
the playhead, pin notes for the class).

Created as part of the **Critical AI Literacy T(h)inkering track** by
Ethnomusicology Professor **Agustina Checa**.

**How it works:** Browser → Node host with a persistent upload volume and
SQLite job state → a GPU provider (Replicate, pinned Demucs) or a local
separator runs the split → webhook/polling marks the job done → the student
streams synchronized MP3 parts → the host enforces 30-day retention. The
Listening Guide runs on OpenRouter (`z-ai/glm-5.2` by default) behind
class-code-gated endpoints; guides are generated once per song and cached
class-wide.

- **~$0.045/song** on Replicate, scales to zero when idle (no GPU to manage).
- The separation provider lives behind one interface
  (`src/separation/types.ts`) — swap in Modal/RunPod/self-hosted Demucs later
  by implementing it and flipping `SEPARATION_BACKEND`.
- Fixed-length uploads stream into the mounted volume through the shared app.
- The Listening Guide is provider-light too: plain `fetch` to OpenRouter,
  model set by the `ASSISTANT_MODEL` var — swap to any cheap tool-calling
  model with a var change and a redeploy. If the provider is down or
  unconfigured, students see a friendly notice and the mixer keeps working.

```
src/
  index.ts              Shared Hono app: uploads, jobs, webhook, labels/annotations,
                        listening-guy guide+chat, file serving
  env.ts                Bindings/vars/secrets types
  r2.ts                 Signed URLs + local retention enforcement
  youtube.ts            YouTube audio fetch (youtubei.js + Replicate yt-dlp fallback)
  archive.ts            Internet Archive crate: licence-floored search + import
  assistant/            Listening Guy: OpenRouter client, mixer tool schemas,
                        system prompt (prompt.ts), guide/chat orchestrators
  separation/
    types.ts            SeparationBackend interface (the swappable seam)
    replicate.ts        Replicate-hosted Demucs implementation
    modal.ts            Stub for a self-deployed Modal backend
  isolation/            Dormant target-isolation contracts, additive resource state,
                        and exact-pin AudioSep adapter; never part of core stems
server/                 Active Node host (SQLite/filesystem binding shims)
audio-analysis/         Private bounded Auto analyzer (separate image)
public/                 Static frontend (vanilla JS mixer + Listening Guide panel)
migrations/             Additive migrations (schema.sql = fresh install)
scripts/smoke.sh        Smoke checks against an explicitly selected deployment
replicate-yt-audio/     Replicate-hosted yt-dlp model (YouTube fetch fallback)
docs/superpowers/       Per-feature design specs + implementation plans
schema.sql              Shared fresh-install relational schema
```

## Hosting

The app runs as a Node host on Railway: `server/index.ts` (Node, `tsx`),
`node:sqlite` plus a volume at `/data` for audio, hourly retention cleanup in
app code, deployed with `railway up --detach -m "<summary>"`.

The canonical Railway target is service
`f53a2915-087c-493a-a345-7a1fa73e6588`, production environment
`b3381640-1e2f-4765-8e15-15baec599ec2`, project
`f070742b-3375-4cba-9a86-335f39273c88`. Two Railway projects share the
`stem-splitter` name, so verify these IDs and use the explicit-ID commands in
`server/CLAUDE.md` before any write or deployment.

`server/` adapts *to* `src/` through small storage and database shims and
never requires a change to it — shared application behavior stays in `src/`.
Reach for the hosted deployment when you want a **publicly reachable
origin**: the separation provider has to fetch the signed source URL and post
a webhook back, and localhost can satisfy neither, so the hosted app is the
only way to exercise that round trip end to end.

`server/CLAUDE.md` is authoritative for the host: the shims, the Railway
project setup, and the post-deploy verify loop.

The separate private Auto analyzer has its own no-public-domain provisioning,
shadow rollout, and rollback runbook in
[Railway audio-analysis provisioning](docs/railway-audio-analysis-provisioning.md).
The repeatable pre-release rollback capture is `npm run baseline:railway`; its
latest non-secret evidence is under
`docs/acceptance/2026-08-09-v3.2-rollback-baseline/`. Validate both provider
pins with `npm run check:replicate` and `npm run check:youtube` before release.
The separate `npm run check:isolation` command vets a candidate AudioSep pin,
but does not authorize or enable the dormant Phase 3 adapter. The teacher-only
isolation shadow route records normalized demand and private source/cache
identity only. Its rollout stage cannot be claimed, and no app route constructs
or starts a provider prediction.

## Secrets and configuration

The app needs these secrets (set as Railway variables; local equivalents in
`.dev.vars`):

- `REPLICATE_API_TOKEN` and `REPLICATE_MODEL_VERSION` — see "vetting a model
  version" below
- `WEBHOOK_SECRET` — any long random string, e.g. `openssl rand -hex 32`
- `CLASS_CODE` — what students type to use the app
- `OPENROUTER_API_KEY` — openrouter.ai key; powers Listening Guy
- `TEACHER_SEED` — pre-hashed teacher records; see
  [Teacher provisioning and prompt governance](docs/teacher-provisioning.md)

Vars:

- `PUBLIC_BASE_URL` — the deployed URL (the provider posts completion
  webhooks here)
- `ASSISTANT_MODEL` — OpenRouter slug for the Listening Guy (default
  `z-ai/glm-5.2`; remove it to disable the Listening Guide entirely)
- `ASSISTANT_FALLBACK_MODELS` — comma-separated independent model routes,
  tried after provider errors and an empty pre-content stream
- `REPLICATE_YT_MODEL` / `REPLICATE_YT_MODEL_VERSION` — owner/name and exact
  deployed version of the `replicate-yt-audio/` fetch model; the version is
  required for that fallback and `latest` is rejected so a model push cannot
  silently change the import path
- `YOUTUBE_FETCH_ORDER` — `replicate-first` in production so the
  authenticated yt-dlp service runs before the usually bot-blocked direct
  client

Fixed prompt changes are recorded in
[the Listening Guide prompt changelog](docs/prompt-changelog.md).

### Vetting a Demucs model version

Get a candidate model version hash:

```sh
curl -s https://api.replicate.com/v1/models/ryan5453/demucs \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" | jq -r .latest_version.id
```

**Vet it before you set it.** Upstream has changed shape at source — the
model's development HEAD serves only `htdemucs` and renamed `output_format`
to `format` — so pinning whatever `latest_version` returns can silently break
the 4- and 6-track splits:

```sh
REPLICATE_MODEL_VERSION=<candidate> npm run check:replicate
```

That checks the candidate against the split catalogue itself, so it fails
with the exact model id or input key that went missing. Only set the secret
once it passes.

## Local development

### Fully local Audio Separator + BS-RoFormer

A localhost-only path uses Audio Separator 0.44.5 and the pinned
`model_bs_roformer_ep_317_sdr_12.9755.ckpt` checkpoint. Its
`bs_roformer_vocals` profile produces two synchronized tracks: `vocals` and
`instrumental`. Production remains configured for Replicate unless
`SEPARATION_BACKEND` is explicitly changed. The service verifies committed
SHA-256 pins for both the checkpoint and its YAML configuration before
deserializing the model.

Prerequisites: Bun 1.3.14, Node 22.23.1, `uv`, and FFmpeg. On Apple Silicon,
Audio Separator uses PyTorch MPS where the model supports it. The first run
creates an isolated Python 3.11/3.12 environment and the first separation
downloads the pinned model, so both take longer than later runs.

```sh
cp .dev.vars.local.example .dev.vars
bun run db:migrate:local
```

Then use separate terminals:

```sh
bun run separator:local
bun run dev:local
```

Open `http://127.0.0.1:8787` and use class code `local-class-code`, or run
the repeatable end-to-end check:

```sh
bun run smoke:local
```

The local mode sends uploads through the app into a simulated local storage
binding; it never needs production storage or Replicate credentials. The
separator API binds to loopback, requires a bearer token, caches model
weights under `local-separator/.models/`, and serializes inference to avoid
accelerator memory contention. It keeps job state in memory and is an
evaluation harness, not a production deployment. Audio Separator's code is
MIT-licensed and asks integrators to credit UVR and its developers; review
the checkpoint's provenance and permitted use separately before institutional
production.

Notes:

- The separation provider can't reach `localhost` with webhooks. That's fine
  — the app reconciles by polling the provider directly whenever a job status
  is fetched (`GET /api/jobs/:id`), so jobs still complete in local dev, just
  on the poll cadence.
- Listening Guy returns a friendly 503 locally unless `OPENROUTER_API_KEY` is
  in `.dev.vars`; the mixer is unaffected either way.
- Local uploads require a valid `Content-Length` and stream directly into the
  simulated storage; normal browser file uploads provide it. Chunked uploads
  are rejected before their body is read. Local uploads and stems older than
  30 days are deleted during hourly API maintenance and expired objects are
  rejected on access; if the local app was offline, its first API request
  after restart catches up the cleanup.

## End-to-end tests

```sh
bun run test:e2e
bun run typecheck:analysis
bun run test:analysis-service
bun run test:e2e:auto
```

The Playwright suite starts a real test-harness app with isolated simulated
storage. Chrome selects and uploads the on-disk PCM WAV fixture in
`tests/fixtures/audio`; the mocked provider returns four on-disk MP3
fixtures. The suite verifies the signed source and stored stem bytes exactly.
It also checks the 2, 4, and 6 track contracts, incomplete output, empty MP3
responses, partial-file cleanup, and the browser's explicit audio-error
state. Only the paid Replicate boundary is mocked, so the suite is
repeatable, offline, and incurs no GPU cost. Upload coverage checks that
chunked and oversized bodies are rejected before storage, length-mismatched
objects are removed, and both uploads and stems are deleted at the local
30-day retention boundary.

The analysis-service suite additionally runs a real FFmpeg decode and proves
authentication, scoped source URLs, byte/duration/time/concurrency limits,
ephemeral cleanup, private source-fingerprint parity, separate
health/readiness, and exact deterministic browser/server classifier parity.
Server Auto remains disabled unless its master flag and rollout mode are
explicitly set; analyzer failure preserves the four-track fallback.

## Offline long-tail instrument controls

The v3.2 research path includes eight exact-hash ChoraleBricks isolated
woodwind/brass controls under CC BY 4.0. Audio is hydrated into the
gitignored corpus directory; only provenance, media pins, evaluator code, and
non-promotion reports are committed.

```sh
bun run hydrate:instrument-controls
bun run hydrate:instrument-controls --verify-only
bun run eval:yamnet:controls --image stem-splitter-yamnet-comparator:v3.2-arm64-candidate
```

The hydrator follows one reviewed same-origin redirect and refuses URL drift,
oversized or mismatched bytes, symlinks, and overwrites. The current report
keeps dataset-authored positives and exhaustive candidate negatives in a
teacher-review-pending state. It does not calculate precision, select a
threshold, enable discovery, alter Auto routing, or provision a Railway
service.

## Costs (rough, per class of 20 students × 100 songs)

| Item | Cost |
|---|---|
| Replicate (Demucs, ~$0.045/song × 2,000) | ~$90/semester |
| YouTube fetch (Replicate yt-dlp, ~1¢/import) | ~$20/semester if every song is imported |
| Listening Guy (≈$0.005/guide, cached once; <1¢/chat exchange) | ~$1–5/semester |
| Railway app service + persistent volume | usage-based; verify the active project dashboard and cap before release |
| Railway audio-analysis CPU service | not provisioned or measured yet; shadow rollout requires an explicit cap |

## Swapping the separation backend

Everything provider-specific is behind `SeparationBackend`
(`src/separation/types.ts`): `start()`, `parseResult()`, `fetchStatus()`.

The `audio-separator` backend is complete: it submits a source URL to the
local service, accepts its webhook, and also polls as a reconciliation
fallback. Set `SEPARATION_BACKEND=audio-separator`, `AUDIO_SEPARATOR_URL`,
and the `AUDIO_SEPARATOR_TOKEN` secret to use it.

To move instead to **Modal** (deploy your own container with scale-to-zero
GPUs):

1. Implement the Modal app + web endpoint (sketch in `src/separation/modal.ts`).
2. Fill in `modalBackend()`.
3. Set `SEPARATION_BACKEND=modal`.

Nothing else in the app changes.

## Swapping the Listening Guide model

`ASSISTANT_MODEL` is the primary OpenRouter slug, and
`ASSISTANT_FALLBACK_MODELS` is its ordered, comma-separated fallback list. All
configured models must support function calling. The guide retries one empty
pre-content stream with a fallback first, but never replays a partial
response. The system prompt and mixer tool schemas in `src/assistant/` are
model-agnostic.

## Operational notes

- **Cold starts:** the first separation after an idle period can take an
  extra 30–60 s while Replicate boots the model. The UI warns students about
  this. Expect it on deadline nights — the first few jobs absorb the warmup,
  then it's fast.
- **Retention / copyright:** originals and stems auto-delete at 30 days;
  stems are served from unguessable per-job URLs; the UI states the
  educational-use policy. Review this with whoever owns institutional risk
  before launch.
- **Auth is a shared class code** (`x-class-code` header) — deliberately
  minimal for v1. If you need per-student identity later, that's the
  `requireClassCode` middleware in `src/index.ts`.
- **Webhook auth** uses a secret token in the webhook URL. Replicate also
  supports signed webhooks if you want defense in depth.
- **Stem URLs are public but unguessable** (UUID job ids) so `<audio>` tags
  work without custom headers. Acceptable for class use; revisit if needed.
- **Keep the Replicate balance above $5** — a YouTube import creates two
  predictions back-to-back, and low-credit accounts are burst-limited, so
  imports slow down or fail when the balance runs low.
- **Coach cost guardrails are structural:** guides are generated once per
  song and cached forever; chat history is capped at 12 turns; `max_tokens`
  is capped server-side; generation and chat require the class code, while
  *reading* a cached guide doesn't.
