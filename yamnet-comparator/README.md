# YAMNet offline comparator

This image is a candidate evaluator, not a Railway service. It accepts at most
three bounded mono `f32le` windows on stdin, runs the official unquantized
Google YAMNet TFLite version 1 artifact with networking disabled, and emits raw
fixed-label scores on stdout. It cannot alter Auto routing or create a stem.

The build verifies all of the following before placing an artifact in the
runtime image:

- the official Kaggle model/instance/version identifiers;
- the official `Apache 2.0` license metadata;
- the exact TensorFlow Models Apache 2.0 license text copied into the image;
- archive and TFLite byte lengths and SHA-256 digests;
- the archive's one-file surface;
- the TensorFlow Models commit and 521-row class-map digest;
- the exact dependency lock, vocabulary, and candidate mapping.

The mapping contains only direct YAMNet classes. Unsupported classroom labels
remain explicit gaps. The scoring policy has no selected threshold: it records
maximum, mean, and top-three-patch mean values per mapped label, then the corpus
evaluator uses the second-highest analysis-window score when a track has more
than one window. Those values are uncalibrated and cannot be shown to students
or used by Auto.

Run dependency-light mapping and input-contract tests without installing
LiteRT:

```sh
npm run test:yamnet-comparator
```

Refresh the exact dependency lock:

```sh
uv lock --project yamnet-comparator --python 3.12
```

Build the Railway-target platform and evaluate the hydrated licensed corpus:

```sh
docker build --platform linux/amd64 \
  -f yamnet-comparator/Dockerfile \
  -t stem-splitter-yamnet-comparator:v3.2-candidate .
npm run eval:yamnet:image
```

The evaluator resolves the tag to an immutable image id, verifies the baked
lock identity, and runs each source in an ephemeral non-root container with a
read-only root, no network, dropped capabilities, bounded CPU/RAM/PIDs, and a
private no-exec `/tmp`. New corpus reports use schema v2 and bind the Node
runtime, TypeScript configuration, dependency locks, every transitive host-side
evaluator source, a SHA-256 checked before and after scoring every hydrated
audio input, and the exact decoded PCM/window sample plan. The checked-in arm64
schema-v1 reports remain immutable historical evidence and must be rerun rather
than edited after source drift.
Timing from an emulated amd64 image is diagnostic only; native amd64 and human
review remain separate promotion gates.
