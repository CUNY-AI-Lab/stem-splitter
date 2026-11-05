# Local Cloudflare releases

Authorized November 5, 2026: develop and commit locally, deploy through Cloudflare,
and push GitHub updates at meaningful checkpoints. A push, PR, merge, Actions run,
and a current remote-main SHA are **not** prerequisites for this local release path.
This takes precedence over earlier merge-before-deploy instructions for these targets.

## Target and source

Use the Cloudflare `dev` lineage, never Railway `main` or root `wrangler.jsonc`. Production deploys `cloudflare/wrangler.jsonc` to `cail-stem-splitter-preview`, behind the existing `stem-splitter` alias. Dev uses `cloudflare/wrangler.dev.jsonc` and its separate storage. The alias, import helper and Railway services are not deployed by this command.
Both targets are pinned to CUNY AI Lab account `452c33847cf5cb1e46f391fca32fd1b5`.
Database/bucket policies, provider pins, secrets, aliases and helper Workers retain
their existing separately verified setup. Review schema/config changes and apply
any required migration separately before releasing dependent code. A code release
never authorizes data deletion or a database rollback.

## Routine

1. Make and review a coherent batch of changes. Commit the intended files locally;
   do not sweep unrelated edits into the commit. Verify author AND committer with
   `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`: both must be
   `zmuhls <42992492+zmuhls@users.noreply.github.com>`. Use a short lowercase message
   with no sign-off. The release command rejects a dirty checkout.
2. From cloudflare, inspect `bun run deploy:plan`. Run `bun run deploy:check`
   to execute the local gates and bundle dry run without a deployment, or
   `bun run deploy:dev` to run those same gates and then deploy Dev.
3. Complete the real signed-in Dev acceptance appropriate to the change. Record
   the exact source and results in a local Markdown file. Exercise a real split through playable nonblank stems and the changed UI; mocks do not establish provider/audio quality.
4. Deploy that same commit to production:

```sh
bun run deploy:production --dev-receipt /absolute/path/to/dev/receipt.json --acceptance /absolute/path/to/dev-checks.md
```

Production verifies the successful Dev receipt, matching commit/tree, acceptance
notes, and the current Dev health marker before uploading. It then independently
runs all configured local gates. The notes file is an operator attestation; the
script cannot prove that a person actually performed the checks.

The command makes an isolated archive of the commit and installs frozen dependencies
there. It typechecks/tests/bundles that archive, rejects changes to tracked source
made during checks, and deploys with `RELEASE=<full local commit>`. It records the
structured Wrangler version ID, deployment history before/after, 100% traffic to
the uploaded version, live release marker and anonymous access denial. Readiness
success remains distinct from authenticated acceptance.

## Prerequisites and coverage

Use Node 22.23.1+ and Bun 1.4.0, plus the pinned Playwright Chromium (installed by the command).
Use the existing authorized Wrangler login, or an appropriately scoped
`CLOUDFLARE_API_TOKEN` supplied through the environment. Never copy credentials
into receipts, Git or command arguments. The script supplies the fixed CUNY account.

The root and Cloudflare dependency installs retain their existing lockfiles. Gates run the release-tool tests, Cloudflare typecheck/unit tests and the adapter browser suite. Shared app, Node/audio-analysis, image, helper-Worker and live paid-provider regression tests remain additional gates when those components change; this is not a claim that the entire Railway/image CI ran.

## Records and rollback

Records live under repository-root `.local-releases/<timestamp>-<target>-<sha>/`:
`source.tar` (exact committed source), its hash and Git tree in `receipt.json`,
check outcomes, structured deployment output, version and prior deployment history.
A `refs/local-releases/...` Git ref keeps the local source commit reachable.
These records are ignored by Git. Back them up securely with the repository;
unpushed work exists only on this machine until a checkpoint push/backup.
A failed/interrupted release is never recorded as verified. Inspect the receipt
and live Cloudflare state before retrying an interrupted upload. A stale
`.local-releases/<target>.lock` may be removed only after confirming its process
has stopped. Do not delete successful receipts before production promotion.

Rollback is a deliberate operation using the prior compatible version in the
receipt and the same explicit target config; confirm compatibility with current
stored data and in-flight jobs first. The command does not automatically restore
databases, modify secrets or revert an upload after a failed acceptance check.

## Occasional GitHub checkpoints

Keep local commits while iterating. At a stable milestone, fetch/reconcile the
correct upstream branch, push the batch and use the normal PR/review process.
Target `dev`, not Railway `main`.
Existing GitHub checks still run on their configured triggers when you do push;
this setup neither disables CI nor sends a push automatically. Preserve the
release refs/receipts so a squash merge cannot obscure which local source shipped.
