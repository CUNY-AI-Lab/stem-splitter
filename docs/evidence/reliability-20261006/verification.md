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

## Corrected implementation checks

The follow-up implementation tree passed:

| Check | Result |
| --- | --- |
| Root and Node adapter typechecks | Pass |
| Root unit/contract suite | 325/325 |
| Node database/config/isolation suite | 42/42 |
| Local separator / instrument / YAMNet Python | 5/5, 30/30, 9/9 |
| Cloudflare typecheck and unit/Workerd suite | 74/74 |
| YouTube importer / inline-parser cases (included above) | 21/21 |
| Extractor free subprocess tests | 4/4 |
| Chrome usage events, one retry, deduplication and account-clear case | 1/1 |
| Candidate Wrangler dry-run | Pass; no deploy |
| Adapter production dependency audit | No vulnerabilities in 10 packages |
| Root production dependency audit | **Blocked: four moderate Hono advisories** |

The root dependency inputs remain frozen. Audit reported `hono@4.12.34` with
GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx and
GHSA-hxh3-vqpv-xpqv. Shared Worker imports still use the root application package;
the adapter-only audit does not establish a clean deployed dependency tree.

Five direct independent-review regressions now cover abandoned-ingestion cron
recovery, stale import fencing, no-network missing-pin failure, complete
120-second polling cooldown across callbacks, and lost final database
acknowledgement. The last case verifies all four committed R2 objects still
exist, including when the first reconciliation read also fails. A pre-commit
failure remains uncharged. Auto snapshot cleanup is fenced and a completed
owned snapshot may be reused during durable recovery.

Actual Workerd checks statically imported local Wasm decoding, valid silent
MP3, invalid side information, and an overlap in one isolate between a generated
600-second >22 MiB MP3 and 12 MiB inline audio import. This is bounded local
execution evidence, not a measured peak-RSS report, a universal corruption
proof or production CPU/load acceptance. Two actual Workerd Workers also share
D1/R2 for atomic admission; separate SQLite-connection cases are not described
as Worker load tests.

Browser/source integration was 18/19 before the final classroom fixture fix:
all fenced stem-path cases passed; the remaining test expected the former logo
size. Final classroom restack, guest integration, full Chrome, Firefox playback,
targeted WebKit, dependency gate and independent review of the exact final head
remain outstanding at this receipt checkpoint.

Local command logs are kept outside the repository as
`/tmp/stem-pr3-root-final.log`, `/tmp/stem-pr3-audit-fixes.log`,
`/tmp/stem-pr3-youtube-tests.log`, `/tmp/stem-pr3-extractor-tests.log`,
`/tmp/stem-pr3-usage-browser.log`, `/tmp/stem-pr3-source-e2e.log`,
`/tmp/stem-pr3-adapter-audit.log`, `/tmp/stem-pr3-root-audit.log` and
`/tmp/stem-pr3-dryrun.log`. These paths are local receipts, not durable CI links.
