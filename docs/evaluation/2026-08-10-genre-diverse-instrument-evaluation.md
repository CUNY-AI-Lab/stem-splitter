# Genre-diverse instrument evaluation contract — 2026-08-10

This slice defines how a future instrument classifier must be reviewed and
compared. It does not select a classifier, calibrate a threshold, provision a
service, change Auto routing, request an isolation, call a provider, or promote
any Railway flag.

## What is frozen

`tests/corpus/instrument-evaluation-plan.json` binds the evaluation to exact
content hashes for:

- 11 authorized real mixes from the existing classroom corpus;
- eight isolated ChoraleBricks wind controls;
- the 51-label `classroom-instruments-v1` vocabulary;
- `instrument-review-ontology-v1`; and
- the existing discovery expectations used to identify the real-mix sources.

The real-mix partition contains rock, jazz, orchestral/chamber, electronic,
hip-hop, folk/traditional, and sparse-acoustic material. The coverage policy
requires reviewed positive evidence across voice, bowed strings, plucked
strings, brass, woodwind, keys, electronic, percussion, free reed, and
traditional families. Those family requirements are gates, not current claims:
only an exhaustive listening review can establish which labels are audible.

The current plan contains no synthetic partition. Slakh2100 and MedleyDB remain
future, separately rights-reviewed additions. When they are added, their
results must remain separate from real recordings and isolated controls.

## Staged NSynth family controls

