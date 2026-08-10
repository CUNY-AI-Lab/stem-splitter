# YAMNet fixed-label comparator audit — 2026-08-09

## Decision

Retain YAMNet as a **promising offline comparator, not a selected classifier**.
It materially outperforms the rejected CLAP prompt/checkpoint pairing on the
same licensed corpus, but it does not clear the accuracy, calibration, ontology,
human-review, native-amd64, or service gates. No threshold was selected, no
Railway service was created, and `INSTRUMENT_DISCOVERY_ENABLED` stays absent or
false.

Eight exact-hash ChoraleBricks controls substantially strengthen the
woodwind/brass evidence: every YAMNet-supported exact instrument ranked in the
top three. They also confirm blocking ontology and confusion problems. Oboe and
tuba have no exact YAMNet labels, an isolated oboe ranked trumpet/brass first,
and horn ranked behind trombone. Dataset-authored isolated-track labels are not
silently promoted to teacher-reviewed ground truth.

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

### Evaluator provenance follow-up

The original arm64 corpus and control JSON remain immutable schema-v1
historical artifacts. A later adversarial pass found that the corpus report did
not name every transitive host-side source used for loading, decoding, window
selection, and contract pins, and it retained only the corpus's legacy SHA-1
for each hydrated file. Updating those recorded hashes in place would falsify
the evidence.

The current corpus evaluator therefore emits schema v2. It adds the exact Node
version, TypeScript configuration, and dependency locks, plus a complete named
SHA-256 map for the runner, loader, decoder, bounded process helper, windowing
policy, analysis pins, vocabulary module/data,
corpus, expectations, mapping, and package manifest, plus a SHA-256 checked
before and after scoring for each hydrated audio input and a digest of the exact
decoded PCM/window sample plan sent to the comparator. The evaluator also
rejects any source-file drift during the run. The native-amd64 workflow watches
the same paths so a transitive change cannot bypass the image gate. A new
native-amd64 corpus-v2 report and refreshed control report remain required
before this evaluator can support any later selection decision.

### V3 candidate-capture boundary

Commit `5f9a8ad1bb554b085c64bef8ddd1b2f7eaec4ff4` adds a
YAMNet-specific adapter between those future raw reports and the classifier-
neutral v3 candidate schema. Its preparation step accepts only repository-
contained, nonsymlinked, bounded JSON reports and binds their exact bytes. Its
capture step revalidates both reports, requires one identical immutable native
non-emulated `linux/amd64` execution, and cross-checks the current model,
mapping, vocabulary, score policy, image sources, dependency lock, evaluator
sources, source identities and ordering, AudioSet rankings, timing, and decoded
PCM/window plans.

The adapter does not infer that YAMNet has passed review. With no selected
threshold, its content-addressed review-pending policy emits all 19 sources as
`abstained`/`no-label-cleared-threshold` and emits no detections. Historical
arm64 reports and the local emulated-amd64 run remain ineligible. No fresh
native-amd64 report or candidate artifact was produced by this code slice.

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

## Isolated woodwind and brass controls

The versioned manifest
[`instrument-control-manifest.json`](../../tests/corpus/instrument-control-manifest.json)
pins eight performed ChoraleBricks tracks: flute, oboe, clarinet, trumpet,
French horn, trombone, alto saxophone, and tuba. The official dataset describes
its individual tracks as isolated recordings and licenses the website data
under CC BY 4.0. Audio remains gitignored. The hydrator accepts only the exact
AudioLabs origin and route, one exact same-origin 307 into the hashed media
route, `audio/mp4`, the declared length, a 2 MiB ceiling, and the recorded
SHA-256. It refuses symlinked output and mismatched existing files, writes with
no-clobber semantics, and supports a networkless verification pass.

The bound native-arm64 control report is
[`native-arm64-controls.json`](../acceptance/2026-08-09-yamnet-comparator/native-arm64-controls.json)
(SHA-256
`67d133c03c2e28221acc0d458e0dc137ee28987ef5c622bec4e93d46a5e663c0`).
Its manifest SHA-256 is
`b2bdd54eed7c9e1bc36e384cbee4cdb61d1532a6502443b558731b6630689b0f`.
Across eight controls:

