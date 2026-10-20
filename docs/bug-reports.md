# Authenticated report footer

The splitter, account, instructor and classroom pages share a compact **Report a
bug** footer button that opens a pop-out panel with one 10–4000-character
description field. Close and Escape return focus to the button and preserve an
unsent draft. A page-category preview contains only an allowlisted route category.
Existing CUNY Login
identifies the reporter. The browser never asks for a name or email and never
attaches recordings, notes, conversations, screenshots, logs or other app content.

Reports are saved for the dedicated Lab administrator triage panel at
`https://tools.ailab.gc.cuny.edu/admin`. Success means Admission durably saved the
report. This reporting path sends no email.

## Authentication and request contract

Both `GET /api/bug-reports/session` and `POST /api/bug-reports` pass through
`authenticatedRequest` and `authorizeCailRequest` with `verifyCailIdentity`.
The first obtains Doorway's JWT from the host-only session cookie and strips
browser credentials. The second verifies its signature, exact Stem audience and
expiry, current Admission membership, and local account access. Unsigned guest
sessions cannot report. No course-specific permission is needed to describe a bug.

The session GET returns only `{ok:true,expectedActor}` with private/no-store
headers. The opaque SHA-256 marker is an account comparison value, not a login
credential or authority. The browser pins it to the draft. POST accepts exactly
`{reportId,description,path,expectedActor}` and compares the marker with the
currently verified principal before invoking the report service. An account
switch returns `account_changed` without submitting the old account's draft.

POST requires the exact app origin, JSON, at most 16,384 bytes, a UUIDv4 and bounded
text. Both endpoints use the existing Cloudflare ingress limiter and reject query
strings; session GET also rejects a foreign Origin when present. Missing configuration or the
trusted Cloudflare IP fails closed. The only accepted path values are `/`,
`/teacher.html`, `/account.html` and `/classroom.html`; the widget maps Cloudflare's
extensionless page aliases to these values. Query strings, fragments, private
identifiers and arbitrary URLs are rejected. Description normalization converts
CRLF/CR to LF and tabs to spaces, then trims surrounding whitespace.

The existing `BUG_REPORTS` binding calls
`cail-tools-admission#AdmissionBugReports.submitAuthenticated` with exactly:

```ts
{ reportId, subject, description, origin, path, release }
```

The server supplies the verified opaque CAIL subject, app origin and deployment
release. Release must match `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`; there is no invented
fallback. No cookie, JWT, raw IP, expected-actor marker, name or email is forwarded.
Admission's source-owned binding props select the app and permitted origins; its
registry rechecks current membership and owns report persistence and triage.

The source wire contract is
`cail-tools-admission/packages/admission-contract/src/bug-report.ts`. The successful
reply is `{ok:true,status:'saved',reportId,createdAt}`. A failure contains
`{ok:false,code,retryable,retryAfterSeconds?}`. The adapter returns only known fields.

## Drafts, retries and account changes

Drafts stay in the current page's memory. The footer exposes a new-tab link to the
existing sign-in route and an explicit **Check sign-in** action. Reauthentication
never automatically submits. A different account cannot inherit the draft.
If the app detects session loss while a draft exists, it clears and conceals
private workspace contents, stops playback and blocks stale app requests while
preserving the report. Private content remains concealed until the page reloads.

An unchanged attempt keeps its UUID. A missing response, timeout or ambiguous
failure freezes the original text and offers **Check report status**, which
replays that same UUID and text explicitly. Admission's idempotent submission
returns the original receipt without creating another report or charging another
report allowance. Its first path, release and creation time remain unchanged.
No timer resubmits and no uncertain outcome rotates the UUID. Existing legacy
receipt/tombstone handling remains the receiver's responsibility.

## Validation and release boundaries

`cloudflare/bug-reports.test.ts` exercises the actual Worker entrypoint with
signed synthetic JWTs, session-cookie fixtures and an in-memory database. It
covers absent/expired/revoked sessions, wrong JWT audiences, current Admission
and local disablement, switched-account drafts, strict fields/routes, rate limits,
bounded input and a lost storage acknowledgement. Node's streamed Request copies
need a test-only duplex shim; the browser suite exercises unmodified Workerd.

`cloudflare/bug-report.spec.mjs` runs the production entrypoint and real static
assets in local Workerd with signed synthetic identities. It covers all four
footers, desktop and phone layout, keyboard dismissal and focus return, retained
drafts after closing, one visible field, unauthenticated access, duplicate clicks,
server attribution, failure drafts, same-account recovery, account switching and
explicit same-UUID reconciliation. The test receiver records local synthetic
data only; it never connects to live Admission, CUNY or SES.

The shared framework-neutral controller and CSS are copied from Systems Mapping's
`src/support/form.js` and `form.css`; `public/classroom-feedback.js` owns Stem's
mounting, route normalization and session-guard integration.

No deployment configuration, origin grants, credentials, service bindings or
paid-job limits change for this feature. The dev Worker's existing report origin
is outside Admission's source-owned allowlist; this change does not widen it.
The authenticated receiver and protected administrator panel must be released
with their corresponding shared contract before the consuming app is released.
Local fixtures do not establish live CUNY or administrator-panel acceptance.
