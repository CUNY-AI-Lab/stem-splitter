# Fleet integration proposal (source only)

Owner: Stem Splitter. Affected action: generating a Listening Guide or sending a
Listening Guy chat turn. Browser → existing Node host → cail-client 6.2.2 → CAIL
Gateway → Gateway-selected model provider. Identity verification uses
cail-identity 5.2.6; bounded scalar authorization events use cail-log 0.6.4.

Both model POST routes keep the class-code check and additionally verify the
Doorway app token for exact audience `cail:stem-splitter`, then the separate
`cail:gateway` token and equal subject. Tokens are request-local and never stored.
There is no personal ownership migration: jobs, labels, annotations, guides and
folders retain their existing class/teacher semantics. Teacher passwords and
sessions remain authoritative for the instructor console. Public job and stem
URLs stay usable. Cached guides remain class-shared, including public job reads.

Configure `CAIL_IDENTITY_JWKS`, canonical `CAIL_IDENTITY_ISSUER`,
`CAIL_GATEWAY_URL=https://tools.ailab.gc.cuny.edu/v1`, `ASSISTANT_MODEL`,
`CAIL_SOURCE_VERSION` (the exact 40-character deployed commit), and a private
`CAIL_READINESS_TOKEN`. `GET /api/fleet/readyz` requires the latter bearer token;
it fails closed when verifier, endpoint, model or source configuration is absent.
The endpoint confirms local configuration, not Gateway health or live acceptance.
Loopback HTTP Gateway URLs are allowed only with `LOCAL_DEV=1` for synthetic tests.
No provider key is used for Listening Guy. Quota, retries and provider selection
belong to Gateway; one chat request makes one model call. Tools-only replies use
local narration. SSE drains trailing usage/errors, preserves safe request IDs,
and propagates caller cancellation and per-job conversation affinity.

Replicate Demucs separation, YouTube fetch (including its Replicate fallback),
provider webhooks, signed source/storage URLs, and retention remain independent.
Their cost/accounting remains outside Gateway. This change neither meters nor
claims to centralize those costs. Existing provider retry behavior there remains.

## Release proposal and order

No deployment, mount activation or paid-provider calls are authorized by this
change. Production releases are CI-only. The active receiver remains the Railway
Node host; the Worker build is a dry compatibility check, not a migration.

1. Review and merge source only after the authoritative CI gates pass. Existing
   audio-analysis evidence pins `bun.lock`; changed dependencies require new
   canonical native-amd64 evidence and linked listening/promotion validation.
   Do not update a checksum to claim a run that did not happen. GitHub Packages
   installation uses the CI token with packages:read; the image receives it only
   through a BuildKit secret, never a build argument or persistent image ENV.
2. A dedicated protected-environment release workflow must run from `main`, with
   `concurrency: stem-splitter-production`, `cancel-in-progress: false`, reject a
   requested SHA that is no longer current main, and depend on successful source
   gates for that SHA. Keep deployment credentials out of PR jobs. Build/deploy
   the exact SHA and set `CAIL_SOURCE_VERSION` from that immutable source.
3. Verify the deployed Gateway receiver before enabling this caller. Provision
   the app audience and Gateway policy, then deploy the Node receiver through CI
   without changing storage or teacher identities. Read back private readiness
   and exact version; verify one version receives 100% traffic.
4. Only after receiver verification, propose `/stem-splitter/` mount activation.
   The Node host supports that prefix and redirects the bare prefix; root legacy
   URLs continue working. Check browser login → class code → guide/chat, quota,
   cancellation, public/campus DNS/access, teacher login, and existing published
   links on the deployed path before rollout acceptance.

The release workflow above is intentionally a proposal, not an enabled deployment
workflow. Existing manual deployment instructions are superseded by this CI-only
rule for fleet releases. Source checks and local synthetic-provider tests do not
prove deployed login, real model output, provider webhook reachability or spend.

## Local verification, 2026-09-08

Identity and transport tests pass, including wrong/mismatched audiences, missing
configuration, exactly one quota-denied attempt, trailing usage/errors, safe
correlation IDs, cancellation and local tools-only narration. The Node adapter
suite passed 42 tests, analysis service 24, separator 5, instrument discovery 30,
and YAMNet comparator 9. Both typechecks and the Worker dry build passed.

The existing browser suite passed 17 tests initially; its two source-attribute
assumptions were updated for relative assets and both affected tests passed on
rerun. A separate Chrome test against the actual Node host passed class-code
entry and teacher navigation at both root and `/stem-splitter/`.

Six existing audio-evidence tests fail because the dependency lock and image
source changed. They remain enforced; canonical CI image evidence is required.
The actual local Gateway receiver test is retained separately and requires a
compatible checkout supplied through `CAIL_GATEWAY_CHECKOUT`; results and exact
receiver revision belong in the task/PR acceptance record. No production
provider, deployment, storage migration or mount activation was performed.

The actual local receiver test passed against Gateway
`f3a8b3cc4b6b8bc99125771da6a907dffbdb07c3`, installed from its frozen lockfile:
`CAIL_GATEWAY_CHECKOUT=../gateway-media-receiver-20260908 bun run test:fleet:gateway`.
It crossed real Node HTTP → Stem Hono → cail-client → Gateway `handleRequest`.
Registry, model catalog and provider were synthetic; an unused WorkerEntrypoint
import used a Node shim. The test verifies matching tokens and class code,
readiness authentication/version, shared guide cache across distinct people,
public job reads, caller/provider counts on scope/quota denial, correlation,
person accounting metadata, terminal outcomes and payload-free logs, and abort
propagation to the synthetic provider. It does not claim live accounting.
Final focused auth/transport tests: 13 passed. Final worker suite: 317 passed,
six canonical evidence checks failed as described above.
