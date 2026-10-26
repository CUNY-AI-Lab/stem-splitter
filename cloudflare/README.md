# Cloudflare deployment

## Current production check — October 26, 2026

On October 26, 2026 at 03:22 UTC, the canonical app reported release
`aa12a79b29011c5193faa97c1a8c58287f1e2ea3`. Guest splitting was enabled
with a five-split daily limit; guest Listening Guy was disabled
(`chatAvailable: false`, `chatLimit: null`, `chatLimitScope: session`).
The two-successful-reply guest contract is implemented, but this check does not
establish its activation.

The live **Share with** selector applies to new work and starts at Personal,
including visits through a course link. Its acknowledgment permits instructor
review. Classmate access requires an instructor's folder permission and
**Save sharing**. Shared playback uses **Start shared session** and explicit
**Follow instructor**; periodic cues allow a short delay between devices.
See [classroom access](../docs/classroom-access.md) and
[guest access](../docs/guest-access.md). The dated candidate and release records
below retain their original scope.

## Reliability and guest candidate — October 6, 2026

The PR3 source replaces historical attempt counting with 15 successful member
splits and 50 human Listening Guy inputs per UTC submission day, durable
reservations/recovery, bounded import validation and redacted usage evidence.
The optional guest path has separate 5/25 allowances and private ownership;
it remains disabled until separately approved bot verification and Gateway
sponsor configuration are installed. See [the operation/migration runbook](../docs/reliability-operations.md),
[guest access gates](../docs/guest-access.md) and [local verification](../docs/evidence/reliability-20261006/verification.md).
These are candidate source semantics, not a deployment or permission change.
The dated ten-attempt/visitor-disabled receipts below describe the older release.

## Classroom candidate — October 6, 2026

The prospective course implementation and migration `0021` are described in
[the classroom access contract](../docs/classroom-access.md). This is source and
local/test evidence, not a deployment receipt. Historical work stays private;
production migration, Admission release, and live acceptance require their
separate release gates. `TODO.md` records the coordinated PR1–PR3 status.
The [local acceptance record](../docs/acceptance/classroom-2026-10-06.md) lists
test results, screenshots, migration rehearsal and dependency-audit limits.

## Dev Worker — October 17, 2026

`wrangler.dev.jsonc` deploys `stem-splitter-dev` at
`https://stem-splitter-dev.ailab-452.workers.dev` with its own D1
(`stem-splitter-dev`, `c66d920f-dd3f-417f-9949-438d50128d56`), R2
(`stem-splitter-dev-audio`, 90-day expiry, 1-day incomplete-multipart abort),
queue (`stem-splitter-dev-adaptive-output`), rate-limit namespace and secrets.
`cail-stem-splitter-preview` remains the production runtime behind the
`stem-splitter` alias; it is not renamed, redeployed or read by the dev Worker.
Workers cannot be renamed, so "renaming the preview" would mean deleting
production, which this change does not do.

Sign-in uses one `IDENTITY` binding whose `worker` prop is `stem-splitter-dev`;
Doorway derives the callback from that prop, so no Doorway registration is
needed. `CANONICAL_BASE_URL` equals the dev origin so the adapter selects that
binding. Guest access is off on dev, which keeps Turnstile and guest-cookie
secrets out of it. `ASSISTANT_MODEL`, `REPLICATE_YT_MODEL` and
`YOUTUBE_FETCH_ORDER` are plain vars on dev.

From this directory: `bun run db:migrate:dev` applies `schema.sql` and the
numbered migrations (duplicates are no-ops), `bun run deploy:dev:check` is the
dry run, `bun run deploy:dev` deploys. Secrets go through stdin:
`WEBHOOK_SECRET` (fresh random) and `CAIL_IDENTITY_JWKS` (the public JWKS) are
set at creation; `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION` and
`REPLICATE_YT_MODEL_VERSION` are set by the operator, and splits fail closed
with the existing provider-configuration message until they exist. `/healthz`,
anonymous denial and a real CUNY sign-in on the dev origin are the acceptance
checks; they do not attest to production.

## Release authority and October 17, 2026 receipt

