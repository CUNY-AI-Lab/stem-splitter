# EfficientAT native-amd64 comparison evidence

GitHub Actions run `34182311130` passed the comparison-only EfficientAT gate
at exact source `a64d5dfb98e9f6b1031ac95f631498b7b139d0d6`. The run built and exercised
one native Linux amd64 image, hydrated the exact licensed 11-mix and
eight-control cohort, and uploaded three JSON reports without audio.

The corpus rankings are diagnostically stronger than the accepted YAMNet
baseline on top-three, top-five, and mean reciprocal rank. This is not a model
selection: the scoring policies differ, no threshold or precision claim exists,
and the comparison explicitly abstains. Instrument discovery remains disabled,
and no Railway discovery service may be created until the instrument-label and
isolated-control reviews, threshold policy, selection, and shadow gates pass.

`evidence.json` binds the source, workflow, native execution, artifact metadata,
file hashes, summaries, comparison disposition, teacher-review boundary, and
remaining blockers. The report files are retained in the expiring GitHub
artifact named there; their exact hashes remain durable in this directory.

The comparator ran on branch `codex/stem-splitter-fleet-integration-20260908`.
Its exact source CI run `34182311139` failed on pre-import comparator workflow
evidence drift. The evidence import commit `9e4b17c5fee49276569a55abdb0b8dd5d84d35d5`
subsequently passed full CI run `34182876507`, including source-gate job
`101925325268`. `sourceGateCommit` records that later integration commit
separately from the unchanged comparator source commit. This is accepted
comparison-only evidence; all teacher-review, threshold and promotion blockers
remain enforced.

The uploaded comparison report used historical YAMNet acceptance run
`33450445790`, SHA-256
`a6bbe96d629934f2d950ecde6f21ba259980fcac2c488eb6b7ecfaa495dcfbf9`.
That historical input is preserved; the report does not claim to compare against
the concurrently refreshed YAMNet evidence. Future comparisons require the
refreshed canonical baseline and its successful source gate.
