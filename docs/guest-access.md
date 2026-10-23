# Public guest access

Guests receive **five successful splits per browser session per UTC day**. Pending work holds a place; failed or cancelled work releases it. Turnstile does not increase the split allowance. The guest Listening Guide continues to require a current-day check. Page reloads preserve the session and its counters.

This document describes the source contract. Live activation and acceptance must be established against the canonical application, `https://stem-splitter.ailab-452.workers.dev/`, and its bound runtime. Configuration, a passing local test, and a deployment attempt are separate from a verified production outcome.

## Session authority and privacy

The application reads `/api/runtime` and `/api/account` on startup. An anonymous browser with `guest.canStart` can silently call `POST /auth/guest` with `{}` and then read its account. This request creates a session or resumes the same valid session, without calling Turnstile. Both bootstrap and verification require an exact same-origin HTTPS request. A member session cookie always retains the CUNY authentication path, including when that cookie is malformed, expired, revoked, or temporarily unverifiable.

The browser receives an HMAC-signed `__Host-stem-guest` cookie with Secure, HttpOnly, SameSite=Lax, a fixed seven-day expiry, and an origin-bound signature. The server generates a random guest subject and rechecks D1 expiry and revocation on each protected request. The subject is separate from CAIL identities, email addresses, IP addresses, and Admission grants. `guest_sessions`, `guest_job_owners`, `guest_upload_owners`, and `guest_listening_conversations` separate guest ownership from member ownership. The operation ledger records an immutable `quota_class` and foreign keys to the corresponding principal.

The split reservation atomically limits each guest session to five successful or pending guest splits for that UTC day. Concurrent requests cannot reserve a sixth place. A rejected sixth request returns HTTP 429 with `code` set to `split_daily_limit`, before provider work starts. The five-minute Turnstile proof is used for guest assistant requests; a proof never increases the split allowance. Idempotent replays return their existing receipt; a verification retry uses the same request key.

When required, `POST /auth/guest` accepts `{ "token": "..." }`. The server verifies the token against the exact hostname, the `stem_guest` action, and a five-minute age bound. An atomic D1 batch stores a short-lived token hash to reject replay and updates only the session's `verified_day`. The client callback alone grants nothing. The next UTC day starts a new five-place split allowance. Guest assistant requests require a fresh check for that UTC day. Reads of existing work retain their normal session and ownership checks throughout.

Guests can upload/import and split their own audio, play/download results, and annotate them. Listening Guy is optional, as described below. A fixed route allowlist and live ownership checks protect other guests' work, member/private jobs, course content, rosters, prompts, transcripts, instructor/admin operations, public-link creation, and sponsor quota reads. Existing explicitly shared audio-only links retain their public projection. Delayed provider starts recheck the stored guest session or the member/course authority associated with the operation.

After a successful CUNY login, the app claims guest recordings through the verified guest cookie. The atomic claim transfers ownership, notes, and saved conversations to that member account. The browser then copies its cached draft, playback position, solo/mute settings, loop, and speed only for server-confirmed recordings; originals remain recoverable. Course assignment stays explicit. Logout revokes the server session before clearing the cookie, so a copied cookie cannot reopen it. Private responses carry the account identity for browser-side checks when a session changes in another tab.

An interrupted reply keeps its request key in the recording's browser cache. The server stores an owned reply receipt for up to 24 hours, bounded by guest-session and recording expiry. A retry retrieves that receipt, including at the fifth turn, and successful sign-in transfers the receipt with the recording. Guest and member retries use the same original operation without charging a second turn or starting another model request. Unsaved transcript entries retry from the cache only while their revision matches the authoritative conversation.

Guest access lasts seven days in the same browser. Clearing the cookie or ending the session removes access to its saved work. Uploaded audio and stems retain the existing 90-day deletion boundary; daily retention removes guest transcripts after session expiry or revocation.

## Abuse boundaries

The allowance identifies a server-issued browser session rather than a unique person. Clearing cookies can create a new session, including another five places before verification. The existing Cloudflare ingress binding allows 30 requests per minute per key, with a separate `stem-guest-start` key derived from the trusted ingress IP for bootstrap and verification. A rejected start performs no database, Turnstile, or provider work and creates no cookie. The IP serves rate limiting rather than content ownership or a persisted account identity.

