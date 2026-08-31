# v3.2 manual listening acceptance

This directory records the human musical-usefulness gate for the exact frozen
Railway rollback job. It must never contain the licensed source or stem audio.
Those files stay in the gitignored private review bundle under `output/`.

`review.json` records Zach's attributable teacher acceptance at
`2026-08-31T21:28:00.000Z`. The executable validator binds that judgment to the
frozen source, job, model, stem order, byte counts, hashes, and exact
attestation; automation did not supply the musical judgment.

## Prepare the private bundle

Hydrate the authorized baseline source, then run from the repository root:

```sh
bun run export:audio-listening -- \
  --output output/v3.2-railway-baseline-listening
```

The exporter reads the already-completed Railway job. It creates no job and
makes no provider call. Before writing anything, it verifies the canonical
catalogue and job contract, exact ordered names, byte counts, SHA-256 values,
MPEG frames, and guarded same-origin download URLs. It writes every private
file with mode `0600`.

Listen to `00-original.mp3` in full, then to `01-vocals.mp3`, `02-drums.mp3`,
`03-bass.mp3`, and `04-other.mp3` in full. Follow `REVIEW.md` and edit only the
private `review.json` draft. The reviewer must:

- use an attributable name and the role `teacher` or `domain-reviewer`;
- supply a UTC timestamp after the frozen baseline was captured;
- accept every exact check and every exact stem, or leave the decision pending;
- record useful failure notes if any track is corrupt, truncated, unexpectedly
  silent, or unsuitable for classroom use; and
- copy the fixed attestation exactly. Automation cannot supply this judgment.

Validate the completed private draft:

```sh
bun run check:audio-listening -- \
  --review output/v3.2-railway-baseline-listening/review.json
```

The validated review is committed at
`docs/acceptance/2026-08-10-v3.2-manual-listening/review.json`, sets
`manualListening` to `true`, removes `manual-listening-missing`, and reruns the
promotion gate. Any source, job, baseline-artifact, stem-order, size, hash,
review-schema, or attestation drift fails closed.
