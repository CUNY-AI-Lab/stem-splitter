# General CI

The `CI` workflow retains the `Source gate` and `Pinned analysis image (native
amd64)` check names. A short selection job compares the PR base to the checked
merge commit, or the before/after commits of a push to `main`. Renames include
both paths. Missing Git history selects every check. A failed selection job or
missing output also runs the source and image gates in full.

The native audio image runs when a recorded image-evidence input changes,
including the Dockerfile, package and lock files, `public/autosplit.js`, image
smoke/capture scripts, CI workflow and selection helpers. Changes anywhere in
`audio-analysis/`, `src/analysis/`, audio fixtures or analyzer/AutoSplit contract
tests also select it. Other UI files, such as `public/app.js`, HTML and CSS,
retain source/browser coverage and skip the native image build.

Changes confined to `cloudflare/` use the dedicated Cloudflare check. Root
Markdown and Markdown under `docs/` skip general CI, except `docs/acceptance/`:
those records remain inputs to the source promotion gate. Mixed changes select
the checks required by their code and evidence inputs. Other paths retain the
full Source gate.

Draft PRs retain source, Python, analyzer and promotion checks; general browser
suites and Chrome installation start when the PR is marked ready for review.
Subsequent ready-PR commits and direct pushes to `main` retain browser coverage.
New commits cancel older runs on the same ref.

Manual dispatch supports `all`, `source` and `image`. Use `image` to capture
fresh native-amd64 evidence after changing its recorded inputs. Download the
real commit-named artifact and commit it at the canonical acceptance path;
then the source promotion gate can validate its hashes. Selection helpers are
also recorded in that evidence, so changing the build policy requires a new
native capture.

CI reports the selected checks in its run summary. Job conditions keep check
names visible for changes whose expensive jobs are skipped.
