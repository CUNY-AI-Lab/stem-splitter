# Stem Splitter

A stem-separation web app for students. Upload a song, get back isolated
vocals / drums / bass / other as MP3s.

**Architecture:** Browser → presigned upload to R2 → Cloudflare Worker creates
a job (D1) → Replicate runs Demucs (`htdemucs_ft`) on a GPU → webhook marks the
job done → student streams MP3 stems from R2 → R2 lifecycle rule deletes
everything after 30 days.

- **~$0.045/song** on Replicate, scales to zero when idle (no GPU to manage).
- The separation provider lives behind one interface
  (`src/separation/types.ts`) — swap in Modal/RunPod/self-hosted Demucs later
  by implementing it and flipping `SEPARATION_BACKEND`.
- Audio bytes never flow through the Worker on upload (presigned PUT direct to
  R2), so there are no Worker body-size issues.

```
src/
  index.ts              Worker: routes for uploads, jobs, webhook, file serving
  env.ts                Bindings/vars/secrets types
  r2.ts                 Presigned URL helpers (aws4fetch)
  separation/
    types.ts            SeparationBackend interface (the swappable seam)
    replicate.ts        Replicate-hosted Demucs implementation
    modal.ts            Stub for a self-deployed Modal backend
public/                 Static frontend (vanilla JS)
schema.sql              D1 schema
cors.json               R2 CORS rules for direct browser uploads
```

## Deploying an existing clone (already-provisioned project)

If the Cloudflare resources already exist (this repo's `wrangler.jsonc` is
already filled in — bucket `stem-splitter-audio`, the D1 database, and the
account are committed), **do not run the `create` commands in the Setup
section below** — that's for standing up a brand-new copy from scratch.

To deploy from a fresh clone against the existing infrastructure:

```sh
npm install
npx wrangler login        # must have access to the account in wrangler.jsonc

# Set the six secrets (values from whoever owns the deployment):
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put REPLICATE_API_TOKEN
npx wrangler secret put REPLICATE_MODEL_VERSION
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put CLASS_CODE

npm run deploy
```

Check what's already set with `npx wrangler secret list`. The R2 bucket
(CORS + 30-day lifecycle rule) and D1 schema are already applied on the
account, so the bucket/D1/migration steps below should be skipped.

## Setup (new project from scratch)

Prereqs: Node 18+, a Cloudflare account, a [Replicate](https://replicate.com) account.

### 1. Install & authenticate

```sh
npm install
npx wrangler login
```

### 2. Create the R2 bucket

```sh
npx wrangler r2 bucket create stem-splitter-audio
```

Apply CORS so browsers can PUT directly to presigned URLs (tighten
`AllowedOrigins` to your deployed URL once you have it):

```sh
npx wrangler r2 bucket cors set stem-splitter-audio --file cors.json
```

Add the 30-day auto-delete lifecycle rule (this is the copyright/retention
mitigation — don't skip it):

```sh
npx wrangler r2 bucket lifecycle add stem-splitter-audio --expire-days 30
```

(If the CLI flags differ in your wrangler version, both CORS and lifecycle can
be set in the dashboard: R2 → bucket → Settings.)

Create an R2 API token (dashboard → R2 → "Manage R2 API Tokens" →
Object Read & Write, scoped to this bucket). Keep the key id + secret for
step 5.

### 3. Create the D1 database

```sh
npx wrangler d1 create stem-splitter
```

Paste the printed `database_id` into `wrangler.jsonc`, then:

```sh
npm run db:migrate
```

### 4. Fill in vars

In `wrangler.jsonc`, set:

- `CF_ACCOUNT_ID` — dashboard sidebar
- `PUBLIC_BASE_URL` — your Worker URL (you'll know it after the first deploy;
  deploy, then update and deploy again)

### 5. Set secrets

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put REPLICATE_API_TOKEN
npx wrangler secret put REPLICATE_MODEL_VERSION   # see below
npx wrangler secret put WEBHOOK_SECRET            # any long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put CLASS_CODE                # what students type to use the app
```

Get the current Demucs model version hash:

```sh
curl -s https://api.replicate.com/v1/models/ryan5453/demucs \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" | jq -r .latest_version.id
```

### 6. Deploy

```sh
npm run deploy
```

Update `PUBLIC_BASE_URL` in `wrangler.jsonc` with the printed URL and deploy
once more (Replicate posts completion webhooks to this URL).

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev                      # wrangler dev --remote
```

Notes:

- `--remote` is intentional: presigned URLs point at the **real** R2 bucket,
  so the local simulator's bucket would never see your uploads.
- Replicate can't reach `localhost` with webhooks. That's fine — the app
  reconciles by polling Replicate directly whenever a job status is fetched
  (`GET /api/jobs/:id`), so jobs still complete in local dev, just on the
  poll cadence.

## Costs (rough, per class of 20 students × 100 songs)

| Item | Cost |
|---|---|
| Replicate (Demucs, ~$0.045/song × 2,000) | ~$90/semester |
| R2 storage (MP3 stems, 30-day retention) | ~$1–2/month |
| R2 egress | $0 (free) |
| Workers + D1 | free tier at this volume |

## Swapping the separation backend

Everything provider-specific is behind `SeparationBackend`
(`src/separation/types.ts`): `start()`, `parseResult()`, `fetchStatus()`.

To move to **Modal** (deploy your own Demucs container, scale-to-zero GPUs,
likely cheaper — free monthly credits may cover a whole class):

1. Implement the Modal app + web endpoint (sketch in `src/separation/modal.ts`).
2. Fill in `modalBackend()`.
3. Set `SEPARATION_BACKEND=modal` in `wrangler.jsonc`.

Nothing else in the app changes.

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
