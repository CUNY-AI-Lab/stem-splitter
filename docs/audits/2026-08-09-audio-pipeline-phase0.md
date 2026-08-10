# Audio pipeline adversarial hardening audit — 2026-08-09

This audit is tied directly to `TODO.md`. It distinguishes implemented local
code from committed, pull-requested, deployed, and live-accepted work. It does
not authorize a release.

## Canonical scope and provenance

- Canonical checkout: `/Users/milwright/Projects/dev/stem-splitter`.
- Branch: `codex/v3.2-audio-pipeline`.
- Implementation base: `9c3120c` (`feat: link footer to instructor console`).
- The reviewed committed lineage now reaches teacher-governance commit
  `fe0a5ff`, Railway preflight commits `c07671c` and `ad816f6`, SAM-Audio
  evaluation commits `e0577d9`, `725316a`, and `3fec9d0`, evidence commit
  `753bb04`, exact-corpus commit `0fbc62a`, and isolation-CI commit `e67dd3b`,
  above upload-snapshot commit `e9f7ed9` and its evidence commit `e425492`.
  Discovery evaluation is bound to
  `ccf7f53`, teacher seed hardening to `e372ab4`, shared import deadlines to
  `c367e23` plus `fe112ef`, Innertube transport to `fce98cf`, Railway prompt
  transactions to `821f5e1`, prompt-aware guide caching to `e640c72`, and the
  prompt-history integrity to `4a3fbf1`, verified fingerprint/shadow routing to
  `10f6b0a`, the isolation source guard to `15e782a`, and the latest complete
  clean committed-source gate to `fe0a5ff`.
- GitHub has no pull request for this branch. PRs 1–5 are merged historical
  work and must not be cited as delivery of this implementation. The current
  branch does not exist on `origin`.
- Canonical Railway scope is project
  `f070742b-3375-4cba-9a86-335f39273c88`, production environment
  `b3381640-1e2f-4765-8e15-15baec599ec2`, Node/Railpack service
  `f53a2915-087c-493a-a345-7a1fa73e6588`.
- The repository's current local Railway link points instead at same-named
  legacy project `b9bf3524-a01d-47f6-a104-2472f86bd0f1`, including a workerd
  `web` service. Release commands now use explicit canonical IDs so that local
  link cannot redirect a write.
- A value-free readback confirms the exact YouTube importer-version variable is
  staged on the canonical Railway service. The newest deployment remains
  `SUCCESS` deployment `7f4bc330-4c52-4257-8762-3b85a24b2d07`, created
  2026-08-08T21:10:37.179Z; it predates `4cf452e` and the staged importer change.
  No service topology,
  deployment, volume, or Cloudflare resource was created or changed.
- The same value-free readback confirms only that the `TEACHER_SEED` key exists;
  its value was not read. The live mixer contains the discrete `INSTRUCTOR`
  footer link and `/teacher.html` returns 200, but authenticated save/restart/
  sign-in persistence remains a separate human gate.

## TODO-linked review

