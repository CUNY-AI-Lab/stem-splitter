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
`CAIL_GATEWAY_URL=https://tools.ailab.gc.cuny.edu`, `ASSISTANT_MODEL`,
`CAIL_SOURCE_VERSION` (the exact 40-character deployed commit), and a private
`CAIL_READINESS_TOKEN`. `GET /api/fleet/readyz` requires the latter bearer token;
it fails closed when verifier, endpoint, model or source configuration is absent.
The endpoint confirms local configuration, not Gateway health or live acceptance.
The Gateway URL is an origin, with no `/v1` suffix; cail-client appends the API path. `ASSISTANT_MODEL` uses a current prefix-free catalog ID (for example `glm-5.2`), never a provider-prefixed route. Loopback HTTP Gateway origins are allowed only with `LOCAL_DEV=1` for synthetic tests.
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

## Source and local verification, 2026-09-08

Full CI run `34182876507` passed at evidence-import commit
`9e4b17c5fee49276569a55abdb0b8dd5d84d35d5`, including source-gate job
`101925325268`. GitHub Packages installation succeeded using a temporary
repository `.npmrc`, `NODE_AUTH_TOKEN` from `github.token`, and the frozen Bun
lockfile; the shell exit trap removed the file. Image builds receive package
credentials through a BuildKit secret. No persistent package credential is
included in the image.

The final local worker suite passes all 325 tests, including the canonical
analysis-image and both comparator evidence checks. The audio-pipeline check
passes with its listening/promotion boundaries intact. Canonical analysis-image
evidence records the successful native image execution within run `34182060935`
at `6756ff251f60ed8a435c7db1f3e745fef02474cc`; that historical overall CI run
failed on pre-import evidence drift. Refreshed YAMNet run `34182311183` and
EfficientAT run `34182311130` both succeeded at exact comparator source
`a64d5dfb98e9f6b1031ac95f631498b7b139d0d6`. Their canonical records bind the
later successful source gate separately through `sourceGateCommit`. Both remain
comparison-only: no classifier or threshold is selected and discovery promotion
remains blocked on the recorded reviews and rollout gates. The uploaded
EfficientAT comparison preserves its historical YAMNet baseline input; future
comparisons use the refreshed canonical YAMNet evidence.

Identity and transport tests cover wrong/mismatched audiences, missing
configuration, exactly one quota-denied attempt, trailing usage/errors, safe
correlation IDs, cancellation and local tools-only narration. Full source CI
also passed the Node and shared typechecks, Python suites, analysis-service
contracts/parity, existing browser, Auto and isolation-shadow suites, and the
Worker dry build. A dry build does not migrate the Railway host to Workers.

The separate Chrome test acts against the actual Node host at both root and
`/stem-splitter/`. It verifies class-code entry and teacher navigation, and
exercises guide/chat with missing and expired CAIL identities. Both cases show
the CAIL sign-in message while preserving the valid class code and keeping the
class-code dialog closed. Wrong class codes instead clear the stored code and
reopen the dialog. The test also checks the bare mount-prefix redirect. These
are local browser identity boundaries, not deployed Doorway login acceptance.

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

No production deployment, provider call, storage migration or mount activation
was performed. Deployed login, provider behavior, public/campus access and the
release-order checks above remain unverified.
