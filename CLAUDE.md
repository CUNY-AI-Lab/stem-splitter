# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stem-separation web app for music students (~20 students × 100 songs/semester). Upload a song → Demucs splits it into 2, 4, or 6 tracks → students play stems back in a synchronized in-browser mixer with per-stem mute. **Current release rule:** use the Node host under `server/` on Railway for integration, live acceptance, and releases until the user declares the product finished. Cloudflare Workers is the deferred finished-product migration target; do not deploy unfinished work there. The old Worker URL may remain reachable but is not proof of current delivery. The class code is the `CLASS_CODE` secret — never write its value into this file or any committed file.

## Commands

```sh
bun run typecheck         # tsc --noEmit (no unit tests; this is the static check)
bun run typecheck:server  # active Railway Node adapter plus shared source
bun run test:worker       # node --test: split contract, rename, catalogue invariants, version guard
bun run check:replicate   # verify REPLICATE_MODEL_VERSION still accepts what the catalogue sends
bun run probe:replicate -- <option-id> <audio-url>   # record a provider's real output names (~$0.05)
CLASS_CODE=<code> bun run test:corpus     # real-audio eval corpus (tests/corpus/corpus.json; paid)
bun run eval:auto [corpus-slug ...]        # local FFmpeg Auto routing gate; exit 2 means a reviewed mismatch
bun run eval:auto:browser [corpus-slug ...] # real Chrome vs FFmpeg decision-parity gate
bun run eval:stems -- --source mix.mp3 --stem vocals=v.mp3 --stem instrumental=i.mp3 --complementary
bun run eval:selftest -- <audio-file>   # ground-truth self-test of the eval tool itself (free)
CLASS_CODE=<code> ./scripts/smoke.sh   # free API smoke checks against the deployed app (code required)
bun run test:e2e          # real-WAV browser flow with local D1/R2 + mocked Replicate
bun run typecheck:analysis && bun run test:analysis-service  # private analyzer + parity gate
bun run test:e2e:auto     # flag-enabled upload/YouTube/Archive server-Auto flow
bun run test:phase0       # Phase 0 gate, including authoritative Auto E2E
SOURCE_AUDIO=song.mp3 ./scripts/run-real-audio-e2e.sh          # live browser run, free local separator
BACKEND=replicate MODEL=vocals_instrumental SOURCE_AUDIO=song.mp3 ./scripts/run-real-audio-e2e.sh   # paid
BACKEND=replicate MODEL=htdemucs_6s YOUTUBE_URL=<url> ./scripts/run-real-audio-e2e.sh               # paid import
./scripts/smoke.sh <job-id>   # + labels/annotations/stem round-trip on a done job
./scripts/smoke.sh --full # + real YouTube import → 6 stems (~$0.06, ~2 min)
bun run test:e2e:crate:run # live archive-crate eval: 5 real IA tracks → real local separation, per-phase timings (free, ~6 min)
SMOKE_ASSISTANT=1 ./scripts/smoke.sh <job-id>  # + listening-guy guide/chat live checks (<1¢)
bun run deploy            # DEFERRED until the user declares the product finished
bun run dev               # wrangler dev --remote — see "Local dev" below for why
bun run start                 # Node host (server/) for Railway prototyping; needs WEBHOOK_SECRET + CLASS_CODE
railway up --detach --project f070742b-3375-4cba-9a86-335f39273c88 --environment b3381640-1e2f-4765-8e15-15baec599ec2 --service f53a2915-087c-493a-a345-7a1fa73e6588 -m "<summary>"   # active Node host; see server/CLAUDE.md
bun run db:migrate        # apply schema.sql to remote D1 (fresh install; additive migrations currently run through db:migrate:16)
bun run wrangler -- d1 execute stem-splitter --remote --json --command "SELECT id,status FROM jobs ORDER BY created_at DESC LIMIT 5"   # ad-hoc prod queries
bun run wrangler -- tail         # live production logs
bun run wrangler -- deploy --dry-run --outdir dist   # validate config/bundle without deploying
```