| TODO gate | Builder miss or adversarial case | Hardening now present | State |
|---|---|---|---|
| Phase 0 response contract | A service could declare `choice: two` while resolving a six-track model, claim a mismatched degraded fallback, return unversioned detections, or exceed the 45-second budget. | The boundary rejects choice/model contradictions, fallback contradictions, unversioned vocabulary output, invalid/bloated values, and timing drift before a paid job can be routed. | Local tests pass. |
| Phase 0 fixed corpus | Rights and audible instruments were prose-only; the jazz Archive identifier was invalid, and optional provider hashes did not bind every hydrated file to exact repository evidence. | Eleven authorized file fixtures now carry structured coverage, expected instruments, Archive provenance, derivative-safe CC licenses, required content SHA-256, and verification dates. Archive SHA-1 remains a second signal where available. Both evaluators reject byte drift before decode, and a manifest test prevents impossible model/track expectations. | All 11 hydrated files independently match commit `0fbc62a`'s pins. Listening calibration and native/Railway reproduction remain. |
| Phase 1 calibration | A broad “four or six is fine” range hid taxonomy failures. The first strict v1 run under-routed jazz to two and over-routed synthwave to six. | Targets partition preferred, accepted, and rejected outcomes. V2 fixed jazz; v3 adds independent electronic controls and raises the six-track evidence threshold without relabeling the original failure acceptable. | Local FFmpeg, real Chrome, and the pinned 8.0.3 amd64 image are 11/11 accepted; native Railway and listening gates remain. |
| Cross-service version drift | Merely requiring a non-floating classifier string allowed a separately deployed analyzer or stale browser to route with an unknown version. | The shared contract pins `autosplit-role-v3` exactly. An analyzer mismatch becomes `analysis_contract_invalid` and uses the frozen fallback; an invalid browser comparison summary is rejected before it can affect paid routing. | Parser and paid-routing fallback tests pass. |
| Phase 2 advisory isolation | An incomplete discovery schema initially broke five core tests and made a valid six-track authoritative result silently fall back to four. Version names alone also allowed model weights or vocabulary content to drift, and an unconstrained HTTPS target could exfiltrate PCM. | Discovery parsing is quarantined from core routing; schema, checkpoint, weight, vocabulary version, and vocabulary content hash are exact pins. The analyzer sends bounded PCM only to loopback/private Railway origins, rejects redirects and malformed tokens, and redacts labels/private pins from student responses. | Contract/client and teacher-auth/redaction E2E pass. The tested CLAP pairing is rejected; replacement calibration and any Railway service remain open. |
| Phase 2 evaluation truth | A newly authored discovery expectation file named positives, hard negatives, and confusion coverage but was untracked and had no consumer, so pins or corpus labels could drift while “bidirectional” claims remained prose. | A contract test now binds all eleven licensed file sources to exact classifier/weight/vocabulary/sample-rate pins, requires every reviewed corpus term to map exactly once, rejects unknown/contradictory labels, and proves each claimed bidirectional trial has evidence in both directions. | Structural and raw-score gates pass as evidence collection. The current CLAP pairing fails usefulness; human listening and comparable replacement scores remain mandatory before promotion. |
| Phase 2 isolated-control truth | Mixed recordings could not distinguish a weak classifier from an instrument masked by the arrangement, while calling every omitted label a negative would manufacture precision. | Eight exact-hash CC BY 4.0 ChoraleBricks tracks separately cover four woodwinds and four brass instruments. The same-origin hydrator bounds redirect, type, length, bytes, timeout, path, and overwrite behavior; the report keeps positives dataset-authored and all 278 non-positive labels candidate-only until teacher listening. | Live hydration, offline readback, native-arm64 scoring, and contract tests pass. Six eligible exact labels are top-three; oboe/tuba remain unsupported. No threshold or precision claim exists. |
| Candidate-report provenance | The rejected CLAP report recorded classifier, weight, vocabulary, and some source hashes, but its Docker image/platform and dependency lock existed only in prose. A mutable tag could also be inspected and then retargeted before execution. The first YAMNet report omitted transitive host-side evaluator sources and per-input SHA-256, while its narrow workflow paths could skip decoder or corpus changes. | The hardened CLAP runners resolve and execute one immutable `linux/amd64` image ID and compare the worktree lock with a digest derived inside that image. YAMNet schema v2 likewise binds immutable image/platform, baked lock and image sources, official artifact/class-map pins, every transitive host evaluator source, Node runtime, TypeScript configuration, dependency locks, mapping/corpus/expectations, before/after-stable hydrated-audio SHA-256, and the exact decoded PCM/window sample plan; the native workflow watches the same paths. | Exact-schema, platform, baked-lock mismatch, shell-syntax, TypeScript, and candidate contract regressions pass locally. Historical CLAP JSON remains rejection-only, and the arm64 YAMNet v1 report remains immutable historical comparison evidence. A clean v2 native-amd64 rerun is still required. |
| Phase 3 source identity | A route-level compare-and-set populated the right digest, but the repository accepted any valid-looking caller digest and nullable legacy source type; a race or future caller could bind cache metadata to bytes other than the completed job. A valid-looking cache key could also conceal a damaged row, and a later object replacement could make a paid provider consume bytes different from a correct earlier digest. | Numbered migration and Railway boot triggers make a non-null job digest, source key, and source type one immutable identity. Resource insert and idempotent readback require the completed job's exact identity; duplicate readback rechecks every stored cache-material/provider field. The dormant pre-spend seam now re-reads with byte/time bounds, re-fingerprints, copies only matching bytes into an app-owned snapshot inaccessible to browser PUTs, and mints a 15-minute URL whose path binds the isolation id and digest. | Exact guard commit `15e782a` plus the earlier identity commits reject null, mismatched, rebound, replaced, expired, deleted, metadata-drifted, and preexisting inconsistent inputs. Its focused suite and the stable combined gate pass; provider execution, commit-only native CI, checkpoint/license, budget, output lifecycle, and Railway acceptance remain open. |
| Browser responsiveness | Correct anti-alias resampling performed roughly 48 filter taps per output sample on the UI thread, risking a multi-second freeze on long tracks; Web Audio decode had no deadline and allocated the complete source. | Authoritative Auto no longer invokes Web Audio. Browser-only/shadow mode checks metadata first, caps sources at 5 minutes and 24 MiB, moves resampling/FFT into the worker, and gives decode and worker phases independent 20-second deadlines. | Real Chrome, policy unit test, and both Auto E2E paths pass. Proxy caps cannot exactly bound exotic multichannel/high-rate decoded PCM, so retiring the shadow decoder remains open. |
| Browser/server window parity | The first browser guard wired no metadata events, so it always timed out; a separate downmix defect analyzed only the first third of sources shorter than 45 seconds while FFmpeg analyzed them in full. | Metadata success/error handlers are attached before loading. The browser now analyzes short sources in full and uses the same three 15-second positions as FFmpeg only when the source exceeds the budget; the flags-off E2E fixture must resolve to its measured two-track result rather than the four-track fallback. | Unit, targeted real-browser, and full flags-off E2E pass. |
| Phase 1B fallback and transport | A degraded analyzer could falsely appear to agree with the browser fallback; a provider ignoring `AbortSignal` could hang job creation; an arbitrary HTTP URL, embedded URL credential, redirect, weak token, or malformed origin could leak the analyzer bearer token or signed source URL. Workerd also refuses to dispatch analyzer subrequests with `redirect: "error"`. | Degraded comparisons are `unavailable`; timeout uses an independent race; endpoint configuration accepts HTTPS plus loopback/private Railway HTTP only and rejects credentials/path/query/fragment; tokens require at least 32 characters; `redirect: "manual"` preserves Workerd compatibility while every 3xx is rejected without following; streamed JSON stops at 64 KiB. | Unit tests, Railway-host config tests, and the complete mocked authoritative suite pass. |
| Authoritative Auto source identity | A valid analyzer response could recommend a non-default split for YouTube or Archive bytes without proving those were the same bytes the app imported and stored. A browser could also reuse its upload PUT after analysis so the separator consumed different bytes, and the older explicit-model plus `routingRequest: auto` shape could bypass a guard written only for `model: auto`. | The app hashes each server-fetched import before storage and requires exact analyzer SHA-256 plus byte count. Authoritative uploads first stream into an app-owned `auto-inputs/v1/<job>` snapshot inaccessible to browser PUTs; analyzer and separator URLs bind that same key, and authenticated analyzer bytes must match stored size. Both valid authoritative request shapes freeze, and later teacher isolation accepts only the exact internal key family. | Exact upload-handoff commit `e9f7ed9` and combined commit `fe0a5ff` pass clean detached-worktree Phase 0 gates. Focused source/routing coverage passes 38/38 and all 6 authoritative-Auto journeys pass, including imported identity drift and upload replacement before and after analysis. Native CI, Railway resource/restart, and listening gates remain. |
| Stored-source import transport | Retry, redirect, prediction polling, response-body, and output-download timers were individually bounded but could reset across phases; a provider stream exception could also escape with provider-controlled text. The installed Innertube library also reads control bodies internally and requests automatic redirects. | Archive retry/redirect/header/body work shares one request deadline. Replicate start/body/poll/output-header/output-body work shares a four-minute deadline. Innertube has one 45-second budget, permits only the exact reviewed session/player/API/audio path families, manually validates at most three redirects, strips cross-origin credentials and identity headers, and caps session/player bodies at 16 MiB while outer audio remains capped at 100 MB. Bounded reads normalize arbitrary stream failures. | Six focused Innertube regressions, a live 19-second/309,288-byte control import, and the complete `fce98cf` gate pass. Live Railway journeys remain. |
| Railway prompt transaction | The synchronous SQLite adapter awaited each already-completed statement inside `batch()`, allowing another request to issue `BEGIN` on the same connection. Guide invalidation also happened after the prompt/history transaction, and rereading the mutable settings row could splice a later teacher's amendment into the first request's hashes. | Node batches execute synchronously under `BEGIN IMMEDIATE`; prompt compare-and-swap, winning-request-only guide invalidation, and append-only history share one rollback boundary. A winner assembles its response from the exact immutable row it inserted rather than the newest settings row. The active host and CI pin exact Node 22.23.1. | The original concurrency/losing-CAS slice passes at `821f5e1`; a forced post-commit second save now proves the first response remains revision- and actor-consistent. Real teacher restart persistence remains. |
| Teacher session and logout truth | Session expiry compared ISO `T`/`Z` text directly with SQLite's space-formatted clock, keeping a same-day expired session alive. The browser also hid the console when logout transport failed and retained amendment/history text in the hidden DOM. | Expiry and cleanup parse both timestamps. Failed logout leaves the console visible with an active-session warning; only confirmed server revocation hides it and scrubs credentials, amendment, preview, history, hashes, and actor metadata. | Deterministic SQLite coverage proves same-day expiry and cleanup. The real-browser instructor journey proves failed logout remains visibly active, confirmed logout returns protected routes to 401, and teacher content leaves the DOM. Railway restart acceptance remains. |
| Instructor landing accessibility | The shared `.yt-go` style has zero vertical padding because its mixer use sits beside an input; reused inside the grid sign-in form, it collapsed to a 16-pixel strip. Browser cache also retained stale layout and interaction assets after source changed. The caret changed the inner scroll position while leaving the true top above the page viewport. | A teacher-scoped submit class supplies a 44-pixel minimum target, centered label, balanced padding, and visible focus outline. The page versions stylesheet and script together, uses the requested sentence case, and focuses plus brings the read-only prompt container into view when navigating upward. | In-app desktop/mobile readback measures the target, proves zero horizontal overflow, scrolls the true first prompt line to viewport top, and reports no console errors. The targeted instructor journey and clean `fe0a5ff` gate pass. |
| Prompt-aware guide cache | A guide generation could begin under amendment revision N, finish after revision N+1 cleared the cache, and then repopulate it with stale output. Cached rows initially trusted only a manually bumped fixed version, so a missed bump could continue serving older prose. | Guide rows carry `SYSTEM_PROMPT_VERSION`, effective multi-variant policy SHA-256, and amendment revision. One conditional upsert publishes only if its captured revision is current; version or hash mismatches are unreadable and regenerate lazily. Railway boot and numbered migrations retain legacy rows with an ineligible identity, and a failed cache invalidation rolls the whole prompt transaction back. | Rollback, in-flight-revision, version/hash mismatch, constraint, Node migration, and numbered-migration regressions pass in the stable combined gate. Native GitHub, Railway, and real-teacher restart gates remain. |
| Prompt-history integrity | `ON CONFLICT DO NOTHING` could hide a pre-existing next-revision history row after a damaged restore or manual drift. Direct SQL could mutate history or append malformed hashes/actors that immediately became immutable, while returning the entire trail on every prompt read created an unbounded authenticated response. | The winning compare-and-swap must append exactly one unique valid row before invalidating guides. Fresh schema, Railway boot, and migration 13 reject malformed inserts plus update, delete, and replacement/conflicting-insert paths. Keyset pagination returns the newest 40 revisions and an authenticated `before` cursor for earlier pages, with no overlap or omission. | Both TypeScript checks and all 28 Railway server/migration tests pass, including fresh/boot/numbered validation, a 43-revision 40+3 traversal, exact concurrent readback, session expiry, and malformed seed-name rollback. Native GitHub, Railway, and authorized teacher restart persistence remain. |
| Prompt fingerprint completeness | Base/effective SHA-256 values covered only one readable guide example, and raw student/provider strings could preserve newlines or quotes that visually impersonated a fixed rule block. | Prompt version `2026-08-10.2` hashes a schema-versioned bundle spanning guide/chat, stem guidance, notes, duration, labels, amendment presence, and injection-shaped data. Titles, labels, and notes are explicitly untrusted and control characters/quotes are escaped before entering the system message. History and guide-cache rows share the effective hash. | Four focused policy regressions prove the complete variants and that malicious title/label/note text cannot create a prompt line. Cache, migration, in-app rendered QA, and the clean combined `fe0a5ff` gate pass. Native GitHub, Railway, and authorized teacher persistence remain. |
| Phase 1A source authority | Origin allowlisting alone allowed the analyzer token to fetch arbitrary endpoints on the app origin, and accepting the six-hour separator URL would widen analyzer authority beyond its purpose-specific URL. | The service accepts only the exact signed `/api/local-sources/uploads/…` URL shape within the ten-minute issuance window, rejects redirects, bounds declared and streamed bytes, and deletes its private temp directory. | Local service tests pass. |
| Phase 1A decoder | Output-side seeking could decode from the start to reach later windows, consuming the timeout on long inputs. | FFmpeg uses bounded input-side accurate seeks for beginning, middle, and end; probe/decode share one phase deadline and stdout caps. | Real local fixture test passes. |
| Phase 1A readiness | A classifier startup exception rejected the readiness promise and turned `/readyz` into a 500; liveness called the classifier too. | `/healthz` is process-only. Decoder and classifier failures settle to explicit 503 readiness reasons, and analysis stays unavailable. | Local service tests pass. |
| Phase 1A privacy/versioning | Success logs omitted pins and included exact source byte count/duration. | Logs contain schema, classifier and FFmpeg versions plus bounded timing and decision metadata, but no URL, signature, token, raw features, source byte count, or source duration. | Local service tests inspect records. |
| Deterministic acceptance timing | The fingerprint test asserted a real async request always completed within the same wall-clock millisecond, so a valid run intermittently reported 1 ms instead of 0 ms and failed the full gate. | The test now injects the service's existing clock dependency, preserving the exact timing contract without scheduler dependence. | The original full run failed at 21/22 analyzer tests and is not counted as acceptance. The corrected targeted test passes 22/22, and the complete frozen-install command subsequently passes. |
| Build/release | The analysis README named a Dockerfile that did not exist; Docker contexts included ignored classroom corpus audio and could include `.dev.vars` variants; a broad FFmpeg build retained unnecessary codecs/formats; the final image copied static libraries, headers, examples, and 33 MB of unused root-project dependencies. | Non-root multi-stage image pins base digests and signature-verified FFmpeg checksum. FFmpeg explicitly disables unused component families and enables only required audio components and file/pipe protocols. Bun bundles the analyzer at build time; the runtime contains one application artifact plus `ffmpeg` and `ffprobe`. `.dockerignore` excludes secrets, corpus audio, caches, and private documents. | Local emulated `linux/amd64` role-v3 image passes runtime surface, readiness/auth, eight-format decode, and 11-source corpus gates. Native CI/Railway and resource gates remain. |
| CI | The authoritative Auto E2E, isolation-shadow E2E, analysis service, and current pinned image were absent from the GitHub workflow. | CI runs analysis typecheck/tests, the three-source authoritative Auto suite, the teacher-isolation shadow journey, and a reusable constrained amd64 image smoke requiring FFmpeg 8.0.3, role v3 readiness, a narrow runtime surface, real short/max-duration audio, malformed/oversized/slow/concurrent cases, cleanup, and redacted logs. | Isolation coverage is committed at `e67dd3b`, but the branch is not on GitHub, so no native GitHub run exists. The gitignored real corpus still requires a separate mounted/live run. |
| YAMNet candidate CI | Local arm64 and amd64-under-emulation runs could hide native runner or image-surface failures, and an incomplete path filter could avoid the workflow when a transitive evaluator dependency changed. | A separate path-scoped, read-only-permission workflow pins Node 22.23.1, Python 3.12.13, action SHAs, `linux/amd64`, the image size/runtime/provenance surface, networkless constrained inference, malformed PCM rejection, and every source path named by the v2 evaluator. | Source and local native-arm64/emulated-amd64 smokes pass for the prior source. The expanded workflow has not run on GitHub, so current native-amd64 evidence remains open. |
| Railway configuration | Two projects share the same name, the YouTube fetcher requires an exact version, and variable edits redeploy by default. | Release docs use explicit IDs; the exact importer version was staged with deploys suppressed; the analyzer runbook uses typed Dockerfile configuration and value-free readiness reporting. | Value-free readback confirms the version key while the earlier successful deployment remains active; coordinated release activation remains. |

