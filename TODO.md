# STEM Splitter: next implementation sequence

**Updated:** 2026-08-10

**Active release target:** Railway

**Migration boundary:** Do not deploy to Cloudflare Workers until the user declares the product finished.

**v3.2 implementation branch:** `codex/v3.2-audio-pipeline`

**Current posture:** Phase 0 contracts, fixed corpus metadata, deterministic
browser/server PCM parity, the flag-gated Phase 1B application path, and the
Phase 1A service code are implemented locally. The minimized, digest-pinned
role-v3 image previously built as `linux/amd64` under local emulation and passed its
runtime allowlist, non-root, health, readiness, authentication, eight-format
decode, and eleven-source corpus gates on FFmpeg 8.0.3. The final image contains
one bundled application artifact plus `ffmpeg` and `ffprobe`, rather than the
root project's unused runtime dependencies. Server Auto remains off live and no
additional Railway service has been provisioned. A new role-v4 candidate closes
a short-source AAC boundary-peak discrepancy while preserving all eleven
authorized local corpus decisions (8 preferred, 3 accepted alternatives). A
real app-plus-analyzer composition test now fetches stored upload, YouTube, and
Archive bytes through the signed source boundary before sending only concrete
models to the separator. Headless Chrome 151 and local FFmpeg 8.1.2 now agree on
all eleven v4 corpus choices. The earlier role-v3 image remains historical
evidence; role v4 still requires its own pinned-image, native CI, manual
listening, resource-limit, and live Railway acceptance gates before authority.
See the
[adversarial hardening audit](docs/audits/2026-08-09-audio-pipeline-phase0.md)
and [model-processing changelog](docs/model-processing-changelog.md).

Phase 2 now has a local, flag-off contract seam: a content-hashed 51-label
teacher-reviewable vocabulary, exact CLAP checkpoint/artifact pins, a bounded
private PCM client, fail-lazy discovery traces, student-response redaction, and
a teacher-authenticated analysis read route. A separate Python service,
deterministic aggregation policy, process-fatal inference watchdog, and
digest-pinned image recipe are implemented locally and pass 30
contract/fake-backend/process tests. A matching native arm64 image has started
with networking disabled and a read-only root filesystem and completed real
CLAP inference on a synthetic control; the `linux/amd64` target image also
builds and matches the current source hashes. The eleven-source evaluation and
networkless raw-logit audit reject the current prompt/checkpoint pairing, so it
must not be calibrated or provisioned under the existing classifier ID. A
separate pinned, networkless YAMNet TFLite comparator now covers 36/51
classroom labels and completed the same licensed corpus. It ranked 21/40
eligible reviewed groups in the top five, but placed no reviewed brass,
woodwind, or free-reed group there and retains 15 explicit ontology gaps.
Treat it as a promising comparison baseline, not a selected classifier: no
threshold, feature flag, application dependency, or service was added. Native
amd64 startup/inference, Railway sizing, human-reviewed calibration, and
service provisioning remain open.
A separately versioned ChoraleBricks control corpus now pins eight CC BY 4.0
isolated performances across four woodwinds and four brass instruments. Its
same-origin, one-redirect hydrator verified every declared byte count and
SHA-256 while keeping audio gitignored. On native arm64, all six YAMNet-
supported exact instruments ranked in the top three and four ranked first;
oboe and tuba remain explicit unsupported gaps. The 278 non-positive labels are
candidate negatives only: no teacher has listened to them, so the report makes
no precision claim and selects no threshold. This is a stronger controlled
comparison, not promotion evidence.
A path-scoped, secret-free native-amd64 image workflow is defined locally but
has not yet run on GitHub, and no detection has been promoted. Its path filter
now covers every transitive host-side evaluator source; otherwise decoder,
windowing, corpus, or contract changes could bypass the native image gate.
Future corpus reports use schema v2, bind those source digests, the Node
runtime, TypeScript configuration, and dependency locks, and add both a
before/after-verified SHA-256 for every hydrated audio input and a digest of the
exact decoded PCM/window sample plan passed to the comparator. The existing
arm64 v1 artifacts remain immutable historical evidence and require a clean v2
rerun; their recorded digests must not be rewritten to match later source. See the
[discovery design](docs/superpowers/specs/2026-08-09-instrument-discovery-design.md)
and [implementation plan](docs/superpowers/plans/2026-08-09-instrument-discovery.md).
Exact committed source `86cd50b` now passes the complete local Phase 0 command
from a clean detached checkout: 183 worker, 23 analyzer, 28 Railway
host/migration, 5 separator, 30 discovery, 9 YAMNet contract, 19 flags-off
browser, 6 authoritative-Auto browser, and 1 teacher-isolation-shadow test
under exact Bun 1.3.14, plus all three typechecks and `git diff --check`. This
supersedes the earlier rejected moving-tree runs without rewriting their
history. The same committed editor also passes an in-app desktop/mobile QA
journey: versioned assets, tail-first read-only Markdown structure, true
top-of-prompt caret navigation, distinct effective policy provenance, revision
snapshot readback, and confirmed-logout DOM scrubbing. The earlier
fingerprint-capable analyzer at `fe0a5ff` rebuilt and passed the constrained
smoke on native arm64 as local image `sha256:e2ebd8c3…`, including
analyze/fingerprint hash parity and a final 61.68 MiB runtime sample. Commit
`86cd50b` changes the compiled source-scope pin and its smoke, so that image is
historical rather than acceptance for the current source. Docker was installed
but no daemon was running during the exact-commit gate; the revised image smoke,
native-amd64 CI, and Railway reproduction remain open.
Exact role-v4 source commit `8901902` now passes a fresh frozen Bun 1.3.14
install and the literal Phase 0 command from a clean detached checkout: all
three typechecks; 184 worker, 24 analyzer, 28 Railway host/migration, 5
separator, 30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6
authoritative-Auto, and 1 isolation-shadow browser journey. The new analyzer
count includes the real upload/YouTube/Archive composition. The checkout stayed
clean, `git show --check` passed, and exact HEAD repeated the eleven-source
local and real-browser v4 gates without a mismatch. The current v4 image,
native-amd64 CI, listening, Railway resources/restart, and service provisioning
remain open.

Exact promotion-gate commit `ddd6236` turns the ordered roadmap into a
versioned, executable manifest without changing that off posture. It binds the
role-v4 candidate to its exact base/candidate commits, compiled classifier and
source-scope versions, frozen 2/4/6 catalogue, exact AudioSep/SAM-Audio pins,
service dependency order, one declared change axis, false-default flags,
stage-by-stage evidence, and flag-only rollback. The current manifest computes
five blockers before `shadow`: the analyzer service is absent; native-amd64,
manual-listening, Railway resource-acceptance, and Railway rollback evidence
are missing. A fresh detached checkout of `ddd6236` passes the promotion
typecheck/CLI and literal Phase 0 command under Bun 1.3.14: 193 worker, 24
analyzer, 28 Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, and
19/6/1 browser tests. The exact commit also repeats the eleven-source FFmpeg
gate at 8 preferred, 3 accepted alternatives, 0 mismatches and browser/FFmpeg
decision parity at 11/11. No service, variable, provider call, migration,
deployment, remote branch, or pull request changed.

Exact provisioning-guard commit `959940b` advances the promotion schema to v2
and separates “safe to create the private analyzer” from “safe to enter
shadow.” The pre-mutation action gate requires native-amd64 role-v4 image,
manual-listening, and frozen Railway baseline evidence; it intentionally does
not require resource and rollback evidence that can exist only after the
service is created. At exact commit `959940b` it failed on those three
prerequisites, and the ordinary shadow gate computed six
blockers. CI fetches full history so exact base/candidate commit verification
can run instead of failing inside a depth-one checkout. A fresh detached
checkout of `959940b` passes the v2 typecheck/CLI and literal Phase 0 command
under Bun 1.3.14: 194 worker, 24 analyzer, 28 Railway host/migration, 5
separator, 30 discovery, 9 YAMNet, and 19/6/1 browser tests. A read-only check
of the explicit canonical Railway IDs still passes with the analyzer absent,
features off, zero mutations, zero provider calls, and no secrets printed.
Docker Desktop remained without a responsive engine even after a bounded
restart attempt, so no current role-v4 image claim was added. No remote branch,
pull request, Railway mutation, provider call, or deployment changed.

Exact rollback-binding commit `ba55621` closes the automated Railway baseline
condition without turning it into a hand-edited claim. The manifest loader
pins the existing `baseline.json` by SHA-256 and revalidates its exact schema,
canonical Railway scope, executable four-track contract, authorized CC corpus
source, local source bytes when hydrated, job timing, ordered distinct stem
hashes, deployed commit/image, and provider pins. A clean exact-commit Phase 0
run passes 198 worker, 24 analyzer, 28 Railway host/migration, 5 separator, 30
discovery, 9 YAMNet, and 19/6/1 browser tests. The pre-mutation action gate now
fails only on native-amd64 role-v4 image evidence and human listening; the
shadow gate has five blockers after carrying forward the automated baseline.
All processing flags remain off, and no service, variable, provider call,
deployment, remote branch, or pull request changed.

Exact acceptance-evidence commit `1aa63d9` closes the two implementation seams
behind the remaining pre-provision blockers without claiming either blocker is
satisfied. A read-only exporter now requires and verifies the hydrated
authorized source, re-reads
the existing frozen Railway job, verifies the live catalogue, job, ordered MP3
bytes, sizes, SHA-256 values, MPEG frames, and same-origin URL boundary, and
writes a private mode-`0600` listening bundle under `output/`. Its strict
review schema requires a named teacher or domain reviewer, a post-baseline UTC
timestamp, every whole-source/stem/usability check, exact frozen stem identity,
and a fixed attestation before the canonical `review.json` can validate. The
native-amd64 CI job now proves a Linux x86_64 runner and Docker host, builds and
smokes the exact `linux/amd64` image, binds every Docker input and smoke source
by SHA-256, and uploads a commit-named evidence artifact with a digest-pinned
official action. A clean exact-commit Phase 0 run passes 207 worker, 24
analyzer, 28 Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, and
19/6/1 browser tests; `actionlint`, the audio-pipeline typecheck, and diff
checks also pass. The private listening bundle matches the frozen source and
all four stems with zero jobs or provider calls created. Human acceptance and
a native GitHub run remain absent, so both manifest booleans stay false and the
pre-mutation action gate still fails on exactly those two conditions. No push,
pull request, Railway mutation, provider call, or deployment occurred.

