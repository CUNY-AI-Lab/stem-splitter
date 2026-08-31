# YAMNet native-amd64 comparison acceptance

This directory records the first complete native Linux amd64 execution of the
current YAMNet comparison pipeline. GitHub Actions run `33450445790` checked
out exact commit `76ea7c004d70cffa8aadcfcc177301ee74d2fe2b`, built and constrained
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