## Local validation evidence

The first exact-Bun combined local command set passed against executable-source
commit `821f5e1`. `npx -y bun@1.3.14 install --frozen-lockfile` checked 104
installs across 160 packages with no changes, then the literal
`npx -y bun@1.3.14 run test:phase0` passed:

- Shared app TypeScript typecheck: pass.
- Railway Node host plus shared-source TypeScript typecheck: pass.
- Analysis service TypeScript typecheck: pass.
- Worker/unit tests: 127 passed.
- Dedicated analysis service gate: 21 passed, including real local FFmpeg
  decode, source policy, authentication, concurrency, cleanup,
  liveness/readiness, container pin assertions, deterministic browser/server
  PCM parity, and the flag-off discovery contract/client seam. Four parity
  cases are intentionally also exercised by the broad worker glob; do not add
  the two counts as if they were disjoint.
- Railway Node host/migration tests: 9 passed.
- Local separator tests: 5 passed.
- Instrument-discovery contract/process/diagnostic tests: 29 passed.
- Baseline browser E2E: 19 passed.
- Authoritative Auto E2E: 4 passed across upload, YouTube, Archive, outage
  fallback, and oversized job-body rejection.
- Pinned analysis image: local `linux/amd64` build passed as non-root with an
  audio-only runtime surface, FFmpeg `8.0.3`, classifier `autosplit-role-v3`,
  401 missing/wrong-auth boundaries, all eight tested variants of the six
  advertised format families, and the eleven-source corpus at 8 preferred,
  3 accepted alternatives, and 0 rejected.
