# EfficientAT native-amd64 comparison evidence

GitHub Actions run `33453966641` passed the comparison-only EfficientAT gate
at exact source `4e6c6bc61d1c3f8195a8c0f277bf0df9331a6e7d`. The run built and exercised
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
