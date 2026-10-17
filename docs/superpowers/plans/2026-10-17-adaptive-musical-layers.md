# Adaptive musical layers implementation plan

1. Rank trusted six-source PCM measurements and produce canonical two/four/six plans; reject fabricated derived contracts.
2. Stream decode and compose MP3 outputs with shared encoder timing, bounded memory, preserved gain and complete remainder coverage.
3. Supply the trusted codec through the Cloudflare adapter; retain legacy behavior with the rollout flag off.
4. Normalize new four/Auto requests to the existing six-source runner, persist adaptive intent, and publish the final model/manifest atomically through fenced ingestion.
5. Advertise adaptive four and imported-source Auto only when configured; show actual final layer names and counts.
6. Exercise synthetic codec/alignment cases, failure cleanup, cancellation/fence behavior, API ownership and browser requests.
7. Reconcile the latest Cloudflare release branch, run required gates, merge the tested tree, and deploy in isolation.
8. Verify a real canary and preserve exact audio/quality receipts. Refresh example curation only after the corresponding default-mode separations are checked.
