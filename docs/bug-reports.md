# Report a problem

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

This release requires the updated Admission receiver through the shared
Cloudflare coordinator before app deployment. Do not bypass the coordinator
lock. Unit/Workers/browser tests use synthetic reports and a mocked email
service. Deployed submission and mailbox readback are separate release checks.
