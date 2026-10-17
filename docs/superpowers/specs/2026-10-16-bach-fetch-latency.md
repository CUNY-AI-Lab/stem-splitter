# Archive discovery and fetch latency

The Bach prelude trace exposed two avoidable waits: album-credited catalog hits
monopolized metadata slots ahead of recordings with file-level artist tags, and
stale or slow direct storage locations delayed the canonical download resolver.
The previous single before/after measurement does not establish causation for
its 306 ms difference; retain that limitation when reporting timings.

## Behavior

- Interleave two item-credited documents with one document needing file-credit
  inspection. Preserve the six-request metadata pool, forty-item bound, final
  sixteen-item selection, and result relevance ranking. No Bach-specific IDs,
  queries, or trusted recordings enter application code.
- Race the existing direct storage probes with a canonical resolver request
  after 600 ms, or immediately when both direct probes fail. A fast verified
  mirror cancels the timer without starting the resolver. At most two direct
  requests and one canonical attempt run per logical probe; the four-probe pool
  remains unchanged. Canonical retries remain sequential and bounded.
- Cancel all losing requests, body reads, pending retry delays and fallback
  timers. Preserve canonical error retryability when every route fails.
- Keep metadata, credit, music, access, duration, byte-range, size and audio
  signature checks. Full imports retain their fresh-metadata and complete-file
  validation. Never expose provider data-node locations to the browser.

Internet Archive documents storage locations in its
[metadata API](https://archive.org/developers/md-read.html). Location hints are
optimizations, not evidence that a file is available or valid.

## Acceptance

Deterministic tests reproduce blocked file-level credit discovery, canonical
fallback while direct nodes are stalled, and cancellation before a losing
fallback retries. Existing search/import and browser suites must pass.
Measure real Archive searches in separate processes to empty application caches,
alternating baseline and candidate order. Record live edge-cache misses
separately: an edge miss alone cannot establish an empty metadata cache, and
upstream latency varies. Verify live search after merging a passing exact tree.
