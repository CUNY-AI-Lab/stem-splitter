# Stem Splitter: Railway-to-Cloudflare migration plan

**Updated:** 2026-08-11

**Status:** Planning authority only. This file does not authorize a deployment.

**Active release target:** Railway until the user declares the product finished.

**Cloudflare target:** The verified CUNY AI Lab Enterprise account, not an
unverified account or the legacy identifiers currently committed in
`wrangler.jsonc`.

**AI decision:** Prefer Cloudflare AI Gateway for the Listening Guide if it
passes the predeclared gates in this document. Direct OpenRouter is the
rollback path, not the preferred final architecture.

## Decision summary

The finished application should move from the Railway Node host to a
Cloudflare Worker with static assets, D1, and R2. Replicate or another reviewed
external compute service should continue to perform long-running GPU stem
separation. The bounded Auto analyzer and any later instrument-classification
or query-isolation services should also remain separate compute services until
each workload independently proves that a Cloudflare runtime is a better fit.

AI Gateway is the presumptive control plane for Listening Guide inference. The
migration should first place the existing OpenRouter request behind an
authenticated AI Gateway custom provider, preserving the current
`z-ai/glm-5.2` behavior. In parallel, the exact Cloudflare-hosted
`@cf/zai-org/glm-5.2` model should be evaluated through AI Gateway. If the
Cloudflare-hosted route passes the same streaming, tool-calling, prompt,
privacy, quality, reliability, latency, and cost gates, it becomes the favored
production route and removes OpenRouter from the primary path.

This preference does not permit an invisible model change. A route or model
may be promoted only through a versioned, reviewable configuration change with
recorded evaluation evidence and a reversible rollout.

## Boundary: what does and does not migrate

### Current architecture

```text
Browser
  -> Railway Node host + static files
       -> SQLite job, guide, teacher, and prompt state
       -> Railway volume for originals and stems
       -> Replicate Demucs and yt-dlp services
       -> direct OpenRouter for the Listening Guide
       -> private Railway analysis services when separately enabled
```

### Preferred finished architecture

```text
Browser
  -> Cloudflare Worker + static assets
       -> D1 for relational state
       -> R2 for originals and stems with lifecycle deletion
       -> Replicate or another reviewed external GPU service
       -> authenticated AI Gateway
            -> Workers AI GLM-5.2 when it passes the gates
            -> OpenRouter custom provider as the tested fallback
       -> private external analysis services when separately enabled
```

AI Gateway governs text-model traffic. It does not run Demucs, FFmpeg, the
Auto analyzer, instrument discovery, AudioSep, SAM-Audio, or another musical
source-separation pipeline. Technically proxying every HTTPS model endpoint
through one gateway would not make those asynchronous, signed-URL and webhook
workloads safer or easier to operate.

## Platform mapping

| Current Railway responsibility | Cloudflare target | Migration rule |
|---|---|---|
| `server/index.ts` Node entry point | `src/index.ts` Worker entry point | Keep the shared Hono application authoritative; do not fork product behavior by host. |
| Static files from `public/` | Worker static assets | Preserve versioned assets and all desktop/mobile browser acceptance checks. |
| `node:sqlite` state | D1 | Rehearse a fresh schema and a production snapshot; preserve triggers and immutable history. |
| `/data` audio volume | R2 | Use scoped signed URLs, verified uploads, and a 30-day lifecycle rule. |
| Hourly application cleanup | R2 lifecycle plus defensive application checks | Prove expiration behavior; do not rely on a dashboard setting without readback. |
| Direct OpenRouter request | AI Gateway, preferably Workers AI GLM-5.2 | Promote only after the gates below pass. |
| Replicate Demucs | External GPU provider | Keep the pinned provider contract and webhook/poll reconciliation. |
| Replicate yt-dlp fallback | External import provider | Retain unless Cloudflare egress is proven reliable against the real import corpus. |
| Private Auto analyzer | Separate private compute service | Keep fail-lazy and feature-flagged; do not place audio decoding in the Worker. |
| Future instrument/query services | Separate reviewed services | Preserve `off -> shadow -> teacher beta -> bounded authority`; evaluate Containers only as a later, independent decision. |
| Railway secrets | Worker secrets, Secrets Store, or AI Gateway BYOK | Rotate at cutover; never copy values into Git or logs. |