## Architecture

One shared Hono application (TypeScript) plus static assets and an external GPU
provider for separation. The active adapter is Railway Node with SQLite and a
filesystem volume; the retained Cloudflare adapter uses Workers, D1, and R2
only after the finished-product migration.

**Request flow:**
1. Browser asks `POST /api/uploads`. Railway returns a same-origin fixed-length upload route backed by its volume; the deferred Worker adapter returns a presigned R2 PUT URL (`src/r2.ts`, aws4fetch).
2. `POST /api/jobs` creates a row through the shared database binding, then calls `SeparationBackend.start()` with a signed GET to the source and a webhook URL containing `?job=<id>&token=<WEBHOOK_SECRET>`. Body carries `model` — a **contract id** from the catalogue (`src/separation/options.ts`), validated against the backend's runnable set and threaded through `SeparationStartRequest`. On Replicate: `vocals_instrumental` (2), `htdemucs_ft` (4, default), `htdemucs_6s` (6).
2a. **Authoritative Auto source handoff:** an uploaded source is streamed into the app-owned `auto-inputs/v1/<job>` key before analysis. Browser PUT routes cannot address that prefix, and both the private analyzer and separator receive signed URLs for that exact snapshot. App and analyzer compile `analysis-source-scope-v2`, which allows only canonical `uploads/<id>/<file>` keys plus exact v1 Auto snapshots and binds an Auto snapshot to upload source type; `/readyz` reports that pin. YouTube and Archive imports instead carry the app-calculated pre-storage SHA-256/byte count into the analyzer identity check. Never point either authoritative path back at a still-live browser upload locator. The app-owned Auto key is a valid later teacher-isolation source; widening analyzer authority to stems, isolation paths, arbitrary internal objects, or noncanonical source keys is forbidden.
2b. **YouTube import:** `POST /api/jobs` with `{ youtubeUrl }` instead of `{ key, filename }` fetches the audio (`src/youtube.ts`, behind the `fetchYouTubeAudio()` seam), stores it at `uploads/<uuid>/source.m4a`, then proceeds like a normal job. 15-min cap, no live streams; the job row is created only after audio lands through the storage binding, so failed fetches never leave stuck jobs. Two fetchers sit behind the seam: a direct `youtubei.js` attempt, then a **Replicate-hosted yt-dlp model** (`replicate-yt-audio/`, owner/name in `REPLICATE_YT_MODEL`, exact deployed version in `REPLICATE_YT_MODEL_VERSION`, ~$0.01/fetch). The version is required for that fallback and `latest` is rejected; a model push takes effect only after an authorized canary and an explicit pin update. The Replicate backend retries 429s because a YouTube import creates two predictions back-to-back and low-credit accounts (<$5) are limited to a burst of 1 — keep the account topped up.
2c. **Internet Archive import ("the Crate"):** `POST /api/jobs` with `{ archiveId, archiveFile }` fetches open-licensed audio straight from archive.org (`src/archive.ts`), stores it at `uploads/<uuid>/source.<ext>`, then proceeds like a normal job. No third-party fetcher and no per-import cost; the server fetches the public source directly. `GET /api/archive/search` and `/api/archive/items/:id` back the browse UI. **The licence floor is load-bearing:** stem separation is a derivative work, so NoDerivatives material is excluded twice — once in the pinned search query (`NOT licenseurl:*-nd*`) and again on item load, because the search index can be stale relative to item metadata. Search queries are assembled server-side and student text is reduced to quoted tokens, so a crafted term can't widen past that floor. Magnatune was evaluated and rejected first: its `song_info.xml` catalog is alive and good, but every audio URL in it points at `he3.magnatune.com`, which no longer resolves.
3. The provider POSTs to `/api/webhooks/separation` on completion. The shared app downloads stems, stores them as `stems/<jobId>/<name>.mp3` through the active storage binding, and flips the job row to `done`.
   Before the `done` transition, the app requires the exact track names for the selected 2, 4, or 6 track model and verifies each result contains an MP3 frame. Missing, repeated, unexpected, empty, or non-audio results fail the job and remove partial files.
