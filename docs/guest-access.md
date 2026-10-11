# Guest access candidate

The October 6 policy is **5 successful splits and 25 human Listening Guy inputs per guest session per UTC day**. It supersedes the September 29 proposal for three visitor attempts. Pending operations hold a place; failed/cancelled splits and replies with no usable output release it. Usable partial replies count once. Guide generation and cache reads do not consume human-input allowance. Provider spend remains separate from these app counts.

This implementation is **off by default and has not been activated**. No sponsor grant, API key, Turnstile widget, secret, production migration, or deployment was created. No old OpenRouter key is used. Production acceptance still requires the release gates below.

## Authority and privacy

`POST /auth/guest` requires an exact same-origin HTTPS request and a server-verified Turnstile token for the request hostname and `stem_guest` action. Token age is bounded to five minutes. A short-lived hash record rejects token replay in an atomic D1 batch even if a verification response is repeated. The browser receives an HMAC-signed `__Host-stem-guest` cookie with Secure, HttpOnly, SameSite=Lax, a fixed seven-day expiry, and an origin-bound signature. D1 expiry/revocation is rechecked on every protected request. A fresh human check is required on each UTC day before paid starts; renewal preserves the session and its counters.

The guest subject is a server-generated random identifier. It is never a CAIL subject, email, IP address, or admission grant. `guest_sessions`, `guest_job_owners`, `guest_upload_owners`, and `guest_listening_conversations` are separate from member ownership. The operational ledger uses an immutable `quota_class` and foreign keys to the appropriate member or guest principal. That accounting provenance grants no access. Delayed paid starts recheck the guest session, or the existing member/course authority, according to the stored quota class.

Guests can upload/import and split their own audio, play/download their own results, annotate them, and use Listening Guy for those results. A fixed route allowlist and live ownership checks deny member/private jobs, other guests' work, course folders, rosters, prompts, transcripts, instructor/admin functions, public-link creation, and sponsor quota reads. Existing explicitly shared audio-only links retain their existing public projection. App administrators do not gain guest content through member ownership APIs.

A member session cookie always selects the existing CUNY authentication path, including malformed, expired, revoked, or unavailable sessions. Such a request never silently becomes a guest. A successful CUNY login revokes the browser's guest session and clears its cookie; no guest content is adopted into a member account or course. Logout revokes the guest server session before clearing the cookie. A copied cookie cannot reopen a revoked session. Session revalidation conceals private UI while authority is pending or unavailable; a changed identity clears and reloads it.

Guest access lasts seven days in the same browser. Clearing the cookie or ending the session removes access to its saved work; it is not an account-recovery mechanism. Existing uploaded-audio/stem storage retains its 90-day deletion boundary. The daily retention job removes guest transcripts after session expiry/revocation. No member or course content is backfilled or reclassified.

## Abuse boundaries

Anonymous per-human limits cannot be exact. These counts identify the server-issued browser session; cookie resets can create another identity after a new valid human check. The existing Cloudflare ingress binding allows 30 requests/minute per key, with a separate `stem-guest-start` key derived from the trusted ingress IP for guest entry. This is best-effort reset-abuse control, not a unique-human or daily person guarantee. A rejected start performs no database, Turnstile or provider call and creates no cookie. No IP is used as content ownership or persisted as an account identifier. No global rate-limit setting changes are included.

The atomic ledger additionally permits at most two active splits per guest, ten active guest splits across the app, fifteen split attempts per guest/day, fifty chat attempts per guest/day, and ten guide attempts per guest/day. Uploads allow at most three outstanding grants and fifteen grants per guest/day, with one-hour upload expiry. These are abuse and concurrency guards, not successful-use charges or a promised monetary ceiling. Existing provider backoff, uncertain-start reconciliation, idempotency, size/rights checks, and the global bounded queue remain in force.

## Gateway and activation

