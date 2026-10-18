# Implementation and release plan

1. Pin and statically bundle wasm-media-encoders 0.7.0 with corresponding source,
   license notices, digest verification and local module injection.
2. Split measurement, peak detection and encoding into reusable bounded stages.
   Keep the inline shared-host adapter for configurations without a queue.
3. Save provider completion and output progress in split-only `result_json`
   envelopes. Release provider capacity only after this durable handoff.
4. Resume one stage per queue delivery. Use fenced unique R2 keys and multipart
   uploads; validate finished outputs in separate invocations. Keep committed
   objects on uncertain D1 acknowledgements and remove unpublished partials.
5. Dispatch through the D1 outbox with periodic recovery, separate local output
   leases from provider cooldowns, and retain the existing hard deadline/DLQ.
6. Set the dev provider ceiling to two with one per subject; keep output
   concurrency at one. Make the preparation phase visible in the existing UI.
7. Test duplicate delivery, crash/lease takeover, lost sends, lost acknowledgements,
   cancellation, deadline crossing, fair multi-Worker claiming, storage failures,
   full fifteen-minute four/Auto composition and authenticated output playback.
8. Run the shared, adapter, browser and immutable-tree release gates. Merge through
   the shared Cloudflare branch and deploy the exact merge only to dev, with
   `SPLIT_STARTS_DISABLED=true` as requested. Verify health, sign-in, assets and
   provider-disabled behavior. Live provider/allowance counts, Cloudflare CPU
   timing and generated-stem playback remain pending until dev is enabled.

Rollback: the preceding Worker version can read the unchanged schema. Its older
code ignores the output journal and re-polls the same existing prediction. Drain
active output stages before rollback where possible; do not delete provider or
accounting evidence. Older code reinstates the monolithic CPU limitation.
