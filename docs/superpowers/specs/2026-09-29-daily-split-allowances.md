# Daily splits and public access

User-approved policy, September 29, 2026:

- Admitted, signed-in users: **10 split attempts per person per UTC day**.
- Visitors without sign-in: **3 split attempts per visitor per UTC day**.
- No aggregate class-wide or application-wide signed-in split-count limit.
- The user clarified the visitor count, not a dollar-denominated sponsored budget.
- The user subsequently confirmed Replicate is covered and approved bot-protection
  setup, with an explicit requirement not to break the existing application.
  Retain the current Replicate transport/billing; do not require a new shared
  Gateway accounting contract to release this daily-count change.

The existing reservation counts attempts before imports/provider calls. Preserve
that conservative rule: an uncertain provider request must not be refunded and
retried into duplicate paid work. Reads, playback and cached results do not use
split reservations. UTC midnight remains the existing reset; display its local
equivalent in My account. Report unknown usage as unavailable, never zero.

## Current implementation boundary

The ten-per-person policy is implemented in the existing verified CAIL path.
Fresh Admission, local suspension, private ownership and same-origin checks
remain prerequisites. All roles, including administrators, get ten. The former
twenty-per-day shared split ceiling is removed. Legacy non-Gateway Guide guards
remain unchanged. None of this is a monetary billing implementation.

Visitor access is **not implemented or enabled**. Today the Cloudflare app
requires CAIL identity for uploads, splits, private playback and saved work.
Do not advertise three free splits until the complete visitor flow passes its
release gates. Do not insert invented cail-* identities into app_users to evade
its identity constraint, or fall back to guest mode on Admission failure.

## Visitor release gates

1. Separate, server-issued high-entropy HttpOnly visitor sessions and ownership
   records, bounded retention, same-origin writes, private result access, and
   atomic three-attempt reservations. Do not derive ownership from IP addresses.
2. Server-verified bot protection before paid work, plus a reviewed abuse rule
   that limits cookie-reset evasion without presenting a shared campus IP as a
   person. Disclose that an anonymous per-person limit cannot be exact.
3. No automatic guest downgrade for revoked/suspended/invalid CUNY sessions.
   No guest Guide, instructor, account-admin or other separately paid endpoint
   exposed by a broad authentication exception.
4. On exhaustion: show CUNY Login, the verified Lab request-access link, and the
   reset time. Explain that continuing with an account requires active Lab
   access. A successful login switches to that person's ten-per-day allowance;
   it does not automatically assign visitor recordings to the account.
5. Bound anonymous input/import work and concurrency using the existing covered
   Replicate connection. Three per visitor is not an application-wide spending
   ceiling; do not invent a dollar cap or change the signed-in billing path.
6. Workerd/browser tests for third/fourth attempts, midnight reset, replay,
   parallel submissions, cookie reset, other-visitor/private-member isolation,
   login/logout, unknown usage, failed imports, and provider timeouts. Real
   Turnstile success and token replay rejection are separate acceptance gates.

## Shared Lab allowance integration (separate follow-up)

The Listening Guide already calls the CAIL Gateway with the signed-in person's
verified identity. Replicate audio separation does not currently debit their
Lab allowance. Forwarding Replicate through Cloudflare AI Gateway alone cannot
establish that debit: current custom-cost support requires token usage in the
provider response, whereas separation predictions report processing time.

The maintained Gateway quota contract makes Cloudflare AI Gateway the monetary
authority; it forbids a second local balance or /v1/quota preflight. A reviewed
async-provider accounting contract, supported spend enforcement, idempotent
terminal reconciliation (including cancellations/unknown starts), and a
separately approved sponsored visitor principal are required. Do not fabricate
tokens, trust client cost/subject fields, or relabel attempt counters as money.
This future shared-accounting work is not a prerequisite for continuing the
user-approved existing Replicate billing arrangement.

## September 29 verification and blocker

The signed-in change passes Cloudflare type checking, 27 backend checks (including
real Workerd/D1/R2 with mocked providers), seven desktop/mobile browser scenarios,
shared/server type checking and the unchanged frozen audio-pipeline gate. No paid
provider request, real student login or deployment was performed. The account UI
checks include exhausted and unavailable counts and retained account access.

The Turnstile setup skill's authentication probe returned `missing_token` because
`CLOUDFLARE_API_TOKEN` is not present in the current environment. No widget or
secret was created. Supply a token with Account / Turnstile / Edit for the Lab
account through a local credential environment, not chat, then resume its domain,
insertion-point and secret-destination confirmation steps. Visitor implementation
and activation remain pending; no partial anonymous auth exception was added.

References checked September 29, 2026:

- [Gateway quota design](https://github.com/CUNY-AI-Lab/cail-gateway/blob/36cd8cdb7d61e2aebc94a03171b5990cea00bf5e/docs/quota-design.md)
- [Replicate through AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/providers/replicate/)
- [AI Gateway custom costs](https://developers.cloudflare.com/ai-gateway/configuration/custom-costs/)
- [Replicate prediction lifecycle](https://replicate.com/docs/topics/predictions/lifecycle)

No Railway mutation, shared Gateway deployment, new sponsor grant, production
secret write, or production release is performed by this local change.