The canonical app is https://stem-splitter.ailab-452.workers.dev/. Release from
`codex/cloudflare-migration`, not Railway's `main`. The current source baseline includes PR #41 for instructor-controlled Archive
examples and consistent rotation. The runtime Worker remains named
`cail-stem-splitter-preview`; the canonical alias uses the same D1/R2 data.

Current daily split limits are 25 for instructors and administrators, 15 for
students and other signed-in Lab members (including signed-in guests), and five
for unsigned guest browser sessions. Failed or
cancelled splits release their reserved place; current Lab membership grants
personal access even without course enrollment. Account recovery and 90-day
upload retention remain released. The Listening Guide uses the private CAIL Gateway. Remixer, server
Auto, instrument discovery and public paid visitor runs remain disabled. See
[the current progression](../TODO.md) and [migration status](../MIGRATION.md)
for acceptance gates. Railway remains untouched, with its separate release and
data policies. Dated handoffs below are historical evidence, not current
deployment instructions where they conflict with this section.

## Guest-instructor course access — October 18, 2026

Course discovery and authorization use Admission V2 (`resolveCourseAccessV2`,
`listCourseAssignmentsV2`, and `listCourseRosterV2`) on every protected request.
The app strictly validates each assignment's `guestInstructor` flag and four
capabilities before opening course tools. V1 remains untouched for its other
consumers. A guest instructor stays a Lab member for personal workspace and
split limits; the guest grant reaches only its assigned class. Instructor
Settings opens at `/teacher.html?course=<classId>` and reads the base prompt,
edits that class's appended guidance, records a change note, and restores a
history snapshot as a new revision with the current revision check.
The demo class also shows one separate, display-only sample roster item; it has
no Admission identity, member ID, stored job, or paid split behind it.

The production Worker allowlist contains the existing musical-experience course
and `cail-teaching-tools-demo`, with `CAIL_CLASSROOM_ENABLED=true`. Admission
must grant the named CUNY identity the persistent guest-instructor role for the
demo class separately in each consuming app; this app never creates Lab-wide
membership, enrollment, invitations, or budget authority. Deploy Admission V2
before this Worker revision. From `cloudflare/`, run
`bunx --no-install wrangler deploy --dry-run` and then
`bunx --no-install wrangler deploy`. After the candidate is accepted, dry-run
and deploy the canonical alias with
`bunx --no-install wrangler deploy --config wrangler.alias.jsonc --dry-run` and
`bunx --no-install wrangler deploy --config wrangler.alias.jsonc`. Revert the
allowlist and classroom flag to `false` to close the app's course entry points.

## September 23 Gateway handoff

The candidate now sends Listening Guide and chat requests through the private
`GATEWAY` binding to `cail-model-api`, using exact `cail-client` 6.2.2,
`cail-identity` 5.2.6 and `cail-log` 0.6.4 packages. `GATEWAY_MODEL=glm-5.2`
is a prefix-free Gateway catalog ID. Check the current Gateway catalog before
release; the model was active when this handoff was prepared.

Doorway supplies separate app and Gateway JWTs. Model actions verify both exact
audiences and matching subjects before the shared app checks current Admission
and recording ownership. Only the Gateway leg leaves on the private binding.
Invalid verifier configuration returns 503 before cookie/token evaluation.

Each action makes one model attempt. It consumes trailing usage or failure
events through EOF, bounds response bodies and waiting, and propagates browser
cancellation. Tools-only replies get local narration. Safe refusal codes,
retry advice and support IDs remain available; provider text is never shown.
The Account page displays aggregate model quota when available. Gateway owns
model-spend enforcement; local Replicate split reservations remain separate.
Missing Gateway configuration fails closed, even if an old OpenRouter key
remains on the Worker. The adapter does not use that key or provider fallbacks.

This applies Steve's shared transport contract to the later Cloudflare product.
It preserves the single Crate, disabled Remixer default, owned recordings,
folders, app-local instructor access, and existing independent D1/R2 storage.
It does not import Railway's class-shared data or revive the Remixer assistant.