Exact teacher-review commit `671c262` makes the already-private Phase 2
discovery evidence usable without advancing the rejected CLAP candidate. The
authenticated instructor console now loads one stored Auto job by bounded ID,
shows its concrete core route, role-classifier version, decision reason,
discovery status, vocabulary/classifier version, and possible/uncertain
detections with confidence and window support. Its copy and controls explicitly
preserve the 2/4/6 contract and cannot create an isolation. Invalid IDs are
rejected before a request; abstention is not presented as instrument absence;
discovery timeout leaves the successful core route visible; source digests and
weight hashes are not rendered; a failed logout retains the active session
state, while a confirmed logout scrubs the job and detections from the DOM.
The complete Bun 1.3.14 Phase 0 gate passes 207 worker, 24 analyzer, 28 Railway
host/migration, 5 separator, 30 discovery, 9 YAMNet, and 19/6/1 browser tests.
In-app browser QA passes at 1280×720 and 390×844 with no overflow or console
warnings/errors. Discovery, query isolation, and server Auto remain off; no
provider route, database change, Railway mutation, push, pull request, or
deployment was added.

Exact teacher-feedback commit `d710fe9` turns that advisory display into
governed candidate evidence without promoting it to ground truth. An
authenticated teacher can classify every surfaced label as confirmed or
absent, add missed instruments only from the pinned vocabulary, and record a
reviewed genre. The review ontology presents specific instruments,
family/ensemble labels, and production textures as distinct kinds so parent and
child evidence is not silently double-counted. Each revision is append-only,
bound to the exact stored analysis, source digest, classifier/vocabulary pins,
ontology version, teacher, and prior revision, while teacher/student responses
omit reviewer and source identity. Rows remain explicitly identified,
unreviewed, and ineligible for training; they cannot change the concrete core
model or request an isolation. The complete Bun 1.3.14 Phase 0 gate passes 210
worker, 24 analyzer, 31 Railway host/migration, 5 separator, 30 discovery, 9
YAMNet, and 19/6/1 browser tests. Desktop/mobile in-app QA confirms durable
revision readback, a one-result vocabulary filter, 44-pixel verdict targets, no
horizontal overflow, and no console warnings/errors. All processing flags stay
off; no Railway mutation, provider call, push, pull request, or deployment
occurred.

Exact genre-diverse evaluation commit `6527828` freezes the first executable
bridge from advisory detections to comparable evidence. Its content-hashed plan
binds all 11 authorized real mixes and eight ChoraleBricks controls, seven
real-mix genre families, all 10 vocabulary families, and the three distinct
review kinds. An owner-only worksheet requires a reviewer to listen to every
complete source and classify all 51 labels; its finalizer strips reviewer
identity and binds the exact private bytes before a public artifact can be
evaluated. Candidate reports require exact classifier/model/vocabulary/
preprocessing/threshold pins and cannot hide degraded inference. Metrics stay
separate by genre, specific-instrument family, review kind, instrument, and
corpus kind; the overlapping all-label aggregate is explicitly ineligible for
promotion. The exact commit passes the complete Bun 1.3.14 Phase 0 gate: 220
worker, 24 analyzer, 31 Railway host/migration, 5 separator, 30 discovery, 9
YAMNet, and 19/6/1 browser tests. No listening review or candidate report exists
yet, no quality floor was selected, and all processing flags remain off.
The final value-free Railway pre-provision readback still passes against the
explicit canonical IDs with the analyzer absent, zero mutations, zero provider
calls, and no secrets printed. The repository action gate remains correctly
blocked only by manual listening and native-amd64 role-v4 image evidence.
See the
[genre-diverse evaluation contract](docs/evaluation/2026-08-10-genre-diverse-instrument-evaluation.md).

Exact evaluation-semantics commit `558708f` advances that plan and its candidate
and metric schemas to v2 before any review or candidate artifact exists. Each
source must now distinguish a definite classification from model abstention and
service degradation, using an outcome-compatible reason code. Empty classified
results remain explicit negative decisions; empty abstained results do not
become false negatives or true negatives; degraded inference contributes only
to the service-failure rate. Precision/recall therefore cover definite
classified decisions, while selective coverage, abstention, and service failure
stay separately visible. The exact commit passes the complete Bun 1.3.14 Phase
0 gate: 221 worker, 24 analyzer, 31 Railway host/migration, 5 separator, 30
discovery, 9 YAMNet, and 19/6/1 browser tests. This changes no processing flag,
route, stem contract, service, or live environment.

Exact candidate-provenance commit `41e66e9` advances the plan, candidate, and
metric artifacts to v3. Candidate identity now binds SHA-256 values for
preprocessing, classifier policy, and threshold policy. A separate evidence
envelope binds an exact source report and schema, the repository generator,
dependency lock, immutable image ID, and native non-emulated `linux/amd64`
execution. Evidence paths must resolve to nonempty regular repository files,
contain no symbolic-link component, stay at or below 16 MiB, and match their
declared digests; the metrics report carries the same evidence forward. The
exact commit passes the complete Bun 1.3.14 Phase 0 gate: 223 worker, 24
analyzer, 31 Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, and
19/6/1 browser tests. This defines a validation boundary, not a candidate result:
no model-specific adapter has yet converted a clean native classifier report
into v3 observations, and no candidate artifact exists. All processing flags
and the live Railway topology remain unchanged.

Exact YAMNet capture-adapter commit `5f9a8ad` implements the first
model-specific bridge without selecting or promoting that classifier. A
two-step, no-overwrite CLI binds a fresh schema-v2 corpus report and schema-v1
control report by path and SHA-256, then revalidates their exact YAMNet model,
mapping, vocabulary, scoring policy, evaluator sources, audio/PCM plan,
dependency lock, immutable image, and shared native non-emulated `linux/amd64`
execution before emitting v3 observations. Because no teacher-cleared threshold
exists, all 19 sources are deliberately emitted as
`abstained`/`no-label-cleared-threshold` with zero detections; the adapter cannot
manufacture negative labels or a selection decision. Historical arm64,
emulated-amd64, mismatched-image, replaced-report, symlinked, reordered, and
pin-drift evidence fails closed. The exact commit passes the complete Bun
1.3.14 Phase 0 gate: 227 worker, 24 analyzer, 31 Railway host/migration, 5
separator, 30 discovery, 9 YAMNet, and 19/6/1 browser tests. No fresh native
reports or candidate artifact were created, and all processing flags and live
Railway topology remain unchanged.

Exact query-isolation budget commit `d207d4b` closes the remaining local spend-
ceiling seam without making AudioSep executable. A versioned, fail-closed
policy binds one course, one semester, and a maximum number of provider starts.
The claim transition atomically reserves from an immutable ledger before it can
move a teacher-beta row to processing; concurrent teachers share the same
course-semester ceiling, every retry consumes another start, deleting a job
does not refund its spend, and changing the ceiling after reservations begin
fails closed. Shadow demand cannot reserve budget, and missing, incomplete, or
invalid policy configuration cannot authorize a claim. The exact commit passes
the complete Bun 1.3.14 Phase 0 gate: 228 worker, 24 analyzer, 33 Railway
host/config/migration, 5 separator, 30 discovery, 9 YAMNet, and 19/6/1 browser
tests. No provider-start route imports the dormant adapter, and no Railway
variable, live migration, service, prediction, deployment, push, or pull
request changed. A post-commit, value-free check of the explicit canonical
Railway IDs still reports the analyzer absent, feature posture off, zero secrets
printed, zero mutations, and zero provider calls. The local provisioning action
gate remains blocked on exactly `manual-listening-missing` and
`native-amd64-image-missing`.

Exact query-isolation output commit `885f4ab` closes the dormant terminal-
ingestion seam without making AudioSep executable. Exact provider identity now
guards a three-attempt, five-minute ingestion lease; one observer hydrates the
result while webhook/poll overlap, stale leases, and terminal replay remain
bounded. The downloader accepts only strict Replicate delivery HTTPS, follows
no redirect, shares one 60-second deadline across retries and body reads, caps
the result at 100 MiB, verifies a complete PCM/float RIFF/WAVE container, and
stores only app-owned `isolations/<id>/target.wav` bytes. Immutable metadata
binds SHA-256, byte count, media type, and the 30-day retention deadline;
metadata insertion, resource completion, and lease deletion commit atomically.
Transient failures release the lease without spending another provider start;
malformed output, exhausted ingestion, and provider failure remain isolated
from the completed core stems. Exact Bun 1.3.14 passes all four typechecks,
235 worker, 24 analyzer, 42 Railway host/config/migration/terminal, 5 separator,
30 discovery, and 9 YAMNet tests plus 19/6/1 browser journeys. The code is not
imported by an app route. No prediction, Railway variable or service, live
migration application, deployment, push, or pull request changed.

Phase 3 now has a false-default teacher shadow seam. The analyzer and server
derive a private SHA-256 from the exact stored bytes; normalized target demand
is idempotently recorded against the complete cache identity, capped at two per
job, and redacted from student payloads. The job digest is write-once after its
first verification; its source key and type then freeze. Resource creation
atomically requires the supplied source type and digest to equal the completed
job. Shadow rows default to a non-executable rollout stage and cannot enter the
provider claim transition. No Replicate prediction path, Railway variable
change, or deployment was added. The course-semester reservation mechanism is
implemented locally, but its canonical scope/ceiling and live teacher-beta
acceptance are intentionally unset. AudioSep checkpoint provenance,
provider orchestration, quality/cost evaluation, native and listening evidence,
live object-retention readback, and rollback acceptance remain open.
The local CI workflow now invokes the isolation-shadow browser journey as an
explicit source gate at commit `e67dd3b`; because the branch remains absent from
GitHub, no native run has yet proved that committed workflow step.

This roadmap extends AutoSplit beyond assumptions inherited from a traditional
rock-band mix. The goal is to recognize and optionally isolate instruments such
as strings, brass, woodwinds, organ, synthesizer, accordion, harp, and regional
or traditional instruments without destabilizing the dependable core split.

The order below is mandatory. A later phase must not become the default merely
because its model or service is available.

## Stable baseline to preserve

- [x] Keep the active Railway `stem-splitter` Node/Railpack service as the app,
  storage, job-control, and webhook authority. Do not substitute the legacy
  Railway `web` service or move unfinished work to a Worker runtime.
- [x] Keep a discrete `INSTRUCTOR` link in the mixer footer. The canonical live
  Railway page renders `/teacher.html` at that link and the target returns 200.
- [x] Keep the current provider-neutral 2-, 4-, and 6-track contracts and the
  pinned Replicate Demucs runner working while experiments are introduced.
- [x] Keep four tracks as the conservative separation default until a new
  routing policy clears the evaluation and release gates below.
- [x] Keep browser AutoSplit classification bounded to the complete source when
  it is at most 45 seconds and to beginning/middle/end windows otherwise, move
  resampling/FFT work off the UI thread, and fail honestly when Web Audio
  decoding or worker analysis exceeds 20 seconds.
- [x] Keep authoritative Auto from decoding uploads in Web Audio at all; the
  stored source is analyzed on Railway. Cap the temporary browser-only/shadow
  path at 5 minutes and 24 MiB before `decodeAudioData`, with a tested honest
  fallback for anything larger.
