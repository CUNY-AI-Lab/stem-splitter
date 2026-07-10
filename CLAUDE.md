# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stem-separation web app for music students (~20 students × 100 songs/semester). Upload a song → Demucs (`htdemucs_ft`) splits it on a Replicate GPU → students play stems back in a synchronized in-browser mixer with per-stem mute. Live at https://stem-splitter.ailab-452.workers.dev (class code: `music101`).

## Commands

```sh
npm run typecheck         # tsc --noEmit (no unit tests; this is the static check)
./scripts/smoke.sh        # free API smoke checks against the deployed Worker
./scripts/smoke.sh <job-id>   # + labels/annotations/stem round-trip on a done job
./scripts/smoke.sh --full # + real YouTube import → 6 stems (~$0.06, ~2 min)
npm run deploy            # wrangler deploy (account is pinned in wrangler.jsonc)
npm run dev               # wrangler dev --remote — see "Local dev" below for why
npm run db:migrate        # apply schema.sql to remote D1
npx wrangler tail         # live production logs
npx wrangler deploy --dry-run --outdir dist   # validate config/bundle without deploying
```

## Architecture

Single Cloudflare Worker (Hono, TypeScript) + static assets, D1 for job state, R2 for audio, an external GPU provider for the actual separation.

**Request flow:**
1. Browser asks `POST /api/uploads` → Worker returns a **presigned R2 PUT URL** (`src/r2.ts`, aws4fetch). Audio bytes never pass through the Worker — this is deliberate (Worker body-size limits, bandwidth). Don't "simplify" uploads into the Worker.
2. `POST /api/jobs` → row in D1 (`schema.sql`), then `SeparationBackend.start()` with a presigned GET to the source and a webhook URL containing `?job=<id>&token=<WEBHOOK_SECRET>`. Body carries `model` (`htdemucs_ft` = 4 stems, default; `htdemucs_6s` = +guitar/piano), validated against an allowlist and threaded through `SeparationStartRequest`.
2b. **YouTube import:** `POST /api/jobs` with `{ youtubeUrl }` instead of `{ key, filename }` fetches the audio (`src/youtube.ts`, behind the `fetchYouTubeAudio()` seam), stores it at `uploads/<uuid>/source.m4a`, then proceeds like a normal job. 15-min cap, no live streams; the job row is created only after audio lands in R2, so failed fetches never leave stuck jobs. Two fetchers behind the seam: a free in-Worker `youtubei.js` attempt (currently always bot-checked — YouTube blocks Cloudflare egress IPs), then a **Replicate-hosted yt-dlp model** (`replicate-yt-audio/`, deployed as the `REPLICATE_YT_MODEL` var, ~$0.01/fetch) which works. The Replicate backend retries 429s because a YouTube import creates two predictions back-to-back and low-credit accounts (<$5) are limited to a burst of 1 — keep the account topped up.
3. Provider POSTs to `/api/webhooks/separation` on completion → Worker downloads stems from provider, stores as `stems/<jobId>/<name>.mp3` in R2, flips D1 row to `done`.
4. **Reconciliation fallback:** `GET /api/jobs/:id` polls the provider directly if a job is still `processing` — covers missed webhooks and makes local dev work (webhooks can't reach localhost). Jobs can't get permanently stuck; don't remove this when touching the job routes.
5. `/api/files/*` streams stems from R2. It serves **only** keys under `stems/` — uploaded originals are intentionally never served back out (copyright posture).

**The swappable seam:** all provider-specific code lives behind `SeparationBackend` (`src/separation/types.ts`): `start()` / `parseResult()` / `fetchStatus()`. Replicate is implemented (`replicate.ts`); Modal is a stub with implementation notes (`modal.ts`), planned as a cost experiment. Selected via the `SEPARATION_BACKEND` var. New providers go behind this interface — nothing else in the app should know about a provider.

**Frontend** (`public/`, vanilla JS, no build step): the `Mixer` class in `app.js` plays all stems as parallel `HTMLAudio` elements — first stem is the master clock, others are nudged back if drift exceeds 80 ms (500 ms interval). Job list lives in localStorage; `mixers` Map preserves player state across re-renders. Visual language is a "studio console" theme (per-stem channel colors are CSS vars `--c-vocals` etc. in `styles.css`).

**Shared labels & annotations:** `jobs.labels` JSON column (`PUT /api/jobs/:id/labels`, full-map replace) and an `annotations` D1 table (`POST/DELETE /api/jobs/:id/annotations[/:annotationId]`); both ride along on `GET /api/jobs/:id`, so any student viewing a job sees them. Writes require the class code; reads stay unauthenticated-but-unguessable. In the mixer: click a channel name to rename; "＋ NOTE" stamps the current time; all notes render in an always-visible list under the channels (timecode click = jump, ✕ on hover = delete) with matching ticks on the seek bar. Seek scrubbing previews while dragging and commits one multi-stem seek on release — don't re-introduce per-`input` seeks (they stall 6 buffers) or unconditional `paint()` slider writes (they fight the drag). Known UX limit: another student's edits appear only after a page reload (polling stops once a job is `done`). Migrations: `schema.sql` is the canonical fresh-install schema; additive changes live in `migrations/` (already applied: `npm run db:migrate:2`).

## Configuration

- `wrangler.jsonc` is the source of truth: account id (ailab — `452c33847…`, not the Veritas account), D1 id, R2 bucket, vars. `R2_BUCKET_NAME` and `CF_ACCOUNT_ID` vars must match the actual bucket/account because presigned URLs are built from them.
- Secrets (set via `wrangler secret put`): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, `WEBHOOK_SECRET`, `CLASS_CODE`. Local equivalents go in `.dev.vars` (see `.dev.vars.example`).
- `REPLICATE_MODEL_VERSION` is a pinned version hash of `ryan5453/demucs`. To bump: `curl -s https://api.replicate.com/v1/models/ryan5453/demucs -H "Authorization: Bearer $TOKEN" | jq -r .latest_version.id`.
- After changing `PUBLIC_BASE_URL` or webhook logic, redeploy — Replicate posts webhooks to the deployed URL.

## Local dev

`npm run dev` uses `--remote` on purpose: presigned URLs always point at the **real** R2 bucket, so the local bucket simulator would never see uploads. End-to-end behavior (incl. webhooks) is only fully testable on the deployed Worker; locally, jobs complete via the polling reconciliation path instead of webhooks.

## Operational invariants

- The R2 bucket `stem-splitter-audio` has a **30-day auto-delete lifecycle rule** — this is the copyright/retention mitigation, not an optimization. Keep it.
- Bucket CORS (`cors.json`, note the `{"rules": [...]}` wrapper R2 requires) allows direct browser PUTs; needed for presigned uploads to work.
- Stems are MP3 (192 kbps), not WAV — keeps storage ~10× smaller.
- Stem URLs are unauthenticated but unguessable (UUID job ids) so `<audio>` tags work without headers. Accepted trade-off for class scale.
- Cost model: ~$0.045/song on Replicate; first job after idle absorbs a 30–60 s model cold start (the UI warns about this).