The atomic ledger also permits at most two active splits per guest, ten active guest splits across the app, fifteen split attempts per guest/day, fifty chat attempts per guest/day, and ten guide attempts per guest/day. Uploads allow at most three outstanding grants and fifteen grants per guest/day, with one-hour upload expiry. Failed work releases successful-use allowance while still counting toward attempt protection. These guards bound app activity; provider spending has its own rules. Existing provider backoff, uncertain-start reconciliation, idempotency, size/rights checks, and the global bounded queue remain in force.

## Configuration and optional Listening Guy

Guest splitting uses the existing audio provider connection. Readiness requires:

| Setting/capability | Purpose |
| --- | --- |
| `GUEST_ENABLED=true` | Runtime activation; absent from the default configuration |
| `GUEST_COOKIE_SECRET` | Dedicated app-local cookie signing secret, at least 32 characters |
| `GUEST_TURNSTILE_SITE_KEY` and `GUEST_TURNSTILE_SECRET` | Verification for guest Listening Guy requests on the exact application hostname |
| Existing `REQUEST_LIMIT` | Ingress control for guest bootstrap, verification, and application requests |

Listening Guy has separate optional readiness: `GUEST_GATEWAY_API_KEY`, the existing private `GATEWAY` binding, and the exact configured primary/fallback model pair must all be present. Runtime and account responses expose `chatAvailable`. An unavailable guest assistant returns a clear error before reserving chat/guide allowance or calling Gateway. Signed-in Listening Guy requests keep their existing app/Gateway identity pair.

When enabled, the guest assistant uses the installed client's application-key transport, `{kind:'key',token}`, with the dedicated Registry-managed credential. Gateway reauthorizes that principal on each request. Guest requests cannot reuse a member identity or inspect sponsor quota, and persistent provider credentials remain server-side. Assistant starts retain their daily human-check requirement. The public preview allows **five Listening Guide turns per saved split**, counting cue generation and chat together. Completed or usable partial replies count once; failed attempts and cached cue reads release their place. Concurrent requests reserve available places atomically. Reloads, conversation resets, and a new UTC day preserve the five-turn count. After five turns, the composer offers **Sign in to continue** and retains the draft and player state. The existing daily abuse limits remain separate from this recording allowance and Gateway spending limits.

Only the widget site key is public. The CSP permits `https://challenges.cloudflare.com` for the script, connection, and frame needed by Turnstile. The browser loads the widget after a server verification response, using the existing submission status area. Server verification follows the [Turnstile validation contract](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

The reliable-operation schema, including guest ownership and accounting provenance and migration `0029-guest-listening-replies.sql`, must be installed before new intake begins. Use the release's drain, backup, migration, and recovery procedure for the actual bound runtime. Existing installations based on an earlier unreleased schema draft require a reviewed upgrade; `CREATE TABLE IF NOT EXISTS` alone cannot update old columns or constraints.

## Verification

Focused local tests cover silent bootstrap/resumption, five successful splits without verification, the hard sixth-place rejection, same-session assistant proof renewal, failure refunds, concurrent reservation at the fifth place, UTC rollover, optional assistant behavior, member transport, and guest/member/course isolation. They also cover rate rejection without side effects, cookie tampering/expiry, unavailable storage, revocation, and replay protection.

Tests use fixture credentials and mocked external bot/provider responses. They establish the app contract rather than real bot resistance, sponsor entitlement, paid output, production cost, or live deployment. Production acceptance should verify a real permitted upload through the canonical host, its resulting playable stems and remaining allowance, and isolation from a separate browser session. A real Turnstile check and a separate permitted YouTube import establish those external paths.

Run the Cloudflare suite from `cloudflare/` with `node --import ./test-wasm-register.mjs --import ../node_modules/tsx/dist/loader.mjs --test *.test.ts`, with the existing fixture `ffmpeg` available on `PATH`. Run `guest.spec.mjs` with the repository's Playwright configuration for browser coverage of silent startup, delayed verification, and the restored interface. Local Worker listeners require loopback access. Record exact test and deployment receipts for the release being reviewed.
