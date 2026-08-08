# Stem Splitter

A stem-separation web app for students. Upload a song — or paste a YouTube
link — and get back isolated stems as MP3s (2-stem vocals / instrumental,
4-stem adding drums / bass / other, or 6-stem adding guitar + piano), played
in a synchronized in-browser
mixer with per-stem mute, shared renameable channel labels, shared timestamped
notes, and **Listening Guy**: an AI listening coach that writes a per-song
listening guide and answers questions in a chat that can drive the mixer
itself (solo/mute channels, jump the playhead, pin notes for the class).

**Architecture:** Browser → presigned upload to R2 (or in-Worker YouTube
fetch) → Cloudflare Worker creates a job (D1) → Replicate runs Demucs on a GPU
in the mode the selected split calls for → webhook marks the job done →
student streams MP3 stems from R2 → R2 lifecycle rule deletes everything after
30 days. The coach runs on OpenRouter (`z-ai/glm-5.2` by default) behind two
class-code-gated endpoints; guides are generated once per song and cached in
D1, shared class-wide.

- **~$0.045/song** on Replicate, scales to zero when idle (no GPU to manage).
- The separation provider lives behind one interface
  (`src/separation/types.ts`) — swap in Modal/RunPod/self-hosted Demucs later
  by implementing it and flipping `SEPARATION_BACKEND`.
- In production, audio bytes never flow through the Worker on upload
  (presigned PUT direct to R2), so there are no Worker body-size issues. The
  explicit local-hosting modes stream browser uploads through the local Worker
  into simulated R2 with fixed-length enforcement.
- The AI coach is provider-light too: plain `fetch` to OpenRouter, model set by
  the `ASSISTANT_MODEL` var — swap to any cheap tool-calling model with a var
  change and a redeploy. If the provider is down or unconfigured, students see
  a friendly notice and the mixer keeps working.

```
src/
  index.ts              Worker: uploads, jobs, webhook, labels/annotations,
                        listening-guy guide+chat, file serving
  env.ts                Bindings/vars/secrets types
  r2.ts                 Presigned URLs + local retention enforcement
  youtube.ts            YouTube audio fetch (youtubei.js + Replicate yt-dlp fallback)
  assistant/            Listening Guy: OpenRouter client, mixer tool schemas,
                        system prompt (prompt.ts), guide/chat orchestrators
  separation/
    types.ts            SeparationBackend interface (the swappable seam)
    replicate.ts        Replicate-hosted Demucs implementation
    modal.ts            Stub for a self-deployed Modal backend
server/                 Node host for the Railway dev deployment (D1/R2 shims)
public/                 Static frontend (vanilla JS mixer + coach panel)
migrations/             Additive D1 migrations (schema.sql = fresh install)
scripts/smoke.sh        Smoke checks against the deployed Worker
replicate-yt-audio/     Replicate-hosted yt-dlp model (YouTube fetch fallback)
docs/superpowers/       Per-feature design specs + implementation plans
schema.sql              D1 schema
cors.json               R2 CORS rules for direct browser uploads
```

## Where this runs: Railway is dev, Cloudflare is production

Two hosts run the same Hono app, and they are not peers.

| | **Railway** — dev | **Cloudflare Workers** — production |
|---|---|---|
| Role | prototyping, rapid iteration | the deployment students use |
| Entry point | `server/index.ts` (Node, `tsx`) | `src/index.ts` (Worker) |
| Storage | `node:sqlite` + a volume at `/data` | D1 `stem-splitter` + R2 `stem-splitter-audio` |
| Deploy | `railway up --detach -m "<summary>"` | `npm run deploy` |
| Retention | hourly cleanup in app code | R2 bucket lifecycle rule |
| Audience | you | the class |

`server/` adapts *to* `src/` through small D1 and R2 shims and never requires a
change to it — an edit under `src/` to accommodate Node drifts the two targets
apart. Reach for Railway when you want a tight loop or, more importantly, a
**publicly reachable origin**: Replicate has to fetch the signed source URL and
post a webhook back, and localhost can satisfy neither, so Railway is the only
way to exercise that round trip end to end.

