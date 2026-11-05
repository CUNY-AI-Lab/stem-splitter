# Instrument labeling and source separation — November 5, 2026

The user requires sources derived from the audio for both initial splits and
resplits, with 2, 4, and 6 outputs across three genres with different instrument
sets. Fixed Demucs categories, relabeled fixed outputs, mocked model responses,
and metadata guesses do not meet that requirement.

## Current result

The application requirement remains **0/18 accepted, 18/18 blocked**. There is
no accepted audio-derived discovery/separation path in this candidate. Existing
instrument-discovery, query-isolation, server-Auto, and Remixer production
switches remain disabled. Listening Guy audio grounding is not established.

The known orchestral, jazz, and bluegrass corpus files were retrieved by their
existing source URLs and verified against their pinned hashes. All three fully
decoded with FFmpeg. Their exact instrument inventories still require review.
If a selected recording does not support six useful distinct source groups,
replace and pin an appropriate recording; do not manufacture silent outputs.

`tests/corpus/instrument-label-release.json` defines the 18 required cases.
`node scripts/check-instrument-label-release.mjs --evidence <receipt.json>`
checks exact input/output bytes, candidate/model identity, source-derived mode,
parent-output identity for resplits, the requested count, and independently
recorded audio judgments. Its nine synthetic unit tests verify the receipt
contract, not instrument-recognition accuracy. Missing judgments fail closed.

## Actual local separator evaluation

