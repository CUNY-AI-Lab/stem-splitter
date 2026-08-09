# AutoSplit role v3 candidate — 2026-08-09

This is local calibration evidence, not release acceptance. The candidate keeps
the frozen two-, four-, and six-track separator contracts and changes only the
role-classifier routing threshold. No Railway variable, service, deployment, or
paid separation was changed.

## Candidate change

Role v3 builds on v2's diffuse-rhythm rule and raises the pitched-attack
threshold for a six-track recommendation from 0.8/s to 1.0/s. Six tracks make a
label-specific promise that the provider's guitar- and piano-trained outputs
are likely to help; generic synthesizer attacks are not enough evidence for
that promise.

The fixed corpus now contains eleven authorized local sources. It adds two more
arrangements from the original MT-32 album and one independently authored CC0
house/electro recording, so the electronic negative control does not depend on
one song or one album alone. Hydrated audio is gitignored and checked against
its recorded Archive SHA-1 when available.

## FFmpeg-side result

The analysis-service path used local FFmpeg 8.1.2, 22,050 Hz mono PCM, and 45
seconds across beginning/middle/end windows.

| Source | v3 choice | Preferred | Accepted set | Result |
|---|---:|---:|---:|---|
| folk-duet | 6 | 6 | 2 or 6 | preferred |
| orchestral | 2 | 2 | 2 | preferred |
| shoegaze | 4 | 6 | 4 or 6 | alternative |
| piano-strings | 4 | 6 | 4 or 6 | alternative |
| jazz-sax | 4 | 4 | 4 or 6 | preferred |
| hip-hop | 4 | 4 | 2 or 4 | preferred |
| bluegrass | 4 | 6 | 4 or 6 | alternative |
| synthwave | 4 | 4 | 2 or 4 | preferred |
| electronic-stiff-hand | 4 | 4 | 2 or 4 | preferred |
| electronic-back-counting | 4 | 4 | 2 or 4 | preferred |
| electronic-house | 4 | 4 | 2 or 4 | preferred |

Summary: 8 preferred, 3 accepted alternatives, 0 rejected.

## Pinned-image reproduction

The minimized role-v3 container was built locally for `linux/amd64` and run
under emulation with the deployment pin, FFmpeg 8.0.3. It repeated the exact
table above: 8 preferred, 3 accepted alternatives, and 0 rejected. Runtime
inspection found only the six advertised demuxer families, audio decoders, and
file/pipe protocols. The bundled service also decoded WAV, MP3, FLAC, AAC-M4A,
ALAC-M4A, Vorbis-OGG, Opus-OGG, and AIFF through its authenticated HTTP path.
This closes the local pinned-decoder compatibility question; it does not
substitute for a native CI build, Railway resource testing, or listening.

## Real-browser comparison

The same eleven files were decoded through Headless Chrome 151.0.7922.76's Web Audio
path at 48,000 Hz, downmixed, then anti-alias resampled and classified in the
real browser worker at 22,050 Hz. Browser and FFmpeg decisions agreed 11/11.
Repeated `npm run eval:auto:browser` runs took about 1.0 second median and less
than 1.8 seconds maximum per source on this machine.

This diagnostic intentionally invokes the lower-level browser classifier for
all corpus files, including the 8- and 10-minute controls. Production
authoritative Auto performs no browser decode; browser-only/shadow mode skips
sources over 5 minutes or 24 MiB before allocating an `AudioBuffer`.

Raw browser and service features are omitted by default. The local diagnostic
`npm run eval:auto:browser -- --features` includes them only when threshold
work requires it.

Decoder output was not byte-identical. Maximum absolute browser/FFmpeg feature
deltas across the corpus were 0.04454 onsets/s, 0.02227 pitched attacks/s,
0.02444 sustained-low share, and 0.00496 percussive-high share. None crossed a
v3 decision boundary in this run. This comparison is materially stronger than
the deterministic shared-PCM unit fixture because Chrome and FFmpeg decoded
the original MP3s independently.

## Gates still open

- The local `linux/amd64` image passed under emulation, but the exact build and
  runtime checks must still pass on a native GitHub runner and Railway with
  measured CPU, memory, child-process, concurrency, timeout, and disk behavior.
- The 1.0/s threshold has a narrow observed margin: synthwave was 0.958/s and
  electronic-stiff-hand was 0.935/s. The pinned decoder and another browser or
  platform could still expose a boundary crossing.
- Only folk-duet currently produces the preferred six-track result. Three
  other six-preferred sources conservatively choose an accepted four-track
  alternative, so this corpus does not establish broad six-track sensitivity.
- Routing correctness does not prove separator quality. The new electronic
  sources still require the manifest's manual listening checks, especially
  whether four tracks preserve programmed rhythm/synth bass and whether six
  incorrectly promotes generic synth content into guitar or piano.
- Server authority, paid separation, and live rollout remain off until the
  native-image, listening, Railway shadow, outage, timeout, resource, and
  rollback gates in `TODO.md` pass.
- Browser resampling and classification are bounded in a worker, authoritative
  mode performs no Web Audio decode, and advisory mode has duration/byte caps.
  Those proxies still cannot exactly constrain exotic high-rate or
  multichannel compressed PCM; retire the shadow decoder after calibration or
  replace it with a streaming implementation.
