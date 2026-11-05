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
