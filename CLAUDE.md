# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stem-separation web app for music students (~20 students × 100 songs/semester). Upload a song → Demucs (`htdemucs_ft`) splits it on a Replicate GPU → students play stems back in a synchronized in-browser mixer with per-stem mute. Live at https://stem-splitter.ailab-452.workers.dev (the class code is the `CLASS_CODE` secret — never write its value into this file or any committed file).

## Commands

```sh
npm run typecheck         # tsc --noEmit (no unit tests; this is the static check)
CLASS_CODE=<code> ./scripts/smoke.sh   # free API smoke checks against the deployed Worker (code required)
npm run test:e2e          # real-WAV browser flow with local D1/R2 + mocked Replicate
./scripts/smoke.sh <job-id>   # + labels/annotations/stem round-trip on a done job
./scripts/smoke.sh --full # + real YouTube import → 6 stems (~$0.06, ~2 min)
npm run test:e2e:crate:run # live archive-crate eval: 5 real IA tracks → real local separation, per-phase timings (free, ~6 min)
SMOKE_ASSISTANT=1 ./scripts/smoke.sh <job-id>  # + listening-guy guide/chat live checks (<1¢)
npm run deploy            # wrangler deploy (account is pinned in wrangler.jsonc)
npm run dev               # wrangler dev --remote — see "Local dev" below for why
npm run db:migrate        # apply schema.sql to remote D1 (fresh install; additive: db:migrate:2, db:migrate:3)
npx wrangler d1 execute stem-splitter --remote --json --command "SELECT id,status FROM jobs ORDER BY created_at DESC LIMIT 5"   # ad-hoc prod queries
npx wrangler tail         # live production logs
npx wrangler deploy --dry-run --outdir dist   # validate config/bundle without deploying
```

## Architecture

Single Cloudflare Worker (Hono, TypeScript) + static assets, D1 for job state, R2 for audio, an external GPU provider for the actual separation.

**Request flow:**
1. Browser asks `POST /api/uploads` → Worker returns a **presigned R2 PUT URL** (`src/r2.ts`, aws4fetch). In production, audio bytes never pass through the Worker — this is deliberate (Worker body-size limits, bandwidth). The explicit `LOCAL_HOSTING=true` path is the exception: it accepts same-origin, fixed-length browser uploads into simulated R2.
2. `POST /api/jobs` → row in D1 (`schema.sql`), then `SeparationBackend.start()` with a presigned GET to the source and a webhook URL containing `?job=<id>&token=<WEBHOOK_SECRET>`. Body carries `model` (`htdemucs_ft` = vocals, drums, bass, other; `htdemucs_6s` adds guitar and piano), validated against an allowlist and threaded through `SeparationStartRequest`.
2b. **YouTube import:** `POST /api/jobs` with `{ youtubeUrl }` instead of `{ key, filename }` fetches the audio (`src/youtube.ts`, behind the `fetchYouTubeAudio()` seam), stores it at `uploads/<uuid>/source.m4a`, then proceeds like a normal job. 15-min cap, no live streams; the job row is created only after audio lands in R2, so failed fetches never leave stuck jobs. Two fetchers behind the seam: a free in-Worker `youtubei.js` attempt (currently always bot-checked — YouTube blocks Cloudflare egress IPs), then a **Replicate-hosted yt-dlp model** (`replicate-yt-audio/`, deployed as the `REPLICATE_YT_MODEL` var, ~$0.01/fetch) which works. The Replicate backend retries 429s because a YouTube import creates two predictions back-to-back and low-credit accounts (<$5) are limited to a burst of 1 — keep the account topped up.
2c. **Internet Archive import ("the Crate"):** `POST /api/jobs` with `{ archiveId, archiveFile }` fetches open-licensed audio straight from archive.org (`src/archive.ts`), stores it at `uploads/<uuid>/source.<ext>`, then proceeds like a normal job. No third-party fetcher and no per-import cost — archive.org serves public audio over plain HTTP with real `Content-Length` and no bot-check, so a direct Worker `fetch` is the whole fetcher. `GET /api/archive/search` and `/api/archive/items/:id` back the browse UI. **The licence floor is load-bearing:** stem separation is a derivative work, so NoDerivatives material is excluded twice — once in the pinned search query (`NOT licenseurl:*-nd*`) and again on item load, because the search index can be stale relative to item metadata. Search queries are assembled server-side and student text is reduced to quoted tokens, so a crafted term can't widen past that floor. Magnatune was evaluated and rejected first: its `song_info.xml` catalog is alive and good, but every audio URL in it points at `he3.magnatune.com`, which no longer resolves.
3. Provider POSTs to `/api/webhooks/separation` on completion → Worker downloads stems from provider, stores as `stems/<jobId>/<name>.mp3` in R2, flips D1 row to `done`.
   Before the `done` transition, the Worker requires the exact track names for the selected 2, 4, or 6 track model and verifies each result contains an MP3 frame. Missing, repeated, unexpected, empty, or non-audio results fail the job and remove partial files.
