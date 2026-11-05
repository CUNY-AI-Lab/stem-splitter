# Label the audible contents of each output

Research checkpoint: November 5, 2026. This is a proposed labeling design,
not a model-validation result. No new model was downloaded or run for this
review. The existing input detector remains disabled.

## Decision

Analyze each completed output's actual audio, including every new resplit
output. Use a supervised multi-label instrument tagger over time, with an
explicit uncertainty policy. Measure prominence separately from confidence
that an instrument is present. The first model comparison should be
EfficientAT versus a music-specific MTG-Jamendo instrument head.

This labeling pass must be independent of the number of outputs requested.
It may report piano and strings in one output, or no reliable instrument in
another. It must not name the top two, four, or six classes simply to satisfy
the selected count. A broad recognition vocabulary is acceptable; assigning
the same instrument roster to every run is not.

Accurate descriptions of existing outputs do not turn fixed Demucs outputs
into audio-derived separation. The earlier adaptive initial/resplit requirement
and isolation validation remain separate unfinished work.

## Evidence and candidates

| Candidate | Use in the comparison | Limits |
| --- | --- | --- |
| [EfficientAT](https://github.com/fschmid56/EfficientAT) | First supervised baseline. Official code provides AudioSet models, windowed inference, embeddings and OpenMIC fine-tuning. The smaller models make bounded local comparison practical. | Repository uses MIT licensing; pin and check the specific weights. AudioSet performance does not establish recognition of separated stems or musical prominence. |
| [Essentia MTG-Jamendo instrument models](https://essentia.upf.edu/models.html#mtg-jamendo-instrument) | Music-specific multi-label comparator with a 40-class instrument head. | MTG model terms are CC BY-NC-SA 4.0 or a separately arranged proprietary license. Broad/overlapping classes and artifacts in separated output need evaluation. |
| [YAMNet](https://www.tensorflow.org/hub/tutorials/yamnet) / [PANNs](https://github.com/qiuqiangkong/audioset_tagging_cnn) | Broad supervised audio-tagging baselines; useful comparisons for silence/nonmusic confusion. | General AudioSet labels do not establish lead instrument or calibrated musical dominance. |
| [MERT](https://huggingface.co/m-a-p/MERT-v1-330M) | Possible music embedding backbone for a trained instrument head. | The cited model is an encoder, not a ready labeling service; 330M parameters and CC BY-NC terms. Requires supervised training and calibration. |
| Existing CLAP service | Retain its source identity, decoding and evaluation plumbing. | Its current prompt/checkpoint policy failed this repository's corpus. Raw cosine similarity is not a presence probability or prominence measurement. |
| [Music Flamingo](https://huggingface.co/nvidia/music-flamingo-2601-hf) | Possible later captioning/Listening Guy research comparator. | Generative descriptions are not calibrated instrument detections; the cited model is 8B and noncommercial. Not the default labeling choice. |

[OpenMIC](https://github.com/cosmir/openmic-2018) supplies polyphonic instrument
annotations and an established instrument-classification task. Its partially
labeled mixtures are useful for training/comparison, but cannot replace
ground truth for separated outputs. Do not treat missing annotations as
confirmed absence. Split by original recording so segments and outputs of
one recording cannot leak between calibration and evaluation.

The repository's `instrument-discovery/README.md` records the rejected CLAP
policy and its positive-only control (13/42 reviewed groups in the top 12).
The later local diagnostic in `2026-11-05-source-separation-status.md` found
correct top rankings on four of five isolated references, a guitar/mandolin
confusion, and high similarities on silence. None supports turning raw scores
into labels by lowering a threshold.

## Proposed labeling and prominence procedure

1. Bind analysis to the exact stored output hash, job/output identity, model
   checkpoint hash, taxonomy version and calibration version. On resplit,
   analyze the selected saved output as input and each resulting child; never
   inherit the original recording's inventory or a parent label.
2. Decode a bounded, deterministic set of overlapping windows distributed
   across active audio. Record their timestamps and sampling coverage. Use
   the sample rate required by the chosen model. Reject silence and near
   silence before classification; measure loudness from original-gain audio,
   even if the classifier uses normalized copies.
3. Calibrate multi-label instrument decisions on held-out labeled outputs.
   Keep per-window scores, presence decisions and activity duration. Use a
   class-specific uncertainty policy, including abstention. Map overlapping
   parent/child labels conservatively: violin plus strings is not evidence of
   two different instruments.
4. Rank outputs by supported audible activity. For an initial diagnostic,
   compute an energy-weighted presence score for each output/instrument:
   `sum(window_duration * original_gain_window_power * calibrated_presence)`.
   Account for overlapping windows once, retain time coverage, and compare
   aligned outputs from the same run at their original gain. This is a
   proposed heuristic, not an instrument-energy estimate or validated rule.
   In a mixed piano/strings output, the full output's power cannot be assigned
   to either instrument independently. Keep both labels unless annotated
   dominance evidence supports an order; do not equate confidence with lead.
5. Examine repeated instruments across outputs for leakage. Do not make
   labels unique by force, suppress a genuine shared source, or add energies
   from correlated outputs and call that a run's source distribution.
6. Display the supported result: `Piano`, `Piano · strings`, a qualified
   uncertain label, or the neutral output number when evidence is inadequate.
   Preserve user renames and canonical download/storage keys. Versioned
   generated display labels are separate metadata, not replacements for
   those identifiers.

## Integration boundaries

Reuse the existing audio decoding, private source fingerprints, bounded
windows and taxonomy hierarchy. Add a distinct output-label analysis scope
that resolves only an authorized job's immutable output bytes. The existing
`src/analysis/source-scope.ts` intentionally forbids stem/isolation reads;
do not broaden its input-analysis allowlist or expose arbitrary object keys.

The current `InstrumentDetectionV1` in `src/analysis/types.ts` does not record
output identity, intervals, calibration or prominence evidence. Introduce
a separate versioned result for output labels. Queue/cache it per output
after separation completes, with cancellation/deletion and ownership checks.
An unavailable labeler must leave playable outputs intact and explicitly
unlabeled. It must not silently reuse an earlier run's labels.

## Next implementation and acceptance work

- Pin and review one EfficientAT checkpoint; score the already saved local
  outputs plus reference stems as a comparator, not a production feature.
- Compare the music-specific head on the same material, subject to its
  runtime/model terms. Keep raw outputs, hashes and window evidence.
- Build a separate calibration set with silence, residual noise, leakage,
  mixed outputs and related timbres. Annotate instrument presence and
  dominance separately. Do not tune thresholds on the release cases.
- Report per-instrument precision/recall, abstention coverage, dominant-label
  agreement and temporal support. Measure isolation independently using
  reference stems and reviewed listening judgments.
- Complete the existing three-genre × 2/4/6 × initial/resplit matrix with
  actual outputs and reviewed labels. This research does not add a pass to
  that matrix, and the three proposed SAM extraction trials would not either.

No new model access, paid prediction, credential use, dataset transmission,
production switch or deployment was performed for this research.