## AI Gateway target and fallback order

The order below is deliberate.

1. **Baseline: direct OpenRouter.** Preserve the current implementation as the
   control and rollback path.
2. **Gateway transport: OpenRouter custom provider.** Route the unchanged
   OpenAI-compatible request through an authenticated AI Gateway. Keep the
   existing OpenRouter model slug and `provider.data_collection: "deny"`.
3. **Preferred candidate: Workers AI GLM-5.2 through AI Gateway.** Evaluate
   `@cf/zai-org/glm-5.2` against the same fixtures and teacher rubric. Favor
   this route if it passes.
4. **Dynamic routing only after separate approval.** Do not enable automatic
   cross-model fallback, A/B routing, or spend-limit fallback in the first
   release. Those features change observable model behavior and require their
   own route version, evaluation, changelog entry, and rollback evidence.

The Railway host can call AI Gateway over HTTPS before the application moves
to a Worker. This makes the provider transition independently testable and
does not violate the Railway-first release boundary.

### Proposed transport configuration

The names below are a design target, not current environment variables:

```text
ASSISTANT_TRANSPORT=openrouter-direct|aig-openrouter|aig-workers-ai
AI_GATEWAY_ACCOUNT_ID=<verified Enterprise account>
AI_GATEWAY_ID=<explicit staging or production gateway>
AI_GATEWAY_TOKEN=<secret; never a browser value>
ASSISTANT_MODEL=<transport-specific pinned model identifier>
OPENROUTER_API_KEY=<needed only for an OpenRouter transport>
```

Refactor the hard-coded endpoint in `src/assistant/openrouter.ts` behind a
small provider-neutral transport. Do not alter prompt assembly, guide caching,
tool schemas, student-safe error messages, or the prompt-governance model as
part of that refactor. An omitted or invalid transport must fail closed to the
current friendly Listening Guide error while leaving the mixer operational.

Use explicit staging and production gateway IDs. Cloudflare AI Gateway API
tokens are account-scoped rather than gateway-scoped, so gateway names alone
are not a security boundary. Prefer a Worker-side binding at the final target;
while Railway calls the REST endpoint, use a dedicated minimum-permission
token and separate Cloudflare accounts when strict staging/production
isolation is required.

## AI Gateway privacy and governance defaults

Listening Guide requests can contain song metadata, class annotations,
conversation history, and teacher-appended instructions. Apply these defaults
before any real class traffic enters AI Gateway:

- Require an authenticated gateway.
- Set the gateway default to avoid payload collection and send
  `cf-aig-collect-log-payload: false` on every request. Metadata-only logs may
  retain provider, model, status, token count, cost, and duration.
- Never put class codes, teacher usernames, song titles, annotations, prompt
  text, conversation text, signed source URLs, or audio identifiers into AI
  Gateway custom metadata. Use only environment, application version, fixed
  prompt version, effective prompt fingerprint, and a non-identifying trace ID.
- Keep Gateway response caching off. The application D1 guide cache remains
  authoritative and is already keyed to governed prompt provenance. Streaming
  responses and prompt-specific conversations must never reuse another
  request's response.
- Keep the existing OpenRouter `provider.data_collection: "deny"` control on
  the custom-provider path.
- Do not treat Cloudflare Zero Data Retention as a substitute for these
  controls. ZDR applies to supported Unified Billing provider routes and does
  not control AI Gateway's own logs or a custom-provider/BYOK route.
- Store an OpenRouter key through AI Gateway BYOK/Secrets Store when the
  verified Enterprise configuration supports the reviewed custom provider.
  Otherwise keep it in a server-side secret only; never send it to the
  browser.
- Disable automatic Gateway retries initially. The application currently
  bounds a pre-stream `429` retry; layered retries can duplicate cost or blur
  partial-stream failure semantics.
- Add request-rate and spend limits after measuring the staging baseline.
  Reaching a limit should return the existing student-safe unavailable state,
  not silently select a cheaper model.
- Do not automatically fail open from AI Gateway to direct OpenRouter. Roll
  back through the reviewed transport flag so bypassing enterprise controls is
  visible and auditable.

The fixed system prompt remains code-owned and read-only. Teacher amendments
remain the only browser-editable prompt layer, with immutable revision history,
fixed/effective prompt hashes, actor, timestamp, and change note. Provider and
AI Gateway route identities should be added to evaluation and operational
provenance; they must not weaken the rules in
`docs/teacher-provisioning.md` or `docs/prompt-changelog.md`.

