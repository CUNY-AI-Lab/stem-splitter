# EfficientAT offline comparator

This image is a comparison evaluator, not a Railway service. It accepts at
most three bounded mono `f32le` windows on stdin, runs the exact MIT-licensed
EfficientAT `mn10_as` v0.0.1 release with networking disabled, and emits raw
fixed-label scores on stdout. It cannot alter Auto routing, rename a stem, or
start an isolation.

The build verifies the GitHub release and asset identities, the original
checkpoint digest, all 312 tensors through a weights-only load, the exact
round-trip into deterministic safetensors, the 527-row AudioSet class map, the
MIT license, the dependency lock, the classroom vocabulary, and the candidate
mapping. The original pickle checkpoint is deleted in the build stage and is
never copied into the runtime image.

The mapping includes only direct AudioSet classes. It covers 37 of 51 classroom
labels, adding `ukulele` to the 36 labels covered by the YAMNet comparator. The
remaining 14 labels stay explicit gaps. Scores are uncalibrated: each analysis
window is one EfficientAT clip, and a multi-window track uses the second-highest
window score. There is no selected threshold, so these results cannot be shown
to students or used by Auto.

Run dependency-light contract tests:

```sh
PYTHONPATH=efficientat-comparator \
  python -m unittest efficientat-comparator/test_contract.py
```

Refresh the exact dependency lock:

```sh
uv lock --project efficientat-comparator --python 3.12
```

Build the Railway-target platform and run the constrained image smoke test:

```sh
docker build --platform linux/amd64 \
  -f efficientat-comparator/Dockerfile \
  -t stem-splitter-efficientat-comparator:v3.2-candidate .
```

Native amd64 corpus evidence, comparison against YAMNet, and teacher review are
separate promotion gates. Until all three are complete, this image remains an
offline candidate and no Railway service should be provisioned for it.
