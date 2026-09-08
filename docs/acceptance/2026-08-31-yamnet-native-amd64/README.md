# YAMNet native-amd64 comparison acceptance

This directory records the refreshed native Linux amd64 execution of the
current YAMNet comparison pipeline. GitHub Actions run `34182311183` checked
out exact commit `a64d5dfb98e9f6b1031ac95f631498b7b139d0d6`, built and constrained
one immutable image, hydrated the exact licensed eleven-mix and eight-control
corpora, and uploaded four JSON reports without audio.

`evidence.json` preserves the run, artifact, file, image, model, corpus, control,
and candidate-envelope identities. The downloadable artifact expires after 30
days, so every contained filename, byte count, schema, and SHA-256 is recorded
here. The source reports remain private, gitignored working evidence under
`output/`; licensed audio is never committed.

This is a reproducibility acceptance, not a classifier acceptance. The run
produced 19 explicit abstentions and zero detections because no label threshold
has cleared teacher review. It selected no threshold, made no precision claim,
did not create a Railway service, did not change a feature flag, and cannot
authorize instrument-discovery promotion.

Zach's separate 5:28 PM teacher attestation accepts the complete authorized
source and its four frozen core stems for the v3.2 Auto pre-provision gate. It
does not approve the 19-source instrument annotations, the 278 candidate
negative control labels, or a discovery threshold. Those gates remain open.

This import is `pending-source-gate`, not accepted comparison evidence. Both
comparators succeeded on branch `codex/stem-splitter-fleet-integration-20260908`,
but source CI run `34182311139` at the recorded `sourceGateCommit` failed on
pre-import comparator workflow evidence drift. The temporary explicit validation
option checks pending record integrity only; default acceptance rejects it.
After this import passes source CI, record that actual successful run and commit,
change status to `passed-comparison-only`, and remove the temporary pending path.
The comparator source commit and source-gate commit are recorded separately.
