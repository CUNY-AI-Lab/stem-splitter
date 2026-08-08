# Audio fixtures

These are deterministic, two-second audio files committed for the browser
end-to-end suite:

- `source.wav` is a 16-bit, 16 kHz mono PCM mix.
- `vocals.mp3`, `drums.mp3`, `bass.mp3`, and `other.mp3` are 64 kbps,
  16 kHz mono MPEG Layer III files, peaking around −18 dBFS.
- `quiet.mp3` is the same format peaking around −64 dBFS: quiet, but not
  digital silence. It stands in for a track the model had nothing to find for —
  `guitar` and `piano` on orchestral material — and exists to prove that the
  blank-stem gate rejects unplayable audio without also rejecting quiet audio.

They contain locally generated sine tones and no third-party recording. The
suite passes `source.wav` to Chrome as a filesystem path, serves the MP3 files
at the mocked provider boundary, and checks their stored bytes exactly. This
keeps the upload and media-decoding path file-real while avoiding a
copyrighted or network-fetched fixture.
