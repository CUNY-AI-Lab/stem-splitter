# Query-isolation output hydration implementation plan

## 1. Freeze the output boundary

- Add strict output URL and RIFF/WAVE validation.
- Share one bounded download deadline across header and body reads.
- Store only deterministic app-owned target/residual keys and return a content
  digest, byte count, media type, and retention deadline.

## 2. Add additive persistence

- Add idempotent lease and output-metadata tables to the canonical schema and
  Railway boot schema.
- Add numbered migration `0016` plus remote/local package scripts.
- Add Node and numbered-migration parity tests for columns, indexes, and
  immutability triggers.

## 3. Make terminal ingestion atomic

- Acquire an exact external-id-bound lease with a three-attempt ceiling.
- Add lease release, terminal failure, and output-completion transitions.
- Require stored output metadata and resource completion to commit together.
- Keep execution/start failures and provider-output ingestion failures distinct.

## 4. Compose and attack the dormant path

- Compose provider terminal results, output hydration, persistence, and source
  snapshot cleanup behind a module that no app route imports.
- Test duplicate observers, expired leases, retry exhaustion, malformed audio,
  download/storage failures, partial cleanup, terminal replay, and unchanged
  core stems.

## 5. Bind evidence without rollout

- Run focused TypeScript, source, isolation, Railway migration, and diff gates.
- Commit the executable slice, then run the literal complete Phase 0 command at
  that exact commit.
- Update `TODO.md`, the provider review, provisioning runbook, and processing
  changelog with exact evidence and remaining blockers.
- Reconfirm the Railway feature posture remains off; do not stage variables,
  call Replicate, deploy, push, or open a pull request without separate
  authorization.