**Nothing on Railway promotes itself.** It has its own SQLite database, its own
audio volume, and its own `WEBHOOK_SECRET` and `CLASS_CODE` — deliberately not
production's. Jobs, stems, labels, notes, and guides created there do not exist
in production, and no amount of prototyping moves code, secrets, or schema
across. Validating on Railway proves the logic; only `npm run deploy` plus the
checks in `CLAUDE.md` prove the deployment.

`server/CLAUDE.md` is authoritative for the dev host: the shims, the Railway
project setup, and the post-deploy verify loop.

## Deploying an existing clone (already-provisioned project)

If the Cloudflare resources already exist (this repo's `wrangler.jsonc` is
already filled in — bucket `stem-splitter-audio`, the D1 database, and the
account are committed), **do not run the `create` commands in the Setup
section below** — that's for standing up a brand-new copy from scratch.

To deploy from a fresh clone against the existing infrastructure:

```sh
bun install
bun run wrangler -- login        # must have access to the account in wrangler.jsonc

# Set the seven secrets (values from whoever owns the deployment):
bun run wrangler -- secret put R2_ACCESS_KEY_ID
bun run wrangler -- secret put R2_SECRET_ACCESS_KEY
bun run wrangler -- secret put REPLICATE_API_TOKEN
bun run wrangler -- secret put REPLICATE_MODEL_VERSION
bun run wrangler -- secret put WEBHOOK_SECRET
bun run wrangler -- secret put CLASS_CODE
bun run wrangler -- secret put OPENROUTER_API_KEY

bun run deploy
```

Check what's already set with `bun run wrangler -- secret list`. The R2 bucket
(CORS + 30-day lifecycle rule) and D1 schema are already applied on the
account, so the bucket/D1/migration steps below should be skipped.

## Setup (new project from scratch)

