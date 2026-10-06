# Reliable operations and allowance migration

This PR is source and local-test work. It does not deploy, apply a remote
migration, change permissions or publish the extractor image. Paid inference,
separation and import calls in tests are mocked. Independent review and the
release gates below still apply.

## Accounting and recovery

A student's successful splits plus active reservations cannot exceed 15 per
UTC submission day, across courses and browsers. One operation binds subject,
verified stored course, idempotency key and input fingerprint to import,
separation, ingestion and settlement. Validation precedes reservation. `done`
settles once only after every expected stem is locally decoded and stored.
Failed or cancelled work releases its reservation once; historical
`app_request_reservations` are preserved as attempts, never inferred successes.
An old operation finishing after midnight settles against its original day.

Listening Guy allows 50 human inputs per UTC day. One reservation wraps tools
and both Gateway attempts. Guide generation, cache reads and instructor review
are separate. No usable reply and no durable effect marker releases an input;
a partial reply counts once. A crash after a persisted delivery/effect-intent
marker counts once as delivery uncertain. A crash before any marker releases
it. Markers precede emission/effects and contain no text. A settled key returns
an actionable 409 and never regenerates a response or repeats tools. Course
reset and lease recovery fence late deltas and durable effects. The transcript
lives only in the established conversation tables, never in the operation
ledger. Empty replies cannot settle success.

App allowance release is **not a provider-billing refund**. Attempts record
provider, exact model/version, phase, request outcome, external ID and reported
usage separately. Unreported cost is unknown, never assumed free. Daily abuse
ceilings are 40 split attempts and 80 human-input attempts. Those denials,
success/active allowance exhaustion and the 100-operation queue ceiling have
distinct codes and messages.

The durable coordinator caps concurrent fetch and separation phases at one
each, with one per student per phase. Shared D1 predicates arbitrate claims;
least-recently-served students precede repeated work. The one-minute cron,
callbacks and authorized polling drain the same queue. A 24-hour unstarted
request deadline does not time out or free an accepted/unknown paid job.
Leases last five minutes; every takeover increments a fence. A runner must
successfully persist its fenced attempt before a paid POST. Expiry before that
write may requeue; expiry after it reconciles. A late accepted response supplies
its external ID through the durable attempt even if its old lease was lost.

Confirmed capacity rejection may retry at most three starts per phase within
the request deadline. `Retry-After` seconds and HTTP dates establish the full
shared cooldown, with bounded jitter only when missing/malformed. Network loss,
5xx or unreadable acceptance is uncertain: never POST a replacement. Known IDs
are polled. Callback recovery requires provider-side evidence of the exact
operation/phase callback and the pinned model version recorded before start.
An old import callback cannot adopt a separation ID. Callback bodies never
choose output URLs. Cancelled uncertain work holds allowance/capacity until an
authoritative terminal result; late success cannot settle it. Active jobs
cannot be deleted out from under the ledger.

## Audio validation and import diagnosis

The Worker uses the pinned local mpg123 module described in
[the decoder receipt](../cloudflare/vendor/README.md). Layer III framing and
side-information checks precede full chunked PCM decoding; decoder errors,
nonfinite PCM, empty output, implausible duration and damaged syntax fail.
Input is at most 24 MiB per stem and 900.1 seconds; PCM is discarded per 4 KiB
compressed chunk. Expected channels and every durable R2 write gate settlement.
The CAIL importer separately caps remote audio at 12 MiB and inline audio at
12 MiB, with a roughly 16.3 MiB prediction-JSON envelope. The inline value is removed at the byte level before metadata JSON parsing;
base64 decodes in 16 KiB chunks directly into one output buffer. Metadata is
bounded at 256 KiB. Declared oversized
bodies are cancelled before reading, streamed bodies are bounded, and decoded
stems are validated/ingested sequentially. The decoder heap is about 16.2 MiB;
a 24 MiB compressed stem plus bounded response copies and one PCM chunk fits
a practical budget below the Worker's 128 MiB isolate limit. These are explicit
input bounds, not a measured guarantee about all runtime overhead. The frozen
Railway import limits remain unchanged. A too-large unknown start response
remains in reconciliation; a size limit never permits a replacement paid POST.
This is evidence of bounded usable decoding, not a universal bit-corruption
oracle or an aesthetic/audio-quality test. A valid silent stem is allowed.