- [ ] Retire browser shadow decoding after parity calibration or replace it
  with a streaming decoder. Duration/byte caps sharply reduce classroom risk
  but cannot exactly bound decoded PCM for exotic high-rate or multichannel
  compressed files.
- [x] Keep the fixed teacher system prompt code-owned and read-only in the
  editor. Open its Markdown-formatted view at the tail, provide an interactive
  upward caret to inspect the top, and isolate teacher-appended instructions in
  a dedicated field. Require a change note and retain teacher, timestamp, base
  prompt version/SHA, effective SHA, and amendment snapshot in revision history
  so prompt changes remain traceable without letting a browser edit fixed
  guardrails.
- [x] Resolve the instructor landing-page browser review. The tagline now uses
  sentence-case “listening guide.” A scoped submit style gives `SIGN IN` a
  44-pixel minimum target, balanced vertical padding, centered text, and a
  visible keyboard-focus outline without changing other `.yt-go` controls. The
  teacher page versions its stylesheet and script together so neither stale
  layout nor stale caret/pagination/logout behavior can survive the update. The
  caret now focuses and brings the true first prompt line into the viewport.
  Real-browser readback measures 44 pixels, and the instructor E2E asserts the
  text, asset versioning, minimum target height, inner scroll, and viewport
  position.
- [x] Keep provider and student data from impersonating those fixed guardrails.
  Prompt version `2026-08-10.2` JSON-escapes control characters and quotes in
  the imported title, custom channel labels, and timeline notes before placing
  them in the system message, and explicitly labels all three as untrusted data.
  An injection-shaped fingerprint variant covers newline, quote, and Unicode
  line-separator behavior so weakening that encoding changes the governed hash
  and guide-cache identity. Direct policy tests prove those values cannot create
  a new fixed-prompt line.
- [x] Document Railway-first teacher provisioning, deprovisioning, rotation,
  rollback, and acceptance. Generate verifier records through a hidden prompt
  in an explicit Bash subprocess so the documented command is safe from the
  workspace's default Zsh as well as Bash. The helper bounds/validates stdin and
  seed identity fields before PBKDF2, with direct regressions. This documentation
  does not replace the authorized live persistence check below.
- [x] Keep teacher governance complete beyond one browser page. The prompt API
  returns a bounded newest-first page plus an authenticated keyset cursor; the
  console appends earlier pages until every retained immutable revision is
  reachable instead of silently stopping at 40. A 43-revision server regression
  proves non-overlap and a 42-revision browser journey proves the complete trail.
  Seed reconciliation also rejects a supplied non-string display name before
  any authoritative account write, so malformed optional metadata cannot cause
  a partial rename or provisioning change.
- [ ] Complete the remaining live teacher-console acceptance check from
  `docs/superpowers/plans/2026-08-08-autosplit-prompt-governance.md`: save one
  revision with an authorized real teacher account, restart Railway, and prove
  that the revision persists. An isolated Node/SQLite save-login-restart-login
  readback now passes locally at revision 1; it does not substitute for the
  real Railway/volume check. A value-free canonical-service readback confirms
  the `TEACHER_SEED` key is present, but key presence does not prove account
  reconciliation or persistence. Never retrieve or expose the credential to
  automate that live check.
- [x] Bound teacher login/prompt JSON by bytes and read time, equalize
  unknown-account PBKDF2 work,
  cap concurrent password checks, throttle failure bursts on the current
  single-replica Railway process, and make teacher responses `no-store`.
- [x] Make session expiry and sign-out truthful. Parse stored ISO timestamps
  before comparing them with SQLite time so a same-day expired session cannot
  survive until midnight. The console now remains visibly signed in when the
  logout request fails; only a confirmed server logout hides the console, and
  that path clears the amendment, preview, prompt history, actor metadata, and
  credentials from the DOM. Deterministic SQLite and real-browser regressions
  cover expiry, cleanup, failed logout, confirmed revocation, and DOM scrubbing.
- [x] Preserve the prompt/history/cache transaction under concurrent Railway
  requests. A direct reproduction showed the Node D1 shim allowed a second
  `batch()` to issue `BEGIN` while the first batch was suspended; each
  synchronous SQLite batch now runs without an internal await. Prompt update,
  append-only revision, and guide-cache deletion share one rollback boundary,
  only the winning compare-and-swap may invalidate guides, and the save response
  is assembled from its immutable revision instead of rereading whichever
  settings revision is newest. A forced later-save interleaving proves the first
  response cannot mix the second teacher's amendment with the first teacher's
  hashes. The original concurrent-batch, losing-CAS, and concurrent-save slice
  is committed at `821f5e1`; exact commit `fe0a5ff` binds the exact-readback
  follow-up and its clean combined gate.
- [x] Prevent stale guide generations from undoing prompt governance. Each
  cached guide records the code-owned `SYSTEM_PROMPT_VERSION`, effective policy
  SHA-256, and monotonic amendment revision; its single-statement upsert
  succeeds only while that revision remains current. A guide begun before a
  teacher edit can finish for its original caller but cannot repopulate the
  shared cache. An older version or content-mismatched policy hash regenerates
  lazily, so a missed manual version bump cannot serve stale guide prose.
  Railway's additive migration preserves legacy rows with a deliberately
  ineligible cache identity. Focused tests also prove transaction rollback when
  invalidation fails.
- [x] Fail closed on prompt-history drift. A pre-existing row for the next
  settings revision must raise an integrity error and roll back the setting,
  cache invalidation, and attempted history write; it may never be silently
  reused as the audit record for a different amendment. The compare-and-swap,
  required append, and winning-request-only invalidation now form a chained
  transaction, with a direct corruption/restore regression.
- [x] Enforce append-only prompt history below the API layer. Fresh schema,
  idempotent Railway boot migration, and numbered migration 13 install row-level
  triggers that reject direct updates, deletes, and replacement/conflicting
  inserts while allowing valid new revisions. A separate insert trigger rejects
  malformed revision numbers, oversized content, empty/oversized notes,
  malformed policy hashes/versions, and invalid actor identities before they
  can become immutable audit evidence. Both TypeScript checks and 28 Railway
  server/migration regressions pass; the complete source-stable gate is recorded
  below. Keep database access restricted because a privileged schema
  administrator can still remove triggers.
- [x] Make prompt fingerprints cover the complete conditional policy surface.
  The original SHA-256 input was only the readable four-stem guide preview, so
  a fixed-text edit confined to chat mode, two-stem `instrumental` guidance,
  populated notes, unknown duration, or custom labels could evade the promised
  trace if its version bump were also missed. Keep the readable preview for the
  teacher, but hash a schema-versioned deterministic bundle exercising every
  current branch; bind it to a new prompt version, changelog entry, and direct
  regressions. Prompt version `2026-08-10.2` and fingerprint schema v1 cover both
  modes, every current data/rendering arm, and injection-shaped untrusted input.
  Guide-cache reads require that same effective SHA, closing the stale-cache
  path even if a future code edit misses the version bump. Four direct prompt
  regressions pass; the accepted current frozen combined gate is recorded below.
  This is local evidence only; it has no GitHub PR or Railway release and does
  not close the real-teacher restart gate.
- [x] Pin the active Railpack host and CI to exact Node `22.23.1` instead of a
  floating `>=22.5`, declare matching Node types directly, and statically check
  `server/` plus shared `src/`. This catches Railway-adapter errors that the
  Worker-only typecheck cannot see. The package/runtime/typecheck slice is
  committed at `821f5e1`.
- [ ] Add a distributed teacher-login edge limit before increasing Railway
  replicas or performing the deferred Cloudflare migration; the process-local
  throttle intentionally does not claim cross-replica protection.
- [x] Capture a new baseline before pipeline work: commit SHA, full test result,
  live `/healthz`, one authorized real-audio 4-track job, output hashes, latency,
  and provider/model version. This is the rollback comparison point. The live
  evidence is recorded under
  `docs/acceptance/2026-08-09-v3.2-rollback-baseline/`; all four outputs had
  valid MP3 headers and distinct hashes. The complete `test:phase0` source gate
  passes on committed source `d4c5781`: 105 worker, 21 analyzer, 5
  server/migration, 5 separator, 24 discovery, 19 browser E2E, and 4
  server-authoritative Auto E2E tests, including the oversized-job-body gate.
  Manual listening remains a release gate.
- [x] Make the repeatable baseline capture fail closed before it handles a class
  code or audio: HTTPS-only remote origin, exact ready health/default contract,
  bounded requests/responses and polling, no redirects, no reflected error
  bodies, same-origin credential-free output URLs, real MPEG-frame evidence,
  exact metadata shapes, and immutable `0600` output. Four focused regressions
  cover the secret, transport, and false-positive audio boundaries.
- [x] Bind the passing full-gate result above to committed source `d4c5781`
  before opening a PR or deploying. Documentation-only follow-up commits do
  not change that tested source identity.
- [x] Bound inbound app JSON and outbound Archive/YouTube bodies by media type,
  declared and streamed bytes, read time, and redirect policy. Reject malformed
  prediction identities, non-audio provider bodies, unsupported licence URLs,
  incomplete Archive duration/size metadata, and unapproved redirect origins;
  cancel rejected streams and log only safe error names/codes.
- [x] Apply one wall-clock budget across Archive retry, redirect, header, and
  body work and across each YouTube provider's session, prediction start/body,
  polling, and output header/body. Map arbitrary provider stream and
  playability errors to fixed local messages rather than reflecting provider
  text. Focused regressions prove the Archive and Replicate phase budgets plus
  safe stream-error normalization.
- [x] Close the remaining Innertube transport boundary before remote Auto is a
  release candidate. The injected fetch restricts requests and manually
  validated redirects to the reviewed `www.youtube.com` session/player paths,
  the exact `youtubei.googleapis.com/youtubei/*` alternate, and
  `*.googlevideo.com/videoplayback`; it strips bearer, cookie, proxy, and
  Google/YouTube identity headers on cross-origin hops, bounds internal
  session/player bodies to 16 MiB, and retains the outer 100 MB streamed-audio
  limit plus the shared 45-second deadline. Six focused regressions pass, and a
  read-only live control imported the known 19-second video as 309,288 bytes.
- [x] Bind the post-baseline timeout/error-normalization work to exact commits
  `c367e23` and `fe112ef` and rerun the complete gate against intermediate source
  `fe112ef`: 121 worker, 21 analyzer, 5 server/migration, 5 separator, 29
  discovery, 19 browser E2E, and 4 authoritative Auto E2E tests pass. The
  verification shell initially lacked the repository-pinned Bun executable, so
  this intermediate gate ran directly through Node/npm/npx/uv; the later
  `821f5e1` gate closes the local Bun-wrapper gap. Native GitHub remains open.