- Real Chrome 151 decoded and classified all eleven authorized MP3s through the
  browser worker. It agreed with the local FFmpeg 8.1.2 service path on 11/11
  choices; feature values were close but not byte-identical. The repeatable
  `npm run eval:auto:browser` gate also passed after adding decode and worker
  deadlines.
- `git diff --check`: pass.

The prompt-aware cache follow-up was then committed as exact executable source
`e640c72`. Against that source, `npx --yes bun@1.3.14 install
--frozen-lockfile` again reported no lock changes and the literal `npx --yes
bun@1.3.14 run test:phase0` passed all three typechecks, 127 worker tests, 21
analysis-service tests, 13 Railway server/migration tests, 5 separator tests,
29 instrument-discovery tests, 19 baseline browser E2E journeys, and 4
authoritative Auto E2E journeys. This local source-bound result supersedes the
9-test server count for prompt-cache code only; it does not supersede the
separate image, corpus-listening, native GitHub, Railway, or authenticated
teacher persistence gates below.

The fail-closed history follow-up was then committed as exact executable source
`4a3fbf1`. The literal Bun `1.3.14` phase-zero gate again passed with the same
counts above except that the new integrity regression raises the Railway
server/migration count to 14. `git diff --check` and the frozen-lock install
also pass. No remote branch, pull request, Railway release, or live teacher
interaction contains or accepts this commit yet.

