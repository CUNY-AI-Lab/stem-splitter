# Faster first-time Archive search

A cold query must stream verified music results without waiting for the slowest catalog or storage node. Repeated-query caching alone does not meet this requirement.

## Changes

- Reserve early discovery for each catalog: all sixteen music-scoped hits, plus four from each broad/credited query. Retain the final sixteen-item relevance pass. Maximum forty distinct metadata reads, with six active at once.
- Use the storage locations supplied by Archive's metadata API for public search probes. Accept only numeric Archive data-node hosts and the exact item's directory. Race at most two nodes, cancel the losing request, and fall back to the canonical download resolver if both fail within 2.5 seconds.
- Preserve existing byte-range, file-size, MP3 signature, music/credit, duration, access, and license checks. Imports still fetch fresh metadata and validate complete audio. Do not expose data-node locations in responses.
- Keep existing bounded caches, four active logical probes, streaming results, and final relevance ranking.

Archive documents the `server`, `workable_servers`, and `dir` fields at https://archive.org/developers/md-read.html.

## Acceptance

Deterministic tests must prove a fast broad catalog cannot starve music results behind a stalled credited catalog, the responsive mirror wins without waiting for a stalled sibling, canceled probes release resources, and invalid/unavailable locations fall back safely. Existing filtering/import tests must pass. Compare first-result latency for live cache misses before and after release, recording result counts and total time separately; upstream variation is not a guaranteed latency bound.
