# v3.2 instrument-discovery candidate baseline — 2026-08-09

## Decision

Do not provision or enable the `instrument-discovery` service yet. The pinned
service completed a constrained, real-model run across all eleven hydrated,
licensed corpus recordings, but the current prompt/threshold policy abstained
on every source. This is a failed musical-usefulness gate, not a transport or
runtime failure. Core Auto routing and the frozen 2/4/6 stem contracts remain
unchanged.

## Frozen inputs

- Branch source: `codex/v3.2-audio-pipeline` commit `ccf7f53` (parent
  `08ca350`). Diagnostic source hashes below bind the two Python files used for
  the raw-score run.
- Native image:
  `sha256:7fc21ac0244c65ef0742cb91d8203534ba330e1e8c609bf9b2a4d0dff3f91081`
  (`linux/arm64`, user `65532:65532`, command `python service.py`).
- Classifier:
  `laion-larger-clap-music-pairwise-presence-rand-trunc-v1@a0b4534a14f58e20944452dff00a22a06ce629d1`.
- Weight SHA-256:
  `5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1`.
- Vocabulary: `classroom-instruments-v1`, SHA-256
  `72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140`,
  still marked `uncalibrated-candidate`.
- Decoder: FFmpeg/ffprobe `8.1.2`, mono `f32le` at 22,050 Hz, at most three
  15-second windows and a 15-minute source ceiling.
- Corpus: eleven local files licensed for derivative testing. The ordered
  source-SHA-1 vector hashed to
  `550e08e3e6ca89825bf5047f349a7344a6e5be2709cc990d621b2f953c601963`.

## Constrained execution

`npm run eval:instruments:image` generated an ephemeral bearer token and ran
the existing image with a loopback-only published port, read-only root,
no-exec/no-suid/no-device temporary storage, no added capabilities,
`no-new-privileges`, 2 CPU, 2 GiB RAM with no additional swap, and 128 PIDs.
The model image forces Hugging Face and Transformers offline. The runner removed
its container and per-run network after completion.

The generated JSON report was mode `0600`, 38,358 bytes, and had SHA-256
`6c57e9b08b4d886b22d8de54be3c6f9d515bbd3c4f1d900cb53120d9adc6d745`.
It is a local evidence artifact rather than a checked-in threshold baseline,
because the current result is not promotion-worthy and the corpus audio itself
is intentionally ignored.

A separate `linux/amd64`-on-`linux/arm64` attempt never completed vocabulary
embedding before the image's baked health policy marked the container
unhealthy. The evaluator rejected the run and its exit trap removed the
container and per-run network. This cross-architecture failure is cold-start
diagnostic evidence only; it does not satisfy or contradict the required native
amd64 gate.

## Result

- Sources analyzed: 11/11.
- Reviewed expected groups: 42.
- Possible detections: 0.
- Uncertain detections: 0.
- Missed reviewed groups: 42.
- Source-level abstentions: 11/11.
- Hard-negative, confusion, and unreviewed detections: 0, because the service
  returned no labels at all.
- Aggregate service classifier time: 9,604 ms.
- Aggregate decode/request/evaluation time: 11,032 ms.

Every represented coverage group—including orchestral, jazz, rock, folk,
bluegrass, hip-hop, and four electronic sources—had the same all-abstention
outcome. Overall accuracy or precision is not calculable from these
non-exhaustive review annotations, and zero false positives cannot compensate
for zero surfaced candidates.

## Pre-threshold diagnostic

A second batch ran the same 33 decoded windows through the same model with the
container network set to `none`. The diagnostic script was bind-mounted rather
than added to the service image; input PCM was read-only and removed on exit,
and raw arrays never crossed the HTTP contract. The final mode-`0600` JSON
report was 769,351 bytes with SHA-256
`be4d64174bccc259fdcccb2e45262afdc790233c9ffcc86183cff4c5de114eb9`.
It records diagnostic source hashes
`0350b4b10029b6ab338e1f077ff3453ba9d8906075cd0e79a309157f7fc53eef`
for `score_audit.py` and
`0a7ea5009186bd0cc56092ada3f75f7a8acad3a3f18859a484011e76d16d5d01`
for `clap_backend.py`.

The 42 best expected-group mean scores ranged from `0.499894` to `0.500002`
(mean `0.499946`). The same collapse appeared across all label categories:

- Expected one-term prompts: mean `0.499924`; two-term prompts: `0.499956`.
- Hard-negative one-term prompts: mean `0.499956`; two-term prompts: `0.499951`.
- Unreviewed one-term prompts: mean `0.499945`; two-term prompts: `0.499955`.

Those overlapping ranges show that the current positive-versus-`without`
pairwise score contains essentially no useful discriminative signal on this
corpus. The underlying logits clarify why: the matching `without` prompt was
usually scored slightly higher than its positive prompt. Positive-only ranking
did not rescue the candidate, however. Only 13/42 reviewed groups placed an
accepted label in the track's top 12; best accepted-label rank averaged 25.67,
with a median of 24 and a worst rank of 51. Koto, sitar, mallet percussion, and
other labels repeatedly outranked reviewed instruments across unrelated
recordings. The evidence therefore rejects both the current negation policy
and the present prompt/checkpoint pairing as a release candidate. It rules out
calibrating by simply lowering the existing family thresholds.

## Required next evidence

1. A separately pinned YAMNet TFLite comparator has now completed the same
   corpus and ranks substantially better, but it remains unselected because of
   family failures, ontology gaps, missing controls, and absent calibration.
   See `2026-08-09-yamnet-comparator-gate.md`. Any renewed CLAP prompt-policy
   experiment still requires a new classifier ID and complete rerun.
2. Calibrate per-family thresholds only from reviewed positives and hard
   negatives. Do not lower thresholds merely to eliminate abstentions.
3. Add licensed positive controls for solo strings and pitched percussion; the
   current corpus only covers the reverse or ensemble side of those confusion
   tests.
4. Repeat on native amd64 and then Railway with resource/restart evidence only
   after the candidate produces reviewable local detections.
5. The evaluator hardening after this rejected run now requires every future
   promotion report to record the immutable executing image ID, exact
   `linux/amd64` platform, and baked dependency-lock identity, with exact-schema
   regressions. Comparison-only reports must bind and expose their non-target
   platform and remain explicitly ineligible. Runners execute by resolved image
   ID so a retag cannot swap the image between inspection and inference. This
   does not retroactively upgrade the CLAP artifacts described here: their image
   remains manually bound above and they must not be treated as self-contained
   promotion evidence.

Until those gates pass, `INSTRUMENT_DISCOVERY_ENABLED` stays false, detection
remains advisory/tester-only, and no long-tail label may select a Demucs model
or become a stem name.
