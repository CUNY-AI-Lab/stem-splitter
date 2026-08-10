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

## Human-review boundary

Prepare an owner-only worksheet under the gitignored `output/` directory:

```bash
bun run prepare:instrument-review --output output/instrument-review.private.json
```

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
prove that a classifier ran. A model-specific capture adapter must still bind
the selected model's native report fields to the v3 observations. Until that
adapter and a clean native report exist, no candidate artifact can satisfy this
contract.

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

A value-free read-only check of the canonical Railway project/environment/app
service also passes the pre-provision topology contract with `audio-analysis`
absent, feature posture `off`, zero mutations, zero provider calls, and no
secrets printed. The separate repository action gate exits nonzero on exactly
`manual-listening-missing` and `native-amd64-image-missing`; no service should
be created until both artifacts pass review.

Railway remains the integration target while the product is unfinished.
Cloudflare Workers migration remains deferred.
