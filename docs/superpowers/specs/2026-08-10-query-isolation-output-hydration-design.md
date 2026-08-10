# Query-isolation output hydration design

**Status:** implementation slice; execution remains unavailable

**Release boundary:** Railway is the active integration target. This design
adds no app route, provider call, credential, flag change, deployment, or
Cloudflare Worker release.

## Problem

The dormant AudioSep adapter can validate a terminal provider URI, but a URI is
not a durable classroom artifact. Before teacher beta, the app must bound and
validate the returned bytes, store them under an app-owned isolation namespace,
bind their identity to the exact provider attempt, survive duplicate webhook and
poll observations, and honor the same 30-day audio-retention boundary as core
stems. None of that may mutate `jobs.stems` or imply that independently queried
outputs reconstruct the source.

## Contract

1. Only a `teacher_beta` isolation in `processing` state with the exact stored
   provider prediction id can acquire an ingestion lease.
2. One active lease prevents a webhook and reconciliation poll from downloading
   the same terminal output concurrently. An expired lease can be reclaimed,
   but no more than three ingestion attempts may be acquired.
3. Provider output URLs must be HTTPS URLs with no userinfo, fragment, or
   nondefault port on `replicate.delivery` or one of its subdomains. Opaque
   provider query parameters are accepted for transport but never persisted or
   exposed. Downloads use manual redirect handling, one shared deadline,
   bounded retries, and a 100 MiB ceiling.
4. This AudioSep slice accepts one real RIFF/WAVE target. It verifies the RIFF,
   WAVE, `fmt `, and nonempty `data` chunks rather than trusting the URL suffix
   or `Content-Type`. HTML, truncated chunks, unsupported encodings, redirects,
   and oversized bodies fail closed.
5. The target is written only to
   `isolations/<isolation-id>/target.wav`. Its SHA-256, byte count, media type,
   storage key, creation time, and 30-day retention deadline are persisted in a
   separate output table. The core split row and stem array never change.
6. Output metadata insertion, isolation completion, and lease removal form one
   database batch. Metadata conflicts abort; a losing terminal observer cannot
   finalize or delete another observer's output.
7. Network and storage outages release the lease for a bounded retry. Unsafe or
   malformed terminal output becomes an app-owned non-retryable failure. Raw
   provider errors, output URLs, signed source URLs, and credentials are never
   persisted or returned.
8. Terminal success or failure removes the app-owned provider-input snapshot.
   Cleanup failure cannot rewrite a correct terminal state; a duplicate
   terminal observation retries the narrow cleanup, and the ordinary audio
   lifecycle remains the backstop.
9. Output metadata may be deleted with its owning isolation/job, and the audio
   object expires under the existing 30-day lifecycle. Matching source hashes
   do not authorize cross-job reuse; that remains a separate future decision.

## Persistence

Two additive tables avoid changing the existing isolation status enum:

- `instrument_isolation_ingestion_leases` stores the exact prediction id,
  opaque lease id, deadline, attempt count, and maximum.
- `instrument_isolation_outputs` stores immutable-per-row target/residual
  identity and retention metadata. This slice writes only `target`; `residual`
  remains reserved for a later reviewed provider such as SAM-Audio.

Fresh installs, Railway boot migrations, and numbered migration `0016` must
carry the same table/index/trigger SQL. No destructive schema rollback is
required; feature rollback remains flag-only.

## Acceptance

- Two concurrent terminal observers yield one lease and one output download.
- A live lease blocks a second claimant; an expired lease is reclaimable; the
  fourth acquisition fails the resource safely.
- Redirect, foreign host, credentials, HTML, malformed/truncated WAV, declared
  and streamed overflow, timeout, and storage failure tests all fail closed.
- Transient failure leaves the provider attempt recoverable without reserving a
  new paid start; terminal invalid audio does not.
- Database and object-store failures leave no partial completed isolation;
  database rollback evidence covers metadata, object cleanup, and lease release.
- Stored identity matches exact output bytes; source snapshot cleanup is narrow;
  the completed core job remains byte-for-byte unchanged.
- Existing flags-off, server-Auto, discovery, teacher, and 2/4/6 contracts pass
  unchanged under the complete Phase 0 gate.
