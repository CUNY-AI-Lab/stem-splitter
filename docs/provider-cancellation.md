# Replicate cancellation

This repair preserves the existing Demucs runtime policy. A four-minute CPU-import canary budget does not establish a supported global cutoff for GPU separation. No new separator `Cancel-After` header is introduced. The existing hosted YouTube importer retains its `Cancel-After: 4m` behavior.

A separately reviewed acceptance run still needs a test-specific provider deadline, the exact deployed pin's hardware/rate, current credit coverage and explicit spending approval. Cancelling does not refund compute already used. Existing application operation/lease deadlines fence new starts but are not provider compute deadlines.

When a user cancels, the durable cancellation flag makes that operation eligible for reconciliation without bypassing the provider cooldown or an active lease. Only that operation is reconciled by the HTTP cancellation route; unrelated jobs are not started. For a known Replicate prediction, reconciliation:

1. Reads the prediction from the fixed Replicate API origin and validates its ID/status.
2. If it is still running, POSTs to that prediction's `/cancel` endpoint.
3. Reads again to confirm a terminal status before releasing the successful-split reservation. A cancellation acknowledgement alone is insufficient.

Network errors, timeouts, rate limits, missing predictions, invalid IDs/statuses and malformed responses preserve the reservation and prediction ID for reconciliation. Rate limits respect Retry-After. No replacement prediction is created for an ambiguous start or cancellation. If a lost submission response left the ID unknown, the existing callback/attempt recovery must establish it; elapsed time alone does not prove completion. An unknown old prediction remains unresolved until authoritative evidence establishes its identity/status.

If completion beats cancellation, a previously committed success remains charged once. If cancellation is recorded before completion is committed, output cannot be published as a successful split and the allowance is released after terminal evidence. The existing database guard protects cancellation during stem downloads/storage, and uncommitted stored stems are removed. Failed or provider-cancelled runs do not consume successful-split allowance. These are application quota semantics, not provider billing refunds.

The durable paid-attempt insert now also checks the active lease, operation deadline and cancellation flag, preventing a cancellation received during preparation from starting compute. A cancellation arriving after that insert is handled against the same accepted provider ID.

Provider documentation:
- https://replicate.com/docs/topics/predictions/create-a-prediction#prediction-deadlines
- https://replicate.com/docs/reference/http#predictions.cancel

Validation is entirely local with mocked provider calls. `cloudflare/provider-cancellation.test.ts` covers preservation of runtime policy, unknown/terminal statuses, cancellation acknowledgements, provider failures/cooldowns, lost submissions, concurrent reconciliation, fetch/split cancellation, HTTP ownership and scheduling, late completion/storage, and member/guest allowance behavior. It does not prove a live model's cancellation behavior or account credit coverage.