The current v3.2 control-corpus worktree then ran exact Bun 1.3.14 through the
pinned npm package because no global Bun binary was on this shell's `PATH`.
The literal `test:phase0` command passed all three typechecks, 141 worker tests,
21 analysis-service tests, 14 Railway server/migration tests, 5 separator tests,
30 instrument-discovery tests, 9 YAMNet Python contracts, 19 flags-off browser
journeys, and 4 authoritative-Auto browser journeys. The additional worker
tests bind the control manifest, secure hydrator, pending-review semantics,
non-promotion report, and native image workflow. This remains local source and
image evidence; no GitHub, Railway, or teacher-review gate changed state.

The later query-isolation source-identity hardening was validated as exact
executable-source commit `4cf452e`. The first complete run exposed two
acceptance-fixture defects instead of being counted as a pass: a wall-clock
millisecond assertion and an isolation seed whose digest did not match its core
job. The corrected fixture stores and submits one exact digest, and the E2E
schema loader now preserves trigger bodies containing internal semicolons. A
fresh frozen Bun 1.3.14 install made no changes; the literal `test:phase0`
command then passed all three typechecks, 152 worker tests, 22 analysis-service
tests, 22 Railway server/migration tests, 5 separator tests, 30 discovery tests,
9 YAMNet Python contracts, 19 flags-off browser journeys, 4 authoritative-Auto
browser journeys, and 1 isolation-shadow journey. `git diff --check` also
passes. This result is bound to the local commit, but not to a native GitHub
run, applied Railway migration, or live service acceptance.