The installed `cail-client` 6.2.2 supports a registry-managed application key via `{kind:'key',token}`. A verified guest request can use only the explicit optional `GUEST_GATEWAY_API_KEY` on the existing private Gateway binding. Gateway reauthorizes that principal through its Registry on every model request. No guest JWT is minted, no member identity is reused, and no persistent provider credential reaches the browser. The guest cannot inspect the sponsor's quota. Signed-in requests retain their current exact app/Gateway identity pair.

Guest readiness requires all of the following. Missing configuration leaves the feature unavailable, including when an unrelated legacy provider key exists.

| Setting/capability | Purpose |
| --- | --- |
| `GUEST_ENABLED=true` | Explicit activation, absent by default |
| `GUEST_COOKIE_SECRET` | Dedicated app-local cookie signing secret, at least 32 characters |
| `GUEST_TURNSTILE_SITE_KEY` and `GUEST_TURNSTILE_SECRET` | Widget for the reviewed exact application hostnames; server verification |
| `GUEST_GATEWAY_API_KEY` | Approved Registry-managed sponsor application key; no fallback credential |
| Existing `GATEWAY`, exact primary/fallback models, and `REQUEST_LIMIT` | Private authorized inference and ingress control |

Only the widget's site key is public. When configuration is complete, the CSP adds `https://challenges.cloudflare.com` to script/connect/frame sources for the widget. Turnstile follows its [server-side validation contract](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/); the client callback alone grants nothing. Its documented [compact widget size](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/#widget-sizes) fits narrow mobile layouts; real widget acceptance remains a release gate.

Before activation: review and approve the sponsor's grant/budget/model entitlement, dedicated cookie key installation, exact-host Turnstile widget and secret, and CSP/abuse settings. Then apply the reviewed unshipped migration `0022-reliable-operations.sql` with the existing backup/drain/rollback plan and complete real browser/Turnstile/Registry acceptance. Source includes guest tables and accounting provenance in that same migration; no fourth PR or shared Gateway/Admission/SSO deployment is required. A database already initialized with an earlier *unreleased draft* of 0022 needs a reviewed rebuild/upgrade plan; `CREATE TABLE IF NOT EXISTS` does not upgrade that draft's old operation schema.

Local tests use fixture credentials and mocked Turnstile, Replicate, and Gateway. They establish app behavior and privacy boundaries, not real bot resistance, sponsor entitlement, paid model output, production cost, or live deployment readiness.

## Local verification

Using Node 22.23.1 and the existing installed dependencies (no lockfile changes):

- Root, server and Cloudflare TypeScript checks pass; the guest/app/account scripts pass syntax checks.
- Shared Worker regression suite: 325/325; server/SQLite compatibility suite: 42/42.
- Cloudflare suite: 78/78, including four guest tests. It covers empty-reply/failed-split release, 5/25 settlement, idempotency, atomic parallel reservation, daily reset/proof renewal, immutable quota provenance, rate-limit rejection with no side effects, cookie expiry/tamper/noncanonical encoding, unavailable storage, revocation, and cross-guest/member/course isolation.
- `cloudflare/guest.spec.mjs` passes in Chrome, Firefox and WebKit against the real local HTTPS Worker listener. The test uses browser file upload, secure-cookie resumption, account limits, pending/unavailable-authority concealment, second-guest clearing, logout, and 320/390/768/1280px overflow checks. Only external bot/provider responses are fixture-controlled.

Run the Cloudflare suite from `cloudflare/` with `node --import ./test-wasm-register.mjs --import ../node_modules/tsx/dist/loader.mjs --test *.test.ts`. Run the guest browser spec from the repository root with `node ./node_modules/@playwright/test/cli.js test --config cloudflare/playwright.config.mjs guest.spec.mjs`; set `STEM_BROWSER=firefox` or `STEM_BROWSER=webkit` for the other engines. Local Workers/HTTPS need loopback permission. Final PR integration still needs its own exact-head audit and CI.