- [x] Bind the Innertube transport boundary to exact executable-source commit
  `fce98cf` and repeat its complete gate: 127 worker, 21 analyzer, 5
  server/migration, 5 separator, 29 discovery, 19 browser E2E, and 4
  authoritative Auto E2E tests pass through the underlying commands. This
  committed-source result and one live control import do not constitute native
  GitHub, Railway, or release acceptance.
- [x] Bind the combined Railway transaction/runtime and import hardening to
  exact executable-source commit `821f5e1`. An ephemeral exact Bun `1.3.14`
  verified the frozen 160-package lock with no changes, then the literal
  `test:phase0` passed all three typechecks plus 127 worker, 21 analyzer, 9
  server/migration, 5 separator, 29 discovery, 19 browser E2E, and 4
  authoritative Auto E2E tests. Native GitHub and Railway acceptance remain
  separate gates.
- [x] Bind the prompt-aware guide-cache follow-up to exact executable-source
  commit `e640c72` and repeat the literal Bun `1.3.14` phase-zero gate. All
  three typechecks plus 127 worker, 21 analyzer, 13 server/migration, 5
  separator, 29 discovery, 19 browser E2E, and 4 authoritative Auto E2E tests
  pass. Native GitHub and Railway acceptance remain separate open gates; this
  local commit is not present on `origin` and has no pull request.
- [x] Bind the prompt-history integrity follow-up to exact executable-source
  commit `4a3fbf1` and repeat the literal local Bun `1.3.14` phase-zero gate.
  All three typechecks plus 127 worker, 21 analyzer, 14 server/migration, 5
  separator, 29 discovery, 19 browser E2E, and 4 authoritative Auto E2E tests
  pass. Native GitHub, Railway, and authorized teacher persistence remain open;
  no remote branch or pull request contains this commit.
- [x] Record the canonical Railway project, environment, and service IDs and
  replace name-based release commands. The current local Railway link resolves
  to a same-named legacy workerd project and must never be treated as authority.
- [x] Before this branch can be deployed, stage an exact
  `REPLICATE_YT_MODEL_VERSION` on the canonical Railway service without
  triggering an unrelated release. Version `bcd3b512…` passed the importer
  schema guard and was staged with `--skip-deploys`; deployment
  `7f4bc330…` remained active and unchanged. Local runtime/config guards now
  accept only the exact 64-hex version form; the staged value is not claimed as
  active in the still-running old deployment.

## Service and dependency order

| Order | Component | Deployment posture | May affect the default split? |
|---|---|---|---|
| 0 | Existing `stem-splitter` app | Already active on Railway; preserve it | Yes, but only through reviewed app releases |
| 1 | Versioned audio-analysis API | New private Railway CPU service | No; shadow/advisory first |
| 2 | Instrument classifier | New private Railway ML service, reachable only by the analyzer after parity | No; detection metadata only at first |
| 3 | AudioSep query separator | Teacher-only shadow demand/resource path; provider execution remains impossible | No; explicit optional isolation only |
| 4 | SAM-Audio comparison | Evaluation-only pinned Replicate integration | No until selected through review |
| 5 | Banquet/Query-Bandit | Future private Cog or GPU service | No until a separate multi-stem design is accepted |

The analysis service comes first because remote Auto needs decoded audio before
it can make an honest decision. The classifier comes next because the system
must identify a plausible target before paying a query separator. AudioSep and
SAM-Audio follow as optional extraction providers. Banquet is a later option if
the product needs a coherent long-tail multi-stem decomposition rather than
individual target isolations.

## Phase 0 — freeze contracts and establish regression gates

- [x] Write a short decision record defining three distinct concepts:
  `core split`, `instrument detection`, and `query isolation`. Never use these
  names interchangeably in API fields, database rows, logs, or UI copy.
- [x] Make `auto` a routing request, not a separation-model identifier. Store
  the resolved core model separately from the request that caused it.
- [x] Freeze the existing core response contract: job state and the meanings of
  `vocals`, `instrumental`, `drums`, `bass`, `other`, `guitar`, and `piano` must
  not change during classifier work.
- [x] Define a versioned analysis response before building another service,
  including at minimum:
  - schema version;
  - role-classifier version;
  - vocabulary/classifier version when present;
  - resolved core model, confidence, features, and human-readable reason;
  - detected instruments with independent confidence values;
  - timing and explicit degraded/fallback state.
- [x] Add provider-neutral interfaces for analysis and query isolation. Shared
  application code must not import a Railway-, Replicate-, Python-, or
  Node-specific implementation.
- [x] Add feature flags with safe false defaults:
  `SERVER_AUTO_ENABLED`, `INSTRUMENT_DISCOVERY_ENABLED`, and
  `QUERY_ISOLATION_ENABLED`.
- [x] Make every new persistent schema change additive. Update `schema.sql`,
  the Railway `node:sqlite` migration path, its regression tests, and a future
  numbered D1 migration together.
- [x] Keep timing assertions deterministic by injecting the service clock.
  The full gate exposed a wall-clock millisecond-boundary failure in the
  fingerprint contract test; fixed elapsed-time behavior now uses the existing
  clock seam instead of assuming an async request completes in exactly 0 ms.
- [x] Build a fixed, authorized eleven-source evaluation manifest spanning rock,
  jazz, orchestral/chamber, electronic, hip-hop, folk/traditional, and sparse
  acoustic music. Record source rights and expected audible instruments. Commit
  `0fbc62a` adds a required SHA-256 for every hydrated file source; both the
  browser and FFmpeg evaluators fail before decoding on byte drift, while the
  recorded Archive SHA-1 remains a second provenance check where available.
  Independent readback confirms all 11 current hydrated files match those pins.
- [x] Add contract tests proving that all new flags disabled produce the exact
  pre-change catalogue, job routing, stem names, and UI behavior.

**Gate:** no additional service is provisioned until the versioned contracts,
fixtures, fallback behavior, and flag-off regression tests exist.

**Local gate evidence:** contracts, deterministic 2/4/6 PCM parity fixtures,
authorized corpus metadata, fallback tests, and flag-off tests now exist and
pass. This permits service provisioning to be planned; it does not authorize a
deployment or enablement.

## Phase 1 — server-authoritative Auto for every source type

### 1A. New Railway `audio-analysis` service

- [x] Implement a small authenticated analysis API in a separate container.
  It adds no FFmpeg, Python ML dependencies, or model weights to the warmed
  `stem-splitter` app container.
- [ ] Provision that container as a separate private Railway CPU service with
  no public domain. Keep the existing app service and its volume unchanged.
  Follow `docs/railway-audio-analysis-provisioning.md`; Railway variable edits
  redeploy by default, so assemble the reviewed batch with `--skip-deploys`.
  The frozen Railway baseline condition is now bound to exact committed
  evidence. The schema-v2 action gate still refuses this mutation until the
  native-amd64 role-v4 image and manual-listening conditions also exist.
- [x] Give the service a least-privilege way to read one short-lived source URL;
  do not mount or share the app's persistent `/data` volume. The shared,
  versioned `analysis-source-scope-v2` contract now permits only canonical
  `uploads/<id>/<file>` objects and app-owned `auto-inputs/v1/<job>` snapshots;
  the latter require upload source type. The app refuses to sign analyzer URLs
  for stems, query-isolation snapshots/outputs, malformed keys, or extra path
  segments, and `/readyz` exposes the exact compiled scope version.
- [x] Decode only bounded beginning, middle, and end windows with FFmpeg and
  enforce byte, duration, phase-timeout, output, and concurrency limits.
- [ ] Set and verify the Railway service's CPU, memory, restart, and ephemeral
  disk limits. Exercise malformed media and maximum-size concurrent requests;
  the Node heap cap alone does not bound the FFmpeg child process.
- [x] Port the existing role features and 2/4/6 decision rules first, then
  version every subsequent calibration change. Use the same golden PCM
  fixtures to prove deterministic browser/server parity.
- [x] Expose liveness and readiness separately. Readiness must remain false
  until the decoder and classifier are actually usable.
- [x] Define a non-root service image with digest-pinned Node and Bun bases,
  checksum-pinned FFmpeg 8.0.3, the frozen dependency lock, and a pinned
  classifier version. Log versions and timings, never source URLs, class codes,
  raw features, audio, or credentials.
- [x] Build the current role-v3 image as `linux/amd64` and run its non-root,
  runtime allowlist, `/healthz`, `/readyz`, authentication, eight advertised
  audio-format, and eleven-source corpus checks on pinned FFmpeg 8.0.3. The
  local emulated run produced 8 preferred choices, 3 accepted alternatives,
  and 0 rejected choices.
- [x] Add one reusable constrained-image smoke used locally and by native CI.
  It runs with a read-only root, dropped capabilities, no analyzer mounts, an
  internal-only fixture network, 1 vCPU, 1 GiB RAM, 64 PIDs, and bounded `/tmp`;
  then proves readiness/auth, real short and 15-minute audio, declared and
  streamed oversize rejection, malformed-media rejection, source timeout,
  overlap `503` plus `Retry-After`, temporary-file cleanup, and secret-free
  logs. The current native arm64 image passed at a final 59.81 MiB sample; the
  existing emulated amd64 image passed at 253.4 MiB. These snapshots are not
  peak Railway metrics.
- [x] Rebuild the fingerprint-capable analyzer from executable commit
  `10f6b0a` on native arm64 and repeat the constrained smoke. Local image
  `sha256:e2ebd8c3d2452ccd34be371ab9222a8a3f9408faaaf4e7cd7d306bbf45e6838f`
  passes source-hash parity, auth, codec allowlists, resource boundaries,
  malformed/oversize/timeout/concurrency failures, cleanup, and redaction. See
  [the bound image evidence](docs/evaluation/2026-08-10-audio-analysis-fingerprint-image.md).
- [ ] Build and reproduce the current role-v4/source-scope-v2 image on a native
  amd64 GitHub runner and Railway. Keep the CI runtime audit that permits only
  the six advertised demuxers, audio
  decoders, and file/pipe protocols; then exercise Railway CPU, memory, child
  process, concurrency, timeout, and ephemeral-disk limits. Local emulation is
  not production resource evidence.
- [x] Bind native-amd64 acceptance to an immutable CI artifact rather than a
  manifest checkbox. The `analysis-image` job now checks out the exact PR head
  or push SHA on an x86_64 Linux host, verifies the Docker host, builds and
  smokes `linux/amd64`, captures image/pin/smoke/source evidence, and uploads a
  commit-named 30-day artifact. The canonical evidence path remains absent
  until that job actually passes.
- [x] Keep credentials fail-lazy in the app: if analysis is unavailable, upload,
  playback, annotations, and explicit 2/4/6 splitting must still work.

### 1B. Integrate without changing defaults

- [x] Let `/api/jobs` accept `model: "auto"` for uploads, YouTube, and Internet
  Archive, but resolve it only after the source has been fetched and stored.