4. **Reconciliation fallback:** `GET /api/jobs/:id` polls the provider directly if a job is still `processing` — covers missed webhooks and makes local dev work (webhooks can't reach localhost). Jobs can't get permanently stuck; don't remove this when touching the job routes.
5. `/api/files/*` streams stems from R2. It serves **only** keys under `stems/` — uploaded originals are intentionally never served back out (copyright posture).
6. **Listening Guy (AI coach):** `src/assistant/` calls OpenRouter via plain fetch (model = `ASSISTANT_MODEL` var, currently `z-ai/glm-5.2`; swap models by changing the var, no code edits). `POST /api/jobs/:id/guide` generates a one-time listening guide, cached in the `guides` D1 table and shared class-wide (generation races converge via `INSERT … ON CONFLICT DO NOTHING`); the cached guide rides along on `GET /api/jobs/:id`. `POST /api/jobs/:id/chat` is stateless chat — history is client-held (≤12 turns) and resent per call — whose replies may carry server-validated mixer tool calls (`solo`/`set_mute`/`seek`/`add_note`, per-job stem enums) that `public/app.js` executes on the Mixer; `add_note` reuses the annotations API. A tools-only model reply triggers one extra server-side narration call (`runChat`) so the coach always speaks — expect up to two provider calls per chat turn. Both endpoints are class-code-gated (they cost money). The v2 system prompt lives in `src/assistant/prompt.ts` — pedagogy + guardrails (no invented timestamps, no fabrication, student data fenced as data-not-instructions). Provider failures map to student-safe strings and never break the mixer — don't let assistant code paths become load-bearing for playback.

**The swappable seam:** all provider-specific code lives behind `SeparationBackend` (`src/separation/types.ts`): `start()` / `parseResult()` / `fetchStatus()`. Replicate is implemented (`replicate.ts`); Modal is a stub with implementation notes (`modal.ts`), planned as a cost experiment. Selected via the `SEPARATION_BACKEND` var. New providers go behind this interface — nothing else in the app should know about a provider.

**Frontend** (`public/`, vanilla JS, no build step): the `Mixer` class in `app.js` plays all stems as parallel `HTMLAudio` elements — first stem is the master clock, others are nudged back if drift exceeds 80 ms (500 ms interval). Job list lives in localStorage; `mixers` Map preserves player state across re-renders. Visual language is a "studio console" theme (per-stem channel colors are CSS vars `--c-vocals` etc. in `styles.css`).

**Instructor console (`/teacher.html`):** teacher accounts + an editable Listening Guy prompt amendment (`src/teacher/auth.ts`, spec: `docs/superpowers/specs/2026-08-05-teacher-console-design.md`). Deliberately **not** gated by the class code — that's a shared secret every student holds, so it can't gate what the coach says class-wide; there's an e2e test asserting the class code gets 401 here. Passwords are PBKDF2-HMAC-SHA256 (210k iterations, per-user salt) and **never appear in the repo, the DB, or a log**: `scripts/hash-teacher-password.mjs` reads the password from stdin and emits a hashed record for the `TEACHER_SEED` secret, which the Worker upserts on boot. Rotating a password = regenerate + update the secret + redeploy; a wiped D1 or lost Railway volume re-provisions the same accounts. Sessions are opaque tokens in HttpOnly cookies, stored only as SHA-256. The teacher edits an **amendment appended to** the prompt, never the prompt itself — it lands after every guardrail block, introduced as subordinate ("the rules above always win"), so no instructor can accidentally disable "never invent timestamps" or the student-data-is-not-instructions fence. Saving clears the `guides` cache (cached guides predate the edit). Migration: `db:migrate:4`.

**Shared labels & annotations:** `jobs.labels` JSON column (`PUT /api/jobs/:id/labels`, full-map replace) and an `annotations` D1 table (`POST/DELETE /api/jobs/:id/annotations[/:annotationId]`); both ride along on `GET /api/jobs/:id`, so any student viewing a job sees them. Writes require the class code; reads stay unauthenticated-but-unguessable. In the mixer: click a channel name to rename; "＋ NOTE" stamps the current time; all notes render in an always-visible list under the channels (timecode click = jump, ✕ on hover = delete) with matching ticks on the seek bar. Seek scrubbing previews while dragging and commits one multi-stem seek on release — don't re-introduce per-`input` seeks (they stall 6 buffers) or unconditional `paint()` slider writes (they fight the drag). Known UX limit: another student's edits appear only after a page reload (polling stops once a job is `done`). Migrations: `schema.sql` is the canonical fresh-install schema; additive changes ship as `migrations/000N-*.sql` with a matching `db:migrate:N[:local]` script pair **and** the same change appended to `schema.sql` (already applied: `:2` labels/annotations, `:3` guides). Feature work ships with a spec+plan docs pair under `docs/superpowers/` — mirror the 2026-07-09 / 2026-07-24 pairs.

## Configuration

- `wrangler.jsonc` is the source of truth: account id (ailab — `452c33847…`, not the Veritas account), D1 id, R2 bucket, vars. Wrangler must be logged in as `ailab@gc.cuny.edu` — a personal Cloudflare login isn't a member of the ailab account, and every write (deploy, `secret put`) fails with `Authentication error [code: 10000]`. Check with `npx wrangler whoami`; fix with `npx wrangler logout` then `login` as ailab. `R2_BUCKET_NAME` and `CF_ACCOUNT_ID` vars must match the actual bucket/account because presigned URLs are built from them.
- Secrets (set via `wrangler secret put`): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, `WEBHOOK_SECRET`, `CLASS_CODE`, `OPENROUTER_API_KEY`. Local equivalents go in `.dev.vars` (see `.dev.vars.example`).
- `REPLICATE_MODEL_VERSION` is a pinned version hash of `ryan5453/demucs`. To bump: `curl -s https://api.replicate.com/v1/models/ryan5453/demucs -H "Authorization: Bearer $TOKEN" | jq -r .latest_version.id`.
- After changing `PUBLIC_BASE_URL` or webhook logic, redeploy — Replicate posts webhooks to the deployed URL.

## Local dev

`npm run dev` uses `--remote` on purpose: presigned URLs point at the **real** R2 bucket. The `LOCAL_DEV=1` Audio Separator path and Funnel-backed `LOCAL_HOSTING=true` path instead use simulated D1/R2. Both local modes stream only fixed-length uploads, HMAC-sign temporary source URLs, and perform hourly 30-day cleanup. `npm run test:e2e` covers the complete browser/upload/job/poll/stem flow with the on-disk WAV/MP3 fixtures in `tests/fixtures/audio` and a mocked Replicate boundary. Listening Guy endpoints 503 by design without `OPENROUTER_API_KEY` in `.dev.vars` (mixer unaffected).

## Operational invariants

- The R2 bucket `stem-splitter-audio` has a **30-day auto-delete lifecycle rule** — this is the copyright/retention mitigation, not an optimization. Keep it; (re)apply with `npx wrangler r2 bucket lifecycle add stem-splitter-audio --expire-days 30`.
- Simulated local R2 must preserve the same boundary: expired objects are rejected on read and local API traffic runs hourly cleanup, including catch-up after restart.
- Bucket CORS (`cors.json`, note the `{"rules": [...]}` wrapper R2 requires) allows direct browser PUTs; needed for presigned uploads to work. (Re)apply with `npx wrangler r2 bucket cors set stem-splitter-audio --file cors.json`.
- Stems are MP3 (192 kbps), not WAV — keeps storage ~10× smaller.
- Stem URLs are unauthenticated but unguessable (UUID job ids) so `<audio>` tags work without headers. Accepted trade-off for class scale.
- Cost model: ~$0.045/song on Replicate; first job after idle absorbs a 30–60 s model cold start (the UI warns about this). Listening Guy adds ≈$0.005 per guide (generated once, cached forever) and fractions of a cent per chat turn on GLM-5.2.