The prompt-fingerprint/cache and pre-spend source-guard follow-ups then ran on
an uncommitted worktree rooted at `15e782a`. The exact executable manifest
SHA-256 was
`7dad62054109c9841c8500725401185f9218378c29398fdc76e3a550aa7f2ef3`
both before and after the accepted run. `npx --yes bun@1.3.14 install
--frozen-lockfile` checked 104 installs across 160 packages with no changes, and
the literal `npx --yes bun@1.3.14 run test:phase0` passed all three typechecks,
159 worker tests, 22 analysis-service tests, 22 Railway server/migration tests,
5 separator tests, 30 discovery tests, 9 YAMNet Python contracts, 19 flags-off
browser journeys, 4 authoritative-Auto browser journeys, and 1
isolation-shadow journey. The new worker coverage comprises three prompt-policy
regressions and four immutable-source regressions. The teacher browser journey
saved revision 1 under `2026-08-10.1`, required a distinct effective hash, and
matched both stored history hashes to API readback. The initial targeted source
guard runs failed on a strip-only-incompatible parameter property and then an
extensionless runtime import; both defects were corrected before acceptance and
neither failure is counted as a pass. `git diff --check` passes. Because these
edits remain uncommitted, the manifest proves run stability but is not a durable
source artifact; no remote branch, PR, Railway release, or real-teacher
interaction contains it.

Prompt-history database triggers and server-fetched import identity checks were
then added on the same shared worktree. One complete command finished green,
but its executable manifest changed from
`15344330e6eefff5831e3f460eac89bfa344485686096813a63b449120f3ef36` to
`664b1093c730d5aafdfbee22475bd59168e302f24a91edcbb1a7328ee52fa0bb`
while concurrent source-identity edits landed; that run is explicitly rejected
as acceptance. After reconciliation, focused worker and authoritative-Auto
tests passed against one stable manifest, followed by a fresh frozen full run.
Executable manifest
`345a2122d6e5cbd3ee6c45eff96ab73a322ab2211802f1889c3651f3b3c132c9`
matched before and after. Bun 1.3.14 again checked 104 installs across 160
packages with no lock change, and the literal `test:phase0` passed all three
typechecks, 160 worker tests, 22 analysis-service tests, 24 Railway
server/migration tests, 5 separator tests, 30 discovery tests, 9 YAMNet Python
contracts, 19 flags-off browser journeys, 5 authoritative-Auto browser
journeys, and 1 isolation-shadow journey. `git diff --check` passes after the
documentation update. The manifest remains uncommitted, absent from GitHub and
Railway, and cannot close native CI, resource, teacher-restart, or listening
acceptance.

