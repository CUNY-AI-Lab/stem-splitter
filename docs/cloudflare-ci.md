# Cloudflare CI

Cloudflare checks run for pull requests and pushes to `codex/cloudflare-migration`.
New commits cancel an older run on the same ref.

Documentation-only changes (`docs/**` and root Markdown files) finish after
checkout and verification of the change detector. The existing `cloudflare`
check stays present so required checks can complete.

Draft pull requests run dependency installation, type checking, Workerd tests
and both bundle validations. Marking a pull request ready for review runs the
full Chrome and Firefox suites; later commits on a ready pull request do too.
Direct pushes to the Cloudflare release branch also retain the full suites.

After a merge, CI can reuse the browser result from a successful pull-request
run only when its saved receipt has the same complete Git tree as the merge.
The receipt and its successful run must identify this repository, workflow,
source head, and both Chrome and Firefox. The merge still runs type checking, Workerd tests and bundle
validation. Missing or expired receipts, API failures and different trees run
fresh browser checks. Squash merges and direct commits also run fresh checks.

Both browser commands use two workers on one runner, with independent tests
scheduled in parallel. Each test creates its own harness, database and browser
context. The local configuration continues to default to one worker.

Missing Git history or an unfamiliar file path requests full verification.
The general source and native audio-image gates are selected separately in
the `CI` workflow; see [General CI](general-ci.md).

FFmpeg installation first tries the runner's existing package index with a
short deadline. An outdated or missing index falls back to the bounded metadata
refresh and installation retries. Both Ubuntu source configuration formats,
including `/etc/apt/apt-mirrors.txt`, use the official Ubuntu archive in place
of the slow Azure package mirror, with the same signed package metadata.
