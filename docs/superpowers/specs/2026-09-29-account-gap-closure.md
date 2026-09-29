# Account gap closure

## Scope

Repair the Cloudflare student and instructor flow without changing Railway,
Replicate credentials, Admission grants, the audio pipeline or feature flags.
The base is the merged Cloudflare PR #14, not the separate Railway main branch.

## Behavior

Same-origin forms retain the Origin required by CSRF checks. Authentication
redirects still suppress referrers. Logout attempts bounded remote revocation,
always clears this browser's two auth cookies after a valid same-origin request,
and returns a readable failure page if remote revocation was not confirmed.
Cross-site/null-origin requests never clear or revoke a session.

My account rechecks its principal and role on focus, clearing private UI when
access is lost. The signed-in footer contains the 30-day retention note. Split
creation confirms account saving only after server persistence/provider startup
returns success. Failed creation does not claim a save. Recovered lists no longer
repeat the retention note. Quotas use runs, and exhaustion displays local reset
time. The existing rule that failed submitted runs count remains explicit.

Guide instructions retain current app-wide semantics with an explicit warning.
This is not a per-class settings implementation. Permanent instructor access from
PR #14 remains supported and covered by the combined regression suite.

## Remaining release gates

Visitor access remains disabled pending bot verification and separate session
ownership. Migration, unified Replicate accounting, class-scoped instructions,
directory names and feature promotion remain separately tracked in TODO.md.
No new central grants or legacy data transfers are authorized implicitly.

Local browser fixtures verify behavior but cannot prove real CUNY authentication,
paid inference, webhook delivery, live storage lifecycle, or account recovery on
the deployed site. Record these separately before claiming classroom acceptance.
