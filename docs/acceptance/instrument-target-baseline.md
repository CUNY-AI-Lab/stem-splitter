# Instrument extraction baseline and release checks

The default remains four fixed model outputs, with manual two-, four- and six-part choices. Optional instrument extraction requests an additional target such as saxophone or piano. A requested name is not evidence that an instrument was detected or successfully isolated. Optional targets can overlap and do not form a reconstruction of the original mix.

## Before deployment

Freeze the exact release commit, provider/model version, non-secret capability flags and artifact hashes. Record production and Dev separately, including Worker version, traffic allocation, public hostname and asset hashes. Previous deployment receipts do not establish current state. Keep the original input and previous outputs unchanged.

The existing local baseline uses the publicly sourced recording “Tab Steps Out” by Tab Smith and His Orchestra. Its original MP3 SHA256 is `67d054858fae699e70a49379e4925dd778573f327cf8f33830530a8f8f1fee63`. Its seven existing measurements cover the source and six previously saved outputs. The six outputs are a known defective comparison, not an approved quality reference. The source's strongest 150 ms contains approximately 0.313% of its energy; several old outputs concentrate most of their energy in a short end burst. That difference establishes an output defect, without establishing its model-level cause.

Local evidence is kept outside the repository in `output/stem-instrument-isolation-20261103/baseline/audio-baseline.json`. It freezes hashes of the original, old outputs, measurement file and analysis script. Do not commit the audio, account metadata or private object locations. Preserve the original measurement timestamp separately from the time its hashes were frozen.

## Repeat the same checks on Dev and production

| Area | Baseline and post-deployment check | Evidence required |
| --- | --- | --- |
| Release identity | Exact source, Worker version, public host, traffic and assets | Separate dated receipts for each environment |
| Defaults | Unset choice is four; explicit two/six remains selected; obsolete Auto choice recovers truthfully | Silent browser assertions, desktop and phone |
| Input | Same source hash, full decode, duration, channels, sample rate and peak | Offline decoder report; no speaker output |
| Core stems | Correct count, decodable files, comparable duration; inspect silence, clipping, duplicates and end bursts | Per-file hashes and measured values; compare with original |
| Target request | Requested name and pinned provider identity match the saved result | Request/result metadata, without tokens or signed URLs |
| Target quality | Compare target presence, unwanted bleed, missing passages and artifacts against the original | Real evaluated model output; fixtures cannot establish this |
| Persistence | Refresh/reopen retains status and private output access; core files remain unchanged | Before/after hashes and saved-state readback |
| Safety | Cross-account denial, source hash mismatch, budget exhaustion, malformed output and redirects | Local synthetic regression results |
| Interruptions | Duplicate submit and uncertain provider acceptance never start another prediction automatically | Provider-call count and durable-state assertions |
| UI | Keyboard operation, readable labels, phone layout, explicit errors and draft recovery | Muted browser checks and screenshots |

A deploy smoke check must not create another model prediction just to verify routing. Reuse an authorized finished result where possible. Local fixtures establish mechanics only. Real extraction evaluation is a separate funded operation; deploying code does not authorize additional paid calls.

## Acceptance limits

All automated checks remain silent. No test should call `play()` or unmute audio. Offline decoding and analysis can detect gross corruption but cannot by themselves prove that a saxophone or piano was isolated. Listening evaluation, if later requested, requires an explicit change to the user's no-audible-playback instruction and can be performed outside the user's speakers.

Do not claim quality improved merely because playback works, a file has a requested label, or peak levels changed. The current trusted service injection is not constructed by production adapters, so this feature remains disabled until a reviewed deployment/configuration path and model evaluation are complete. Record blocked, failed and skipped checks alongside passes. A disabled feature is not a successful target-extraction acceptance test.

## Activation is separate from this infrastructure change

No production adapter constructs `InstrumentTargetSession`. Its constructor requires a trusted sponsor-authorization callback; this change supplies no real implementation of that decision. Existing reservations still use `course-semester-provider-starts-v1` and the `teacher_beta` stage. They must not be relabeled as personal funding or assigned a made-up course. A recording owner or a valid Lab account alone is not authority to spend a course sponsor's allowance.

Before activation, either an actual course sponsor must explicitly authorize the subject and recording under its bounded policy, or a separately reviewed app/personal sponsorship policy and honest ledger scope must be implemented. Course enrollment must not become a new condition for ordinary personal Stem use. The adapter must recheck sponsorship before dispatch. The deploy and model-test plan must name its sponsor, allowed recordings and maximum provider starts; a price estimate is not a spending cap.

The extraction service can be reviewed and tested while disabled. Publishing this code does not complete an instrument-aware release or establish that the optional target sounds usable. No production, Dev, secret or budget configuration changes are part of the local test evidence.