- six exact positives were eligible and oboe/tuba stayed explicitly
  unsupported;
- 4/6 eligible exact positives ranked first and all 6/6 ranked in the top
  three, for an 8,056-basis-point mean reciprocal rank;
- woodwinds placed 3/3 eligible exact positives first; brass placed 1/3 first
  and 3/3 in the top three;
- horn ranked third behind broad brass and trombone; trombone ranked second
  behind broad brass; and
- isolated oboe ranked trumpet and brass first, while tuba's broad brass score
  was useful but its exact label remained unavailable.

All 278 vocabulary labels outside each control's declared positives remain
`candidate-only-awaiting-teacher-listening`. The threshold sweep therefore
labels every negative alert `none-review-pending`, makes no precision claim,
and selects no threshold. This evidence cannot enable a flag, service, or UI.

The official [NSynth dataset](https://magenta.tensorflow.org/datasets/nsynth)
was considered for the next tranche, not substituted for these exact controls.
Its release contains 305,979 four-second monophonic notes
from 1,006 sampled instruments under CC BY 4.0, but annotates only eleven broad
families. It can strengthen acoustic/electronic/synthetic and family-level
coverage; it cannot establish exact oboe, tuba, free-reed, or traditional-
instrument truth. Synthetic/sample-library results must remain a separate
slice from performed-track evidence.

## Verification

Exact executable-source commit `4cf452e` passed the literal `test:phase0`
command under Bun 1.3.14, invoked through its pinned npm package because this
shell had no global Bun on `PATH`:

- 152 worker/shared-contract tests;
- 22 analyzer tests;
- 22 Railway-host and migration tests;
- 5 separator tests;
- 30 discovery service/evaluator tests;
- 9 dependency-light YAMNet contract tests;
- 19 flags-off browser E2E tests; and
- 4 authoritative server-Auto plus 1 teacher-isolation-shadow browser E2E
  tests.

The YAMNet image separately passed a real eleven-source native arm64 run, the
eight-control native-arm64 run, a current-source amd64-on-arm64 jazz-sax run,
and both native-arm64 and emulated-amd64 constrained image smokes. The new
native-amd64 GitHub workflow is defined but has not run because the branch is
local. No test or report authorizes classifier selection, a Railway service,
or live rollout.

The later exact adapter commit `5f9a8ad1bb554b085c64bef8ddd1b2f7eaec4ff4`
passes four TypeScript checks; 227 worker, 24 analyzer, 31 Railway
host/migration, 5 separator, 30 discovery, and 9 YAMNet tests; plus 19
flags-off, 6 authoritative-Auto, and 1 isolation-shadow browser journey under
Bun 1.3.14. Four focused capture tests and all 12 combined adapter/comparator
tests pass. The workflow parses as YAML; `actionlint` was unavailable in this
shell and is not claimed.

## Comparator disposition

The fixed AudioSet head avoids the rejected CLAP candidate's prompt-negation
collapse and yields substantially better corpus ranking. That makes YAMNet a
useful baseline for the next candidate, not a production choice. Selection is
blocked by:

1. no teacher/domain listening review of the isolated positives or exhaustive
   candidate negatives;
2. material exact-label confusions on oboe, horn, and tuba despite strong
   controlled rankings elsewhere;
3. weak brass, woodwind, free-reed, and several confusion results;
4. fifteen explicit ontology gaps, including several requested orchestral and
   traditional instruments;
5. no calibrated family thresholds or abstention policy;
6. no native-amd64 runner evidence; and
7. no reason yet to provision a service for a candidate that has not cleared
   the offline gate.

The next evidence unit is teacher listening review of the isolated controls,
followed by fresh native-amd64 corpus/control execution through the now-defined
capture adapter and a specialized fixed-label or reviewed transfer-learning
head against this frozen baseline. Essentia remains blocked
until the exact weight and runtime license boundary receives written
clarification and institutional review. Only one selected candidate may later
proceed to a private Railway service, with flags still off and no student or
routing effect.