4. **Reconciliation fallback:** `GET /api/jobs/:id` polls the provider directly if a job is still `processing` — covers missed webhooks and makes local dev work (webhooks can't reach localhost). Jobs can't get permanently stuck; don't remove this when touching the job routes.
5. `/api/files/*` streams stems from R2. It serves **only** keys under `stems/` — uploaded originals are intentionally never served back out (copyright posture).
6. **Listening Guy (the Listening Guide):** `src/assistant/` calls OpenRouter via plain fetch (`ASSISTANT_MODEL` is primary; `ASSISTANT_FALLBACK_MODELS` supplies independent tool-capable routes). OpenRouter handles provider/model errors, and one empty or broken pre-content stream is retried fallback-first; a partial response is never replayed. Both endpoints **stream SSE** (`data:` JSON events: `delta` prose → optional `tool_calls` → `done` carrying the full final text; failures after headers arrive as `error` events, while config/validation failures stay pre-stream JSON with real statuses, including the documented 503 when unconfigured). `POST /api/jobs/:id/guide` generates a one-time **opening message** (~80 words: genre → one mixer move → one question; the Listening Guide teaches turn-by-turn in chat, not via a long spiel), cached in the `guides` table and shared class-wide. Cache rows carry the fixed-prompt version, effective policy fingerprint, and amendment revision: an in-flight old generation cannot repopulate the cache after a teacher edit, and an old or content-mismatched fixed-prompt row regenerates lazily. Each racing caller receives the same final text it was streamed, while the last revision-current write becomes the shared cache. The cached guide rides along on `GET /api/jobs/:id`. `POST /api/jobs/:id/chat` is stateless chat — history is client-held (≤12 turns) and resent per call — whose replies may carry server-validated mixer tool calls (`solo`/`set_mute`/`seek`/`add_note`, per-job stem enums) that `public/app.js` executes on the Mixer; `add_note` reuses the annotations API. A tools-only model reply triggers one extra server-side narration call (`streamChat`) so the Listening Guide always speaks — expect up to two provider calls per chat turn. The browser also keeps a display-only per-song conversation archive in localStorage (`coachChat:<jobId>`), rendered as a collapsed "EARLIER SESSION" block after reload — the model still starts fresh. Both endpoints are class-code-gated (they cost money). The v3 system prompt lives in `src/assistant/prompt.ts` — pedagogy + guardrails (markdown banned — the UI's `coachHtml` absorbs bleed-through as a safety net; one idea per message ending with the ball in the student's court; no invented timestamps, no fabrication, student data fenced as data-not-instructions). Provider failures map to student-safe strings and never break the mixer — don't let assistant code paths become load-bearing for playback.

**The swappable seam:** all provider-specific code lives behind `SeparationBackend` (`src/separation/types.ts`): `start()` / `parseResult()` / `fetchStatus()`. Replicate is implemented (`replicate.ts`); Modal is a stub with implementation notes (`modal.ts`), planned as a cost experiment. Selected via the `SEPARATION_BACKEND` var. New providers go behind this interface — nothing else in the app should know about a provider.

**The split catalogue is data** (`src/separation/options.ts`). Each option is a contract (`id`, `stems`, `label`, `engine`) plus a `runners` map keyed by backend; presence of a runner is what makes the option available there, so `getSeparationOptions()` is a filter, not a branch. A Replicate runner owns its `versionVar`, its provider `input()`, and any `outputNames` rename — so **adding or repointing a choice is a data edit, never a backend edit**, and `replicate.ts` holds no model default of its own. Ids are provider-neutral contract ids (`vocals_instrumental`, not `htdemucs_ft_2s`) so an option can move providers without rewriting stored jobs. `getSeparationOptions()` projects options down to the four public fields — **runner wiring must never reach the browser**. The 2-track Replicate choice is Demucs karaoke mode (`stem: 'vocals'`), which returns `vocals`/`no_vocals` and renames `no_vocals` → `instrumental`; it separates fully then sums, so it costs the same as a 4-track split, not less. Swapping it to a hosted RoFormer later is a change to that option's `runners.replicate` and `engine` only. Guard the pin with `bun run check:replicate`; record a new provider's real output names with `bun run probe:replicate -- <option-id> <audio-url>` before trusting a rename map.

**Frontend** (`public/`, vanilla JS, no build step): the `Mixer` class in `app.js` plays all stems as parallel `HTMLAudio` elements — first stem is the master clock, others are nudged back if drift exceeds 80 ms (500 ms interval). Job list lives in localStorage; `mixers` Map preserves player state across re-renders. Visual language is a "studio console" theme (per-stem channel colors are CSS vars `--c-vocals` etc. in `styles.css`).

**Instructor console (`/teacher.html`):** teacher accounts + governed Listening Guide prompt amendments (`src/teacher/auth.ts`; provisioning runbook: `docs/teacher-provisioning.md`). Deliberately **not** gated by the class code — every student holds that shared secret, so it cannot guard class-wide prompt controls; an e2e test asserts that the class code gets 401 here. Passwords are PBKDF2-HMAC-SHA256 (210k iterations, per-user salt) and never appear in the repo, D1, arguments, or logs: `scripts/hash-teacher-password.mjs` reads stdin and emits a hashed `TEACHER_SEED` record. A valid seed is authoritative: listed accounts are upserted, omitted accounts are removed, password changes revoke that account's sessions, `[]` deprovisions all, and malformed seeds—including a supplied non-string display name—make no changes. The console shows the code-owned prompt read-only, initially at its tail; an upward caret focuses the prompt and brings its true first line into the viewport. The page versions its stylesheet and script together. Only the dedicated appended-instructions section is editable. Every changed save requires a changelog note and atomically updates settings, clears cached guides, and adds an `assistant_prompt_revisions` row with teacher, timestamp, `SYSTEM_PROMPT_VERSION`, base fingerprint, and effective fingerprint; optimistic concurrency prevents stale overwrites. Row-level triggers make existing history immutable to update, delete, and replacement/conflicting insert paths, while authenticated newest-first keyset pagination exposes every retained revision in bounded 40-row pages; database access remains restricted against privileged schema changes. Fixed-prompt changes must pass backward through source review by editing `src/assistant/prompt.ts`, incrementing the version, and updating `docs/prompt-changelog.md`. No-op saves do none of those. Migrations: `db:migrate:4`, then `db:migrate:5`, with prompt-aware guide caching in `db:migrate:7`, content identity in `db:migrate:12`, and history immutability in `db:migrate:13`; audio-routing metadata is the independently gated `db:migrate:6`.

**Shared labels & annotations:** `jobs.labels` JSON column (`PUT /api/jobs/:id/labels`, full-map replace) and an `annotations` D1 table (`POST/DELETE /api/jobs/:id/annotations[/:annotationId]`); both ride along on `GET /api/jobs/:id`, so any student viewing a job sees them. Writes require the class code; reads stay unauthenticated-but-unguessable. In the mixer: click a channel name to rename; "＋ NOTE" stamps the current time; all notes render in an always-visible list under the channels (timecode click = jump, ✕ on hover = delete) with matching ticks on the seek bar. Seek scrubbing previews while dragging and commits one multi-stem seek on release — don't re-introduce per-`input` seeks (they stall 6 buffers) or unconditional `paint()` slider writes (they fight the drag). Known UX limit: another student's edits appear only after a page reload (polling stops once a job is `done`). Migrations: `schema.sql` is the canonical fresh-install schema; additive changes ship as `migrations/000N-*.sql` with a matching `db:migrate:N[:local]` script pair **and** the same change appended to `schema.sql` (already applied: `:2` labels/annotations, `:3` guides, `:4` teacher auth/settings, `:5` prompt history, `:6` Auto routing metadata, `:7` prompt-aware guide cache identity, `:12` guide policy fingerprint, `:13` prompt-history immutability, `:14` instrument-discovery feedback, `:15` query-isolation budget reservations, `:16` query-isolation output ingestion). Feature work ships with a spec+plan docs pair under `docs/superpowers/` — mirror the 2026-07-09 / 2026-07-24 pairs.

## Configuration

- `wrangler.jsonc` is the source of truth: account id (ailab — `452c33847…`, not the Veritas account), D1 id, R2 bucket, vars. Wrangler must be logged in as `ailab@gc.cuny.edu` — a personal Cloudflare login isn't a member of the ailab account, and every write (deploy, `secret put`) fails with `Authentication error [code: 10000]`. Check with `bun run wrangler -- whoami`; fix with `bun run wrangler -- logout` then `login` as ailab. `R2_BUCKET_NAME` and `CF_ACCOUNT_ID` vars must match the actual bucket/account because presigned URLs are built from them.
- Secrets (set via `wrangler secret put`): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, `WEBHOOK_SECRET`, `CLASS_CODE`, `OPENROUTER_API_KEY`, `TEACHER_SEED`. Local equivalents go in `.dev.vars` (see `.dev.vars.example`); generate and rotate the teacher seed only through `docs/teacher-provisioning.md`.
- `REPLICATE_MODEL_VERSION` is a pinned version hash of `ryan5453/demucs`. **Never bump it blind to `latest_version`.** Upstream (`Ryan5453/demucs-next`) has already changed shape at source: its HEAD serves only `htdemucs` (no `htdemucs_ft`, no `htdemucs_6s`) and renamed `output_format` → `format`. That build is not published yet, so the current pin is fine — but the moment it is, a blind bump silently breaks the 4- **and** 6-track splits. To bump: get the candidate hash (`curl -s https://api.replicate.com/v1/models/ryan5453/demucs -H "Authorization: Bearer $TOKEN" | jq -r .latest_version.id`), then **vet it before deploying** with `REPLICATE_MODEL_VERSION=<candidate> bun run check:replicate`, which verifies the candidate still accepts every model id and input key the catalogue sends. Only then `wrangler secret put` and deploy.
- After changing `PUBLIC_BASE_URL` or webhook logic, redeploy — Replicate posts webhooks to the deployed URL.

## Local dev

`bun run dev` uses `--remote` on purpose: presigned URLs point at the **real** R2 bucket. The `LOCAL_DEV=1` Audio Separator path and Funnel-backed `LOCAL_HOSTING=true` path instead use simulated D1/R2. Both local modes stream only fixed-length uploads, HMAC-sign temporary source URLs, and perform hourly 30-day cleanup. `bun run test:e2e` covers the complete browser/upload/job/poll/stem flow with the on-disk WAV/MP3 fixtures in `tests/fixtures/audio` and a mocked Replicate boundary — including both import paths (YouTube → 6 tracks, YouTube → 2 tracks with the `no_vocals` rename) and the **quiet-but-valid** case: a six-track split whose `guitar`/`piano` come back near-silent must reach `done`, because the blank-stem gate rejects unplayable audio, not quiet audio. Listening Guy endpoints 503 by design without `OPENROUTER_API_KEY` in `.dev.vars` (mixer unaffected).

`scripts/run-real-audio-e2e.sh` is the *live* browser harness: same Playwright flow, real separation, no mocks. `BACKEND=audio-separator` (default) runs the local Python separator for free; `BACKEND=replicate` runs the paid provider and is the only way to exercise a real YouTube import in the browser. Provider webhooks cannot reach localhost, so a Replicate run there completes through the reconciliation fallback — that is the point, not a workaround. Supply exactly one of `SOURCE_AUDIO` or `YOUTUBE_URL`; no default song ships in the repo.

## Where this runs now: Railway until the product is finished

Two hosts can run the same Hono app, but they are not currently peers.
**Railway's Node host is the active integration, acceptance, and release
target.** Cloudflare Workers is the deferred finished-product migration; do not
deploy unfinished work there.

| | **Railway** (`server/`) | **Cloudflare Workers** (`src/`) |
|---|---|---|
| Role | active integration and releases | deferred finished-product target |
| Storage | `node:sqlite` + a volume at `/data` | D1 `stem-splitter` + R2 `stem-splitter-audio` |
| Deploy | `railway up --detach` | `bun run deploy` |
| Retention | in-app hourly cleanup | R2 bucket lifecycle rule |
| Audience | current testers and instructors | future class release |

Use Railway now. Beyond its tight iteration loop, it provides the **publicly
reachable origin** localhost cannot fake: under `LOCAL_HOSTING=true` the app
hands Replicate an HMAC-signed `/api/local-sources/` URL and expects a webhook
back at `/api/webhooks/separation`. On localhost both are unreachable, so jobs
finish only through reconciliation. Railway exercises the real webhook and
signed-source round trip end to end.

Migrate to Cloudflare only after the user declares the complete product
finished. Its managed bindings and platform lifecycle policy remain the final
hosting goal, not the current release path.

**The trap: nothing on Railway promotes itself.** It has its own SQLite
database, audio volume, and secrets. Jobs, stems, labels, notes, prompt history,
and guides created there will not exist in Cloudflare after migration unless a
separate data plan handles them. Railway validation proves the current release;
it does not prove the later Worker migration or its CPU/subrequest limits.

`server/CLAUDE.md` is authoritative for the active host — the shims, canonical
Railway service, and verify loop. Its core rule still governs both directories:
`server/` adapts to `src/`; shared application behavior remains in `src/` so the
later migration does not fork the product.

### Deferred finished-product migration to Cloudflare

Do not run this sequence while Railway is the active target. Once the user
declares the product finished and authorizes migration, run in order; each step
gates the next.

```sh
bun run wrangler -- whoami                            # must be ailab@gc.cuny.edu, else writes fail: Authentication error [10000]
bun run typecheck && bun run test:worker && bun run test:e2e
bun run check:replicate                        # pin still accepts every catalogue model id and input key
bun run wrangler -- deploy --dry-run --outdir dist    # config/bundle validation, no deploy
bun run db:migrate:4                          # existing D1 only; idempotent
bun run db:migrate:5                          # prompt history must exist before new code runs
bun run db:migrate:6                          # additive Auto routing metadata
bun run db:migrate:7                          # prompt-aware guide version/revision identity
bun run db:migrate:8                          # optional isolation resource
bun run db:migrate:9                          # stored-source SHA-256 identity
bun run db:migrate:10                         # isolation rollout stage
bun run db:migrate:11                         # write-once source locator/hash guards
bun run db:migrate:12                         # effective prompt fingerprint cache identity
bun run db:migrate:13                         # append-only prompt-history triggers
bun run db:migrate:14                         # immutable instrument-discovery feedback
bun run db:migrate:15                         # query-isolation budget reservations
bun run db:migrate:16                         # query-isolation output ingestion identity
bun run deploy
CLASS_CODE=<code> ./scripts/smoke.sh           # against the deployed Worker
```

Then confirm the things that live outside the bundle and so survive no deploy on their own:

- Any new `migrations/000N-*.sql` applied to **remote** D1 (`bun run db:migrate:N`) — Railway applies `schema.sql` on every boot and needs no migration, so a schema change can pass there and be missing in production.
- R2 lifecycle rule and CORS still applied (see Operational invariants) — both are bucket state, not code.
- Every secret set for the Worker: `wrangler secret put` is per-environment, and Railway variables are a separate set.
- `PUBLIC_BASE_URL` in `wrangler.jsonc` matches the deployed URL — Replicate posts webhooks there, so a stale value strands jobs on the fallback path.

## Real-audio evaluation

The contract gate only checks track *names*. `scripts/eval-stems.mjs` checks the *audio*: per-track level (distinguishing "quiet but valid" from blank, per the 2026-07-30 spec), pairwise correlation (catches a provider returning the same file under two names), and reconstruction of the mix from the summed tracks. Reconstruction thresholds differ by split type and this matters — a **complementary** split (the 2-track karaoke mode, where `no_vocals` is the arithmetic sum of the other sources) must reconstruct to better than −20 dB, while independently estimated 4/6-track splits get −12 dB. A single lenient threshold passes a deliberately mis-renamed 2-track split; don't merge them. The 4/6-track figure is provisional until calibrated against a real run.

Known blind spot: reconstruction cannot detect two stems being **swapped** (the sum is identical either way), so a sub-200 Hz energy comparison flags a likely vocals/instrumental swap as a WARN. It is a heuristic — confirm by ear.

**The eval tool has its own ground truth: `bun run eval:selftest -- <audio-file>`.** It builds exact partitions with ffmpeg, so every expected verdict is known by construction rather than by listening, and it is free. Run it after any change to `eval-stems.mjs` — two real defects were found this way, one in each direction. A single lenient threshold once *passed* a mis-renamed 2-track split at 91.6%; and aligning each track to the source independently once *failed* a split that sums exactly, because a bass-dominated track's correlation peak wanders a few samples and the relative shift destroys the sum (−72 dB → −4 dB). Tracks in one result share a single decode and therefore a single delay: **sum first, align once.** That second bug false-FAILed every correct split, 2- and 6-track alike, so a corpus run against it would have condemned a working pipeline.

When building ground truth, note that cascaded ffmpeg `highpass`/`lowpass` bands do **not** partition a signal — they are IIR, so they shift phase and cross over at −3 dB, and four such bands reconstruct at only ~77%. Build partitions by successive subtraction, and leave headroom so the parts cannot clip.

`tests/corpus/corpus.json` holds the evaluation corpus with per-source adversarial expectations; `scripts/run-audio-corpus.mjs` drives it through a deployment. No audio ships in the repo (house rule): the eleven `kind: file` entries point at derivative-safe CC recordings under the gitignored `tests/corpus/audio/`, and the two `kind: youtube` entries ship with a blank `source` because the spec requires a caller-supplied URL and no license can be asserted over an arbitrary video. A blank `source` is **skipped with a notice, not an error** — one unfilled URL must not take the ready entries down with it — but naming that slug on the command line *is* an error, because that is a request to run it. For YouTube sources the original mix is unretrievable by design (`/api/files/*` serves only `stems/`), so those are scored by **cross-model consistency** instead: two different splits of the same recording must sum to the same audio. That needs two models per entry — a one-model YouTube entry measures nothing.

## Operational invariants

- The R2 bucket `stem-splitter-audio` has a **30-day auto-delete lifecycle rule** — this is the copyright/retention mitigation, not an optimization. Keep it; (re)apply with `bun run wrangler -- r2 bucket lifecycle add stem-splitter-audio --expire-days 30`.
- Simulated local R2 must preserve the same boundary: expired objects are rejected on read and local API traffic runs hourly cleanup, including catch-up after restart.
- Bucket CORS (`cors.json`, note the `{"rules": [...]}` wrapper R2 requires) allows direct browser PUTs; needed for presigned uploads to work. (Re)apply with `bun run wrangler -- r2 bucket cors set stem-splitter-audio --file cors.json`.
- Stems are MP3 (192 kbps), not WAV — keeps storage ~10× smaller.
- Stem URLs are unauthenticated but unguessable (UUID job ids) so `<audio>` tags work without headers. Accepted trade-off for class scale.
- Cost model: ~$0.045/song on Replicate; first job after idle absorbs a 30–60 s model cold start (the UI warns about this). Listening Guy adds ≈$0.005 per guide (generated once, cached forever) and fractions of a cent per chat turn on GLM-5.2.
