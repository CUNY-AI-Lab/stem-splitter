# Cold search implementation and release

1. Profile catalog, metadata, and delivery stages with real Archive calls; capture live first-query baseline timings.
2. Remove the shared early-discovery starvation and skip the download redirect using validated metadata storage locations, with a bounded two-node race and canonical fallback.
3. Run search/import regressions, root and Cloudflare typechecks, focused browser tests, and exact-commit CI.
4. Merge to codex/cloudflare-migration only after CI passes. Prove the merged tree matches the tested tree and deploy its isolated archive through cloudflare/wrangler.jsonc.
5. Compare uncached live first-result timings, verify the streaming search interface, health and runtime version, and retain rollback evidence. Do not change Railway, identity, storage policy, or provider configuration.
