# Listening Guide allowances and recovery

Anonymous browser guests receive two successful real replies for the entire
session. Cue and chat share those places across recordings, tabs, reloads and
UTC days. The first reply appears normally. The second includes a subtle
application-provided sign-in link inside the chat. A third interaction displays
only a sign-in request before any model call. Failed, empty and incomplete
replies release demo places; cached cues and exact-request readback use no
additional place. The source is ready for funded activation, which remains
disabled pending its specifically approved sponsorship and spending contract.

Signed-in accounts use the existing daily allowances: 50 successful chat replies
and 20 guide attempts per UTC day. Chat failures and incomplete replies release
daily chat capacity. Successful splits retain their existing role-based daily
allowance. Pending work reserves capacity atomically, and Gateway and course
budgets continue to apply. A rolling limit of ten new assistant attempts per
minute and the shared 200 guide attempts per day protect the service.

## Accounting and client state

The operation ledger enforces the daily member allowances and the two-reply guest
limit in the same D1 batch that reserves each request. Guest reservations require
a saved recording identifier. Claiming a guest session keeps its original guest
accounting class while transferring ownership through the existing claim path.
Historical listening cycle tables remain available for old receipts; new member
requests use daily accounting and return a null cooldown deadline.

Members read `GET /api/listening-usage`; `/api/account` returns the same daily chat
state as `listeningUsage`, including `limit`, `successfulTurns`, `inProgress`,
`remainingTurns` and `resetsAt`. Guests read the exact-owner recording route
`GET /api/jobs/:id/listening-usage`. Exhausted guest requests return
`guest_listening_signin_required` with HTTP 403 and current usage.

Both assistant POST routes accept a stable `messageId` or `Idempotency-Key`.
Interrupted requests retain that identifier for readback. Pending or uncertain
retries make no further provider call; an explicit new attempt can follow a
terminal failure. Existing lease recovery fences late output and tool effects.
Provider cost can remain uncertain even when an incomplete reply releases input
capacity.

## Privacy and release checks

Existing exact-owner receipt and conversation access, expiry, deletion and reset
fences remain in force. Accounting and activity summaries contain counters and
request state, while reply text stays within the existing owner-only paths.
The member allowance correction needs no new table. The accompanying guest reply
recovery requires additive migration `0029-guest-listening-replies.sql`, which
creates exact-owner guest receipts before this worker is released.

Synthetic checks cover continued member use beyond five replies, daily and burst
limits, failed and partial refunds, shared guest cue/chat capacity, concurrent
reservations, sign-in gating, interrupted readback and ownership boundaries.
Real sign-in acceptance and deployed release verification are separate checks.
