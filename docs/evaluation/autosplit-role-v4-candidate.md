# AutoSplit role v4 candidate — 2026-08-10

This is local source and composition evidence, not release acceptance. The
candidate preserves the frozen two-, four-, and six-track separator contracts.
No Railway variable, service, deployment, or paid separation changed, and
server Auto remains off live.

## Miss that triggered the version change

A composed app-plus-real-analyzer test sent the same two-second sustained
fixture through all three authoritative source paths. The upload and Internet
Archive WAVs selected two tracks, but the YouTube-shaped AAC/M4A transcode
selected four. AAC priming or padding introduced one isolated boundary peak;
on a short source, counting that single peak as a rate produced roughly 0.5
onsets per second and falsely satisfied the moving-low rule.

Mocked analyzer E2E could not reveal this failure because it supplied a
prebuilt routing response instead of decoding the stored media.

## Candidate change

Role v4 requires at least two refractory-separated onset peaks before any
onset-derived routing feature becomes nonzero. One isolated peak is not
repeating attack evidence. Once two peaks exist, their complete count and the
existing duration-normalized thresholds apply unchanged. The same support rule
also governs pitched-attack counting.

A direct regression proves that one boundary-like peak over a low drone stays
on the two-track route while two separated peaks still exceed the four-track
onset threshold. The classifier identifier changes from `autosplit-role-v3` to
`autosplit-role-v4`; this is not treated as an invisible threshold edit.

## Real composition result

The new integration test composes the Wrangler app harness with the actual
`audio-analysis` service implementation, actual signed-source URL policy,
actual FFmpeg decode, actual AutoSplit classifier, source hashing, and temporary
file cleanup. It mocks only the external YouTube-media, Internet Archive, and
Replicate-separator boundaries.

For upload WAV, YouTube AAC/M4A, and Archive WAV, respectively, the test proves:

- the app stores or freezes the source before invoking analysis;
- the analyzer fetches the app-minted `auto-inputs/v1` or `uploads` URL and
  returns HTTP 200 under `analysis-source-scope-v2`;
- every applied result reports `autosplit-role-v4` and a non-degraded decision;
- all three equivalent sources resolve to the concrete
  `vocals_instrumental` contract; and
- Replicate receives `htdemucs_ft` with `stem: vocals`, never `model: auto`.

Wrangler's in-process external-service proxy redacts `Authorization` before
the request reaches the test interceptor, so this composition test restores a
known fixture bearer token at that seam. The separate HTTP-adapter regression
continues to prove that the app emits the analyzer bearer header. Neither test
prints the token, source URL signature, or raw feature arrays.

## Genre-diverse corpus result

Local FFmpeg 8.1.2 decoded the fixed eleven-source corpus to 22,050 Hz mono PCM
under role v4. The result remains 8 preferred choices, 3 accepted alternatives,
and 0 mismatches. No source changed its v3 choice:

| Source | v4 choice | Result |
|---|---:|---|
| folk-duet | 6 | preferred |
| orchestral | 2 | preferred |
| shoegaze | 4 | accepted alternative |
| piano-strings | 4 | accepted alternative |
| jazz-sax | 4 | preferred |
| hip-hop | 4 | preferred |
| bluegrass | 4 | accepted alternative |
| synthwave | 4 | preferred |
| electronic-stiff-hand | 4 | preferred |
| electronic-back-counting | 4 | preferred |
| electronic-house | 4 | preferred |

This protects the existing folk, orchestral, jazz, hip-hop, bluegrass, and
electronic controls while closing the short imported-codec discrepancy. It
does not broaden the still-limited sensitivity of the six-track route.

## Real-browser comparison

Headless Chrome 151.0.7922.76 decoded the same eleven files through Web Audio,
resampled them from 48,000 Hz to the fixed 22,050 Hz classifier rate, and ran
role v4 in the browser worker. Its decisions agree with local FFmpeg 8.1.2 on
11/11 sources, with 0 rejected choices. The maximum observed absolute feature
deltas remain 0.04454 onsets/s, 0.02227 pitched attacks/s, 0.02444 sustained-low
share, and 0.00496 percussive-high share; none crosses a decision boundary.

## Compatibility and rollback

- The app and analyzer compile the exact v4 pin. A stale v3 analyzer response
  is rejected as `analysis_contract_invalid` and routes to the frozen default.
- The analysis schema, source-scope version, concrete provider models, and
  two-/four-/six-track contracts do not change.
- With `SERVER_AUTO_ENABLED=false`, existing browser-side Auto and explicit
  model behavior remain unchanged. The immediate live rollback remains the
  same flag-off posture.
- Corpus manifests, query-isolation provenance, browser E2E fixtures, service
  tests, and the constrained-image smoke all carry the new pin together so a
  partial version change fails a gate.
- The earlier role-v3 image results remain immutable historical evidence. They
  do not accept the current role-v4 source.

## Gates still open

- Build and run the role-v4/source-scope-v2 image on native amd64 CI, then
  reproduce it on Railway with measured CPU, memory, FFmpeg child-process,
  concurrency, timeout, and ephemeral-disk behavior.
- Repeat the fixed corpus with the pinned FFmpeg 8.0.3 image; local FFmpeg and
  real-browser v4 agreement does not substitute for that deployment decoder.
- Manually listen to the rollback baseline and candidate stems by genre.
- Provision the private `audio-analysis` service with Auto still off, then run
  shadow upload, YouTube, Archive, outage, timeout, restart, and rollback
  journeys before considering server authority.