`cloudflare-candidate.yml` installs exact packages from public npm, tests the actual Worker/Hono/client boundary and
Chrome UI, and dry-builds only this candidate. It does not deploy. Root analyzer
dependency and existing native-image workflow inputs remain unchanged.
See `../docs/superpowers/plans/2026-09-23-cloudflare-gateway.md` for acceptance.

## Class access

The Cloudflare production and Workerd-test bundles alias Hono to the adapter's
patched `hono-cloudflare` pin (4.13.11). Keep the two alias maps aligned. The
root dependency lock belongs to the frozen native-analyzer evidence and is not
silently rebaselined by this Cloudflare release. Its older Hono dependency still
needs a separately validated update before rebuilding that host.

Active Lab class enrollment satisfies the existing Admission check, and the
first signed-in request creates the student's local app record. No second
student roster import is needed. Class enrollment, expiry and allowance scope
stay in Admission; instructor editing access remains a separate app grant with
an end date or an explicit **No end date** choice. Neither bypasses Admission.
Administrators can reach Lab class management from Account → Manage access.

See [class access and usage](../docs/class-access-and-usage.md) for the enrollment
workflow, current billing coverage and outstanding Replicate accounting work.

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
fresh Admission check, app-local instructor grants and recording ownership.
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
That sign-in release retained the approved Replicate and Listening Guide
transports. The September 23 source change above replaces only model transport.

At the September 8 handoff, Railway was the original production lane. This directory targets only
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

`/healthz` reports the candidate's private Gateway/model configuration without
revealing keys or making paid calls. Configuration presence is distinct from
authenticated end-to-end acceptance. The following September 6 receipt records
the older direct-provider deployment; it does not attest to this new source.

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

Use Bun 1.4.0 for this adapter's version-2 lockfile. From the repository root,
run `bun install --frozen-lockfile`. Then:

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
to the accepted analyzer image evidence. Adapter CAIL packages use exact versions and integrity hashes from public npm;
no GitHub Packages credential is required. `vendor/README.md` records the historical 5.2.5 SDK artifact.

`test-worker.ts` and `test-wrangler.jsonc` are local fixture entrypoints only.
The deployment entrypoint is `worker.ts`; never deploy the test configuration.
Tests mint local RS256 identities and simulate Admission/Replicate. They do not
claim a real CUNY login, live provider quality, or full-load acceptance.

## Data and access

- Fresh D1: `cail-stem-splitter-preview`, ID `ae01c5db-c19e-48c8-91bd-132876276f22`.
- R2: `cail-stem-splitter-preview-audio`; 90-day expiry and one-day incomplete
  multipart cleanup. No public bucket access and no S3 credentials are needed.
- Fresh schema: `wrangler d1 execute cail-stem-splitter-preview --remote --file ../schema.sql`.
- Existing schema upgrades: explicitly execute `../migrations/0018-workspace-access.sql`
  and `../migrations/0019-listening-conversations.sql` against the intended database
  after backup. No Railway database is migrated by this work.
- Identity: exact `cail:stem-splitter` audience, canonical Doorway issuer and
  pinned public JWKS. The private `AdmissionResolver` binding rechecks membership
  each protected request. Network/config failures deny access with 503.
- New admitted members become students. Ordinary students/instructors access
  only owned recordings and folders. An Admission admin can manage workspace
  roles in `/account.html`; grants require a future end date or an explicit
  **No end date** choice. Changes are revision-checked and immutably audited.
  A null `role_expires_at` on an instructor row means no end date; missing API
  expiry fields are rejected. Students never gain instructor access from a null
  date. Admission expiry, revocation, local disable and audio ownership still apply.
- Admission owns enrollment and CUNY sign-in. Do not seed legacy passwords or
  infer roles from JWT display/entitlement claims. Real CUNY handoff remains a release gate.
- This candidate caps signed-in splits at 10/person/day (UTC), with no shared
  class/workspace split ceiling. Visitor runs remain disabled. Gateway owns model quotas; this adapter does not reserve
  guide/chat attempts locally. Failed/uncertain split requests consume a
  reservation. YouTube may use two
  provider predictions per split; these are job caps, not an exact dollar budget.