- [x] Run the analysis service in shadow mode for local uploads first. Compare
  its result with the browser result while continuing to honor the browser's
  existing choice.
- [x] Record shadow disagreement, timeout, source type, chosen fallback, and
  versioned reason in job metadata. Do not log raw feature arrays if they could
  fingerprint copyrighted recordings.
- [x] Treat the analyzer endpoint and bearer token as a fail-closed transport
  boundary: require HTTPS except for loopback or `*.railway.internal`, reject
  embedded credentials and non-root URL paths/queries/fragments, require at
  least 32 token characters, reject redirects without forwarding credentials,
  and cap streamed JSON responses at 64 KiB.
- [x] Bind successful analyzer recommendations for server-fetched YouTube and
  Archive imports to the exact SHA-256 and byte count calculated before storage.
  A missing or different analyzer identity now records
  `source_identity_mismatch`, preserves the server-owned private digest, and
  routes only the frozen default. A core-contract failure also discards any
  fingerprint field that happened to parse before the failure. Unit coverage
  exercises missing/hash/length drift and authoritative E2E proves neither
  imported source can send the mismatched recommendation to the separator.
- [x] Close the upload-specific post-analysis race before authoritative
  promotion. Authoritative upload jobs now stream the current stored object into
  an app-owned `auto-inputs/v1/<job>` snapshot before analysis; browser upload
  routes cannot address that prefix, and both the analyzer and separator receive
  signed URLs for the same frozen key. The analyzer's reported byte count must
  match the stored snapshot size before its route can apply. Railway's filesystem
  adapter streams writes through unique temporary files under a per-key writer
  lock instead of materializing the 100 MiB boundary in the warmed heap. Focused
  regressions cover replacement before and after analysis, byte-identical retry,
  concurrent PUTs, retention expiry, collision, failed-copy rollback, the full
  100 MiB streaming boundary, and analyzer/separator URL identity. Exact
  authoritative mode also covers the legacy valid request shape with an
  explicit model plus `routingRequest: auto`, so it cannot bypass freezing.
  Because the job now retains the app-owned key, the later teacher-isolation
  boundary explicitly accepts that exact key family without accepting arbitrary
  internal storage paths. Exact executable-source commit `e9f7ed9` passes the
  literal Bun 1.3.14 Phase 0 gate from a clean detached worktree: all three
  typechecks; 165 worker, 22 analyzer, 22 Railway/migration, 5 separator, 30
  discovery, and 9 YAMNet tests; plus 19 baseline, 6 authoritative-Auto, and 1
  isolation-shadow browser scenario. `git show --check` passes. Real Railway
  resource/restart evidence remains separate.
- [x] Close the analyzer allowlist seam for the immutable upload handoff. A
  cross-service audit reproduced that the app signed
  `/api/local-sources/auto-inputs/v1/<job>` while the real service accepted only
  `/api/local-sources/uploads/...`; the mocked authoritative browser suite did
  not exercise that service policy, so a deployment would have fallen back to
  four tracks. App and analyzer now compile one `analysis-source-scope-v2`
  module. Cross-service tests prove the app-minted snapshot URL is accepted only
  as an upload, while stems, isolation paths, malformed/over-deep keys, and
  source-type mismatches fail before fetch. The constrained image smoke also
  requires the readiness pin and an actual authoritative-snapshot analysis.
  Exact executable-source commit `86cd50b` passes a frozen Bun 1.3.14 install
  and literal `test:phase0` from a clean detached worktree: all three
  typechecks; 183 worker, 23 analyzer, 28 Railway/migration, 5 separator, 30
  discovery, and 9 YAMNet tests; plus 19 flags-off, 6 authoritative-Auto, and 1
  isolation-shadow browser journey. The canonical read-only Railway
  pre-provision gate also passes with the analyzer absent, all related features
  off, zero mutations, zero provider calls, and no secrets printed.
  Native-amd64 and Railway image reproduction remain open.
- [x] Compose the actual app and analyzer before provisioning. A real local
  integration test now stores or freezes upload WAV, YouTube AAC/M4A, and
  Archive WAV sources; makes the analyzer fetch each app-signed URL; runs real
  FFmpeg decode, role classification, hashing, and cleanup; and proves the
  separator receives three concrete two-stem inputs, never `auto`. This test
  exposed role v3's one-boundary-peak AAC discrepancy. Versioned role v4
  requires two refractory-separated onset peaks, restores three-source parity,
  and preserves all eleven fixed-corpus decisions. See
  `docs/evaluation/autosplit-role-v4-candidate.md`. Current image, native CI,
  manual listening, and Railway execution remain open.
- [ ] Calibrate parity on the fixed manifest and investigate systematic
  disagreement before allowing server results to route a paid separation.
  Local role v4 is 11/11 accepted (8 preferred, 3 alternatives) and changes no
  v3 corpus choice. Real Chrome agrees with local FFmpeg on all 11 v4 choices;
  the pinned FFmpeg 8.0.3 image still proves only historical v3 source. Keep
  this gate open until the v4 image, native CI/Railway, and manual stem
  listening checks pass; decision agreement alone does not establish musical
  usefulness.
- [x] Export a private listening bundle from the existing frozen Railway job
  without creating a job or making a provider call. The exporter verifies the
  authorized source and all ordered stem bytes before writing the original,
  four MP3 stems, pending review, and guide under the gitignored `output/`
  directory.
- [ ] Obtain an attributable full-source and full-stem acceptance from a
  teacher or domain reviewer. Validate it against
  `docs/acceptance/2026-08-10-v3.2-manual-listening/review.json`; do not commit
  licensed audio or set `manualListening: true` before the strict review loader
  passes.
- [ ] Make the server decision authoritative for all source types only after the
  parity gate passes. Keep the old catalogue default as an explicit fallback,
  never an implicit claim that remote audio was analyzed.
- [ ] Prove upload, YouTube, and Archive journeys end-to-end on Railway,
  including analyzer outage and timeout cases.

**Gate:** remote Auto is complete only when all source types are actually
analyzed after ingestion, every decision is attributable to a classifier
version, and an analyzer failure degrades to the old split without losing the
job.

## Phase 2 — broaden instrument discovery without routing separation

- [x] Add a versioned, teacher-reviewable instrument vocabulary covering at
  least strings, violin, viola, cello, double bass, brass, trumpet, trombone,
  horn, saxophone, clarinet, flute, oboe, organ, electric piano, synthesizer,
  pad, accordion, harmonica, harp, percussion, and selected traditional
  instruments represented in the evaluation corpus. The uncalibrated
  `classroom-instruments-v1` candidate has 51 unique labels in 10 families and
  is locked to a content hash by a schema/integrity test.
- [x] Define a pinned candidate evaluation mapping for all eleven licensed file
  sources: reviewed corpus terms map to one or more vocabulary ids, explicit
  hard negatives, and six named confusion trials. A contract test requires
  exact classifier/weight/vocabulary pins, complete one-to-one corpus coverage,
  known label ids, and real positive/negative evidence for every claimed
  bidirectional trial. Its status is deliberately
  `candidate-baseline-not-a-release-gate`; it contains no model scores.
- [x] Freeze a separate discovery wire contract and analyzer client with exact
  schema, classifier revision, weight hash, vocabulary version/content hash,
  PCM rate/window, response-size, timeout, private-origin, and redirect pins.
  Discovery failure or drift gets its own trace and cannot change a validated
  core Auto decision; student responses strip labels and private pins.
- [x] Spike LAION CLAP inside a separate `instrument-discovery` image
  as the first flexible zero-shot classifier. Load the exact music checkpoint
  during image build, verify its checksum, and prove offline startup; do not
  pull a floating checkpoint during container boot. The current native arm64
  image passed a network-disabled, read-only, non-root smoke with exact
  readiness pins and real inference; a three-second synthetic control completed
  in 258–394 ms, while post-warm container-memory observations ranged roughly
  405–745 MiB across repeated local runs.
  This is implementation evidence, not musical calibration or Railway sizing.
- [ ] Start and infer with the current `linux/amd64` image on a native amd64
  runner and Railway. The 2.11 GB target image builds locally and its runtime
  source hashes match the working tree, but local emulation crossed the image's
  health window during vocabulary embedding and is not production timing
  evidence.
- [ ] Decide whether to convert the pinned PyTorch pickle to safetensors before
  teacher shadow. If converted, verify every tensor name, shape, dtype, and
  value against the pinned source; assign a new artifact hash and classifier
  id; and rerun the full corpus. Never replace the current weight artifact
  under its existing provenance record.
- [x] Add a process-fatal watchdog so a timed-out synchronous inference clears
  readiness and exits instead of monopolizing capacity indefinitely. Regression
  tests cover the permitted two-request race and prove the real fatal callback
  terminates a child process with exit code 70; they do not load PyTorch.
- [x] Define a path-scoped native-amd64 CI image gate that verifies the pinned
  image platform, non-root command, size ceiling, runtime surface, offline
  readiness pins, empty mount surface, dropped capabilities, bounded CPU/RAM/
  PIDs, authentication, and real synthetic-control inference. The workflow is
  local-only until a remote branch/PR run proves it on GitHub infrastructure.
  `actionlint` passes; the earlier fresh native arm64 container run remains the
  local evidence, while a remote branch/PR run is still required.
- [ ] After a replacement classifier passes local musical-usefulness and human
  review, prove that selected discovery container restarts cleanly after the
  watchdog kills a deliberately stuck real inference. Do not spend Railway
  acceptance effort on the rejected CLAP prompt/checkpoint pairing. The chosen
  image still requires Railway restart/readiness evidence before shadow traffic.
- [x] Audit the Essentia/MTG-Jamendo license boundary before downloading a
  candidate. Official MTG sources conflict between CC BY-NC-SA and CC BY-NC-ND,
  the model-directory license is internally inconsistent, and the exact
  40-class instrument metadata has no resolving license field. Treat the model
  as not cleared for Railway/container use; see
  `docs/audits/2026-08-09-essentia-license-gate.md`.
- [ ] Compare Essentia/MTG-Jamendo on the same manifest only after written MTG
  clarification and institutional review cover the exact weight file,
  noncommercial classroom inference, container distribution, and the AGPL
  boundary if the Essentia runtime is used. Pin and hash the cleared artifact
  before an offline bake-off; never infer approval from the educational intent.