## AI Gateway promotion gates

Define numerical latency, cost, and quality thresholds before a live test;
do not select them after seeing the result. Promotion requires all of the
following.

### 1. Deterministic contract gate

- Mocked direct, gateway-custom-provider, and Workers AI transports exercise
  synchronous and streaming responses.
- SSE framing, `[DONE]`, fragmented JSON, tool-call argument accumulation,
  finish reasons, aborts, and empty or malformed responses match the existing
  application contract.
- The guide and chat paths retain their token caps, bounded history,
  class-code checks, prompt fingerprint, guide-cache invalidation, and
  student-safe error mapping.
- Explicit tests cover `401`, `403`, credit/billing failure, `429`, `5xx`,
  timeout, connection abort, and failure after a partial stream.
- A concrete model identifier is recorded for every generated guide and
  evaluation; no request persists an unresolved dynamic alias.

### 2. Privacy and security gate

- An authenticated staging request succeeds and an unauthenticated request
  fails.
- Dashboard/API readback proves prompt and response bodies are absent from AI
  Gateway logs while the approved operational metadata remains available.
- Provider keys and Gateway tokens are absent from Worker output, application
  logs, browser responses, source maps, and test artifacts.
- No signed audio URL or class/user identifier reaches AI Gateway.
- Token scope, rotation ownership, incident response, retention, and log
  access are approved for the Enterprise account.

### 3. Behavioral and teacher-quality gate

- Use frozen synthetic or properly authorized fixtures covering guide
  generation, follow-up chat, mixer tool calls, and prompt amendments.
- Compare the current OpenRouter baseline, AI-Gateway-to-OpenRouter path, and
  Workers AI GLM-5.2 path with a rubric declared before review.
- Tool target, timestamp, mute/solo action, annotation behavior, and refusal
  boundaries must have no contract regression.
- A named teacher/domain reviewer records blinded judgments for usefulness,
  musical accuracy, unsupported claims, instructional tone, and adherence to
  the effective prompt.
- Do not dual-submit live student or teacher content to multiple providers for
  shadow comparison without a separate privacy approval. Prefer synthetic and
  licensed evaluation inputs.

### 4. Reliability, latency, and cost gate

- Measure first-token and completion latency, stream interruption rate,
  provider errors, rate-limit behavior, token usage, and estimated cost on the
  fixed evaluation workload.
- Confirm that the Gateway does not buffer the Listening Guide stream or alter
  tool-call deltas in a way the current parser cannot handle.
- Exercise the spend limit and verify the bounded `429` user experience.
- Run a staged concurrency test sized to the expected class, then repeat the
  complete guide/chat browser journey.
- Record the tested gateway ID, transport version, exact model, fixed prompt
  version/SHA, effective prompt SHA, evaluation corpus version, date, and
  result in a durable acceptance artifact.

### 5. Rollout gate

Promote through:

```text
off/control -> AI Gateway with OpenRouter -> Workers AI teacher beta
            -> bounded canary -> production authority
```

Each transition requires an explicit configuration diff, acceptance artifact,
and tested flag-only rollback. Failure at any gate keeps or returns the system
to the last passing transport. Passing the OpenRouter-through-Gateway gate is
enough to favor AI Gateway as the control plane even if the Workers AI model
candidate does not yet pass.

## Migration phases

### Phase 0: finish and freeze the Railway release

- Complete or explicitly waive every release blocker in `TODO.md`, including
  authorized teacher-console persistence and restart acceptance and every
  audio-pipeline promotion gate intended for the finished product.
- Capture a fresh Railway rollback baseline and repeat real upload,
  YouTube/Archive import, separation, playback, annotation, guide, teacher,
  persistence, and download journeys.
- Freeze model versions, classifier versions, prompt versions, schema, public
  assets, and retention policy for the migration window.
- The user explicitly declares the product finished and authorizes Cloudflare
  staging. Until then, stop here.

### Phase 1: verify the Enterprise target

- Authenticate as the approved CUNY AI Lab Enterprise identity.
- Inventory accounts, zones, existing Worker names, D1 databases, R2 buckets,
  AI Gateways, Secrets Store entries, custom domains, and billing controls.
