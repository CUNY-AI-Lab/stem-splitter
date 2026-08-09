# Instrument discovery design — v3.2 Phase 2

**Status:** local candidate; rollout off

## Purpose

Instrument discovery adds teacher-reviewable, advisory metadata to a completed
audio analysis. It does not select a separation model, add a stem, rename a
stem, or make an isolation request. The existing two-, four-, and six-track
contracts remain the only core split contracts.

## Service order and trust boundary

```text
Railway stem-splitter app
  -> short-lived signed source URL
Railway audio-analysis service
  -> bounded mono f32le windows only
Railway instrument-discovery service
  -> versioned advisory detections only
```

The discovery service receives no source URL, storage credential, filename,
class code, job id, or persistent volume. The analyzer remains the only new
service allowed to fetch a stored source. It sends at most 45 seconds of
22,050 Hz mono PCM over Railway private networking and records only bounded
detector metadata.

Discovery is optional and fail-lazy. A discovery timeout, unavailable service,
or malformed response produces an explicit discovery-unavailable trace while
preserving the already computed core Auto decision. A stale analyzer that does
not understand the requested discovery contract is rejected by the app before
its metadata can be trusted.

## Candidate classifier and exact pins

The first spike uses the official Hugging Face conversion of LAION's
music-specialized CLAP model:

- repository: `laion/larger_clap_music`;
- revision: `a0b4534a14f58e20944452dff00a22a06ce629d1`;
- `pytorch_model.bin` SHA-256:
  `5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1`;
- app classifier id:
  `laion-larger-clap-music-pairwise-presence-v1@a0b4534a14f58e20944452dff00a22a06ce629d1`;
- vocabulary: `classroom-instruments-v1`;
- vocabulary SHA-256:
  `72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140`.

The image downloads that exact revision at build time, verifies the weight
hash, and runs with Hugging Face and Transformers offline. Container startup
must never resolve `main`, `latest`, or a default checkpoint. The
[LAION repository](https://github.com/LAION-AI/CLAP) identifies the code as
CC0-1.0 and recommends the music checkpoint for music use. The
[official model card](https://huggingface.co/laion/larger_clap_music) labels
the converted checkpoint Apache-2.0. The training corpus includes linked audio
with copyright restrictions, so model-card licensing does not remove the need
for institutional review before a student rollout.

`pairwise-presence-v1` is part of the classifier id because it converts each
reviewed term's positive/negative CLAP logit pair into an independent score and
then takes the maximum over that instrument's terms. A prompt-template,
synonym-aggregation, softmax-policy, or model-revision change requires a new
classifier id even if the weight file is unchanged. These scores are candidate
signals, not calibrated probabilities.

## Essentia comparison boundary

The evaluation-only comparison candidate is MTG Jamendo Instrument over the
Discogs-EffNet embedding:

- classification head:
  `mtg_jamendo_instrument-discogs-effnet-1.onnx`, SHA-256
  `9ae2d9e763d66bd8eed654d1ac3aa171e6539cb8a0e11f3dcd53df1428980802`;
- embedding:
  `discogs-effnet-bsdynamic-1.onnx`, SHA-256
  `a280825b334797cf677939db8cd5762c0392aedd0ca6415dbc1cd083f045e43c`;
- published head: 40 labels, test PR-AUC 0.20 and ROC-AUC 0.78.

The [official Essentia model catalogue](https://essentia.upf.edu/models.html)
states that MTG-created models are CC BY-NC-SA 4.0 or available under a
proprietary licence. The directory licence text also contains conflicting
human-readable wording. Therefore Essentia is not included in the production
image and cannot become a live backend without a written institutional licence
decision. Its scores may be compared only in the offline evaluation harness.

## Vocabulary and aggregation

`instrument-discovery/vocabulary.json` is the reviewable source of truth. It
contains stable ids, display labels, families, prompt terms, candidate family
thresholds, and known confusions. A vocabulary change requires a new version;
editing labels under an existing version is prohibited. A local integrity test
pins the file's content hash as well as its version, so an edit under the same
claimed version fails the gate.

Decoded material is divided into at most three windows of at most 15 seconds.
Every window is scored independently. For a track with multiple windows, an
instrument normally needs support in at least two windows. Scores between the
family's uncertain floor and possible threshold are retained as `uncertain`,
not promoted to a positive label. Candidate thresholds are explicitly
uncalibrated until the fixed corpus reports per-label and per-genre metrics.
Support counts windows at or above the family's uncertain floor; the retained
score is the arithmetic mean across every analyzed window, so one strong
window cannot hide two absent ones. A one-window source needs one supported
window. Results are sorted deterministically and capped at twelve.

The discovery service resamples the analyzer's fixed 22,050 Hz role PCM to the
checkpoint's 48,000 Hz input with a pinned polyphase implementation. For clips
longer than CLAP's ten-second feature window, the fused checkpoint retains its
whole-window view plus three mel crops; `pairwise-presence-v1` fixes the crop
seed by window index. Any resampler, crop, prompt, synonym, or pairwise-logit
change requires a new classifier id and a new evaluation entry.

The response contains no raw embedding, prompt vector, full score table, or
audio. Each retained item includes only its vocabulary id, label, bounded
confidence, state, supporting-window count, and total analyzed windows.
Classifier revision, model-weight hash, vocabulary version, and vocabulary
content hash cross both service boundaries and must match the app's compiled
pins exactly.

The analyzer sends PCM only to loopback or a `*.railway.internal` origin. It
rejects public origins, URL credentials, paths, queries, fragments, malformed
tokens, redirects, oversized responses, already-aborted requests, and any
response whose schema or content pins drift. These failures are discovery-only:
they cannot replace an already validated two-, four-, or six-track decision.

## Visibility and governance

Full detections are persisted with the private job analysis for auditability.
Student job responses strip vocabulary metadata and detections. A separate
teacher-authenticated analysis endpoint is the only application surface that
may expose them during the candidate phase. Teacher feedback is not a training
label: confirmed, absent, and missed reports require a later additive schema,
de-identification policy, and review workflow.

## Promotion gate

The discovery flag stays false until all of the following are recorded:

1. exact image and model hashes plus offline-start proof;
2. per-instrument and per-genre precision/recall;
3. calibration and abstention rate;
4. similar-timbre confusion matrix;
5. latency, peak memory, cold-start, and Railway cost;
6. manual teacher review of vocabulary and false positives;
7. legal status for the selected checkpoint;
8. proof that discovery success, failure, and version drift never change the
   concrete core split sent to the separator.
