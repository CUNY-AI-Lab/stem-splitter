# Isolated Cloudflare candidate

## September 8 integration

Current work is Cloudflare-only. `codex/cloudflare-migration` contains the
Crate-to-song implementation (`d7f25b5`) and the deployed Crate-first removal
merged at `b473fea`. Do not merge this branch into Railway's release path.
Remixer stays false-default pending signed-in live audio acceptance.

CUNY sign-in uses Doorway's existing `WorkerIdentity` private RPC entrypoint,
not a new Tools mount or a second CUNY OIDC client. The two deployed service
bindings pin `cail:stem-splitter` to the canonical and preview callback hosts
separately. Each host keeps its own Secure, HttpOnly, SameSite=Lax `__Host-`
cookie. `/auth/login` generates state and S256 PKCE; `/auth/callback` validates
the initiating cookie and redeems Doorway's one-use code. No identity JWT or
CUNY token is exposed to browser JavaScript. POST `/auth/logout` revokes the
app session; it does not sign the user out of other CUNY applications.

Protected requests discard browser identity/authorization headers, resolve the
opaque session through Doorway, then retain the existing exact JWT verifier,
fresh Admission check, expiring instructor grants and recording ownership.
Writes require the exact app origin. Provider webhooks and signed source reads
remain independent capability routes. No provider settings or data are migrated.

