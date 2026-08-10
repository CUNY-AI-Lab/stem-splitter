# YAMNet fixed-label comparator audit — 2026-08-09

## Decision

Retain YAMNet as a **promising offline comparator, not a selected classifier**.
It materially outperforms the rejected CLAP prompt/checkpoint pairing on the
same licensed corpus, but it does not clear the accuracy, calibration, ontology,
human-review, native-amd64, or service gates. No threshold was selected, no
Railway service was created, and `INSTRUMENT_DISCOVERY_ENABLED` stays absent or
false.

YAMNet remains advisory research only. It cannot change Auto's concrete 2/4/6
route, alter the provider model, append or rename a stem, or expose labels to
students.

## Exact candidate identity

The comparator uses Google's official unquantized YAMNet TFLite version 1 from
Kaggle Models rather than an unversioned `yamnet.h5` download. The official
[Kaggle model listing](https://www.kaggle.com/api/v1/models/list?owner=google&search=yamnet)
reports this exact instance as Apache 2.0 and supplies stable model, instance,
and version identifiers.

| Component | Frozen identity |
| --- | --- |
| Classifier | `google-yamnet-tflite-v1-max-class-top3-patch-mean-second-window-v1@kaggle-version-763` |
| Kaggle model / instance / version | `52` / `630` / `763` (version number `1`) |
| Download archive | 14,220,537 bytes; SHA-256 `be65f33dc14caf40e2044c71ebb2633d04deb059b6916eaa06a408e1070b018c` |
| TFLite member | `1.tflite`; 16,096,668 bytes; SHA-256 `141fba1cdaae842c816f28edc4937e8b4f0af4c8df21862ccc6b52dc567993c3` |
| TensorFlow Models revision | `4d7bdd8c170ee90850f2f9ccef0f6d19b817de35` |
| AudioSet class map | 14,096 bytes; 521 sequential classes; SHA-256 `cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2` |
| Bundled license copy | 11,512 bytes; SHA-256 `5b17814bf0de8cf65069bc6d7cc38cff19fcaa864d243423ad3ef3db01b52385` |
| Runtime lock | Python 3.12; `ai-edge-litert==2.0.3`; `numpy==2.3.5`; `scipy==1.16.3`; lock SHA-256 `b4cb15c5bf6fc4e68b9e3a7d617fc6ad81302ce35c3466cd70ba8f5626de4e3e` |
| Classroom mapping | `classroom-instruments-v1`; mapping SHA-256 `cda962367ff7cf0b65674b5cbd8cb8289a34789c671df83d4e27ba583e4b3318` |

The official [YAMNet README](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/README.md)
defines a 16 kHz mono waveform input, 0.96-second patches with a 0.48-second
hop, a 521-class AudioSet head, and uncalibrated class scores. The pinned
[class map](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv)
and the TensorFlow Models [Apache 2.0 license](https://github.com/tensorflow/models/blob/master/LICENSE)
provide the vocabulary and source-license records. Kaggle's version-specific
metadata supplies the separate weight-license record.

## Mapping and scoring policy

The mapping covers 36 of the existing 51 classroom labels using only exact
YAMNet classes. Fifteen labels remain explicit unsupported gaps: viola,
classical guitar, ukulele, tuba, oboe, bassoon, pipe organ, pad, marimba,
bongos, oud, erhu, koto, shamisen, and gamelan. The combined YAMNet
`Marimba, xylophone` class maps only to the broader `mallet-percussion` label;
it is not duplicated as a marimba score.

For each mapped classroom label, the comparator takes the maximum across its
mapped AudioSet classes and the mean of the three strongest patches. Across
analysis windows it uses the second-highest score, with a documented
single-window exception. This produces reviewable ranking and threshold-sweep
data only. It does not define a detection threshold, calibration curve,
`possible` state, or `uncertain` state.

## Implementation and containment

`yamnet-comparator/` is a separate candidate-only image and CLI, not a service.
The build:

- checks exact official metadata before downloading;
- accepts only the reviewed Kaggle-to-Google Storage redirect path;
- bounds and hashes the archive, requires its one-file tar surface, and hashes
  the extracted TFLite file;
- pins and validates all 521 class-map rows and the complete 51-label mapping;
- bakes dependency-lock and source-file digests into the image; and
- loads only a local flatbuffer after checking the model-directory surface.

Each evaluation source is decoded through the existing analyzer decoder. PCM
travels only over stdin into a distinct ephemeral container. Every inference
runs by immutable image ID with no network, a read-only root, a no-exec tmpfs,
uid/gid `65532:65532`, dropped capabilities, `no-new-privileges`, and bounded
CPU, memory, swap, PIDs, output, and duration. It receives no source URL,
storage credential, class code, job id, filename, or volume. This follows
TensorFlow's [serialized-model security guidance](https://github.com/tensorflow/tensorflow/security)
without turning the comparator into an application dependency.

## Licensed-corpus result

The durable, non-promotion report is
[`native-arm64-corpus.json`](../acceptance/2026-08-09-yamnet-comparator/native-arm64-corpus.json).
It binds all evaluation inputs and the native arm64 image
`sha256:84be0205ccd53da93791a9c843ede0ae77ab1d12b6c1ebffc4712120ca14a14c`
(673,683,451 bytes). The report SHA-256 is
`b59d4f7d32bfb999263a26bd7abb3313afe49111c96e23f7d162d4efba09fe93`.
Across eleven licensed sources:

- 40 reviewed expected groups were eligible and 2 were explicitly unsupported
  (orchestral oboe and bassoon);
- 16/40 ranked in the top 3, 21/40 in the top 5, and 31/40 in the top 10;
- mean reciprocal rank was 3,507 basis points;
- a diagnostic threshold of `0.05` surfaced 10/40 groups and five reviewed
  hard-negative alerts;
- a diagnostic threshold of `0.10` surfaced 6/40 groups and no reviewed
  hard-negative alerts; and
- no threshold was selected because the annotations are non-exhaustive and do
  not support a precision claim.

Family slices expose the blocking failures. Voice placed all 6/6 reviewed
groups in the top five, keys 1/1, bowed strings 3/4, electronic 3/5,
percussion 2/4, and plucked strings 3/7. Brass placed 0/2, woodwind 0/3, and
free-reed 0/1. The directional confusion trials correctly separated electric
guitar from synthesizer on shoegaze and bass guitar from double bass on
shoegaze, but reversed both electronic-stiff-hand and bluegrass. Piano beat
mallet percussion; brass outscored saxophone on the jazz-sax source. Solo
strings versus string section and pitched percussion versus keys remain corpus
gaps.

The native arm64 build completed constrained real inference. A separately
built `linux/amd64` image
`sha256:2db266436041f8c2583f9506f35abe564003cb7644f466812f8d45f3a7842df5`
(739,899,239 bytes) completed the jazz-sax source under local emulation. The
largest observed mapped-score difference between the two architectures was
`0.00000014`. This is numerical-parity evidence only: emulated timing is not a
native-amd64 performance or Railway-sizing result.

## Verification

The exact Bun 1.3.14 install completed with the frozen lock and no changes. The
literal `test:phase0` command passed:

- 132 worker/shared-contract tests;
- 21 analyzer tests;
- 14 Railway-host and migration tests;
- 5 separator tests;
- 30 discovery service/evaluator tests;
- 9 dependency-light YAMNet contract tests;
- 19 flags-off browser E2E tests; and
- 4 authoritative server-Auto browser E2E tests.

The YAMNet image separately passed a real eleven-source native arm64 run and a
current-source amd64-on-arm64 jazz-sax run under the locked container controls.
No test or report authorizes classifier selection, a Railway service, or live
rollout.

## Comparator disposition

The fixed AudioSet head avoids the rejected CLAP candidate's prompt-negation
collapse and yields substantially better corpus ranking. That makes YAMNet a
useful baseline for the next candidate, not a production choice. Selection is
blocked by:

1. missing authorized single-instrument positives and exhaustive negative
   controls;
2. no teacher/domain listening review of corpus annotations;
3. weak brass, woodwind, free-reed, and several confusion results;
4. fifteen explicit ontology gaps, including several requested orchestral and
   traditional instruments;
5. no calibrated family thresholds or abstention policy;
6. no native-amd64 runner evidence; and
7. no reason yet to provision a service for a candidate that has not cleared
   the offline gate.

The next evidence unit should add reviewed single-instrument controls and
exhaustive negatives, then compare a specialized fixed-label head or a
reviewed transfer-learning head against this frozen result. Essentia remains
blocked until the exact weight and runtime license boundary receives written
clarification and institutional review. Only one selected candidate may later
proceed to a private Railway service, with flags still off and no student or
routing effect.