Official [AudioSep](https://github.com/Audio-AGI/AudioSep) source at
`944583f18b84589dc965de3ad77525c945334252` and the official space checkpoint
`f8cda01bfd0ebd141eef45d41db7a3ada23a56568465840d3cff04b8010ce82c`
were run offline on CPU. All separator and query-encoder weights were loaded
strictly. The pinned local text-encoder snapshot was used without network calls;
the only compatibility buffer was checked against the saved checkpoint before
loading. There were no paid provider calls or audible playback.

Eight existing ChoraleBricks control mixtures have dataset-authored isolated
reference tracks: flute, trumpet, tuba, oboe, trombone, clarinet, horn, and
saxophone. These controls do not substitute for the three-genre application
matrix. With bare instrument queries, the mean SI-SDR improvement was about
0.009 dB, three outputs were worse than the input mixture, and all eight output
SI-SDR values were below 0 dB. The existing repository scorer confirmed zero
alignment offset for every output.

A bounded failed-flute diagnostic tested two natural-language descriptions at
two input gains. A subsequent eight-control run using the fixed sentence
“The sound of a {instrument} playing.” improved the flute result by 5.48 dB,
but retained substantial interference across the other controls. All eight
output SI-SDR values remained below 0 dB. This is insufficient evidence of
usable isolation or correct instrument labels. No production adapter or
capability claim was enabled from these results.

The model pins, per-case measurements, input/reference/output hashes, and
research-only scope are in `2026-11-05-audiosep-research.json`. The full local
research runners and WAV outputs are under the task's
`evidence/audiosep-local-20261105/` directory.

## Continued local evaluation: SoloAudio and real multitracks

The earlier stop after the UI checkpoint was premature. This continuation
verified the clean recovered checkout and absence of another Stem writer, then
ran another separator rather than treating the UI tests as audio acceptance.

Docker's daemon remains unavailable. PyTorch 2.8 can use the Mac GPU outside the
restricted process sandbox, so Docker does not block local inference. The first
new run stopped before inference because iCloud had offloaded `_soundfile.py`.
Its readable package-cache copy was verified against the wheel's RECORD hash
and restored into the temporary evaluation path; the original was preserved.
The pip launcher had also been offloaded. Five minimal, pinned Python wheels
were therefore verified and extracted only into the temporary runtime. No
global Python, application dependency, account, or service was changed.

The official [SoloAudio source](https://github.com/WangHelin1997/SoloAudio) was
pinned to `975a7949f1514a8f2a33105d37cd83c89f03d3e5`; its official
[model snapshot](https://huggingface.co/westbrook/SoloAudio) was pinned to
`1311326c8532cfa95b03d3ce13078b3607f0a0e7`. The separator, VAE, and
required CLAP general checkpoint were hash-verified and loaded strictly in
weights-only mode. Model weights are CC BY-NC-SA 4.0; this was local
noncommercial research, not approval for an institutional production service.

The public [MedleyDB sample](https://zenodo.org/records/1438309) matched its
published MD5 and recorded SHA-256. Its two recordings provide dataset-authored
references for folk and singer/songwriter material under the
[dataset's research terms](https://medleydb.weebly.com/downloads.html).
The sample has too few distinct sources to establish the requested six-source
release cases, and the folk references have documented microphone bleed.
Neither the recordings nor model weights are committed or published.

Six active target-reference cases completed silently on the Mac GPU using
50 diffusion steps. Five of six output SI-SDR values were below 0 dB. The
singer/songwriter acoustic guitar improved from 3.62 to 7.23 dB; this single
result is not a release pass. Flute and voice did not improve, violin remained
below 0 dB, and the active electric-guitar trial failed badly. A CPU flute
cross-check also retained more interference than target signal. An earlier
electric-guitar trial used a nearly silent reference excerpt and is explicitly
excluded; its replacement excerpt was chosen by reference energy before
running the model. There were eight actual inference calls: six active primary
cases, one inactive diagnostic, and one CPU cross-check.

A separate CLAP general diagnostic ranked the documented instrument first on
four of five active isolated references. The folk acoustic-guitar reference
ranked mandolin first. Mixture rankings still confused related instruments,
and silence produced large raw cosine similarities. These are uncalibrated
rankings, not presence probabilities or permission to force the top 2/4/6
labels into outputs. The full small, non-audio evidence record is
`2026-11-05-soloaudio-research.json`. Experiment code and local WAVs remain in
`/tmp/stem-source-research-20261105`.

## Exact remaining steps and access

No accepted detector/separator pair exists, so the app's audio-derived source
path is still not implemented or enabled. This is a model-quality and
validation blocker, not merely a missing UI switch. Both initial splits and
resplits must analyze the exact input bytes; a resplit uses the selected saved
stem, not its original parent recording or a copied instrument inventory.

The next bounded separator trial is the existing pinned SAM Audio candidate
(`geopti/sam-audio-large`, version
`d8a8a4fcdcbf0bdc863f6d98cd2117ec0bc02224b576c7b98b2a009a8a1f83fa`).
Use at most three ten-second reference excerpts, one prediction per excerpt,
no automatic resubmissions, and a provider `Cancel-After: 120s` deadline. At
the published L40S rate of $0.000975/second, three full deadlines represent
$0.351 of nominal compute, within the previously approved $0.50 test budget.
Recheck the pinned version/schema and current hardware/rate before starting;
do not interpret a typical per-run estimate as a spending cap. Record any
uncertain start and reconcile it before another call. This is separator
evaluation only; it would not validate automatic discovery or the 18 app cases.

No Replicate credential is available in this task's environment or its expected
local configuration files. The smallest next input is access to the existing
`REPLICATE_API_TOKEN` in the local task environment, without creating a new
credential or posting it in chat. Firefox's CUNY session does not provide this
provider credential. No paid call has run. Local SAM weights additionally need
gated model access; that access was not requested or bypassed.

The three-genre release matrix also needs exact reviewed instrument inventories
and suitable recordings with enough genuine sources, including a parent output
that remains meaningfully separable for each resplit case. Existing orchestral,
jazz, and bluegrass audio is available, but documentary instrumentation alone
does not satisfy that ground truth. The two MedleyDB samples improve reference
evidence without closing the full matrix. Do not manufacture silent outputs or
label an already isolated instrument as six new instruments.

Publication remains held: the previous push/PR denial was not retried, and no
new merge, deploy, sign-in, paid call, or restricted Library access occurred.

## Checkout recovery and UI verification

The original iCloud-backed checkout has offloaded Git metadata that reports its
recorded size but returns no bytes. Finder Download Now and Foundation's
documented download/coordinated-read APIs did not restore it. The original
checkout was preserved. A separate checkout was cloned from public `dev` at
`20c84c3fcd543d7d1f4304d28e2b788d5a036af3`. Its recovered source was checked
against all 791 entries in the readable saved Git index from `30d82e4`.
Only the three expected playback-fix files differed at that checkpoint; the
subsequent removal of the search and “Split into” headings is recorded in Git.
Four new release-check files were recovered from the verified test copy. The
earlier untracked instrument-label documentation remains in the original
checkout and could not be read; this document records the current result.

Before the final heading removal, the candidate passed 207/207 Chromium browser
tests, 32/32 Firefox playback tests, three typechecks, and a Cloudflare production
dry build. After recovery, all 421/421 shared tests passed with real Git history
and local fixture HTTP access. Earlier failures caused by missing type files,
missing Git history, or blocked loopback sockets are retained as environment
failures, not concealed or counted as application passes. The prior unchanged
Cloudflare adapter and server receipts were 431/431 and 44/44 respectively.

These are local/synthetic application checks, not proof of live provider
quality, real CUNY persistence, or production deployment. Firefox's existing
signed-in workspace was separately observed. Publication has not been retried,
and no merge, deploy, production data change, or paid split has run.

The final upload area shows the search field directly beneath the upload control,
without a search heading, repository selector, accordion, or “Split into” heading.
The 2/4/6 control retains its accessible name, “Number of splits.” The affected
desktop/phone layout and synthetic import flows passed 16/16 Chromium checks,
and the final layout/menu checks passed 3/3 in isolated muted Firefox. The final
Cloudflare dry build also passed. The earlier 207-case run predates this final
HTML/CSS-only cleanup and is not presented as a fresh run of that cleanup.

The continuation found one remaining visible “Split into” label in the resplit
dialog and removed it too. The count selector retains `aria-label="Number of
splits"`. The existing sharing/resplit test passed 1/1 in Chromium and 1/1 in
isolated muted Firefox, including cancel/retry and preservation of uploaded
stem bytes. A fresh Cloudflare dry build passed. These synthetic identity and
provider checks do not establish real provider behavior or a deployment.