Reference: CUNY AI Lab knowledge base `9143fb9ee14c6438318613b82493743c10b74cc9`,
[Tool Integration Contract](https://github.com/CUNY-AI-Lab/cail-knowledge-base/blob/9143fb9ee14c6438318613b82493743c10b74cc9/05%20Infrastructure/CAIL%20Tool%20Integration%20Contract.md)
and [Doorway](https://github.com/CUNY-AI-Lab/cail-knowledge-base/blob/9143fb9ee14c6438318613b82493743c10b74cc9/05%20Infrastructure/CAIL%20Doorway.md).
The actual protocol is owned by `cail-tools-admission/apps/doorway/docs/WORKER-SIGN-IN.md`.
Doorway's current source `f71a918` and serving version
`74dfb950-341b-4102-87cc-dc1a0516253c` were read back before enabling this caller.
Shared Doorway, Admission and Railway are not deployed by this change.

Local sign-in tests use a synthetic RPC receiver; browser tests use synthetic
identities/Admission and provider fixtures. They do not establish a real CUNY
callback. Deployment and actual sign-in/reload/logout must be verified separately.
This integration retains the approved Replicate and Listening Guide transports;
the separate Gateway proposal is not silently merged with authentication work.

Railway is still production. This directory targets only
`cail-stem-splitter-preview` in CUNY AI Lab account
`452c33847cf5cb1e46f391fca32fd1b5`; never use the root legacy deploy command.

## Established Worker address

The user authorized replacing the stale app at
`https://stem-splitter.ailab-452.workers.dev` with this candidate on September 6.
`wrangler.alias.jsonc` deploys a streaming service-binding front door to the
same candidate runtime. It does not duplicate its code, database, audio,
provider secrets or authentication. The browser stays on the requested address.
`CANONICAL_BASE_URL` explicitly selects that origin for same-origin writes and
provider callbacks; arbitrary caller origins remain rejected. Preview remains
available, and Railway remains unchanged. This is not a readiness/SSO sign-off.

From a verified committed release tree, deploy the candidate first, then:

```sh
bunx --no-install wrangler deploy --config wrangler.alias.jsonc --dry-run
bunx --no-install wrangler deploy --config wrangler.alias.jsonc
```

The former `stem-splitter` deployment is retained for rollback; its legacy
database and bucket are not deleted or imported. Do not run root `bun run deploy`,
which would replace this front door with the obsolete application again.

Listening Guy uses the candidate's `OPENROUTER_API_KEY` and `ASSISTANT_MODEL`.
Absent `ASSISTANT_FALLBACK_MODELS`, the shared client enables its reviewed
fallback defaults; only an explicitly empty value disables them. `/healthz`
reports configuration presence without revealing keys or making paid calls.
Provider-stream checks are separate from authenticated end-to-end acceptance.

Verified transfer (2026-09-06, implementation commit `f4d9810`): candidate
version `b4e2cdc8-82db-4174-a8c1-6e791985ef15`, established-address version
`aa0cb403-6f74-4a3e-93ee-dd4739a1c3d0`, each deployed at 100%. All eleven
public assets at the established address match that release byte-for-byte.
Health confirms Listening Guide and fallback configuration; the approved
OpenRouter key returned streamed text separately from GLM 5.2, Claude Haiku
4.5 and Gemini 3 Flash Preview. These are provider checks, not signed-in live
guide acceptance. The Worker-origin handoff above supersedes the proposed mount.

Local gates: 318 shared tests, 12 adapter/security tests, 19 browser regression
tests and the candidate student/instructor/admin/Remixer browser journey passed.
Live Chrome checks at 1280×900 and 390×844 confirm the enlarged logo, no
horizontal overflow, and navigation to `https://ailab.gc.cuny.edu/`. The only
console errors were expected anonymous 401s on account/instructor endpoints.
The previous established-address version is
`2fcbbbef-fdf2-48cb-9449-71ccc5b90b4f`; previous candidate code version is
`91f6db43-30e3-4d4a-8022-fdec6986904c`. No storage was deleted or migrated.

## Development and verification

From the repository root, run `bun install --frozen-lockfile`. Then:

```sh
cd cloudflare
bun install --frozen-lockfile
bun run typecheck
bun run test
../node_modules/.bin/playwright test --config playwright.config.mjs
bunx --no-install wrangler deploy --dry-run
```

Run root `test:worker`, `test:server`, `test:analysis-service`, `test:e2e`,
`test:e2e:auto`, and `test:e2e:isolation-shadow` as separate regression gates.
The adapter pins Wrangler 4.129.0 to test the September compatibility date;
root package/lock files are deliberately unchanged because they are inputs
to the accepted analyzer image evidence. See `vendor/README.md` for SDK provenance.

`test-worker.ts` and `test-wrangler.jsonc` are local fixture entrypoints only.
The deployment entrypoint is `worker.ts`; never deploy the test configuration.
Tests mint local RS256 identities and simulate Admission/Replicate. They do not
claim a real CUNY login, live provider quality, or full-load acceptance.

## Data and access

- Fresh D1: `cail-stem-splitter-preview`, ID `ae01c5db-c19e-48c8-91bd-132876276f22`.
- R2: `cail-stem-splitter-preview-audio`; 30-day expiry and one-day incomplete
  multipart cleanup. No public bucket access and no S3 credentials are needed.
- Fresh schema: `wrangler d1 execute cail-stem-splitter-preview --remote --file ../schema.sql`.
- Existing schema upgrades: explicitly execute `../migrations/0018-workspace-access.sql`
  against the intended database after backup. No Railway database is migrated by this work.
- Identity: exact `cail:stem-splitter` audience, canonical Doorway issuer and
  pinned public JWKS. The private `AdmissionResolver` binding rechecks membership
  each protected request. Network/config failures deny access with 503.
- New admitted members become students. Ordinary students/instructors access
  only owned recordings and folders. An Admission admin can manage workspace
  roles in `/account.html`; grants need an expiry and changes are revision-checked.
- Admission owns enrollment and CUNY sign-in. Do not seed legacy passwords or
  infer roles from JWT display/entitlement claims. Real CUNY handoff remains a release gate.
- Application reservations currently cap split attempts at 5/person/day and
  20/workspace/day, and guide/chat attempts at 100/person/day and 500/workspace/day
  (UTC). Failed/uncertain requests consume a reservation. YouTube may use two
  provider predictions per split; these are job caps, not an exact dollar budget.
- The edge IP rate limiter is supplemental and approximate, not spend authority.

## Candidate deployment

Check `wrangler whoami`, the exact account and config, then dry-run. Put secrets
through Wrangler stdin, never arguments, Git, logs or screenshots. Reuse only
the existing approved Replicate key/pins and Listening Guide settings. Generate
a distinct candidate webhook secret. Copy no teacher seed, CUNY signing key,
session cookie, class code, existing user rows or audio.

`CAIL_IDENTITY_JWKS` is public verifier material fetched only from
`https://tools.ailab.gc.cuny.edu/cail-sso/.well-known/jwks.json`; do not learn a
key URL from a submitted token. Coordinate public-key rotation with Doorway.

`REMIXER_ENABLED`, server Auto, discovery and isolation remain off in the
candidate config. Keep `AUTH_MODE=cail`; missing authentication configuration
must fail closed. Do not add a development bypass to the deployed Worker.

The `/healthz` endpoint checks D1 and identifies the candidate release. A 200
does **not** establish SSO, R2, provider, analyzer or guide readiness. The full
promotion gates and rollback sequence are in `../MIGRATION.md`.
