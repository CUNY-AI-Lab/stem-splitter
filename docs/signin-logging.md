# Background sign-in records

The Cloudflare adapter records sign-in activity in the existing `usage_events` table through `ExecutionContext.waitUntil`. The interface and sign-in responses stay unchanged. Existing retention removes events after 30 days; the existing daily limit of 25,000 usage events applies. A database logging failure produces a fixed warning and leaves sign-in available.

- `signin_attempt`: each GET to `/auth/login` on the configured app origin, including rejected requests and requests with an existing session.
- `signin_success`: a validated callback issues a new app session cookie.
- `signin_failure`: login or callback returns an error. Codes distinguish login from callback and authentication, admission, rate limits, or service availability.
- `signin_session_reused`: an existing validated session navigates home, including stale-callback recovery. This is separate from a newly completed sign-in.

Records contain timestamps, HTTP status, elapsed time, and fixed categories. They omit identities, email addresses, IP addresses, callback parameters, cookies, and credentials. These counts describe requests and observed outcomes, rather than unique people. A login abandoned at CUNY or Doorway has an attempt without a completion; upstream failures that never return to the app remain unobserved. Logging starts with this release and cannot reconstruct earlier attempts.

The existing admin-only `/api/admin/usage-events?days=1` summary includes these events. For a precise reporting interval, use UTC milliseconds in this aggregate D1 query (convert the requested local-day boundaries first):

```sql
SELECT event_type, code, http_status, COUNT(*) AS count
FROM usage_events
WHERE event_type LIKE 'signin_%' AND at >= ? AND at < ?
GROUP BY event_type, code, http_status;
```

# Saved rack and folders

Saved cards stay attached while status requests settle, preserving playback, focus, and entrance-animation state. Adding a completed split to a personal instructor folder moves it out of the account rack; moving it again replaces its location among that folder owner's folders in one database batch. Other owners' folders remain independent. Removing a split from a folder or deleting the folder makes the saved split available in the rack again, with its audio and notes intact. The existing LOAD controls explicitly open folder contents for listening.

# Instructor review

The account page uses verified profile names and provides Student activity. Recorded visits count existing, best-effort member `session_start` events from the past 30 days. Split runs combine durable split operations with older saved jobs, counting each run once; completed runs are shown separately. Deleted and expired audio stays unavailable. Recording lists load on selection and audio loads on request.

Administrators retain their existing app-wide review scope. Instructors require a current course-owner relationship in Admission and a current participant relationship for the selected student. Each recording and audio request rechecks those relationships. The review returns audio and recording metadata; private notes and conversations remain separate. Existing personal job permissions are unchanged.

Apply migration `0025-account-display-names.sql` before deployment. The additive table stores display names from verified identity or Admission course profiles; existing accounts are populated on access using the current profile service. If an older account's original course has ended, another current assignment can supply its verified name. Names are display information and never grant authority. An unavailable profile is labeled “Name unavailable” until verified data becomes available.