- Treat the account, database, bucket, URL, and account ID currently committed
  in `wrangler.jsonc` as legacy/unverified until each is matched to the
  approved Enterprise tenant. Never deploy to them by inference.
- Decide whether staging and production require separate accounts because AI
  Gateway Run tokens are account-scoped.
- Record owners for DNS, billing, privacy, incidents, secret rotation, and
  rollback.

### Phase 2: introduce and evaluate AI Gateway from Railway

- Add the provider-neutral Listening Guide transport and false-default
  configuration.
- Create authenticated staging and production gateways in the verified
  account, but send only synthetic/authorized staging traffic first.
- Run the direct OpenRouter control, OpenRouter custom-provider candidate, and
  Workers AI GLM-5.2 candidate through all promotion gates.
- Select AI Gateway as the preferred route if it passes. Prefer Workers AI as
  its provider if that candidate also passes; otherwise use the passing
  OpenRouter custom-provider route.
- Keep Railway as the application host throughout this phase so the provider
  and hosting changes do not share one failure surface.

### Phase 3: provision isolated Cloudflare staging

- Create new staging Worker, D1 database, and R2 bucket in the verified
  Enterprise target. Do not reuse production-looking legacy resources merely
  because their names match.
- Apply `schema.sql` for a fresh database and prove that it matches the result
  of the complete numbered migration chain.
- Apply R2 CORS and the 30-day lifecycle policy, then read both back.
- Configure scoped R2 signing credentials, webhook secret, class code,
  teacher seed, model pins, optional-service flags, and the selected AI
  Gateway transport through secret stores and environment variables.
- Keep all optional audio-pipeline flags false until their independent
  Railway evidence is deliberately promoted to staging.

### Phase 4: rehearse data movement

Choose one complete policy; do not copy a convenient subset that breaks
referential or prompt-history provenance.

**Preferred policy: drain ephemeral class state and start clean.** Stop new
Railway jobs, allow the 30-day audio retention window to expire, preserve only
approved immutable governance/evaluation evidence, rotate teacher credentials,
and begin the Cloudflare class release with fresh job state.

**Continuity policy, only if required:**

- Take a read-only SQLite snapshot and an explicit volume object manifest.
- Classify each table and object as required, expired, or prohibited before
  export.
- Never migrate teacher sessions. Rotate/reseed teacher credentials and the
  class code.
- Preserve prompt revision order, actor references, timestamps, fixed prompt
  version/SHA, effective SHA, amendments, change notes, and immutability
  triggers.
- Preserve source hashes and object byte hashes; verify row counts,
  foreign-key relationships, trigger behavior, object sizes, content types,
  and sampled decoded audio after import.
- Copy only unexpired originals/stems when continuity is explicitly approved,
  and set their new expiration relative to the original creation time rather
  than resetting retention.
- Rehearse twice against disposable D1/R2 resources and produce a value-free
  reconciliation report before touching production.

### Phase 5: Cloudflare staging acceptance

- Run all typechecks and unit/integration suites against the exact candidate
  commit.
- Run the full browser suites against Worker assets, D1, and R2.
- Prove presigned upload, Replicate source fetch, authenticated webhook,
  polling reconciliation, ordered 2/4/6 stem output, playable MP3s, download,
  labels, annotations, reload persistence, and 30-day expiration.
- Prove upload, YouTube, and Archive flows use server-authoritative Auto only
  when its reviewed flags are enabled and use the explicit concrete fallback
  during analyzer failure.
- Prove teacher login, amendment save, restart persistence, immutable history,
  prompt cache invalidation, logout scrubbing, and the footer instructor link.
- Prove the selected AI Gateway route through real streaming guide/chat and
  mixer-tool journeys while payload logging remains disabled.
- Run the pinned Replicate and YouTube checks; a successful Worker build or
  HTTP health response is not production acceptance.

### Phase 6: production cutover

- Capture final Railway and Cloudflare baselines and publish the exact
  rollback criteria, owners, and maximum acceptable recovery point.
- Enter a brief maintenance/drain window; do not dual-write SQLite and D1.
- Apply the final approved state transfer, rotate secrets, deploy the exact
  accepted commit, and move the custom domain or traffic rule.
- Repeat health, configuration, browser, provider-backed audio, teacher, and
  AI Gateway acceptance against the public production hostname.
