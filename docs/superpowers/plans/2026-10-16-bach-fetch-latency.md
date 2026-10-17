# Bach search and Archive fetch implementation

1. Trace current Bach catalog, metadata, and verification stages; capture live
   cache-miss baselines without simultaneous browser prefetches.
2. Add a regression that fails when item credits monopolize metadata capacity;
   interleave discovery while preserving validation and result ranking.
3. Hedge slow direct verification through the canonical resolver; cancel losing
   requests and retry delays. Cover stalled nodes, successful mirrors and errors.
4. Run Archive regressions, root and adapter typechecks, focused browser tests,
   and the complete source and Cloudflare CI gates.
5. Merge into codex/cloudflare-migration, verify merged/tested tree equality,
   deploy the isolated merge with cloudflare/wrangler.jsonc, then verify live
   health, version, uncached Bach timings, Tab acceptance and visible results.
   Preserve concurrent releases and record the current rollback version.
