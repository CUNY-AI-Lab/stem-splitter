# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Scope: the **active Railway Node host**. Railway is the integration, live
acceptance, and release target until the user declares the product finished;
Cloudflare Workers migration is deferred until then. The root `CLAUDE.md`
remains authoritative for shared application code under `src/`. Read this one
when working in `server/`, releasing to Railway, or doing local end-to-end work.

## The rule that governs everything here

`server/` must never require a change to `src/`. The Worker is production; this is a host that adapts *to* it. If a shim can't express something `src/` does, fix the shim — an edit under `src/` to accommodate Node is a bug in this directory, and it silently drifts the two targets apart.

Corollary: `src/` has no import of anything in `server/`, and `tsconfig.json` scopes `tsc --noEmit` to `src` only. `server/` is type-checked by nothing; it is exercised by running it.

## Three ways to run this app, and when each applies

| Mode | Storage | Separation | Use it for |
|---|---|---|---|
| `npm run dev` (`wrangler dev --remote`) | **real** D1 + R2 | Replicate | Verifying against production infra. Presigned URLs point at the live bucket — uploads here are real. |
| `npm run dev:local` + `npm run separator:local` | simulated D1/R2 (Miniflare) | local BS-RoFormer via `local-separator/` | Offline work with no cloud spend. Needs `uv`. `LOCAL_DEV=1`, `SEPARATION_BACKEND=audio-separator`. |
| `npm start` (this directory) | `node:sqlite` + a real directory | Replicate | Railway, and any time you need a **publicly reachable** origin. |

The third mode exists because of one constraint the other two can't satisfy: Replicate must be able to *reach back*. Under `LOCAL_HOSTING=true` the app hands the provider an HMAC-signed `/api/local-sources/` URL built from `PUBLIC_BASE_URL`, and the provider posts results to `/api/webhooks/separation`. On localhost both are unreachable — jobs only complete via the reconciliation fallback in `GET /api/jobs/:id`. On Railway the public domain makes both work, so this is the only setup that exercises the real webhook path and is currently the release target.

The active service is the Node/Railpack `stem-splitter` service in Railway
project `f070742b-3375-4cba-9a86-335f39273c88`. Do not substitute the newer
`web` service whose `Dockerfile.worker` runs workerd inside Railway; that still
uses a Worker runtime and is outside the current hosting rule.

## Commands

```sh
npm start                 # run the Node host (needs WEBHOOK_SECRET and CLASS_CODE)
npm run dev:node          # same, with watch
DATA_DIR=/tmp/ss PORT=8899 WEBHOOK_SECRET=s CLASS_CODE=c npm start   # throwaway instance
```

