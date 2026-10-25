# October 25 review repairs

These are source repairs for draft PR #75, not a deployment or classroom
acceptance receipt. They preserve the existing course permissions, note authorship,
and explicit instructor-led playback behavior. No YouTube/Cue incident cause or
new live fix is asserted. The user's October 25 confirmation of the earlier
classroom issues is reported evidence; it is separate from this code validation.

## Reporting transport

The Dev direct adapter uses Workers-supported `redirect: 'manual'` and rejects
301/302/303/307/308 before reading any response body. It never follows a Location
with the API key. Synthetic Workerd tests exercise the actual adapter and D1
receipts, including same/cross-origin redirects, stalled/oversized redirect bodies,
saved receipt replay, conflicting text, lost acknowledgement, empty/matching
recovery lookups, malformed/oversized success, and atomic explicit retry after 429.
Existing uncertain receipts remain lookup-only; this change never resubmits them.
The production BUG_REPORTS service is a separate delivery path.

## Account activity

`/api/admin/users` and `/api/teacher/students` return `nextCursor` and `complete`.
Each page considers at most 25 stored accounts and retains current authorization
checks. A page can have zero eligible students and a non-null cursor; clients must
continue paging before treating it as a complete empty result. The numeric rowid
boundary contains no filtered subject, name or timestamp. Accounts are traversed
in reverse insertion order; within each page, eligible names are sorted for display.
No database migration or access grant is required.

Settings provides Load more accounts and explicit completion messages. Selecting
an older account also loads the necessary activity pages. Reopening Student
activity preserves already loaded pages and the selected student's recordings.
The synthetic fixture includes 201 accounts, empty eligible pages, tied timestamps,
invalid cursors and disclosure reopening followed by the next recordings page.

## Reporting availability

A failed availability check leaves a visible status and keyboard-accessible retry.
Automatic recovery is bounded to three checks total, including initial load; online
and focus events coalesce with an in-flight check. An explicit retry performs only
an availability GET. An intentionally disabled receiver offers no form. Once a form
mounts, recovery listeners stop and the same form/draft remains in place. No send is
replayed automatically. Browser tests cover recovery focus, one mounted form,
unsent drafts and disabled/pending availability.

## Source and serving reconciliation

At 14:38 UTC on October 25, a fresh fetch found release branch `aba7734` and draft
#75 at `473f832`, with no other open PR. Canonical health reported `53079c5`; Dev
reported `c88cd9dd`. Current account.js and classroom-feedback.js on both origins
matched the corresponding unpatched source bytes. These are observations at that
time, not an assertion about all classroom functions or later deployments.

The Dev owner's original source is recovered locally at
`2026-10-22/class-workspace-https-stem-splitter-ailab-8/work/stem-layout`:
`c88cd9dd45f39c7273592794d71aed7703025dad` retains activity-display commit
`ab8da58ceae2004fec7de4cd8007166491b269e6`. The repair diff must be integrated
with those commits before any separately authorized Dev release; never deploy an
older integration checkout over that layout. Source integration is checked locally
without modifying the owner's checkout. This PR does not authorize deployment.

## Verification

Use the root and Cloudflare TypeScript checks, complete shared/server and Cloudflare
unit suites, and complete Cloudflare Playwright suite. Workerd fixtures and browsers
use isolated temporary storage and ephemeral localhost ports, with no participants
or paid/live provider requests. The new transport test's outbound service is wholly
synthetic and cannot contact Redmine. The full media suite requires FFmpeg with
lavfi/libmp3lame; local verification uses imageio-ffmpeg 0.6.0 installed only under
`/tmp/stem-review-media`, with its FFmpeg 7.1 binary added only to the test PATH.
No project dependency, global package or production setting changes for this tool.

Record exact final revision, results, independent review, CI state and any skipped
checks in the delivery report. Draft PR browser skips are not browser acceptance;
local checks and hosted checks must be described separately. No production report,
real SSO, physical-device acceptance, credential change, merge or deployment is
part of this repair.
