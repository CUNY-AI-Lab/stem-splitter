# Report a bug

## Current Cloudflare behavior

The footer's **Report a bug** control opens the shared compact form. It supports
verified CUNY Login or **No account?**, which asks for first name, last name and a
`.edu` email address. Guest details are self-reported, unverified and grant no
app access. `GET /api/bug-reports/session` checks signed-in reporting identity;
account submissions use `/api/bug-reports`, and contact submissions use
`/api/bug-reports/guest`. Existing course and instructor permissions are unchanged.

Reports contain a description, fixed page category, app release and report UUID.
The server validates identity/contact and supplies rate-limit references. The
form does not automatically attach audio, notes or conversations. Drafts stay in
tab memory, including after a failed availability check; a reload discards them.
Explicit retries retain the same UUID and body while the outcome is unresolved.

Production uses `BUG_REPORT_MODE=redmine-fallback`. Configured Redmine is tried
first. An unconfigured Redmine transport or a definite rejected receipt permits
the existing email fallback to `zmuhlbauer1@gmail.com`. Timeouts, unreadable
responses and uncertain receipts cannot switch transports or create a duplicate.
The private D1 delivery record retains the description, page, release, timestamp,
transport/state and hashed owner/rate references. Raw account, IP and guest
contact fields are excluded from that table and the fallback email; user-entered
report text can itself contain personal information. Redmine receives the report
and, for the guest path, the explicitly provided contact details.

The form says **Sent. Thank you.** for a saved Redmine report, or **Report recorded.
Email accepted for delivery.** for accepted fallback mail. Email acceptance does
not establish mailbox arrival. Pending or unknown deliveries remain visible for
readback instead of being declared successful. Existing validation, request and
rate limits continue to apply. The delivery ledger permits ten reports per owner
per 24 hours. Guest-contact reports also have a limit of twenty per salted network
reference. The email service's separate limits apply to fallback mail.

See [the reporting adapter and production runbook](../cloudflare/redmine-reports.md)
for migrations, privacy details and rollback boundaries. Source tests do not
establish production delivery. No live report is required for a documentation
release; preserve existing receipt rows and do not replay old submissions.

## Historical anonymous email-only flow (superseded)

The notes below describe the earlier anonymous route. They do not describe the
current Cloudflare contact form, session endpoint, delivery ledger or Redmine
selection described above.

The footer button opens a compact pop-up with one description field. Reporting
is anonymous and requires no CUNY Login. This exception applies only to
`POST /api/bug-reports`; course, instructor, roster and student-work APIs retain
their existing authentication and authorization. The retired report-session
endpoint returns 404.

The browser submits only `{reportId, description, path}`. It sends no identity,
attachments or private application contents. Context uses fixed page categories,
never project IDs, query strings, fragments or capability tokens. The server adds
the configured origin/release and an app/day/IP digest for rate limiting, then
calls the private app-scoped `AdmissionBugReports.submitPublic` binding. Raw IP,
cookies, JWTs, names, emails and course headers are not forwarded.

The receiver sends plain text through its existing SES facility to the fixed
recipient **zmuhlbauer1@gmail.com**. It retains durable content-free receipts and
the existing budgets of 3 attempts per app/day/IP digest, 50 per app/day and 100
across both apps/day. The body is limited to 16,384 bytes; the description is
10–4,000 UTF-16 units. Same-origin, content-type, trusted IP, ingress limiter,
closed fields and bounded dependency waits are enforced before submission.

`{ok:true,status:"accepted",reportId}` means SES accepted the email. It does not
prove arrival in the mailbox. Failures remain visible. A draft and its UUID stay
in tab memory; explicit retries preserve them. A durable pre-send claim prevents
duplicate sends after unknown outcomes. Only an explicit provider throttling
refusal can permit a bounded retry; network/5xx/ambiguous failures cannot resend.
Existing stored reports and prior receipt records remain intact.

The production configuration includes the app-scoped `BUG_REPORTS` binding.
Release this configuration only after Admission PR #335 has passed its hosted
source check, shared-coordinator release and receiver readback. The previous
classroom release omitted the binding and returned `enabled: false`.

The availability route exposes the report form only when the binding exists.
A production submission and corresponding mailbox readback are separate release
checks; mocked tests establish neither. Keep the previous deployment available
for rollback if the receiver refuses reports after activation.
