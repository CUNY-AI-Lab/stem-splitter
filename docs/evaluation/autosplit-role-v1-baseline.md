# AutoSplit role v1 genre baseline — 2026-08-09

This is the pre-tuning baseline captured locally from the eight authorized file
sources in `tests/corpus/corpus.json`. Audio remains gitignored. The run used
the same 22,050 Hz, 45-second beginning/middle/end analysis path as the planned
service, with local FFmpeg 8.1.2. It is calibration evidence, not a Railway or
FFmpeg 8.0.3 release result.

| Source | Coverage | v1 choice | Reviewed range | Result |
|---|---|---:|---:|---|
| folk-duet | folk, sparse acoustic | 6 | 2 or 6 | preferred |
| orchestral | strings, brass, woodwinds | 2 | 2 | preferred |
| shoegaze | rock, dense electric guitar | 4 | 4 or 6 | accepted |
| piano-strings | piano, bowed strings | 4 | 4 or 6 | accepted |
| jazz-sax | reeds, bass, drums | 2 | 4 or 6 | **investigate** |
| hip-hop | rap, synth bass, programmed percussion | 4 | 2 or 4 | preferred |
| bluegrass | fiddle, banjo, mandolin, upright bass | 4 | 4 or 6 | accepted |
| synthwave | synthesizer, synth bass, programmed drums | 6 | 2 or 4 | **investigate** |

Two outcomes block authority. On jazz-sax, sustained reeds suppressed distinct
onset peaks enough that v1 treated the ensemble as voice-like sustain and chose
two despite audible bass and drums. On synthwave, harmonic programmed attacks
looked plucked/hammered and chose six even though they do not establish useful
guitar/piano channels. The follow-up must version each routing change, rerun
deterministic PCM and all eight real sources, and preserve the orchestral
two-track result. No instrument label may be converted into a core stem.