- [x] Implement and run a fixed-label YAMNet baseline offline, without a new
  service. The comparator pins Google's official unquantized TFLite version 1,
  Kaggle model/instance/version and Apache 2.0 metadata, archive/model bytes and
  SHA-256 values, TensorFlow Models revision and 521-class map, exact LiteRT/
  NumPy/SciPy lock, 16 kHz preprocessing, scoring policy, vocabulary, and
  36-label mapping. Fifteen unsupported labels stay explicit. Every corpus
  source runs by immutable image ID in a distinct networkless, read-only,
  non-root, resource-bounded container, and the report binds the image, lock,
  source, corpus, expectation, and mapping identities. The hardened v2
  evaluator additionally binds its transitive loader/decoder/windowing/contract
  sources, runner, Node version, Bun lock, and each stable hydrated input's
  SHA-256. Its native workflow watches all of those paths. The prior arm64 v1
  JSON remains an immutable comparison artifact rather than current-evaluator
  evidence. The eleven-source run
  ranked 16/40 eligible reviewed groups in the top 3, 21/40 in the top 5, and
  31/40 in the top 10, with a 3,507-basis-point mean reciprocal rank. No
  threshold was selected and no precision claim is available. See
  `docs/audits/2026-08-09-yamnet-comparator-gate.md` and the bound report under
  `docs/acceptance/2026-08-09-yamnet-comparator/`.
- [x] Extend the YAMNet comparison with authorized, exact-hash isolated-
  instrument controls and exhaustive **candidate** negatives. ChoraleBricks v1
  supplies flute, oboe, clarinet, trumpet, horn, trombone, saxophone, and tuba
  under CC BY 4.0. A bounded hydrator accepts one exact same-origin 307,
  refuses symlinks and mismatched existing files, and verifies content type,
  length, SHA-256, and offline readback. The native-arm64 report places all six
  supported exact positives in the top three (four top-one; 8,056-basis-point
  MRR), keeps oboe/tuba unsupported, records 278 candidate negatives, and
  explicitly makes no precision claim or threshold selection.
- [ ] Have an authorized teacher listen to every isolated positive and every
  candidate-negative alert before changing the manifest review state. Only
  then recalculate family precision/recall, calibration, abstention, latency,
  and memory on native amd64. The mixed-corpus brass/woodwind failures, high
  oboe-to-trumpet/brass and horn-to-trombone confusions, fifteen ontology gaps,
  missing free-reed controls, failed confusion directions, and absent native
  runner result still block classifier selection and threshold calibration.