The authoritative upload snapshot then landed as exact executable-source commit
`e9f7ed9`, which separately passes the literal Phase 0 gate in a clean detached
worktree: all three typechecks; 165 worker, 22 analysis-service, 22 Railway
server/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus 19
flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey. That
commit's whitespace check passes. The first pre-commit Workerd browser attempt
failed 3/5 because its object-store upload lacked a known length; this was fixed
before the commit and is not counted as acceptance.

The then-uncommitted prompt-history pagination and teacher-governance follow-up
was tested together with `e9f7ed9`. Two complete commands finished green but
are explicitly rejected because executable source changed during each run:
`9b4c229c…` became `3cd801f6…`, and `ba35a080…` became `1a398b27…`. After
reconciliation, Bun 1.3.14 checked 104 installs across 160 packages with no lock
change. The literal `test:phase0` command passed all three typechecks; 168
worker, 22 analysis-service, 26 Railway server/migration, 5 separator, 30
discovery, and 9 YAMNet tests; plus 19 flags-off, 6 authoritative-Auto, and 1
isolation-shadow browser journey. Executable manifest
`1a398b275056203f021bc17a0d19f355bacc9741892e2d240a6bd1dd69b93876`
matched before and after. `git diff --check` passes. This source-stable result is
local dirty-tree evidence rooted at `e9f7ed9`; it does not bind the remaining
teacher work to a commit, GitHub run, applied Railway migration, live restart,
or listening acceptance.

The final teacher-governance security follow-up was then tested with corpus-pin
commit `0fbc62a`, isolation-CI commit `e67dd3b`, and documentation commit
`753bb04`. An initial focused interleaving assertion failed only because a
SQLite null-prototype row was compared directly with a plain object; the test
assertion was corrected, rerun, and that failure is not counted as acceptance.
After an eight-second executable stability window, exact Bun 1.3.14 checked 104
installs across 160 packages with no lock change. The literal `test:phase0`
command passed all three typechecks; 169 worker, 22 analysis-service, 28 Railway
server/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus 19
flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
The legacy selected-path executable manifest
`e7707ea78aa8e97a82bc000845237f95d83dc46b5725215d4060ab5289fb667f`
matched before and after, and `git diff --check` passes. That recipe was later
found to omit executable scripts and service/config trees, so this remains
partial historical evidence rather than current combined acceptance. At that
checkpoint the teacher implementation remained uncommitted and absent from
GitHub and Railway, so it could not close native CI, applied-migration,
real-teacher restart, resource, or listening acceptance.

Browser review then found that the sign-in page reused the mixer-oriented
zero-vertical-padding `.yt-go` control, collapsing `SIGN IN` to 16 pixels. The
tagline was also requested in sentence case. A teacher-scoped style now provides
a 44-pixel minimum target, centered text, balanced padding, and focus outline;
the page versions its stylesheet and script together so stale layout or
interaction code cannot remain cached.
The instructor journey asserts both the corrected text and target height and
passes independently. A fresh frozen install made no changes, and the same
literal complete command went green with 169/22/28/5/30/9 unit-service counts
and 19/6/1 browser counts. It is nevertheless rejected: the selected-path
manifest reported `909a8850…` unchanged while concurrent executable `scripts/`
files appeared outside that boundary.

The acceptance guard was therefore widened to every tracked or unignored
source, config, service, workflow, fixture, public asset, migration, and test,
excluding only documentation and images. It caught both subsequent otherwise-
green complete commands changing during execution: `fccaf815…` became
`5e3adcd5…`, then `f059739f…` became `45f2d503…`. The latter passed all three
typechecks; 175 worker, 22 analyzer, 28 Railway, 5 separator, 30 discovery, and
9 YAMNet tests; plus 19/6/1 browser journeys. Neither is acceptance. At that
point, combined validation remained open until the shared bakeoff source
stopped moving; the focused instructor fix remained green.

The moving-tree condition ended when the reviewed teacher scope was committed
as `fe0a5ff`. A clean detached checkout of that exact commit installed 104
packages with frozen Bun 1.3.14, remained clean, and passed the literal
`test:phase0` command: all three typechecks; 181 worker, 22 analyzer, 28 Railway
server/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus 19
flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey.
`git diff --check` also passes. Separate in-app QA at default desktop and
390-by-844 mobile viewports proves versioned assets, no horizontal overflow,
tail-first fixed-prompt rendering, true top-of-prompt caret navigation,
editable appended content only, distinct effective fingerprint readback, an
immutable revision snapshot, and confirmed-logout DOM scrubbing without
console warnings or errors. This closes current local committed-source
stability only; it is not GitHub native-amd64, applied Railway migration,
real-teacher restart, audio listening, or live service evidence.

