# Bug report footer and reusable adapter

The Cloudflare app exposes an accessible, closed-by-default footer on the splitter,
account, instructor, and course pages. Name, email, and a 10–4000-character bug
description are required. The footer sits outside private views so sign-in or
session verification failures can be reported. Horizontal rules bound the form.
It supports keyboard disclosure, visible focus, live status, submitting, accepted,
failure, delayed retry, and uncertain-delivery recovery. It keeps drafts only in
the current page's memory; reload/navigation clears them.

`POST /api/bug-reports` is deliberately available before authentication. It grants
no access to app data. It requires the exact app origin, JSON, at most 16,384 bytes,
bounded fields, a UUIDv4, the existing ingress limiter, and Cloudflare's trusted
IP header. Missing configuration or trusted IP fails closed. Extra fields,
cross-site requests, and name/email control characters are rejected. The server
derives app/day/IP rate metadata; no raw IP or session credential is forwarded.
The daily hash is a pseudonym and people behind one NAT share a budget.

The private `AdmissionBugReports.submit` service binding uses Admission's existing
SES sender and fixed `ailab@gc.cuny.edu` recipient/from/subject. Reporter email is
unverified plain text, never an email header. The email includes only app name,
random report reference, name, email, and description. It attaches no page URL,
account identity, logs, chats, audio, maps, or screenshots. No SES credentials are
copied into either application. Railway's server has no new email endpoint.

One unchanged submission keeps its UUID across explicit retries. Known-safe
failures preserve editable fields. Lost responses/timeouts lock the original
fields and offer **Check report status** using that same UUID. There is no
automatic resend or UUID rotation. **Accepted for delivery** means SES returned a
message ID and Admission recorded acceptance; mailbox delivery is not proven.

Admission durably limits dispatch to 3 per app/day/IP hash, 50 per app/day, and
100 total/day. Only explicit SES 429 rejection is eligible for a delayed retry,
up to three attempts. Permanent opaque receipt tombstones prevent old IDs being
replayed; capacity is 100,000 receipts, then new reports fail closed. Receipt
storage contains no raw name, email, description, or IP. Email itself reaches SES
and the Lab mailbox and is subject to their retention.

## Reuse and ownership

The source contract and fixture belong to
[Admission's contract package](https://github.com/CUNY-AI-Lab/cail-tools-admission/blob/2351fed850f9070524e1ced07fb154c558c92060/packages/admission-contract/src/bug-report.ts),
with [delivery and release documentation](https://github.com/CUNY-AI-Lab/cail-tools-admission/blob/2351fed850f9070524e1ced07fb154c558c92060/apps/admission/docs/BUG-REPORTS.md).
This adoption pins receiver commit `2351fed850f9070524e1ced07fb154c558c92060`.

`cloudflare/bug-reports.ts` and the form's `form.js`/`form.css` are identical vendored
v1 modules in Stem and Systems Mapping. The controller has no framework or auth
dependency; `mountBugReport(element)` returns its cleanup function. Stem mounts
it from `public/bug-report/stem.js`; Mapping wraps it in a small React component.
Only layout/theme integration differs. To adopt in another PoC, copy the adapter
and controller/styles, add app-specific mounting and same-origin route, and
explicitly review the new source-owned Admission app/origin grant. Do not turn the
relay into a general recipient-selectable mail API. A versioned package may
replace these copies after additional consumers justify publishing one.

## Validation and release hold

`cloudflare/bug-reports.test.ts` exercises request bounds, origin/method failures,
header injection, missing configuration, ingress limits, opaque rate metadata,
and lost acknowledgement. `cloudflare/bug-report.spec.mjs` runs the production
entrypoint and native UI against a local mocked mail service, including keyboard,
phone, success, safe retry, and uncertain recovery. Test-only wrappers are absent
from deployment config. Admission separately tests real local RPC/SQLite with
all SES calls intercepted. No test sends real email.

Source declares the private binding, but no deployment, live namespace creation,
merge, or real email has occurred. Release requires separate approval for the
new Admission receipt namespace, per-app binding props and anonymous ingress,
followed by an approved report from each app and verification in the Lab mailbox.
Do not report delivery as production-verified until that mailbox acceptance test
is complete. Browser plugin unavailable; existing Playwright is the QA fallback.