Separation, coach, and teacher credentials (`REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, `OPENROUTER_API_KEY`, `TEACHER_SEED`) are **not** required to boot — see "Fail-fast vs. fail-lazy" below. Without `TEACHER_SEED`, the instructor console has no provisioned account. Generate its pre-hashed authoritative array through `docs/teacher-provisioning.md`; never place plaintext credentials in Railway variables.

Railway (project `stem-splitter`, workspace Inference Arcade):

```sh
railway link --project stem-splitter --service stem-splitter --environment production
railway up --detach -m "<summary>"
railway deployment list --json   # poll until status is SUCCESS — `up` returning only means the build started
railway logs --build --lines 100
railway variable set "NAME=value" --service stem-splitter   # any set triggers a redeploy
```

Setting a variable redeploys, so batch changes when you can, and always re-verify the live URL afterward rather than assuming the old container's behavior carried over.

## Architecture

`server/index.ts` builds an `Env` by hand and calls `app.fetch(request, env)` — `src/index.ts` is `export default app`, a plain Hono app with no `scheduled` handler and no `waitUntil`, which is what makes this port a thin one. All app routes live under `/api/*`; everything else is served from `public/` the way Workers assets would be.

`server/d1.ts` and `server/r2.ts` implement **only the binding surface `src/` actually uses**, not the full Cloudflare API:

- **D1** — `prepare().bind().first()/run()/all()`, `batch()`, `meta.changes`. `bind()` returns a *new* statement rather than mutating, matching D1; code in `src/` relies on that. `undefined` is coerced to `null` because `node:sqlite` rejects it.
- **R2** — `put/get/head/delete/list`, plus the `R2Object` fields the call sites touch: `size`, `uploaded`, `httpMetadata`, `writeHttpMetadata(headers)`, and a streamed `body`. `writeHttpMetadata` is easy to miss; `/api/files/*` depends on it for content types.

Objects are stored flat: `encodeURIComponent(key)` as the filename under `blobs/`, with a sidecar JSON in `meta/` carrying `size`/`uploaded`/`contentType`. Blob and meta are each written to a temp file and renamed, so a crash can't leave a meta entry pointing at a half-written blob. `uploaded` lives in that sidecar rather than on the filesystem because the 30-day retention logic in `src/r2.ts` reads `object.uploaded`, and mtime would be wrong after any copy or restore.

`schema.sql` is applied on every boot. It is idempotent (`CREATE TABLE IF NOT EXISTS`) and canonical — it already contains everything the numbered migrations add, so the `migrations/` files are irrelevant here. They exist for the production D1 instance, which was created before those columns.

## Fail-fast vs. fail-lazy

`WEBHOOK_SECRET` and `CLASS_CODE` are required at boot and `process.exit(1)` if absent — every request path needs them, so booting without them only produces confusing 500s later.

`REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, `OPENROUTER_API_KEY`, and `TEACHER_SEED` are checked lazily and only warn. This is deliberate: without them, upload, mixer, labels, notes, and stem playback all still work; a missing teacher seed leaves the instructor console unprovisioned, while a separation attempt returns the backend's own error. Making them fatal would crash-loop the whole service over a feature most of the app doesn't need. Keep this split when adding credentials — ask whether a missing value should take down playback.

## Parity constraints with production

These are properties of the app, not of the host, so the shims must not quietly break them:

- **`/api/files/*` serves only `stems/`.** Uploaded originals are never served back out. Verify with a request for an `uploads/…` key; it must 404.
- **30-day retention.** `src/r2.ts` enforces expiry on read and runs hourly cleanup whenever `isLocalHosting(env)` is true, which it is here. `list()` must keep returning accurate `uploaded` values or retention silently stops working.
- **Uploads are fixed-length only.** `src/index.ts` rejects chunked and oversized uploads *before* reading the body. `put()` buffers fully (100 MB ceiling, enforced upstream), which is fine only because those checks come first.
- **`WEBHOOK_SECRET` here is not production's.** It signs source URLs; a fresh random value per environment is correct. Don't copy prod's in.

## Railway specifics

Service `stem-splitter` in project `stem-splitter`, environment `production`, with a volume mounted at `/data` and `DATA_DIR=/data`. The volume is load-bearing: without it every deploy resets the database and all audio. Confirm persistence after infrastructure changes by re-POSTing a key uploaded before a restart — `400 Upload not found` means the volume isn't holding.

`PUBLIC_BASE_URL` is derived from `RAILWAY_PUBLIC_DOMAIN` when unset, so the domain must exist before the container starts for webhooks to resolve. Builder is Railpack; `engines.node >= 22.5` matters because `node:sqlite` is what the D1 shim is built on.

## Verifying a deploy

Reaching `SUCCESS` says the container started, not that the app works. The checks worth running against the live URL, in order of what they actually prove:

1. `GET /healthz` — echoes the resolved `PUBLIC_BASE_URL`; wrong value here means webhooks will fail later.
2. `POST /api/uploads` then `PUT` the returned `uploadUrl` — note the field is `uploadUrl`, not `url`.
3. `POST /api/jobs` — a 200 proves the provider accepted the signed source URL, which is the part localhost cannot test.
4. Poll `GET /api/jobs/:id` to `done`, then fetch each stem and check the leading bytes are an MP3 sync word (`fffb`) or `ID3`. Hash them: equal sizes are normal for short fixtures, identical *hashes* would mean the same file was stored under several names.

`POST /api/jobs/:id/chat` takes `{"messages": [...]}` — `turns` is the internal name and will 400.

## Tests

`npm run test:e2e` runs against Miniflare, not this host — it validates `src/`, so it is necessary but not sufficient for a change here. There is no automated coverage of `server/` itself; the shims are verified by running the real flow against a deployment.
