# Cloudflare migration — current state and remaining gates

Updated September 29, 2026. [TODO.md](TODO.md) is the single active checklist.
The [original plan](docs/archive/migration-plan-2026-09-06.md) is historical
evidence, not current operating instructions.

## Serving architecture

The application is https://stem-splitter.ailab-452.workers.dev/. Its alias Worker
forwards privately to `cail-stem-splitter-preview`, with dedicated D1/R2. Preview
and canonical addresses share runtime/data but have host-specific auth cookies.
Only `cloudflare/wrangler.jsonc` and its existing alias configuration are release
targets. Never use the root legacy deployment command.

The release branch is `codex/cloudflare-migration`. PR #16 is deployed as
`cloudflare-playback-retention-20260929`. Cloudflare uploads/stems now expire
after **90 days**, matching account listing, routed reads and bucket lifecycle.
This change does not recover previously deleted audio.

Railway is retained and unchanged. Its data, policy and release branch are
separate. Do not deploy to it, merge this branch into Railway main, transfer
private recordings or retire the host as an incidental migration step.

## Identity and model transport

CUNY sign-in uses Doorway's existing private `WorkerIdentity` handoff, not a new
Tools mount or CUNY client. Requests verify identity and current Admission.
Class membership admits eligible students; it does not share their recordings,
import legacy data or automatically grant app instructor editing access.

Listening Guide already uses the private CAIL Gateway with the person's verified
Gateway identity. The old direct-OpenRouter comparison is not an unimplemented
prerequisite. Do not add a bypass/fallback or change the pinned model without
separate acceptance. Shared Gateway owns model-allowance enforcement.

Replicate retains its approved existing key/transport. Ten daily submitted runs
is a count limit, not GPU-cost accounting. Asynchronous Replicate cost settlement
against Lab allowances remains unimplemented. Three anonymous daily runs remain
off pending private visitor ownership, limits and bot verification.

## Remaining order

1. Diagnose/fix reported first-attempt sign-in; verify fresh login, logout,
   expiry and shared-device isolation.
2. Actual student/instructor save-and-return acceptance. Existing-session and
   local fixture checks are not substitutes.
3. Visitor access, class-scoped settings and the separate shared GPU-accounting
   contract, preserving the working member path.
4. Rehearse approved legacy import with identity/ownership evidence, original
   dates/provenance, byte checks, backups and batch-only rollback. The new 90-day
   policy does not automatically extend legacy custody or authorize old imports.
5. Provider canaries, large-file/classroom load, failure recovery, expiry and
   rollback on the exact Worker release.
6. Promote Remixer and optional analysis independently through their gates.
7. Soak and explicit retirement approval; check Railway service dependencies first.

See [class accounting](docs/class-access-and-usage.md), [account migration](docs/account-migration-readiness.md)
and [Cloudflare operations](cloudflare/README.md) for the specific contracts.

## Rollback

- Preserve the last accepted Worker version; read back canonical assets/health
  after release. Leave optional flags off until their own acceptance.
- Do not restore the legacy root Worker at the canonical address.
- Code rollback cannot reconcile D1/R2 writes into Railway. Traffic/data reversal
  needs a reviewed reconciliation manifest; DNS alone is insufficient.
- Rotate compromised secrets forward, never restore exposed credentials.
- Keep both environments' evidence/data. Green CI, host health, authenticated
  behavior, accounting readback and human acceptance are separate receipts.