- [ ] Add a second rights-reviewed control tranche only after the listening
  protocol is fixed. [NSynth](https://magenta.tensorflow.org/datasets/nsynth)
  is CC BY 4.0 and offers 305,979 four-second
  monophonic notes across 1,006 sampled instruments, but its eleven labels are
  broad families rather than reliable exact instrument identities. Use it for
  acoustic/electronic/synthetic and family-level diversity, keep it separate
  from performed-track results, and find separately licensed exact positives
  for free reeds, solo strings, pitched percussion, and traditional
  instruments. Never convert a filename or family label into exact ground
  truth.
- [ ] Choose exactly one replacement discovery classifier after the CLAP,
  YAMNet, and any license-cleared Essentia evidence is comparable. Give every
  prompt policy, checkpoint, label map, or preprocessing change a new
  classifier ID; never inherit `instrument-discovery-v1` thresholds. Only the
  selected candidate may proceed to a new private Railway service, and it stays
  advisory until human-reviewed shadow evidence passes.
- [x] Score multiple windows independently, then aggregate. On multi-window
  material, a sound confined to one window cannot become a track-level
  detection under the tested minimum-support rule; the documented one-window
  source exception still requires calibration. Fixed-corpus calibration
  against real CLAP output remains open.
- [x] Add a pin-checked, non-mutating licensed-corpus evaluator for the CLAP
  candidate. The manifest maps every reviewed corpus annotation to vocabulary
  IDs, preserves directional hard negatives, reports candidate group coverage,
  abstentions, family/genre summaries, latency, parent/child overlaps, and
  confusion evidence, and refuses unknown labels or pin drift. Electric guitar
  versus synthesizer and bass guitar versus double bass have bidirectional
  corpus trials; piano versus mallet percussion and saxophone versus brass are
  one-direction trials; solo strings versus section strings and pitched
  percussion versus keys remain explicit corpus gaps. The runner makes no
  precision claim and cannot change thresholds, Auto routing, or stem names.
  The first constrained native-arm64 run completed all 11 sources but returned
  no labels: 11 abstentions and 0/42 reviewed groups surfaced in 9,604 ms of
  aggregate service time. Treat that as a failed usefulness gate and keep the
  service off; inspect pre-threshold scores and prompt-policy bias before any
  threshold change. Evidence is recorded in
  `docs/audits/2026-08-09-instrument-discovery-candidate.md`.
  A separate local amd64-on-arm64 attempt remained in vocabulary embedding
  until the image's baked health policy marked it unhealthy; the runner
  rejected the run and removed its container/network. That cross-architecture
  cold-start failure is diagnostic only and supplies no native-amd64 evidence.
  The image runner uses an ephemeral token, a per-run no-masquerade bridge with
  an automatically allocated loopback port, a read-only/non-root container,
  dropped capabilities, bounded CPU/RAM/swap/PIDs, and exclusive `0600`
  evidence files.
- [x] Add a networkless, offline-image raw-score audit that keeps diagnostic
  arrays out of the service HTTP contract and deletes temporary decoded PCM on
  exit. Across the first 33 real-audio windows, every expected, hard-negative,
  and unreviewed score collapsed around `0.5`; the 42 best expected-group means
  spanned only `0.499894`–`0.500002`. This rejects the current pairwise score as
  a calibration basis and makes blind threshold lowering unsafe. Positive-only
  ranking also failed: just 13/42 reviewed groups placed an accepted label in
  the top 12, with a 25.67 mean best rank and repeated unrelated koto/sitar/
  mallet-percussion leaders. Reject this prompt/checkpoint pairing rather than
  tuning it into production.
- [x] Make every future candidate evaluator/report self-bind the executing
  Docker image ID, exact `linux/amd64` promotion platform, and dependency-lock
  identity in addition to classifier/weight/vocabulary and evaluation-source
  hashes. Both image runners resolve a mutable tag once and execute the
  immutable image ID, reject other platforms, compare the repository lock to a
  lock hash derived and baked inside that image, and pass an exact provenance
  object into version-bumped reports. Exact-schema and baked-lock mismatch
  regressions pass. YAMNet report schema v2 now also binds every transitive
  host-side evaluation source, the Node runtime, TypeScript configuration,
  dependency locks, stable SHA-256 of hydrated audio, and the exact decoded
  PCM/window sample plan; its native workflow cannot skip those paths. The
  rejected CLAP JSON and existing YAMNet v1 JSON remain historical evidence;
  this hardening applies to the required clean YAMNet/replacement reruns.
- [x] Freeze a classifier-neutral v3 candidate envelope that requires content
  hashes for preprocessing, classifier policy, threshold policy, source report,
  repository generator, and dependency lock, plus an immutable image ID and
  native non-emulated `linux/amd64` execution. Evidence files are bounded,
  repository-contained, nonsymlinked, and rehashed before metrics are computed;
  the resulting report preserves the same provenance envelope.
- [x] Implement a comparison-only YAMNet capture adapter. It consumes paired
  clean native corpus/control reports from one immutable `linux/amd64` image,
  revalidates model, preprocessing, scoring-policy, evaluator, audio/PCM,
  platform, lock, source, ordering, and result pins, and emits all 19 v3 sources
  as explicit abstentions while no reviewed threshold exists. It rejects the
  historical arm64 reports, emulation, caller-authored execution drift, report
  replacement, and symbolic-link inputs. This closes the YAMNet evidence-format
  seam only; it does not select YAMNet or create a real candidate artifact.
- [x] Add a classifier-neutral, comparison-only cohort gate before model
  selection. It binds the exact deidentified review and every v3 candidate
  artifact by SHA-256, revalidates all candidate evidence, sorts candidates by
  classifier id, and refuses classifier-id reuse after a checkpoint,
  preprocessing, classifier-policy, or threshold-policy change. Reusing a
  component version with different content also fails closed. At least two
  candidates with definite classified decisions are required for
  comparability; the existing abstention-only YAMNet adapter therefore cannot
  pass by itself. Even a comparable cohort remains explicitly unselectable
  until quality-floor, license, calibration, latency/memory, human-decision,
  and Railway-shadow evidence is separately bound.
- [ ] After exactly one discovery classifier is selected, implement or adapt its
  model-specific capture path against a fresh native `linux/amd64` report and
  its separately reviewed threshold policy. The existing YAMNet adapter may be
  reused only if YAMNet wins selection and every bound pin still matches. Its
  current abstention-only output cannot satisfy calibration or promotion.
- [ ] Calibrate per-family thresholds and an `uncertain` state. Do not force
  every track into the nearest available label. The v3 candidate contract
  retains v2's distinction among classified, abstained, and degraded source
  outcomes and reports selective coverage separately, but no threshold or
  allowed abstention ceiling has been selected.
- [x] Measure prompt-policy bias before accepting the CLAP candidate. Twenty-nine
  labels currently take the maximum of two prompt aliases while twenty-two use
  one, and CLAP-style text encoders may not treat “without” as reliable
  negation. Compare matched prompt counts and control/negation formulations on
  positive and hard-negative audio; any change requires a new classifier id.
  The networkless raw-logit audit found matching negative prompts usually
  outranked positives, while positive-only ranking still performed poorly and
  showed strong label priors. The current candidate is rejected; a redesigned
  prompt policy or replacement checkpoint must use a new ID and rerun all
  evidence rather than inheriting these thresholds.
- [x] Review the vocabulary ontology and teacher display policy for overlapping
  parent/child results (`brass` plus `trumpet`, `strings` plus `violin`, or
  `percussion` plus `drum-kit`) and for production/timbre labels such as
  `sampler` and `pad`. Do not double-count or present them as equivalent kinds
  of evidence. `instrument-review-ontology-v1` now assigns every pinned label
  to a specific instrument/voice, family/ensemble, or production-texture kind;
  the console renders those kinds separately and the feedback policy explicitly
  requires overlap-aware review rather than treating them as independent
  instrument counts.
- [x] Keep detection advisory: the authenticated instructor console displays
  “possible instruments,” confidence, state, window support, classifier and
  vocabulary provenance for one stored Auto job. Student payloads remain
  redacted, the panel has no isolation control, and its explicit guard preserves
  the concrete Demucs 2/4/6 route regardless of a long-tail detection.
- [ ] Specifically test similar-timbre confusions: electric guitar versus
  synthesizer, bass guitar versus double bass, piano versus mallet instruments,
  saxophone versus brass, solo strings versus string section, and pitched
  percussion versus keys. The candidate mapping identifies four currently
  evidence-backed directions and explicitly records corpus gaps for solo
  strings and pitched-percussion positives; do not check this off until actual
  model scores and human listening verify the positive and hard-negative claims.
- [ ] Have an authorized teacher/domain reviewer verify every candidate positive
  and hard-negative annotation before using it to calculate precision/recall.
  Corpus metadata and rationale are testable provenance, not ground truth by
  themselves. The fixed listening protocol now has a private mode-`0600`,
  no-overwrite worksheet and a strict deidentifying finalizer. This remains
  unchecked because no authorized reviewer has completed all 19 sources × 51
  labels and no public review artifact has been accepted.
- [x] Add teacher feedback controls for confirmed, absent, and missed
  instruments without treating those reports as training labels until they are
  reviewed and de-identified. The append-only schema records exact analysis,
  source, classifier, vocabulary, ontology, reviewer, revision, and genre
  provenance. Database constraints permanently mark these rows identified,
  unreviewed, and training-ineligible; a later curated artifact—not an update
  to these rows—must carry any de-identification and ground-truth approval.

**Gate:** choose a discovery classifier only after reporting per-instrument and
per-genre precision/recall, calibration, abstention rate, latency, memory, and
license status. Overall accuracy alone is insufficient.

## Phase 3 — optional long-tail instrument isolation

### 3A. AudioSep pilot

- [x] Add a separately pinned AudioSep Replicate runner and version variable.
  `REPLICATE_AUDIOSEP_VERSION` accepts only the exact reviewed provider-version
  lowercase 64-hex id. Offline `test:worker` regressions bind that pin and schema surface;
  the authenticated `npm run check:isolation` verifies the exact remote
  OpenAPI contract. Both bind `audio_file`/`text` to a one-URI output and reject
  code, version, or schema drift. The reviewed candidate is
  community-hosted `cjwbw/audiosep` version `f0700443…`, not an official
  Audio-AGI service. The provider-start adapter remains unimported by app
  routes, the feature flag remains false, and no provider call or spend path
  exists. The additive resource has teacher-only readback plus a separately
  gated shadow-create route that records demand and exact identity without
  starting a prediction.
  The offline pin/schema regressions pass; authenticated remote-schema readback
  remains a pre-release gate because no local Replicate token was read.
- [ ] Bind the pinned community image to an exact AudioSep checkpoint hash and
  applicable weight license. Replicate attributes the reviewed build to fork
  commit `e3bd8d46…`, but that tree predates the Cog wrapper and contains no
  checkpoint. The later wrapper at `5fa53949…` loads an untracked
  `audiosep_base_4M_steps.ckpt`; neither official MIT source nor a separate
  mirror's Apache-2.0 metadata proves which bytes the hosted image executes.
- [x] Create a separate `instrument_isolations` job/resource. Its additive
  fresh schema, numbered D1 migration, and idempotent Railway boot migration
  never append query output to core `stems` or claim reconstruction.
- [x] Require an explicit normalized target entered by an authorized teacher.
  The shadow route takes only bounded `{target}` JSON, canonicalizes it on the
  server, binds `requested_by` to the authenticated session, rejects the shared
  class code, and never accepts a teacher identity from the client.
- [x] Preserve the completed core split when an isolation is slow, timed out,
  rejected, or fails. Resource lifecycle tests read back unchanged core status,
  model, and stems after failure.
- [x] Bind within-job cache identity to a server-verified source hash,
  normalized target, provider, exact model version, adapter contract, and
  analysis-vocabulary version. The analyzer streams the exact stored bytes
  through one bounded SHA-256 path; YouTube and Archive imports also hash their
  server-fetched bytes before storage. The private digest persists on `jobs`
  but is absent from student and teacher response bodies. Duplicate shadow
  requests are idempotent.
  The digest is write-once after its first verification, and the resource's
  conditional insert atomically requires exact equality with both the job's
  stored source type and digest. Missing, legacy-null, changed, or caller-
  supplied mismatched identities fail before a row can be created or returned
  idempotently. The first-hash compare-and-set also binds the completed state,
  source key, and source type that were fingerprinted. Once the digest exists,
  database triggers freeze that key/type, and duplicate readback rechecks every
  stored cache-material/provider field rather than trusting the cache-key string
  alone.
- [x] Before enabling any provider-start path, fingerprint the source again
  immediately before spend and compare it to the write-once job digest. The
  guard now copies those exact verified bytes to a deterministic, app-owned
  `isolation-inputs/v1/<isolation>/<sha256>` snapshot before minting a fresh
  15-minute provider URL. Browser upload routes cannot address that prefix, so
  an earlier replacement fails the digest comparison and a later replacement
  cannot change what the provider consumes. The provider contract rejects any
  URL whose snapshot suffix does not bind the same isolation id and digest.
  The read is byte- and time-bounded against stored object metadata before the
  app buffers or hashes it. Railway filesystem-adapter regressions cover a
  different-digest overwrite, post-check overwrite, metadata/body length drift,
  retention expiry, deletion, signed-URL expiry, same-digest retry, and narrowly
  scoped cleanup. This closes the source-byte barrier only; it does not enable
  a provider route, approve the unverified checkpoint, or close semester-budget
  and live output-retention gates.
- [ ] Before enabling provider execution, benchmark and cap snapshot preparation
  against the canonical Railway service's actual memory, CPU, and disk limits.
  The reader now fails closed at the stored size, 100 MB global ceiling, and
  60-second deadline, but SHA-256 plus snapshot upload still buffers the verified
  source in application memory. Define a streaming or service-offloaded path
  before the eventual Cloudflare migration if that full-source allocation does
  not fit its then-current runtime budget; do not let this dormant seam become a
  hidden Railway-only assumption.
- [x] Hydrate terminal query-isolation output into an app-owned, independently
  retained artifact before any teacher-beta route exists. Commit `885f4ab`
  adds strict Replicate-delivery URL handling, one shared 60-second/three-
  attempt download boundary, a 100 MiB ceiling, complete PCM/float RIFF/WAVE
  validation, SHA-256 identity, deterministic target/residual namespaces, and
  immutable 30-day metadata. A five-minute external-id-bound lease serializes
  webhook and poll observers; expired leases can be reclaimed at most three
  times. Output metadata insertion, isolation completion, and lease deletion
  share one transaction, while database failure removes the new object and
  releases the lease. Terminal replay retries narrow source-snapshot cleanup;
  malformed output fails locally; transient output failure does not reserve a
  second provider start; core 2/4/6 stems remain unchanged. Fresh schema,
  Railway boot migration, and numbered migration `0016` carry identical SQL.
  The literal complete Phase 0 gate passes at the exact commit with 235 worker,
  24 analyzer, 42 Railway host/config/migration/terminal, 5 separator, 30
  discovery, 9 YAMNet, and 19/6/1 browser tests. This remains dormant:
  `src/index.ts` imports no terminal-ingestion module, no provider-start or
  webhook route exists, and no live migration or object-retention readback has
  occurred.
- [x] Re-run the frozen combined Phase 0 gate against one stable executable
  manifest after the prompt-policy/cache, prompt-history trigger, pre-spend
  snapshot, and server-import identity changes. One green run is rejected as
  acceptance because concurrent edits changed its manifest from `15344330…` to
  `664b1093…`. After reconciliation, the accepted before/after SHA-256 matched
  at `345a2122…`; exact Bun 1.3.14 checked 104 installs across 160 packages with
  no changes, then passed all three typechecks, 160 worker, 22 analyzer, 24
  Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, 19 flags-off
  browser, 5 authoritative-Auto browser, and 1 isolation-shadow E2E test. The
  first targeted isolation runs failed on a strip-only-incompatible parameter
  property and runtime extensionless import; those failures were fixed and are
  not counted as acceptance. At that checkpoint the accepted manifest was still
  uncommitted, absent from GitHub, and absent from Railway; the later exact
  `fe0a5ff` gate below supersedes that local evidence.
- [x] Re-run the same literal gate after the immutable upload handoff and
  prompt-history pagination landed. The first upload-snapshot authoritative
  browser attempt failed 3/5 because the object-store runtime requires a
  known-length stream; the fixed shared storage path supplies that length while
  Railway continues streaming into unique temporary files. Two otherwise-green
  combined runs are explicitly rejected because source changed while they ran
  (`9b4c229c…` to `3cd801f6…`, then `ba35a080…` to `1a398b27…`). After
  reconciling the legacy explicit-model plus `routingRequest: auto` path and
  teacher-isolation compatibility, exact Bun 1.3.14 checked 104 installs across
  160 packages with no changes. The accepted before/after executable SHA-256
  matched at `1a398b27…`, and all three typechecks, 168 worker, 22 analyzer, 26
  Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, 19 flags-off
  browser, 6 authoritative-Auto browser, and 1 isolation-shadow E2E test passed.
  `git diff --check` passes. This is stable dirty-tree evidence rooted at
  `e9f7ed9`, not a committed combined-source artifact, GitHub run, applied
  migration, or Railway acceptance.
- [x] Validate prompt version `2026-08-10.2`, untrusted-data
  escaping, exact winning-revision response binding, parsed session expiry,
  history insert validation, confirmed-logout DOM scrubbing, the corpus-pin
  commit `0fbc62a`, and CI isolation commit `e67dd3b`. An initial focused
  interleaving assertion failed because a SQLite null-prototype row was compared
  directly with a plain object; the assertion was corrected and that failed run
  is not acceptance. Both TypeScript checks, 4 direct prompt-policy tests, 28
  Railway server/migration tests, and the targeted real-browser instructor
  journey pass. Live browser readback also proves the sentence-case tagline and
  44-pixel sign-in target. At that checkpoint the focused evidence remained
  uncommitted; it is now included in exact commit `fe0a5ff` and the complete
  clean gate below. It still cannot close native CI, applied-migration,
  real-teacher restart, listening, or resource gates.
- [x] Obtain one complete source-stable Phase 0 run after concurrent bakeoff
  edits stop. The earlier selected-path and moving-tree runs remain rejected.
  After binding the teacher-governance implementation to exact commit
  `fe0a5ff`, a clean detached checkout installed the frozen Bun 1.3.14 graph
  and passed all three typechecks; 181 worker, 22 analyzer, 28 Railway, 5
  separator, 30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6
  authoritative-Auto, and 1 isolation-shadow browser journey. The detached
  worktree remained clean and `git diff --check` passed. This proves current
  committed local source only; GitHub native-amd64, applied Railway migrations,
  service provisioning, real-teacher restart, and live audio acceptance remain.
- [x] Bind the dormant pre-spend source guard to exact commit `15e782a` after
  correcting its strip-only syntax/import defects. Its focused source/AudioSep
  suite passes 11/11, and the source-stable `fe0a5ff` gate above includes both
  the exact committed guard and the committed prompt follow-up. The branch
  remains absent from `origin`, `gh pr list --head codex/v3.2-audio-pipeline
  --state all` returns no pull request, and no Railway release contains it.
- [x] Re-run the complete local Phase 0 gate after write-once source identity,
  atomic idempotent-read validation, and trigger-aware E2E schema integration.
  On 2026-08-10 exact executable-source commit `4cf452e` passed a frozen Bun
  1.3.14 install, all three typechecks, 152 worker, 22 analyzer, 22
  Railway host/migration, 5 separator, 30 discovery, 9 YAMNet, 19 flags-off
  browser, 4 authoritative-Auto browser, and 1 isolation-shadow E2E test.
  The commit whitespace check also passes. This is local committed-source
  evidence, not a native GitHub run, migration application, or Railway
  acceptance.
- [x] Reconcile release state after `4cf452e`. The branch is still absent from
  `origin` and has no pull request. The canonical Railway service's newest
  deployment remains `SUCCESS` deployment `7f4bc330…` from 2026-08-08, so it
  cannot contain the 2026-08-10 hardening. Value-free live readback still shows
  healthy prompt storage, the footer instructor link, and a 200 teacher page;
  no variable, service, migration, or deployment was changed during this audit.
- [x] Bind the verified fingerprint/shadow implementation to exact commit
  `10f6b0a`. Exact Bun 1.3.14 passes the literal `test:phase0` command with 152
  worker, 22 analyzer, 21 Railway host/migration, 5 separator, 30 discovery, 9
  YAMNet, 19 flags-off browser, 4 authoritative-Auto browser, and 1
  isolation-shadow E2E test. No remote branch, PR, migration, Railway variable,
  service, or deployment contains that commit.
- [ ] Define cross-job output reuse only after the new hydration identity has
  live retention/deletion evidence and can prove that a cached artifact is
  still authorized and available. Matching source hashes alone do not
  authorize reuse, and an immutable metadata row does not prove its 30-day
  object is still present.
- [ ] Enforce per-track concurrency, semester budget, timeout, retry, and
  maximum-isolation limits before enabling the paid endpoint. The dormant
  resource now atomically enforces one processing request, two attempts,
  15-minute deadlines, and two requests per track. Shadow rows carry a distinct
  rollout stage that the claim transition cannot select. Commit `d207d4b` adds
  a versioned course-semester provider-start ceiling and reserves it in the same
  transaction as each claim. Reservations are immutable, shared across
  teachers in the configured course, survive ordinary job deletion, charge
  every retry, reject concurrent overspend, and freeze the policy once spend
  begins. This combined item remains open because the canonical course,
  semester, and ceiling are not configured or accepted on Railway and no paid
  endpoint exists to exercise the complete provider lifecycle. Commit
  `885f4ab` separately serializes terminal output observers, caps ingestion at
  three attempts, protects active ingestion from generic timeout/failure races,
  and releases transient failures without another budget reservation; those
  local controls still lack live provider and rollback acceptance.
- [ ] Label outputs “optional instrument isolations,” with model/version and
  limitations available in the UI. The teacher-only API summary now supplies
  that label, exact identity, and limitations without storage keys; no UI is
  wired while execution is blocked.

### 3B. SAM-Audio bake-off

- [x] Add SAM-Audio only to the evaluation harness at first; do not expose two
  paid implementations in the student interface. Commit `e0577d9` adds a
  versioned offline preparation/scoring harness, exact community-schema pin
  guard, shared AudioSep/SAM-Audio text and span modes, and 30 failure-closed
  contract tests. Evidence commit `725316a` records the boundary. There is no
  application adapter, route, credential, feature flag, provider prediction,
  or student choice.
- [ ] Complete institutional review of the SAM license, gated checkpoint terms,
  and the operational risk of any community-hosted Replicate deployment.
  The 2026-08-10 source review confirms a custom modifiable SAM License, gated
  Hugging Face checkpoints, target-plus-residual semantics, and only a
  community Replicate candidate; it does not substitute for institutional
  approval.
- [ ] Compare target isolation, leakage, residual usefulness, span prompting,
  latency, failure rate, and cost against AudioSep on the exact same manifest.
- [ ] Select one default query provider through a documented decision. Keep the
  other disabled but retain its fixtures and adapter tests if it is a useful
  fallback.

**Gate:** a query provider may reach teacher-only beta after it beats the
accepted quality floor, stays within the cost ceiling, and passes a pinned live
canary. Student access remains off.

## Phase 4 — iterative optimization beyond rock-band mixes

- [x] Freeze the first genre-diverse evaluation and review contract before
  adding more datasets or candidates. `tests/corpus/instrument-evaluation-plan.json`
  binds 11 authorized real mixes and eight isolated controls to their exact
  manifests and SHA-256 identities, requires seven real-mix genres, all 10
  vocabulary families, and all three ontology kinds, and keeps real-mix versus
  isolated-control reporting separate. The validator refuses source, ontology,
  policy, vocabulary, and ordering drift. The v3 candidate boundary also binds
  policy content, source-report, generator, dependency-lock, immutable-image,
  and native-platform provenance. A YAMNet-specific comparison adapter now
  validates that chain but deliberately emits only abstentions; a selected-
  classifier adapter, fresh native reports, and a real reviewed candidate
  artifact remain open. A comparison-only cohort gate now prevents candidate
  or component-version reuse after content drift and prevents an
  abstention-only artifact from masquerading as comparable evidence. The
  evaluator exposes selective
  coverage, model abstention, false alerts, degraded sources, and coverage gaps
  without turning an outage into classifier error. It forbids promotion from
  an overlapping all-label aggregate. This establishes the evidence shape but
  does not supply human ground truth, candidate scores, Slakh/MedleyDB data, a
  quality floor, or a promotion decision.
- [ ] Establish an evaluation loop using authorized classroom tracks plus
  instrument-rich subsets of Slakh2100 and MedleyDB. Keep synthetic and real
  results separate in reports. The current 11-real/8-isolated contract is the
  authorized foundation; rights-reviewed, exact-hash Slakh2100 and MedleyDB
  subsets remain to be selected and added as distinct partitions.
- [ ] Measure detection precision/recall, abstention, SI-SDR/SDR improvement,
  target leakage, residual/reconstruction error where applicable, latency,
  provider errors, cache hit rate, cost, and blinded teacher listening ratings.
- [ ] Review results by genre and instrument family so abundant drums, bass,
  guitar, and vocals cannot hide failures on reeds, bowed strings, brass,
  keyboards, electronic textures, or traditional instruments. The v1
  instrument evaluator now enforces the detection-side breakdown, but it has no
  accepted human review or candidate artifact yet and does not cover separator,
  provider, cost, or blinded-listening metrics.
- [x] Enforce one-dimension candidates—role classifier, instrument classifier,
  vocabulary, thresholds, windowing, prompt policy, separator version, schema,
  or default routing—and record exact base/candidate commits and compiled pins.
  `tests/corpus/audio-pipeline-promotion.json` and its strict validator reject
  multiple declared axes, non-additive schema work, floating artifacts, pin or
  core-contract drift, and default-routing changes before the final stage.
- [ ] Promote changes through `off` → `shadow` → `teacher beta` → bounded
  student canary → default. Every step needs a rollback flag that does not
  require a schema rollback. The versioned promotion gate now encodes this
  ladder, refuses stage skips and paper acceptance, computes the next-stage
  blockers, and runs explicitly in CI. Schema v2 separately guards analyzer
  provisioning so post-provision checks do not form a circular precondition.
  It correctly leaves role v4 at `off`; no rollout stage has been promoted.
- [ ] Automatically request at most one or two high-confidence additional
  isolations only after manual-query evidence supports it. Until then,
  discovery may suggest but must not spend.
- [ ] Re-run the frozen rock-band regression set on every optimization. Broader
  coverage is not acceptable if it silently worsens the current dependable
  paths.
- [x] Maintain a model-processing changelog containing classifier vocabulary,
  thresholds, checkpoint/version pins, evaluation summary, rollout stage, and
  known regressions for every promoted change. The log now also binds the
  executable promotion schema, current exact-commit evidence, and unresolved
  release blockers; a changelog entry never authorizes promotion by itself.

## Phase 5 — coherent long-tail multi-stem research, only if needed

- [ ] Evaluate Banquet/Query-Bandit after the optional-isolation beta. Decide
  first whether users actually need simultaneous, reconstructable long-tail
  stems rather than occasional target extraction.
- [ ] If justified, package it as a private Replicate Cog or a separate
  scale-to-zero GPU service. Do not place it in the Railway app service or the
  CPU analysis service.
- [ ] Define overlap, ordering, residual, and reconstruction semantics before
  allowing recursive separation. Target-plus-residual recursion is
  order-dependent and must not be presented as objective ground truth.
- [ ] Run the same pinning, schema-contract, cost, failure-isolation, canary,
  licensing, and rollback gates used for AudioSep/SAM-Audio.

## Breaking-change shields required throughout

- [x] Reject floating provider versions. Existing provider guards and the
  promotion validator require exact compiled pins and explicitly reject
  `latest`, branch names, moving heads, and nightlies.
- [x] Keep classifier labels advisory. Only a concrete advertised separation
  model may create tracks, and the promotion manifest is compared directly
  with the executable 2/4/6 catalogue.
- [x] Freeze stored core stem meanings in place. Contract regressions and the
  promotion validator require a separately versioned contract or isolation
  resource for any new output vocabulary.
- [x] Keep optional service credentials fail-lazy. Railway host configuration
  reports absent, incomplete, invalid, or configured optional services without
  making their credentials boot-critical while their features are off.
- [x] Keep provider calls behind shared interfaces. Railway filesystem and
  process construction stay in the host adapter; shared application contracts
  do not import Railway-specific implementations.
- [x] Reject multi-axis releases. The promotion schema permits exactly one
  declared axis and independently forbids destructive schema rollback and
  early default-routing changes; the exact commit diff remains a required
  review surface.
- [ ] Never consider a Railway build or `SUCCESS` status sufficient evidence.
  Verify health, analysis readiness, one full authorized source journey, output
  media bytes, stored decision metadata, persistence, and rollback behavior.
  The promotion gate now names and blocks on this evidence, but the current
  manifest correctly records it as missing rather than treating booleans as
  live proof.
- [ ] Never migrate or deploy this unfinished pipeline to Cloudflare Workers.

## Research references

- [2026-08-10 provider/source review](docs/evaluation/2026-08-10-query-isolation-provider-review.md)
  — exact reviewed revisions, contracts, licensing boundaries, and dispositions.

- [AudioSep](https://github.com/Audio-AGI/AudioSep) — open-domain,
  text-queried target separation; first Replicate integration candidate.
- [SAM-Audio](https://github.com/facebookresearch/sam-audio) — text/span target
  plus residual; evaluation candidate subject to license and hosting review.
- [Banquet / Query-Bandit](https://github.com/kwatcharasupat/query-bandit) —
  query-based separation beyond fixed four/six-stem taxonomies.
- [LAION CLAP](https://github.com/LAION-AI/CLAP) — flexible audio-text
  classification candidate; not itself a separator.
- [Essentia models](https://essentia.upf.edu/models.html) — useful fixed
  instrument taxonomy with a model-license review requirement.
- [Slakh2100](https://www.slakh.com/) and
  [MedleyDB](https://medleydb.weebly.com/) — complementary synthetic and real
  multitrack evaluation sources.