- Keep Railway intact but non-authoritative during a defined soak period.
  Any writes accepted after cutover need a documented reconciliation path
  before a rollback; DNS reversal alone cannot reconcile D1 back to SQLite.

### Phase 7: retirement

- After the soak and acceptance sign-off, export the final approved Railway
  audit snapshot, remove public routing, revoke provider and Railway secrets,
  and delete retained audio according to policy.
- Remove Railway only after confirming that no analyzer or other private
  service still depends on its private network or volume.
- Update `README.md`, `TODO.md`, operational runbooks, cost estimates, and
  architecture diagrams so they no longer describe Railway as active.
- Keep this migration record and its acceptance artifacts; do not rewrite
  them into a claim that the migration was always complete.

## Cutover acceptance checklist

- [ ] The user has declared the product finished and authorized Cloudflare staging and production.
- [ ] The Enterprise account, account ID, zone, and resource ownership are verified.
- [ ] No deployment command targets a legacy or personal Cloudflare account.
- [ ] AI Gateway passes its contract, privacy, quality, reliability, latency, cost, and rollback gates.
- [ ] The chosen AI route and exact model are versioned and recorded.
- [ ] D1 fresh-schema and upgrade-path parity passes.
- [ ] R2 CORS, signing, object integrity, and lifecycle expiration pass.
- [ ] The selected data policy is rehearsed and reconciled.
- [ ] Replicate source fetch, webhook, polling, and 2/4/6 output pass on the public target.
- [ ] Upload, YouTube, Archive, Auto/fallback, and long-tail feature posture pass.
- [ ] Teacher provisioning, prompt editing, immutable history, restart persistence, and logout pass.
- [ ] Full desktop/mobile browser acceptance passes against the public target.
- [ ] Observability contains no secrets, prompts, responses, signed audio URLs, or teacher/student content.
- [ ] Spend/rate controls and friendly failure behavior pass.
- [ ] Rollback is exercised before DNS/traffic authority changes.
- [ ] Railway remains recoverable through the approved soak period.

## Rollback principles

- Hosting rollback: restore traffic to the last accepted Railway deployment.
- AI rollback: change the reviewed transport flag to the last passing route;
  do not add an automatic direct-provider bypass.
- Audio-pipeline rollback: disable optional flags first, preserving the explicit
  four-stem fallback and historical traces.
- Data rollback: restore only from a validated snapshot and reconcile all
  post-cutover writes. Never overwrite D1 or SQLite merely to make row counts
  match.
- Secret rollback: rotate forward. Do not restore an exposed or superseded
  secret value.
- A failed migration does not authorize deleting the Cloudflare or Railway
  evidence needed to diagnose it.

## Current blockers at the time of writing

- The product has not been declared finished; Railway remains authoritative.
- `TODO.md` still contains human review, live teacher, native-image, service
  provisioning, and audio-pipeline promotion gates.
- The approved Enterprise account has not been positively matched to the
  identifiers committed in `wrangler.jsonc`.
- Local Wrangler is not authenticated in this checkout.
- AI Gateway has not yet been integrated or evaluated against Stem Splitter's
  streaming, tool-calling, prompt-governance, privacy, and teacher-quality
  requirements.
- No D1/R2 data-movement rehearsal or public Cloudflare production acceptance
  has been completed for the current v3.2 branch.

## Repository authorities

- Current architecture and deployment commands: `README.md`
- Outstanding implementation and promotion order: `TODO.md`
- Railway runtime: `server/CLAUDE.md`
- Auto analyzer provisioning: `docs/railway-audio-analysis-provisioning.md`
- Teacher provisioning and prompt governance: `docs/teacher-provisioning.md`
- Fixed prompt history: `docs/prompt-changelog.md`
- Audio processing versions and decisions: `docs/model-processing-changelog.md`
- Shared application and deferred Worker entry point: `src/index.ts`
- Current Listening Guide provider seam: `src/assistant/openrouter.ts`
- Fresh D1 schema and additive migrations: `schema.sql` and `migrations/`

## Cloudflare references

- [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Custom Providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Bring Your Own Keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [AI Gateway dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [Workers AI GLM-5.2](https://developers.cloudflare.com/ai/models/%40cf/zai-org/glm-5.2/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1](https://developers.cloudflare.com/d1/)
- [R2](https://developers.cloudflare.com/r2/)
