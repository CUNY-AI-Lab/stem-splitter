# Listening Guide allowances and recovery

Guests receive five generated turns for each saved split. Cue and chat requests
share those five places across tabs, reloads and UTC days. After the fifth turn,
sign-in is required to continue and save progress. Failed requests release their
place; a cached cue or readback of an existing request uses no additional turn.

Signed-in accounts use the existing daily allowances: 50 successful chat replies
and 20 guide attempts per UTC day. Chat failures and incomplete replies release
daily chat capacity. Successful splits retain their existing role-based daily
allowance. Pending work reserves capacity atomically, and Gateway and course
budgets continue to apply. A rolling limit of ten new assistant attempts per
minute and the shared 200 guide attempts per day protect the service.

## Accounting and client state

The operation ledger enforces the daily member allowances and the five-turn guest
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
This correction needs no additional schema migration.

Synthetic checks cover continued member use beyond five replies, daily and burst
limits, failed and partial refunds, shared guest cue/chat capacity, concurrent
reservations, sign-in gating, interrupted readback and ownership boundaries.
Real sign-in acceptance and deployed release verification are separate checks.
