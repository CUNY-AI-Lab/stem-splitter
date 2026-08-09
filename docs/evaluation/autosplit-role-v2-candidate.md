# AutoSplit role v2 candidate — 2026-08-09

This local run used the eight authorized files in `tests/corpus/corpus.json`,
the review targets in `tests/corpus/autosplit-expectations.json`, 22,050 Hz mono
PCM, and 45 seconds across beginning/middle/end windows. Local FFmpeg was 8.1.2;
the unrebuilt service image target is 8.0.3. This is calibration evidence, not
release acceptance.

| Source | v2 choice | Preferred | Accepted set | Result |
|---|---:|---:|---:|---|
| folk-duet | 6 | 6 | 2 or 6 | preferred |
| orchestral | 2 | 2 | 2 | preferred |
| shoegaze | 4 | 6 | 4 or 6 | alternative |
| piano-strings | 4 | 6 | 4 or 6 | alternative |
| jazz-sax | 4 | 4 | 4 or 6 | preferred |
| hip-hop | 4 | 4 | 2 or 4 | preferred |
| bluegrass | 4 | 6 | 4 or 6 | alternative |
| synthwave | 6 | 4 | 2 or 4 | **rejected** |

Summary: 4 preferred, 3 accepted alternatives, 1 rejected.

The single v2 routing change fixed the attributable jazz failure. Jazz had low
onset density (0.289/s) but independently showed sustained low energy (0.145)
and high-band percussive energy (0.196), satisfying all three diffuse-rhythm
cues. Orchestral remained two with lower values on all three cues (0.245/s,
0.081, 0.066).

Synthwave remains blocked. Its programmed harmonic attacks exceed the pitched
attack threshold (0.958/s), causing six even though the mix contains
synthesizers rather than evidence that the guitar/piano-trained channels are
useful. Do not accept this result or tune from one example. Add more authorized
electronic textures, repeat inside FFmpeg 8.0.3, and decide whether a new
feature, abstention/fallback, or later advisory classifier is justified.
