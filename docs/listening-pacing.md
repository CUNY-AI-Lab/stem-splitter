# Listening Guy pacing and recovery

This release candidate gives each signed-in account five successful generated
replies across cue, chat, songs and tabs. The fifth completion starts a five-minute
cooldown. After that deadline the next request starts a new five-turn cycle.
Cached cues, completed-request readback, failures and partial replies do not use
another successful turn. Playback remains available throughout.

The cycle replaces the signed-in daily chat/guide input and attempt limits.
It retains a rolling limit of ten new assistant attempts per account per minute,
the existing shared limit of 200 guide attempts per UTC day, guest allowances,
ingress protection and all Gateway/provider budgets. A provider outage or budget
rejection can still prevent a reply; the five-minute cycle is not an uptime or
unlimited-provider guarantee.

## Atomic accounting

`listening_cycles` stores only a subject, cycle generation, success count and
cooldown deadline. A D1 batch checks completed replies plus active reservations
before inserting an operation and its cycle reservation. At most five requests
can therefore occupy one cycle even across separate Worker instances.

The operation's successful terminal transition increments the cycle in the same
transaction. Repeated completion, failed/partial transitions and late runners do
not increment it. Existing operation leases expire after 90 seconds and remain
fenced; recovery never starts inference on an old request identifier.

## Client contract

Authenticated members can read `GET /api/listening-usage`. `/api/account` exposes
the same state as `listeningUsage`; `chatAllowance` remains the guest daily view
and is null for members. Terminal assistant SSE events include current `usage`.

```json
{
  "ok": true,
  "limit": 5,
  "successfulTurns": 2,
  "inProgress": 1,
  "remainingTurns": 2,
  "cooldownUntil": null,
  "serverTime": "2026-10-20T12:00:00.000Z",
  "retryAfterSeconds": 0
}
```

Both POST routes accept a stable `messageId` or `Idempotency-Key`. The client
must preserve the exact request snapshot while checking an interrupted attempt.
It must not create a new identifier automatically after a lost response.

| Result | Meaning |
| --- | --- |
| `listening_cooldown` / 429 | Fifth reply completed; wait until `cooldownUntil`. |
| `listening_in_progress` / 409 or 429 | Same request is running, or the cycle's available turns are reserved. |
| `listening_attempt_limit` / 429 | Ten new attempts in the rolling minute; wait for `Retry-After`. |
| `listening_attempt_failed` / 409 | Terminal attempt; `newAttemptAllowed: true` permits an explicit fresh submission. |
| `listening_attempt_uncertain` / 409 | Provider outcome is uncertain; same-key readback makes no provider call. |
| `listening_result_available` / 409 | Completion committed but delivery acknowledgement failed; retain the identifier and recover it. |
| `listening_result_unavailable` / 409 | Old completed result expired or was reset; the key still cannot generate again. |

In-flight or uncertain retries never make another model call. Terminal provider
uncertainty is bounded by 120 seconds after the original start, covering the
operation and course-conversation leases. After that bound, an explicit fresh
attempt is allowed; old output and tool effects remain fenced. Original provider
cost can remain uncertain and is never represented as refunded.

Successful readback emits validated local mixer calls before `done`. The client
buffers those calls until `done`, then clears its pending request. Server-written
notes are excluded from replay, so recovering a response cannot add a note twice.

## Privacy and retention

Course reply readback uses the existing exact-owner conversation tables. Personal
reply receipts are also exact-owner only, inaccessible through instructor and
audit APIs, and retained for at most 24 hours or the split's 90-day expiry,
whichever comes first. Job/account deletion cascades to these receipts. Personal
conversation reset atomically cancels active personal chat operations and removes
saved receipts. Accounting and event logs contain no reply text.

## Migration and verification

Apply `migrations/0028-listening-cycles.sql` to the canonical Cloudflare database
before releasing this worker. It creates additive tables, indexes and one success
trigger; it changes no historical rows and backfills no inferred usage. Do not
reapply the full schema to production. Migration 0027 is unchanged.

0028 SHA-256:
`afadba5256daac065b8e3d60bfcf6500a36a201035d0976e1245b691dc190c2f`.

Local synthetic tests cover the fifth/sixth turn and exact timer boundary,
cross-tab/two-connection reservations, cue/chat parity, partial/failed/uncertain
requests, expired identity, same-key replay, lost commit acknowledgement,
personal reset fencing, note deduplication, private receipt retention, historical
daily-limit removal and preserved global/guest limits. These tests make no paid
provider calls. Deployment and real instructor-session acceptance remain separate
release checks; this document does not establish deployed success.