- The edge IP rate limiter is supplemental and approximate, not spend authority.
- Listening Guy chat history is stored per owning CUNY subject and split, never
  shared across accounts, and expires at the split's fixed 90-day boundary.
  Wrangler runs its daily purge at 08:00 UTC.

## Candidate deployment

Check `wrangler whoami`, the exact account and config, then dry-run. Put secrets
through Wrangler stdin, never arguments, Git, logs or screenshots. Reuse only
the existing approved Replicate key/pins. Keep the verified Gateway service
binding and canonical model configuration. Generate
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

## Adaptive output queue

`ADAPTIVE_FOUR_ENABLED=true` advertises adaptive four and imported-source Auto.
Both use the existing pinned six-source prediction, then measure its real audio.
Create `cail-stem-splitter-adaptive-output` in the configured CUNY account before
the first release using this binding. The deployed consumer has one message per
batch, one concurrent invocation, twenty retries, and a 300000 ms CPU limit.
Messages contain only an existing job ID. The consumer rechecks stored intent,
provider state and the existing lease/fence; duplicates cannot create paid work.
Polls, completion webhooks and the minute scheduler enqueue publication.

Provision `cail-stem-splitter-adaptive-output-dlq` before deploying the consumer.
After twenty retries, Cloudflare moves an undeliverable message there instead
of discarding it. It has no automatic consumer. Inspect the source queue and
DLQ in Cloudflare Queues and correlate the job ID with D1 before manually
redriving a message. Redrive only an active job before its hard deadline;
duplicate deliveries still use the existing prediction and publication fence.
No source URLs, audio or credentials are placed in either queue.

Queue exceptions emit `adaptive_queue_failed`; reconciliation exceptions emit
`split_reconcile_failed`. Both include job ID, stage, a bounded error name and
a fixed diagnostic message. Raw exception text is deliberately excluded because
upstream failures can contain signed URLs or credentials. A CPU-limit termination
may skip application logging; inspect Cloudflare invocation outcomes as well.
The minute sweep and queue delivery terminally fail jobs at their 24-hour hard
deadline, even if a work lease or provider cooldown is still active. Settlement
releases allowance/capacity once and fences late publication; partial output is
cleaned by the ingesting worker when it can resume, or by R2 retention otherwise.

For rollback, prefer the same merged codec/queue-capable bundle with
`ADAPTIVE_FOUR_ENABLED=false`: this stops advertising new adaptive choices while
already accepted adaptive jobs can finish. Keep the queue and its consumer until
all accepted jobs are terminal. Do not roll an active adaptive job back to code
that does not understand its stored output contract. No schema migration or
provider version change accompanies this feature.

## Link import Worker

`cail-stem-import` (`link-import.jsonc`, entry `link-import-worker.ts`, logic in
`../src/link-import.ts`) owns every request to a host a person pasted. It has no
public route (`workers_dev: false`); the splitter reaches it only through the
`LINK_IMPORT` service binding.

- **Direct files and share links.** Dropbox, Google Drive, OneDrive and
  SharePoint links are rewritten to their direct downloads. Every redirect hop
  must pass the same public-HTTPS rules, and the app's own hosts are refused.
  MP3 (full frame syntax), WAV and FLAC (header fields checked against the byte
  count) are proven and written to R2 under the operation's fenced
  `uploads/<operation>/source-<fence>` key. Other containers, web pages and
  files over the native byte caps answer `hosted: true`, and the splitter uses
  the existing pinned ffmpeg importer, so the native path never refuses what the
  hosted path would accept.
- **YouTube links.** `POST /api/link-info` returns oEmbed title metadata and an
  Internet Archive search query. The app does not fetch YouTube audio; the UI
  runs the Archive song search and offers a local upload.
- **Flag.** `LINK_IMPORT_ENABLED` is `"true"` in production since 2026-10-18
  (`cail-stem-import` deployed first). With it set to `"false"`, or with the
  binding absent, every path behaves exactly as before.

Deploy order: deploy `cail-stem-import` first
(`wrangler deploy --config link-import.jsonc`). A splitter release that declares
the `LINK_IMPORT` binding fails to deploy while the target Worker is missing.
Turn the flag on only after that release; roll back by setting it to `"false"`.
