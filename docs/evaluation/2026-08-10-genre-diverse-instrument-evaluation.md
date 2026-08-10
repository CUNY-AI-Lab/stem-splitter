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

A candidate-observation artifact must cover the same 19 sources in the same
order and pin:

- classifier version;
- model SHA-256;
- vocabulary version and SHA-256;
- preprocessing version; and
- threshold-policy version.

Each detection is `possible` or `uncertain`. A degraded source must report no
detections; the evaluator records every label decision for that source as a
service failure rather than silently converting the outage into an abstention
or absence claim. Floating labels, duplicate detections, confidence outside
`0..1`, a changed source hash, or any reordered source fails validation.

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

The report calculates true/false positives and negatives, precision, recall,
candidate abstention, and service-failure rates in basis points. It reports
them separately by:

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

Railway remains the integration target while the product is unfinished.
Cloudflare Workers migration remains deferred.
