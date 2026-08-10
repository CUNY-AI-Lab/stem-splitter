# Essentia / MTG-Jamendo instrument-model license gate — 2026-08-09

## Decision

Do not download, bake, provision, or compare the Essentia MTG-Jamendo
instrument model in the v3.2 Railway pipeline yet. The primary licensing
materials are internally inconsistent, and the specific model metadata does
not resolve the inconsistency. Treat the weights as not cleared for deployment
until Music Technology Group or institutional review provides a written answer.
This is a release-policy decision, not legal advice.

## Primary-source findings

- The [Essentia model catalog](https://essentia.upf.edu/models.html) says models
  created by MTG use CC BY-NC-SA 4.0 and can be licensed proprietarily on
  request.
- The separate [Essentia licensing page](https://essentia.upf.edu/licensing_information.html)
  says the pretrained models use CC BY-NC-ND 4.0 for noncommercial use and are
  also available under proprietary terms.
- The actual [license file served beside the model weights](https://essentia.upf.edu/models/LICENSE)
  calls the license Attribution-NonCommercial-NoDerivatives, but the legal-code
  URL inside that same file points to CC BY-NC-SA 4.0 and its summary permits
  adaptation. The file therefore does not give one coherent set of terms.
- The specific
  [MTG-Jamendo instrument model metadata](https://essentia.upf.edu/models/classification-heads/mtg_jamendo_instrument/mtg_jamendo_instrument-discogs-effnet-1.json)
  identifies a 40-class sigmoid classification head but contains no license
  field.
- The [MTG-Jamendo dataset project](https://github.com/MTG/mtg-jamendo-dataset)
  limits the dataset to noncommercial research and academic use unless Jamendo
  provides authorization; its metadata and individual audio have separate
  licenses.
- The [Essentia software library](https://github.com/MTG/essentia) is AGPLv3
  and documents additional dependency obligations. Running the ONNX model in a
  different runtime could avoid importing Essentia itself, but it would not
  resolve the model-weight license conflict.

## Fit assessment

The CUNY classroom purpose may be noncommercial and academic, but that fact
alone does not settle public Railway hosting, redistribution inside an image,
future institutional reuse, ShareAlike obligations, or the conflicting
NoDerivatives statement. A local research comparison would also create work
that could be mistaken for deployment approval. The safe sequence is therefore:

1. Ask MTG to identify the controlling license for the exact `.onnx` or `.pb`
   files and whether noncommercial institutional web-service inference and
   container distribution are permitted.
2. Have CUNY/institutional review confirm whether the intended classroom and
   later public deployment fit those terms and the AGPL boundary if the
   Essentia runtime is used.
3. If cleared, record the exact model URL, bytes, SHA-256, license text/date,
   embedding dependency, classification-head schema, and attribution in a new
   candidate manifest before any download enters a build.
4. Run the same eleven-source manifest as an offline evaluation only. Do not
   connect its 40 tags to Auto routing or student-visible labels during the
   bake-off.

Until those steps are complete, Essentia/MTG-Jamendo is a documented
license-blocked comparison candidate, not the replacement for the rejected CLAP
prompt/checkpoint pairing.
