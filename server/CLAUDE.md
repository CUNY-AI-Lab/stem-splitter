# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Scope: the **active Railway Node host**. Railway is the integration, live
acceptance, and release target until the user declares the product finished;
Cloudflare Workers migration is deferred until then. The root `CLAUDE.md`
remains authoritative for shared application code under `src/`. Read this one
when working in `server/`, releasing to Railway, or doing local end-to-end work.

## The rule that governs everything here

The Railway Node service is production until the product is finished. Keep the
shared Hono application platform-neutral: if a Node shim cannot express a
binding surface that `src/` already uses, fix the shim. Do not edit shared
application behavior merely to accommodate the adapter, because that silently
drifts the future migration target from the active host.

Corollary: `src/` has no import of anything in `server/`. The shared
`tsconfig.json` checks the application, while `tsconfig.server.json` checks the
Node adapter plus the shared source against the exact Node runtime types. Keep
both static gates; runtime tests still exercise the SQLite/filesystem shims.

## Three ways to run this app, and when each applies

| Mode | Storage | Separation | Use it for |
|---|---|---|---|
| `npm run dev` (`wrangler dev --remote`) | **real** D1 + R2 | Replicate | Verifying against production infra. Presigned URLs point at the live bucket — uploads here are real. |
| `npm run dev:local` + `npm run separator:local` | simulated D1/R2 (Miniflare) | local BS-RoFormer via `local-separator/` | Offline work with no cloud spend. Needs `uv`. `LOCAL_DEV=1`, `SEPARATION_BACKEND=audio-separator`. |
| `npm start` (this directory) | `node:sqlite` + a real directory | Replicate | Railway, and any time you need a **publicly reachable** origin. |

The third mode exists because of one constraint the other two can't satisfy: Replicate must be able to *reach back*. Under `LOCAL_HOSTING=true` the app hands the provider an HMAC-signed `/api/local-sources/` URL built from `PUBLIC_BASE_URL`, and the provider posts results to `/api/webhooks/separation`. On localhost both are unreachable — jobs only complete via the reconciliation fallback in `GET /api/jobs/:id`. On Railway the public domain makes both work, so this is the only setup that exercises the real webhook path and is currently the release target.

The active service is the Node/Railpack `stem-splitter` service
`f53a2915-087c-493a-a345-7a1fa73e6588`, in production environment
`b3381640-1e2f-4765-8e15-15baec599ec2` of Railway project
`f070742b-3375-4cba-9a86-335f39273c88`. Do not substitute the same-named legacy
project or its newer `web` service whose `Dockerfile.worker` runs workerd inside
Railway; that still uses a Worker runtime and is outside the current hosting
rule. A local Railway link is not authority: inspect its IDs before every write.

## Commands

```sh
npm start                 # run the Node host (needs WEBHOOK_SECRET and CLASS_CODE)
npm run dev:node          # same, with watch
bun run typecheck:server  # static check for server/ plus shared src/
DATA_DIR=/tmp/ss PORT=8899 WEBHOOK_SECRET=s CLASS_CODE=c npm start   # throwaway instance
```

Separation, YouTube import, analysis, coach, and teacher credentials
(`REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`,
`REPLICATE_YT_MODEL` + `REPLICATE_YT_MODEL_VERSION`,
the shadow-only `REPLICATE_AUDIOSEP_VERSION`,
the dormant `QUERY_ISOLATION_COURSE_ID` + `QUERY_ISOLATION_SEMESTER_ID` +
`QUERY_ISOLATION_MAX_PROVIDER_STARTS` budget policy,
`AUDIO_ANALYSIS_URL` + `AUDIO_ANALYSIS_TOKEN`, `OPENROUTER_API_KEY`, and
`TEACHER_SEED`) are **not** required to boot—see "Fail-fast vs. fail-lazy"
below. Without `TEACHER_SEED`, the instructor console has no provisioned
account. Generate its pre-hashed authoritative array through
`docs/teacher-provisioning.md`; never place plaintext credentials in Railway
variables.

Railway (canonical IDs are intentionally explicit because two projects share
the `stem-splitter` name):

```sh
railway status --json             # inspect IDs; never infer authority from the name
railway link --project f070742b-3375-4cba-9a86-335f39273c88 --environment b3381640-1e2f-4765-8e15-15baec599ec2 --service f53a2915-087c-493a-a345-7a1fa73e6588
railway up --detach --project f070742b-3375-4cba-9a86-335f39273c88 --environment b3381640-1e2f-4765-8e15-15baec599ec2 --service f53a2915-087c-493a-a345-7a1fa73e6588 -m "<summary>"
railway deployment list --json --project f070742b-3375-4cba-9a86-335f39273c88 --environment b3381640-1e2f-4765-8e15-15baec599ec2 --service f53a2915-087c-493a-a345-7a1fa73e6588
railway logs --build --lines 100 --project f070742b-3375-4cba-9a86-335f39273c88 --environment b3381640-1e2f-4765-8e15-15baec599ec2 --service f53a2915-087c-493a-a345-7a1fa73e6588
```

Setting a variable redeploys unless `--skip-deploys` is used. Stage coordinated
release variables with `--skip-deploys`, then deploy the reviewed commit once;
always re-verify the live URL afterward. Never print `railway variable --json`
or `--kv` output because both include raw secret values.

## Architecture

`server/index.ts` builds an `Env` by hand and calls `app.fetch(request, env)` — `src/index.ts` is `export default app`, a plain Hono app with no `scheduled` handler and no `waitUntil`, which is what makes this port a thin one. All app routes live under `/api/*`; everything else is served from `public/` the way Workers assets would be.

