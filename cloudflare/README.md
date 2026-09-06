# Isolated Cloudflare candidate

Railway is still production. This directory targets only
`cail-stem-splitter-preview` in CUNY AI Lab account
`452c33847cf5cb1e46f391fca32fd1b5`; never use the root legacy deploy command.

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
  infer roles from JWT display/entitlement claims. The live Doorway mount is still a release gate.
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