`tests/corpus/nsynth-family-control-manifest.json` stages a second control
tranche without changing the frozen 19-source plan. The official
[NSynth dataset](https://magenta.tensorflow.org/datasets/nsynth) is CC BY 4.0;
the manifest binds its test archive to one exact Google Cloud object, byte
count, storage generation, ETag, modification time, SHA-256, complete tar
surface, and `examples.json` hash. It then pins one four-second, mono, 16 kHz
PCM WAV from each family actually present in that split:

- bass, brass, flute, guitar, keyboard, mallet, organ, reed, string, and vocal;
- four acoustic, three electronic, and three synthetic sources; and
- no `synth_lead`, because the test archive contains no member in that family.

Hydrate the exact archive without committing its audio:

```bash
bun run hydrate:nsynth-controls
bun run hydrate:nsynth-controls --verify-only
```

For an already downloaded exact archive, use `--archive /absolute/path` once;
`--archive` and `--verify-only` are mutually exclusive. The downloader refuses
redirects, encoded responses, header or object-identity drift, excess bytes,
and hash drift. Its bounded streaming gzip/ustar reader accepts only the pinned
directory, metadata, and WAV surface, captures only the 10 selected WAVs plus
`examples.json`, validates each selected metadata record and RIFF contract, and
writes no-overwrite mode-`0600` files under the gitignored
`tests/corpus/audio/nsynth-family-controls-v1/` directory.

Prepare the separate human-review worksheet only after offline verification
passes:

```bash
bun run prepare:nsynth-review \
  --output output/nsynth-family-review.private.json
```

The command re-reads every selected WAV as an owner-only regular file and
checks its exact byte count and SHA-256 before creating the worksheet. The
private mode-`0600` file includes the repository-relative listening path for
each control and all 51 verdicts in pinned vocabulary order. An authorized
teacher or domain reviewer must listen to every complete four-second WAV, set
`wholeSourceListened` to `true`, classify every label as `audible`, `absent`, or
`uncertain`, add a canonical UTC timestamp and reviewer name, and copy the
fixed full-listening attestation. Do not prefill verdicts from NSynth metadata.

After that human work is complete, create a separate deidentified artifact:

```bash
bun run finalize:nsynth-review \
  --input output/nsynth-family-review.private.json \
  --output output/nsynth-family-review.public.json
```

Finalization refuses non-owner input, symbolic links, files above 512 KiB,
overwrite, changed manifest/audio identity, incomplete listening, unreviewed or
reordered verdicts, claim-boundary changes, and mismatched serialized bytes. It
binds the exact private worksheet by SHA-256 while removing the reviewer and
local audio paths. The public review remains
`reviewed-deidentified-family-control-evidence`, not evaluation ground truth:
it records `not-integrated`, forbids candidate-metric and promotion use, and
names the missing expanded-plan, candidate, quality-floor, human-selection, and
Railway-shadow evidence. Normal human approval is still required before that
public artifact becomes canonical.

This tranche deliberately asserts dataset-authored family and source labels
only. It does not infer an exact sampled instrument from `instrument_str`, map
a family to a classroom-vocabulary positive, treat omitted labels as negatives,
join the mixed/performed control partition, or count toward promotion. Before
integration, an authorized teacher must listen to every clip and classify all
51 vocabulary labels using the same exhaustive protocol. That accepted review
must create a new evaluation-plan version that preserves an isolated
family/source partition. Separately licensed exact positives remain necessary
for free reeds, solo strings, pitched percussion, and traditional instruments.

The owner-only review workspace now exists locally, but no instrument verdict
or public review artifact has been accepted. The current private worksheet is
still at 0 of 19 completed recordings. The separate v3.2 source-and-stem
listening acceptance does not populate or approve this instrument-label review.

## Human-review boundary

Prepare an owner-only worksheet under the gitignored `output/` directory:

```bash
bun run prepare:instrument-review --output output/instrument-review.private.json
```

Review that worksheet in the localhost-only listening workspace:

```bash
node --experimental-strip-types scripts/serve-instrument-evaluation-review.mts \
  --input output/instrument-review.private.json
```

The workspace binds to `127.0.0.1`, checks every hydrated recording against
the frozen plan before serving it, autosaves partial progress to the same
owner-only worksheet, and supports reload/resume. It does not add a public
route, prefill a verdict, infer a label from metadata, or finalize evidence.
The reviewer still must make every listening judgment and complete the fixed
attestation below.

For every source, the authorized teacher or domain reviewer must:

1. listen to the complete recording;
2. set `wholeSourceListened` to `true`;
3. classify every one of the 51 labels as `audible`, `absent`, or `uncertain`;
4. enter a canonical UTC review timestamp and a bounded reviewer name; and
5. copy the fixed attestation exactly.

The private worksheet contains the reviewer identity and must not be committed.
It is created with mode `0600`, and the finalizer refuses a symbolic link, a
non-owner-only input, a file larger than 2 MiB, an incomplete/reordered review,
noncanonical time, changed plan identity, an existing output, or mismatched
serialized bytes.

Finalize to a separate deidentified artifact:

```bash
bun run finalize:instrument-review \
  --input output/instrument-review.private.json \
  --output output/instrument-review.public.json
```

The public artifact removes the reviewer field, declares that no raw teacher
feedback is present, retains the exact source and label order, and records the
SHA-256 of the precise private worksheet bytes. That hash provides an audit
link without publishing the identified source document. The public artifact
still requires normal human approval before it becomes canonical evidence.

## Candidate boundary

A v3 candidate-observation artifact must cover the same 19 sources in the same
order and pin:

- classifier version and model SHA-256;
- vocabulary version and SHA-256;
- preprocessing version and SHA-256;
- classifier-policy version and SHA-256; and
- threshold-policy version and SHA-256.

It must also carry one exact execution-evidence envelope: a repository-relative
source-report path, schema, and SHA-256; the path and SHA-256 of the repository
generator under `scripts/`; a recognized dependency-lock path and SHA-256; and
an immutable image digest. The image and host must both declare
`linux/amd64`, with emulation false. Every referenced file must be nonempty,
regular, no larger than 16 MiB, contained inside the repository without any
symbolic-link path component, and byte-for-byte equal to its declared digest.
The metrics artifact carries this validated envelope forward.

This envelope validates a supplied provenance chain; it does not independently
prove that a classifier ran. A model-specific capture adapter must bind the
selected model's native report fields to the v3 observations.

The first such adapter is intentionally limited to the comparison-only YAMNet
candidate. From the repository root, after placing fresh reports under the
gitignored `output/` directory, run:

```bash
bun run prepare:yamnet-candidate \
  --corpus-report output/yamnet-native-amd64-corpus-v2.json \
  --control-report output/yamnet-native-amd64-controls-v1.json \
  --output output/yamnet-candidate-source.json

bun run capture:yamnet-candidate \
  --source-report output/yamnet-candidate-source.json \
  --output output/yamnet-instrument-candidate.json
```

Both commands refuse overwrite and create mode-`0600` output. The first command
validates and binds the two raw reports by exact bytes. The second re-reads those
bytes and verifies the current model, mapping, vocabulary, score policy,
evaluator sources, hydrated-source identities, decoded PCM/window plans,
dependency lock, immutable image ID, and one shared native non-emulated
`linux/amd64` execution. Raw reports, source descriptor, and candidate output
remain gitignored review artifacts. Exact GitHub run `33450445790` produced all
four for source `76ea7c0`; the repository preserves their hashes, schemas,
metrics, execution identity, and disposition under
`docs/acceptance/2026-08-31-yamnet-native-amd64/` without committing audio.

No label-cleared YAMNet threshold exists. The adapter therefore emits every one
of the 19 sources as `abstained` with reason
`no-label-cleared-threshold` and no detections. That output can exercise the v3
evidence and selective-metric boundary, but it cannot establish absence,
calibrate a threshold, select YAMNet, or authorize promotion. A different
selected classifier still needs its own adapter; this adapter may be reused only
if YAMNet is selected and its exact pins and reviewed policy remain current.

Each source must declare exactly one outcome and a compatible bounded reason:

- `classified` with `threshold-policy-applied`: detections may be `possible` or
  label-level `uncertain`; every omitted label is a definite negative decision;
- `abstained` with `no-label-cleared-threshold` or
  `insufficient-confidence-margin`: no detections are allowed; or
- `degraded` with `service-timeout`, `service-unavailable`, `invalid-response`,
  or `unsupported-source`: no detections are allowed.

This distinction is mandatory. An empty classified result says that the pinned
threshold policy classified every vocabulary label as absent. An empty
abstained result makes no such claim, and a degraded result records service
reliability rather than classifier error. The validator rejects the ambiguous
v1 schema. Floating labels, duplicate detections, incompatible outcome/reason
pairs, confidence outside `0..1`, a changed source hash, or any reordered source
also fails validation.

## Candidate cohort comparison

After an approved deidentified review and at least one v3 candidate artifact
exist, the comparison-only CLI can bind their exact bytes into one report:

```bash
bun run compare:instrument-candidates \
  --review output/instrument-review.public.json \
  --candidate output/candidate-a.json \
  --candidate output/candidate-b.json \
  --output output/instrument-candidate-comparison.json
```

The output is created once with owner-only permissions. The comparison binds
the exact review and candidate artifact SHA-256 values, revalidates every v3
candidate and its transitive evidence, calculates the existing separated
metrics, and sorts candidates by classifier version. One candidate is accepted
as diagnostic input, but at least two candidates with definite classified
decisions are required before `comparable` can become true. This means the
current abstention-only YAMNet adapter remains visible without being presented
as comparable calibration evidence.

Within a submitted cohort, one classifier version may name only one exact
combination of model, vocabulary, preprocessing, classifier policy, and
threshold policy. The gate rejects reuse of that classifier version after any
of those identities changes. It also rejects a preprocessing,
classifier-policy, or threshold-policy version reused with different content.
A changed model or policy must therefore receive a new classifier id instead
of silently inheriting an earlier candidate's history.

This report cannot select a classifier. Even when `comparable` is true, its
selection field remains false and names the still-unbound quality floor,
license, calibration, latency/memory, human selection, and Railway shadow
evidence. It cannot change the discovery flag, provision a service, route Auto,
rename a core stem, or authorize an isolation. Use `--require-comparable` only
when a later evidence workflow must fail on an incomplete cohort; without
artifacts, the command prints the current blockers without claiming results.

Evaluate only after both an approved public review and a pin-complete candidate
artifact exist:

```bash
bun run check:instrument-evaluation \
  --review /approved/instrument-review.public.json \
  --candidate /approved/instrument-candidate.json
```

Without both paths, `bun run check:instrument-evaluation` prints the current
plan and its blockers without inventing results.

## Metric semantics

The v3 report retains the v2 selective-outcome semantics and calculates
true/false positives and negatives, precision, recall,
selective coverage, candidate abstention, and service-failure rates in basis
points. Precision and recall use only definite classified decisions. A
source-level abstention or label-level uncertainty contributes to abstention;
degraded inference contributes to service failure; neither is converted into a
false negative or true negative. It reports these measures separately by:

- ontology kind;
- real-mix genre, using specific-instrument/voice labels only;
- instrument family, using specific-instrument/voice labels only;
- individual vocabulary label; and
- corpus kind.

The all-label total is diagnostic only. Labels such as `brass` and `trumpet`,
or `percussion` and `drum-kit`, overlap; combining parents, children, ensembles,
and production textures into one headline score would double-count evidence and
let abundant rock-band labels hide long-tail failures.

Coverage fails closed when a required genre lacks a reviewed specific positive,
a required family lacks an audible specific label, a review contains
uncertainty, or candidate inference degraded on any source. Even when coverage
is complete, `promotionEligible` remains false until a reviewed quality floor,
a human candidate-selection decision, and Railway shadow evidence exist.

## Current result

At implementation commit `65278281ecc8420aaf2ab73b4c3dbd9141696ddc`, the
plan contains 11 real mixes and eight isolated controls and reports these five
blockers:

1. exhaustive deidentified review missing;
2. candidate observations missing;
3. candidate quality floor not selected;
4. candidate selection decision missing; and
5. Railway shadow evidence missing.

The exact commit passes the complete Bun 1.3.14 Phase 0 command: 220 worker, 24
analyzer, 31 Railway host/migration, 5 separator, 30 discovery, and 9 YAMNet
tests, plus 19 flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser
journey. This verifies the evidence machinery, not musical accuracy.

Commit `558708fdb3962326306da40cdb76389e4598730a` corrects the
pre-artifact ambiguity by advancing the evaluation plan, candidate observations,
and metrics to v2. The exact commit passes the same full gate with 221 worker
tests; its 11 focused evaluation/review tests prove that classified-negative,
model abstention, label uncertainty, and service degradation remain disjoint.
No accepted review or candidate artifact was invalidated because none exists.

Commit `41e66e9027101b9339ab7d3366030b22515019b4` advances the plan,
candidate observations, and metrics to v3. It binds policy content and exact
execution-evidence files, rejects report/generator/lock drift, floating images,
wrong platforms, emulation, symbolic links, and oversized evidence, and carries
the validated provenance into the metrics report. The exact commit passes four
TypeScript checks; 223 worker, 24 analyzer, 31 Railway host/migration, 5
separator, 30 discovery, and 9 YAMNet tests; plus 19 flags-off, 6
authoritative-Auto, and 1 isolation-shadow browser journey under Bun 1.3.14.
The nine focused candidate/evaluation tests pass. This verifies the envelope,
not musical accuracy or the truth of a future model-specific runtime report;
the capture adapter and candidate artifact remain missing.

Commit `5f9a8ad1bb554b085c64bef8ddd1b2f7eaec4ff4` adds the bounded
YAMNet-specific adapter and its two no-overwrite commands. It rejects historical
arm64 reports, wrong or mismatched images, emulation, dependency/evaluator/
mapping/source/score/PCM/order drift, report replacement, symbolic links, and a
repository-root mismatch. Its only threshold policy is content-addressed
review-pending abstention, so it produces no detection or promotion claim. The
exact commit passes four TypeScript checks; 227 worker, 24 analyzer, 31 Railway
host/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus 19 flags-off,
6 authoritative-Auto, and 1 isolation-shadow browser journey under Bun 1.3.14.
The four focused adapter tests and 12 combined adapter/comparator tests pass.
Later GitHub run `33450445790` completed the fresh native Linux amd64 corpus,
control, source, and candidate reports. The candidate contains 19 abstentions
and zero detections; it is real execution evidence but remains ineligible for
comparison or promotion without reviewed labels and a selected threshold.

A value-free read-only check of the canonical Railway project/environment/app
service also passes the pre-provision topology contract with `audio-analysis`
absent, feature posture `off`, zero mutations, zero provider calls, and no
secrets printed. The separate repository action gate exits nonzero on exactly
`manual-listening-missing` and `native-amd64-image-missing`; no service should
be created until both artifacts pass review.

Railway remains the integration target while the product is unfinished.
Cloudflare Workers migration remains deferred.
