# Dev bug reports

The footer shares its compact form with Systems Mapping. Instructor Console uses
the existing shared button style. The bug icon expands on hover or keyboard focus.

The dev adapter submits authenticated and guest reports as private Bug issues in CAIL Ticketing (project 15,
tracker 2) at `https://tools.ailab.gc.cuny.edu/help/`. The Worker keeps
`REDMINE_API_KEY` in a Cloudflare secret. Reports include the description, page
category, release, time and a pseudonymous account reference. No files are attached.

D1 stores only receipt metadata and a content fingerprint, with a ten-report
account limit per 24 hours. Ambiguous deliveries are looked up by report reference;
they are never automatically created again. Drafts remain in memory until reload.

The form recognizes SSO on open, focus, visibility changes and every 30 seconds
while visible, and checks again before sending. It shows the verified SSO name
above the description. A compact home-page CUNY Login button replaces manual
sign-in checks. “No account?” reveals first name, last name and email fields.
Shared browser/server validation accepts `.edu` email addresses and shows errors
beside the affected field. These guest details are labeled self-reported and
unverified in Redmine and grant no app access.

Guest receipts use a separate table, limited to ten reports per email and twenty
per salted network reference per 24 hours. Only hashes and receipt metadata are
stored locally; contact details and report text go to the private Redmine issue.

Before deploying this branch to Dev, from `cloudflare/`:

```sh
bunx --no-install wrangler d1 execute stem-splitter-dev -c wrangler.dev.jsonc --remote --file=redmine-reports.sql
bunx --no-install wrangler secret put REDMINE_API_KEY -c wrangler.dev.jsonc
bunx --no-install wrangler deploy -c wrangler.dev.jsonc --var RELEASE:$(git rev-parse HEAD)
```

The dev adapter and contact form preserve the reporting flow served by dev
release `397aa1d3`, alongside the classroom and listening refinements based on
public release `d69851a1`. The shared navigation includes Class workspace.
Provider starts remain disabled until dev has its provider credentials, and
existing dev bindings are preserved. Form and routing checks do not establish
successful ticket delivery; verify that separately when submitting an authorized report.

## Production

Production pins `BUG_REPORT_MODE=redmine-fallback`. The shared SSO / `.edu`
guest form remains available through the existing `BUG_REPORTS` binding when
Redmine is unconfigured. That Admission service sends to `zmuhlbauer1@gmail.com`;
this release adds no credential, email permission, or shared service deployment.

Apply additive migrations 0031 and 0032 to the existing production D1 before
publishing this mode. `bug_report_deliveries` stores report UUID, description,
page, release, timestamp, hashed owner/rate references, selected transport and
pending/accepted/unknown state. Guest contact fields and raw account/IP values
are not copied into this table or the fallback email. Description text is
user-supplied and may itself contain personal information. Records are private
and retained; do not drop receipt tables on rollback or replay old reports.

When configured, Redmine remains the first transport. Only a definite rejected
Redmine receipt permits email fallback. Timeouts, unreadable replies, lost
acknowledgments and pending receipts stay on Redmine, including if its key is
later removed. Existing receipt fingerprints are reconciled before a transport
is selected. The shared email service durably claims each report before sending
and owns email duplicate protection; retries preserve UUID and description.

The UI distinguishes email acceptance from mailbox receipt: “Report recorded.
Email accepted for delivery.” Actual delivery requires separate mailbox readback.
A missing sender or failed/uncertain send must not produce that success message.
Rollback the Worker while retaining these additive tables and delivery records;
rolling code back does not retract mail or erase reports already accepted.