The known counterexample has complete MPEG headers but illegal side
information (`main_data_begin` exceeds the available initial reservoir and
`big_values=511`, greater than 288). Framing alone accepts it; tolerant mpg123
alone conceals it as samples. The combined validator rejects it. A local
ffmpeg `-xerror` cross-check also rejects it. Valid and corrupt inputs run
through the statically bundled module in actual Workerd, not only Node.

Archive cache reuse is restricted to the same subject and exact course.
Every hit rechecks current public rights evidence. The global fetch slot also
serializes same-source work, allowing the next request to reuse completed
bytes without sharing private data across students. Cache metadata lasts at
most 24 hours. YouTube has no affirmative reuse-rights evidence, so it is not
cached. Signed download URLs are never cached. No arbitrary-URL fetch or
source restriction bypass is added.

The 2026-10-06 read-only investigation did **not** establish a working current
Railway deployment: its latest recorded deployment was removed on October 5
and its domain returned 404. The accepted August 31 Railway source
`4c00b32fab96c8f9405095742ce3ca7170ace75b` and Cloudflare baseline `e1918da`
have identical importer, extractor and root dependency files. There was no
missing historical extractor patch to port. The Cloudflare version receipt
showed all four YouTube secret names present; their contents were not read,
and presence does not prove validity or entitlement. A normal environment
probe was blocked and a short ordinary log tail found no matching event; no
bypass was attempted. The exact live cause remains unconfirmed.

Local mocks did establish diagnostic defects in the old fallback chain:
missing/invalid configuration, provider credit rejection and pin/permission
rejection could all end as “YouTube blocked.” The durable path preserves the
stage/code/status, validates required importer configuration before reserving,
and exposes value-free configuration health. Unknown old-image errors remain
generic extractor failures; only explicit restriction evidence becomes source
denial. The updated extractor pins and cleanup are source changes only; the
existing deployed `REPLICATE_YT_MODEL_VERSION` is deliberately unchanged.

## Gateway contract

The ordered aliases are `glm-5.2`, then `deepseek-v4-flash-0731`. The current
read-only Gateway catalog reported both active with streaming and tools. This
does not establish account entitlement or successful live inference.

