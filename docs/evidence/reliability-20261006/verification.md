# PR3 local verification — 2026-10-06

All provider starts/inference in these checks are mocked. No production data,
paid jobs, migrations, permissions, extractor publication or deployment changed.
This is an implementation receipt, not an independent audit certification.

## Published checkpoint

`aa74797ce38d9b5dbfcc4849daf17b0cd41a4c96`, on classroom checkpoint
`daaa8c55a51a6c6ef8a2bc82d8eebba623cc87e7`, was separately checked in a disposable
worktree: Cloudflare typecheck and 66/66 tests; importer 20/20 tests. The draft
at that point had a temporary 4 MiB inline limit and five recovery defects
subsequently reproduced by the independent reviewer. It is not release-ready.

## Integrated implementation checks

Final application source is `ba752069180e625dfb85f49fe773ca523010fc1e`, stacked
on PR2 `f5506597f8fab2196d3f55119242d76210ff553d`. The later test-only commit
`cd48cd4233c4da931a59c019625cf7d0cba50426` asserts the intended telemetry
rejection during deliberate fixture identity switches. Receipt commits do not
change application behavior. All three TypeScript checks passed.

| Check | Result |
| --- | --- |
| Root and Node adapter typechecks | Pass |
| Root unit/contract suite | 325/325 |
| Node database/config/isolation suite | 42/42 |
| Local separator / instrument / YAMNet Python | 5/5, 30/30, 9/9 |
| Cloudflare typecheck and unit/Workerd suite | 84/84 |
| YouTube importer / inline-parser cases (included above) | 21/21 |
| Extractor free subprocess tests | 4/4 |
| Full Chrome suite | 38/38 |
| Firefox playback, guest and account | 23/23, including all 18 playback cases |
| Targeted WebKit playback, guest, account and Gateway | 24/24 |
| Final account fixture assertion, Chrome / Firefox / WebKit | 4/4 in each |
| Candidate Wrangler dry-run | Pass; no deploy |
| Adapter production dependency audit | No vulnerabilities in 10 packages |
| Root legacy dependency audit | Four moderate Hono advisories; absent from candidate bundle |

The root dependency inputs remain frozen. Audit reported `hono@4.12.34` with
GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx and
GHSA-hxh3-vqpv-xpqv. The candidate and test Wrangler configurations explicitly alias both `hono`
and `hono/factory` to adapter `hono-cloudflare@4.13.11`. The dry-run build
metafile confirms all 27 Hono inputs use that patched alias and zero use the
legacy root package. The [bundle receipt](bundle-dependencies.json) records
that check. The four root advisories remain a legacy Node/analyzer dependency
finding; they are not a demonstrated candidate runtime exposure. Frozen root
analysis-image inputs were not changed.

The five initial independent-review regressions cover abandoned-ingestion cron
recovery, stale import fencing, no-network missing-pin failure, complete
120-second polling cooldown across callbacks, and lost final database
acknowledgement. The last case verifies all four committed R2 objects still
exist, including when the first reconciliation read also fails. A pre-commit
failure remains uncharged. Auto snapshot cleanup is fenced and a completed
owned snapshot may be reused during durable recovery. The reviewer's follow-up
cross-operation/cross-phase cooldown case now checks the shared provider floor
inside the atomic reconciliation claim. No browser polling is needed to recover
an expired ingestion lease. These are implementation regressions; final
independent approval is recorded separately by the reviewer.

Additional cases cover 30 simultaneous submissions across two actual Workerd
Workers sharing D1, 15 member places, 60 human inputs limited to 50, 20 students
through two SQLite coordinators, UTC/year/DST boundaries, unknown starts,
cancellation and duplicate callback settlement. Guest checks exercise separate
ownership, 5/25 accounting, simultaneous 25th/26th inputs, partial output,
failed-input replacement, proof renewal and immutable quota provenance.
Operation recovery rejects late final delivery; course effects check the live
operation as well as the conversation claim. Reset after a saved reply but
before final delivery cannot restore that reply or emit its tools.

Usage tests validate fixed fields, no private content, stable retry IDs, separate
member/guest aggregates, bounded volume and 30-day retention. Old-actor batches
are rejected before recording under a new cookie. WebKit surfaced these
intentional 409 responses during the account fixture's rapid identity changes;
the fixture now requires the exact rejection body and differing request/verified
response actors before allowing that specific console entry. Unrelated errors
still fail. Browser capture remains best effort, not guaranteed accounting.

Actual Workerd checks statically imported local Wasm decoding, valid silent
MP3, invalid side information, and an overlap in one isolate between a generated
600-second >22 MiB MP3 and 12 MiB inline audio import. This is bounded local
execution evidence, not a measured peak-RSS report, a universal corruption
proof or production CPU/load acceptance. Two actual Workerd Workers also share
D1/R2 for atomic admission; separate SQLite-connection cases are not described
as Worker load tests.

The earlier corrected source-browser checkpoint passed 19/19 after updating
the fenced stem paths and inheriting the final classroom logo/title fixtures.
No path was flattened to satisfy an old assertion. Account recovery/logout now
use actual local HTTPS 303 responses and Secure cookies in all three engines.
Guest screenshots from the isolated handoff were reviewed; the guest and shared
mixer retain the existing controls and separate private ownership. Local guest
fixtures mock Turnstile, Registry/Gateway and Replicate; they establish none of
those live grants or paid-provider results.

Remaining gates are exact-head independent Astra High review, final PR3 CI,
approved backup/migration/drain and release, actual Gateway member/sponsor
entitlement, real exact-host bot verification, an approved extractor image build
and pin, and permitted-source/normal-runtime audio acceptance. The deployed
extractor pin is unchanged. The reported live YouTube failure has not been
reproduced or assigned a verified root cause. Source diagnostics and 12 MiB
bounded imports are not a claim of a production fix or universal source access.

Local command logs are kept outside the repository as
`/tmp/stem-pr3-final-root.log`, `/tmp/stem-pr3-final-cloudflare.log`,
`/tmp/stem-pr3-final-extractor.log`, `/tmp/stem-pr3-final-chrome.log`,
`/tmp/stem-pr3-final-firefox.log`, `/tmp/stem-pr3-final-webkit.log`,
`/tmp/stem-pr3-final-account-{chrome,firefox,webkit}.log`,
`/tmp/stem-pr3-source-e2e.log`, `/tmp/stem-pr3-integrated-adapter-audit.log`,
`/tmp/stem-pr3-root-audit.log` and `/tmp/stem-pr3-final-dryrun.log`.
The [machine-readable receipt](final-checks.json) records commands, tested heads,
results and log hashes. These paths are local receipts, not durable CI links.
