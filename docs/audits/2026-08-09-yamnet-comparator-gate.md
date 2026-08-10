# YAMNet fixed-label comparator gate — 2026-08-09

## Decision

Use YAMNet as the next **offline comparison candidate**, not as a selected
classifier or a Railway service. Its fixed AudioSet vocabulary avoids the
rejected CLAP candidate's positive/`without` prompt collapse and covers many
non-rock instruments, but it still needs artifact-license confirmation,
content pins, corpus evidence, and human review before implementation can move
beyond a networkless evaluator.

## Primary-source fit

- The official [YAMNet README](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/README.md)
  describes a MobileNet-based model trained on AudioSet-YouTube to predict 521
  audio-event classes. It consumes 16 kHz mono audio in overlapping 0.96-second
  patches, has about 3.7 million weights, and emits per-patch scores plus a
  1,024-dimensional embedding.
- The official
  [class map](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv)
  includes singing/choir; guitar, bass, banjo, sitar, and mandolin; piano,
  organ, and synthesizer; drum kit, drum machine, timpani, and mallet
  percussion; brass, horn, trumpet, and trombone; bowed strings, string
  section, violin, cello, and double bass; flute, saxophone, clarinet, harp,
  harmonica, and accordion. It does not supply exact equivalents for every
  classroom label, including oboe, bassoon, viola, and koto.
- The TensorFlow Models repository and YAMNet source declare
  [Apache 2.0](https://github.com/tensorflow/models/blob/master/LICENSE), but
  the separately hosted `yamnet.h5` artifact still needs an exact downloaded
  digest and a recorded institutional determination that the repository terms
  cover redistribution in a service image. Do not equate code licensing with
  automatic weight clearance.
- TensorFlow's own
  [security guidance](https://github.com/tensorflow/tensorflow/security)
  treats serialized models as programs. Load only a content-pinned artifact in
  a networkless, non-root, read-only evaluator with bounded decoded PCM.

## Required sequence

1. Pin an exact TensorFlow Models commit, `yamnet.h5` byte length/SHA-256, class
   map SHA-256, model license snapshot, runtime version, and preprocessing
   contract before any artifact enters a build context.
2. Create a candidate-only mapping from YAMNet classes to the existing
   classroom vocabulary. Preserve unsupported labels and parent/child
   collisions as explicit gaps; do not invent an oboe, bassoon, viola, or koto
   score.
3. Run a separate networkless evaluator on the same eleven licensed sources,
   directional hard negatives, and new reviewed single-instrument controls.
   Report raw per-window scores, abstention, per-label precision/recall,
   calibration, latency, memory, and genre/family slices.
4. Compare it with the rejected CLAP baseline and with Essentia only if MTG
   clears the latter's license. A favorable aggregate score cannot override a
   poor long-tail family or hard-negative result.
5. Assign a new classifier ID and build/provision **one** private Railway
   discovery service only after the offline candidate and human-review gates
   pass. Keep discovery advisory and feature-flagged; it cannot alter Auto's
   2/4/6 choice or create a separator stem.

This gate adds no model dependency, weight, runtime, service, feature flag, or
live deployment. It only closes the sequencing gap left by the rejected CLAP
candidate and the license-blocked Essentia candidate.