Fallback is allowed only before an accepted stream, any output or any tool
side effect, with `should_retry === true` and these exact normalized pairs:
`upstream_rate_limited`/429, `upstream_unavailable`/503 and
`model_unavailable`/503. The verified serving source and contract are
[36cd8cdb](https://github.com/CUNY-AI-Lab/cail-gateway/blob/36cd8cdb7d61e2aebc94a03171b5990cea00bf5e/docs/gateway-contract.md#L535-L570).
Quota, authentication, payment, policy, unknown 429 and timeouts do not trigger
fallback. One deadline spans both attempts. The verified subject and course
prompt remain unchanged. Partial/trailing stream failure never calls another
model. Tools-only replies get local narration, and duplicate tool IDs fail.
Missing or different backup configuration fails closed.

Course deltas and effect intents atomically check the active conversation claim.
Notes and durable replies also require the live 90-second operation lease,
within the conversation's longer 120-second recovery lease. Final delivery
requires a winning operation settlement and the unchanged completed course
revision. Expiry, recovery or reset cannot authorize a stale tool event or
restore a cleared transcript.

## Private operational and usage evidence

Lifecycle and attempt events are transactionally recorded alongside the durable
ledger, including operation/attempt IDs, type, phase, state, elapsed duration,
normalized error, pinned model, fallback and reservation/charge/release effect.
Repeated settlement or unchanged attempt completion cannot add a second charge
receipt. Provider usage retains only finite numeric accounting fields.

Discrete browser observations cover page/session attachment, successful play,
stop, committed seek and download intent. Server observations cover page
responses, rejected split/chat requests, annotation saves/deletes and routed
download responses. Download acceptance is not proof the browser saved a file;
client observations are not billing evidence or unique-person counts.
There is no audio, chat/annotation text, name, email, title, source URL, signed
URL or credential in these event tables. Job/operation IDs are internal support
correlations. Date-scoped subject hashes limit logging volume without
copying the institutional identity into usage events; these are pseudonymous
operational records, not an anonymity guarantee.

Client recording is explicitly best effort: a 50-event in-memory queue sends
batches of at most ten, with one bounded retry and stable IDs. Closing a page,
offline use, blocked requests, process loss or the daily protection ceiling can
lose observations. Signed-out public-audio playback and seek cannot submit
private usage events; only page/download server observations cover that case.
Account changes clear the queue and abort outstanding work.
Server critical operation triggers are durable; auxiliary request/page logging
cannot break the original request on a diagnostics failure. Idempotent rejected
requests coalesce; requests with no operation key are separate observations.

Events are access-controlled in the existing D1 database and purged after
30 days. A student/guest may submit only the fixed event vocabulary for work
they can currently access. Per-day client ceilings are 500 member/250 guest
observations and 25,000 total auxiliary events globally. The existing admin-only
`GET /api/admin/usage-events?days=7` returns aggregate counts, outcomes and mean
durations for at most 30 days, without identities or content. Client and server
counts remain separate to prevent treating them as additive exact usage.
Minimal non-content unresolved operation/billing evidence follows the separate
reconciliation policy below; no external analytics destination is introduced.

## Migration, drain and rollback

Before any approved release, take and verify an environment-specific database
backup and record the installed migration version. Rehearse restoration into
a disposable local database. Apply existing baseline migrations, then
`0021-classroom.sql`, then additive `0022-reliable-operations.sql`, before new
code accepts work. `0021` adds existing-table columns and must be tracked/applied
once; do not blindly rerun it. `0022` is repeatable. Fresh `schema.sql` and the
baseline-to-0021-to-0022 upgrade are compared in tests, including preservation
of old private messages, notes, ownership and historical attempts. No legacy
course associations or successful charges are manufactured.

Choose and record a UTC start boundary. Pause old-version intake before it;
new reservations start only under the new version after the schema is ready.
An old ten-attempt reader cannot account for the new success ledger. Do not
allow mixed old/new intake against the same database during conversion.

For a rollback, set `SPLIT_STARTS_DISABLED=true` in a separately authorized
release. It pauses intake/new paid starts while preserving read/playback and
known-operation reconciliation. Cancel queued work through the cancellation
path. Drain accepted work and reconcile unknown starts with exact provider
IDs/phase/version evidence. Never mark an unknown start failed merely because
its lease expired. Keep a compatible reconciler until those operations are
terminal. Do not drop new tables or restore an old backup over newer work.
If returning to the historical reader, keep intake paused through the next
UTC boundary and until all in-flight work is settled; otherwise neither its
old daily count nor its rollback can represent the same allowance safely.

A vanished provider response with no discoverable ID can require operator
reconciliation; no provider-wide idempotency lookup is claimed. Retain the
minimal correlation/cost evidence and hold the operation rather than guessing.
At 90 days, request filenames/URLs, replay metadata and cached source metadata
are redacted even for unresolved operations, cancellation is requested, and
existing conversation/audio retention still applies. Minimal non-content
accounting/external-ID evidence remains for reconciliation. An unresolved
provider start never retains the original private request indefinitely.

## Release gates and evidence

Completed local checks and their exact counts are recorded in
[the verification receipt](evidence/reliability-20261006/verification.md).
Two actual Workerd Workers share a local D1/R2 fixture for concurrent admission;
separate two-connection SQLite tests exercise fair progress and fault recovery.
Neither is production load evidence.

Before enabling this release: independent Astra High review of the final
stacked head; normal Source, Pinned analysis image and Cloudflare CI gates;
approved database plan/backup/drain; confirmed Gateway account entitlement;
approved pinned extractor image build and permitted-source canary; and an
approved normal-runtime audio acceptance check, including long tracks/resource
limits. No test here launches a paid job or changes production. The root
analysis-image dependency inputs are unchanged; only the adapter gains the
small pinned decoder dependency and separately imported module.