The six Innertube-specific cases cover exact URL/path rejection, approved
cross-origin redirect credential stripping, unapproved redirect rejection, the
three-redirect ceiling, deadline preservation across redirects, and bounded
internal control bodies. A read-only live control against the same committed
source imported “Me at the zoo” (19 seconds, 309,288 bytes). This is
compatibility evidence, not musical-routing or Railway acceptance.

Docker Desktop remained unavailable after its earlier metadata-store errors,
so an existing stopped Colima VM was started without changing its saved
configuration; Colima became the active Docker context. Its registered amd64
emulator provided an independent local build route. The first broad FFmpeg
build reached irrelevant video/audio filter compilation and crashed under
emulation; that failure exposed the overbroad build surface rather than
becoming an accepted flake.

The corrected image compiles the checksum-pinned official FFmpeg 8.0.3 source
with a reproducible single-job default, explicit component-family disables,
and a narrow audio allowlist. A clean two-job QEMU rebuild produced inconsistent
libc `hypot` feature detection, while the serial build is repeatable; native
builders may override parallelism only after their own image gate passes. Runtime
inspection found only AIFF, FLAC, MOV/M4A, MP3, OGG, and WAV demuxers; only
audio decoders; and only file/pipe protocols. The non-root image reported
FFmpeg 8.0.3 and role v3 readiness, rejected missing and incorrect bearer
tokens, decoded WAV, MP3, FLAC, AAC-M4A, ALAC-M4A, Vorbis-OGG, Opus-OGG, and
AIFF, and repeated the eleven-source 8/3/0 corpus result. A final hardening pass
removed installed FFmpeg development artifacts and bundled the application at
build time, leaving only `/app/dist/server.mjs`, `ffmpeg`, and `ffprobe` in the
application-owned paths. The resulting local image is amd64 but emulated; native
GitHub and Railway resource behavior remain unproved. No Docker reset, prune,
cache deletion, or user-data removal was attempted.

The strict real-corpus evaluation used local FFmpeg 8.1.2. Role v1 produced 3
preferred, 3 accepted-alternative, and 2 rejected decisions (jazz-sax to two;
synthwave to six). Role v2 fixed jazz without moving orchestral, producing 4
preferred, 3 alternatives, and 1 rejection. Synthwave still routes to six
because harmonic programmed attacks resemble evidence for guitar/piano-trained
channels. Role v3 added three authorized electronic controls, including an
independent CC0 house/electro source, and raised the six-track evidence
threshold. It produced 8 preferred, 3 accepted-alternative, and 0 rejected
decisions across eleven sources. Chrome, local FFmpeg 8.1.2, and the pinned
FFmpeg 8.0.3 amd64 image agreed on all choices, but the narrow synth boundary,
manual listening, native CI, and Railway gates remain. The exact trace is in
`docs/model-processing-changelog.md` and
`docs/evaluation/autosplit-role-v3-candidate.md`.

## Live state and unresolved acceptance

Read-only Railway inspection found the canonical deployment healthy at the
pre-pipeline commit: `/healthz` returned `ok: true` and `promptSchema: ready`,
and the live separation catalogue remained the frozen 2/4/6 baseline. That is
baseline evidence only; it does not prove the local v3.2 commit.

The canonical service now has the exact `REPLICATE_YT_MODEL_VERSION` staged on
its configuration plane with deploys suppressed. It is not active in the
still-running old deployment. Server Auto remains disabled, and the analyzer
and discovery services remain unprovisioned, as expected while the rollout is
off.

The teacher console still needs its authorized human acceptance: the seed key
is present, but a real teacher must save one revision, restart the canonical
Railway service, sign in again, and prove the amendment and revision history
persist. Do not retrieve the credential to automate this check.

## Mandatory next order

1. Review the clean `fe0a5ff` release scope, then publish the v3.2 branch for
   native GitHub CI when authorized. No pull request or remote branch exists yet.
2. Reproduce the locally passing role-v3 image, runtime allowlist, readiness,
   authentication, and corpus evidence on native CI/amd64; then validate actual
   Railway CPU, memory, FFmpeg child-process, concurrency, and disk limits.
3. Manually listen to the already captured rollback baseline stems; retain its
   exact provider pin, hashes, and latency as the comparison point.
4. Provision `audio-analysis` as a private Railway CPU service with explicit
   memory/CPU/restart/disk limits, no shared volume, no public domain, and Auto
   still off.
5. Verify analyzer readiness, then enable **shadow** only. Calibrate the fixed
   manifest and investigate browser/server disagreement by genre.
6. Run upload, YouTube, Archive, timeout, outage, restart, and rollback journeys
   on Railway. Complete the separate teacher persistence acceptance.
7. Only after those gates may authoritative Auto be considered. Instrument
   discovery and optional separation remain later phases and cannot rename or
   reroute the frozen core stem contracts.