Prereqs: Bun 1.3.14, Node 22.23.1, a Cloudflare account, and a
[Replicate](https://replicate.com) account.

### 1. Install & authenticate

```sh
bun install
bun run wrangler -- login
```

### 2. Create the R2 bucket

```sh
bun run wrangler -- r2 bucket create stem-splitter-audio
```

Apply CORS so browsers can PUT directly to presigned URLs (tighten
`AllowedOrigins` to your deployed URL once you have it):

```sh
bun run wrangler -- r2 bucket cors set stem-splitter-audio --file cors.json
```

Add the 30-day auto-delete lifecycle rule (this is the copyright/retention
mitigation — don't skip it):

```sh
bun run wrangler -- r2 bucket lifecycle add stem-splitter-audio --expire-days 30
```

(If the CLI flags differ in your wrangler version, both CORS and lifecycle can
be set in the dashboard: R2 → bucket → Settings.)

Create an R2 API token (dashboard → R2 → "Manage R2 API Tokens" →
Object Read & Write, scoped to this bucket). Keep the key id + secret for
step 5.

### 3. Create the D1 database

```sh
bun run wrangler -- d1 create stem-splitter
```

Paste the printed `database_id` into `wrangler.jsonc`, then:

```sh
bun run db:migrate
```

### 4. Fill in vars

In `wrangler.jsonc`, set:

- `CF_ACCOUNT_ID` — dashboard sidebar
- `PUBLIC_BASE_URL` — your Worker URL (you'll know it after the first deploy;
  deploy, then update and deploy again)
- `ASSISTANT_MODEL` — OpenRouter slug for the Listening Guy coach (default
  `z-ai/glm-5.2`; remove it to disable the coach entirely)
- `REPLICATE_YT_MODEL` — owner/name of a deployed `replicate-yt-audio/` model;
  unset it if you don't need the YouTube-fetch fallback (the free in-Worker
  fetch is usually bot-blocked from Cloudflare egress IPs, so without this
  YouTube import mostly won't work)
- `YOUTUBE_FETCH_ORDER` — set to `replicate-first` in production so the
  authenticated yt-dlp service runs before the usually blocked in-Worker
  client. If the Replicate model is not configured, the Worker still tries
  the in-Worker client.

### 5. Set secrets

```sh
bun run wrangler -- secret put R2_ACCESS_KEY_ID
bun run wrangler -- secret put R2_SECRET_ACCESS_KEY
bun run wrangler -- secret put REPLICATE_API_TOKEN
bun run wrangler -- secret put REPLICATE_MODEL_VERSION   # see below
bun run wrangler -- secret put WEBHOOK_SECRET            # any long random string, e.g. `openssl rand -hex 32`
bun run wrangler -- secret put CLASS_CODE                # what students type to use the app
bun run wrangler -- secret put OPENROUTER_API_KEY        # openrouter.ai key — powers Listening Guy
```

Get a candidate Demucs model version hash:

```sh
curl -s https://api.replicate.com/v1/models/ryan5453/demucs \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" | jq -r .latest_version.id
```

**Vet it before you set it.** Upstream has changed shape at source — the model's
development HEAD serves only `htdemucs` and renamed `output_format` to `format`
— so pinning whatever `latest_version` returns can silently break the 4- and
6-track splits:

```sh
REPLICATE_MODEL_VERSION=<candidate> npm run check:replicate
```

That checks the candidate against the split catalogue itself, so it fails with
the exact model id or input key that went missing. Only set the secret once it
passes.

### 6. Deploy

```sh
bun run deploy
```

Update `PUBLIC_BASE_URL` in `wrangler.jsonc` with the printed URL and deploy
once more (Replicate posts completion webhooks to this URL).

## Local development

Production-backed development still uses the real R2 bucket:

```sh
cp .dev.vars.example .dev.vars   # fill in real values
bun run dev                      # wrangler dev --remote
```

Notes:

- `--remote` is intentional: presigned URLs point at the **real** R2 bucket,
  so the local simulator's bucket would never see your uploads.
- Replicate can't reach `localhost` with webhooks. That's fine — the app
  reconciles by polling Replicate directly whenever a job status is fetched
  (`GET /api/jobs/:id`), so jobs still complete in local dev, just on the
  poll cadence.
- Listening Guy returns a friendly 503 locally unless `OPENROUTER_API_KEY` is
  in `.dev.vars`; the mixer is unaffected either way.

### Fully local Audio Separator + BS-RoFormer

The `codex/local-bs-roformer` branch adds a localhost-only path that uses
Audio Separator 0.44.5 and the pinned
`model_bs_roformer_ep_317_sdr_12.9755.ckpt` checkpoint. Its new
`bs_roformer_vocals` profile produces two synchronized tracks: `vocals` and
`instrumental`. Production remains configured for Replicate unless
`SEPARATION_BACKEND` is explicitly changed.
The service verifies committed SHA-256 pins for both the checkpoint and its
YAML configuration before deserializing the model.

Prerequisites: Bun 1.3.14, Node 22.23.1, `uv`, and FFmpeg. On Apple Silicon, Audio Separator
uses PyTorch MPS where the model supports it. The first run creates an isolated
Python 3.11/3.12 environment and the first separation downloads the pinned
model, so both take longer than later runs.

```sh
cp .dev.vars.local.example .dev.vars
bun run db:migrate:local
```

Then use separate terminals:

```sh
bun run separator:local
bun run dev:local
```

Open `http://127.0.0.1:8787` and use class code `local-class-code`, or run the
repeatable end-to-end check:

```sh
bun run smoke:local
```

The local mode sends uploads through the Worker into Miniflare's local R2
binding; it never needs production R2 or Replicate credentials. The separator
API binds to loopback, requires a bearer token, caches model weights under
`local-separator/.models/`, and serializes inference to avoid accelerator
memory contention. It keeps job state in memory and is an evaluation harness,
not a production deployment. Audio Separator's code is MIT-licensed and asks
integrators to credit UVR and its developers; review the checkpoint's
provenance and permitted use separately before institutional production.

For a Funnel-accessible Worker with simulated D1/R2, set the public URL to the
Funnel hostname and opt into local hosting explicitly:

```sh
bun run wrangler -- dev --local --port 8080 \
  --var LOCAL_HOSTING:true \
  --var PUBLIC_BASE_URL:https://your-funnel-host.example
```

Local uploads require a valid `Content-Length` and stream directly into
Miniflare R2; normal browser file uploads provide it. Chunked uploads are
rejected before their body is read. Because Miniflare does not inherit the
production bucket lifecycle, the Worker deletes local uploads and stems older
than 30 days during hourly API maintenance and rejects expired objects on
access. If the local Worker was offline, its first API request after restart
catches up the cleanup.

## End-to-end tests

```sh
bun run test:e2e
```

The Playwright suite starts a real Wrangler test-harness Worker with isolated
Miniflare D1/R2. Chrome selects and uploads the on-disk PCM WAV fixture in
`tests/fixtures/audio`; the mocked provider returns four on-disk MP3 fixtures.
The suite verifies the signed source and stored stem bytes exactly. It also
checks the 2, 4, and 6 track contracts, incomplete output, empty MP3 responses,
partial-file cleanup, and the browser's explicit audio-error state. Only the
paid Replicate boundary is mocked, so the suite is repeatable, offline, and
incurs no GPU cost. Upload coverage checks that chunked and oversized bodies are
rejected before storage, length-mismatched objects are removed, and both uploads
and stems are deleted at the local 30-day retention boundary.

## Costs (rough, per class of 20 students × 100 songs)

| Item | Cost |
|---|---|
| Replicate (Demucs, ~$0.045/song × 2,000) | ~$90/semester |
| YouTube fetch (Replicate yt-dlp, ~1¢/import) | ~$20/semester if every song is imported |
| Listening Guy (≈$0.005/guide, cached once; <1¢/chat exchange) | ~$1–5/semester |
| R2 storage (MP3 stems, 30-day retention) | ~$1–2/month |
| R2 egress | $0 (free) |
| Workers + D1 | free tier at this volume |

## Swapping the separation backend

Everything provider-specific is behind `SeparationBackend`
(`src/separation/types.ts`): `start()`, `parseResult()`, `fetchStatus()`.

The local branch includes a complete `audio-separator` backend. It submits a
source URL to the local service, accepts its webhook, and also polls as a
reconciliation fallback. Set `SEPARATION_BACKEND=audio-separator`,
`AUDIO_SEPARATOR_URL`, and the `AUDIO_SEPARATOR_TOKEN` secret to use it.

To move instead to **Modal** (deploy your own container with scale-to-zero
GPUs):

1. Implement the Modal app + web endpoint (sketch in `src/separation/modal.ts`).
2. Fill in `modalBackend()`.
3. Set `SEPARATION_BACKEND=modal` in `wrangler.jsonc`.

Nothing else in the app changes.

## Swapping the coach model

`ASSISTANT_MODEL` in `wrangler.jsonc` is an OpenRouter slug; any cheap model
with function calling works. Change the var and `bun run deploy` — the system
prompt and mixer tool schemas in `src/assistant/` are model-agnostic.

## Operational notes

- **Cold starts:** the first separation after an idle period can take an extra
  30–60 s while Replicate boots the model. The UI warns students about this.
  Expect it on deadline nights — the first few jobs absorb the warmup, then
  it's fast.
- **Retention / copyright:** originals and stems auto-delete at 30 days via
  the R2 lifecycle rule; stems are served from unguessable per-job URLs; the
  UI states the educational-use policy. Review this with whoever owns
  institutional risk before launch.
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
- **Coach cost guardrails are structural:** guides are generated once per song
  and cached forever; chat history is capped at 12 turns; `max_tokens` is
  capped server-side; generation and chat require the class code, while
  *reading* a cached guide doesn't.