`server/d1.ts` and `server/r2.ts` implement **only the binding surface `src/` actually uses**, not the full Cloudflare API:

- **D1** — `prepare().bind().first()/run()/all()`, `batch()`, `meta.changes`. `bind()` returns a *new* statement rather than mutating, matching D1; code in `src/` relies on that. `undefined` is coerced to `null` because `node:sqlite` rejects it.
- **R2** — `put/get/head/delete/list`, plus the `R2Object` fields the call sites touch: `size`, `uploaded`, `httpMetadata`, `writeHttpMetadata(headers)`, and a streamed `body`. `writeHttpMetadata` is easy to miss; `/api/files/*` depends on it for content types.

Objects are stored flat: `encodeURIComponent(key)` as the filename under
`blobs/`, with a sidecar JSON in `meta/` carrying
`size`/`uploaded`/`contentType`. `put()` streams into unique temporary files and
serializes writers per key; the prior complete blob remains visible until the
new blob commits, so a concurrent browser PUT cannot splice its versions into
an authoritative Auto snapshot. Blob and meta are each renamed only after the
stream finishes. `uploaded` lives in the sidecar rather than on the filesystem
because the 30-day retention logic in `src/r2.ts` reads `object.uploaded`, and
mtime would be wrong after any copy or restore.

`schema.sql` is applied on every boot and is canonical for fresh databases.
`CREATE TABLE IF NOT EXISTS` cannot add a column to a table already stored on
the persistent Railway volume, so `SqliteD1.applyNodeMigrations()` immediately
follows it with idempotent additive upgrades. Every new persistent-column
change needs both the canonical schema and a Node migration regression test.
Numbered `migrations/` remain deferred Cloudflare D1 migration inputs.

## Fail-fast vs. fail-lazy

`WEBHOOK_SECRET` and `CLASS_CODE` are required at boot and `process.exit(1)` if absent — every request path needs them, so booting without them only produces confusing 500s later.

`REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, the YouTube model/version
pair, the dormant AudioSep version and course-semester budget, the analysis
URL/token pair, `OPENROUTER_API_KEY`, and `TEACHER_SEED` are
checked lazily. This is deliberate: without them, upload, mixer, labels, notes,
and stem playback all still work. `/healthz.configuration` reports only
value-free `configured`/`unconfigured`/`incomplete`/`invalid` states and rollout
flag states; these report configuration, not a network probe. Startup logs warn
without printing values. A missing analyzer makes Auto
record and use the explicit four-track fallback. Making these variables fatal
would crash-loop the whole service over optional features. Keep this split when
adding credentials—ask whether a missing value should take down playback.

## Parity constraints across environments

These are properties of the app, not of the host, so the shims must not quietly break them:

- **`/api/files/*` serves only `stems/`.** Uploaded originals are never served back out. Verify with a request for an `uploads/…` key; it must 404.
- **30-day retention.** `src/r2.ts` enforces expiry on read and runs hourly cleanup whenever `isLocalHosting(env)` is true, which it is here. `list()` must keep returning accurate `uploaded` values or retention silently stops working.
- **Uploads are fixed-length only.** `src/index.ts` rejects chunked and oversized
  uploads *before* reading the body. `put()` streams the accepted body to disk;
  do not reintroduce a full 100 MB application buffer. Shared authoritative Auto
  also streams its source snapshot, and its analyzer/separator URLs must retain
  the same app-owned key.
- **`WEBHOOK_SECRET` is environment-specific.** It signs source URLs; use a
  fresh random value for local/test environments and never copy the Railway
  production value into them.

## Railway specifics

The canonical service IDs are listed above. It has a volume mounted at `/data`
and `DATA_DIR=/data`. The volume is load-bearing: without it every deploy resets
the database and all audio. Confirm persistence after infrastructure changes by
re-POSTing a key uploaded before a restart—`400 Upload not found` means the
volume is not holding.

`PUBLIC_BASE_URL` is derived from `RAILWAY_PUBLIC_DOMAIN` when unset, so the domain must exist before the container starts for webhooks to resolve. Builder is Railpack; `engines.node` is pinned to exact `22.23.1`, matching CI and the declared Node types, because `node:sqlite` is what the D1 shim is built on.

## Verifying a deploy

Reaching `SUCCESS` says the container started, not that the app works. The checks worth running against the live URL, in order of what they actually prove:

1. `GET /healthz` — echoes the resolved `PUBLIC_BASE_URL` and value-free optional-service configuration state. This is not a network readiness probe: verify the analyzer's own `/readyz` separately. Wrong base means webhooks will fail; `incomplete` or `invalid` means the related optional path must not be enabled.
2. `POST /api/uploads` then `PUT` the returned `uploadUrl` — note the field is `uploadUrl`, not `url`.
3. `POST /api/jobs` — a 200 proves the provider accepted the signed source URL, which is the part localhost cannot test.
4. Poll `GET /api/jobs/:id` to `done`, then fetch each stem and check the leading bytes are an MP3 sync word (`fffb`) or `ID3`. Hash them: equal sizes are normal for short fixtures, identical *hashes* would mean the same file was stored under several names.

`POST /api/jobs/:id/chat` takes `{"messages": [...]}` — `turns` is the internal name and will 400.

## Tests

`npm run test:e2e`, `npm run test:e2e:auto`, and
`npm run test:e2e:isolation-shadow` run against Miniflare, not this host, so
they are necessary but not sufficient for a change here.
`npm run test:server` covers additive SQLite migration and value-free runtime
configuration reporting. The public signed-source and webhook round trip still
requires a real Railway flow.
