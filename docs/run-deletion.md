# Run deletion and failed-run expiry

CAIL accounts may delete their own runs with DELETE /api/jobs/:id. The rack removes the card after server acceptance. Durable markers block subsequent run, stem, and public-share access while accepted work settles.

Failed runs remain through two distinct rack sessions and disappear on the third. An account-scoped sessionStorage ID survives reloads; a new browser tab starts another session. The server counts distinct IDs so switching existing tabs cannot inflate visits. Users can delete failures immediately.

Deletion cancels queued work. Accepted or uncertain provider work retains its accounting and reconciliation fence until terminal. Completed usage is never refunded. Private content and dedicated uploaded audio are purged after operations settle. Sources referenced by other runs and shared Archive cache objects are preserved.

Deployment: apply migrations/0024-run-deletion.sql before enabling RUN_DELETION_ENABLED=true. The migration is additive and idempotent. Legacy class-code hosting does not support account-backed deletion or expiry.

Tests cover session counting, owner isolation, durable deletion, shared-source preservation, completed allowance, and uncertain provider cancellation fences. Production rollout is separate from local validation.
