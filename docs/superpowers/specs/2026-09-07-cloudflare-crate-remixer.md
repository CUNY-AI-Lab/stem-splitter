# Cloudflare Remixer: Crate to song

## Product boundary

Cloudflare candidate only. Railway remains on its existing production build;
do not deploy this work to Railway. Keep `REMIXER_ENABLED` false until the
candidate's signed-in live workflow and release gates are accepted.

Listening Guy retains its original Splitter guide/chat prompt and tools.
There is no assistant panel, adversarial persona, debate, or challenge shortcut
in Remixer. Historical plans describing those are superseded.

## Implemented workflow

1. Open Remixer. The Crate comes first; the optional stem shelf is hidden when
   empty. Search Music or All open audio and inspect source/license details.
2. PREVIEW delivers validated Archive audio through the authenticated
   Cloudflare app. ADD TO MIX reuses those bytes as a whole-track layer.
   SPLIT is a separate, optional action that still uses the existing provider.
3. Combine up to eight layers. Set volume, pan, entry time, speed, tape mode,
   reverse, loop, and mute. Remove unwanted layers. Existing stem handoff stays.
4. Name the song, choose a length from 1 to 600 seconds, preview, and CAPTURE.
   Recording starts at the beginning and stops at the chosen length or earlier
   when a non-looping arrangement finishes. END TAKE stops recording/playback.
   Arrangement controls cannot change a frozen recording.
5. SAVE WITH CREDITS downloads a ZIP containing browser-recorded audio
   (WebM/Opus or M4A, according to browser support), ATTRIBUTION.txt and
   remix.json. Clearing the deck does not remove existing takes.

## Delivery and rights boundary

`POST /api/remix/archive-audio` is available only with CAIL authentication and
the Remixer flag. The Worker enforces same-origin writes and ingress limits.
It accepts an Archive identifier/file, never an arbitrary download URL.
Metadata/license, redirects, timeout, audio signature, declared file size and
a 10 MiB per-track cap are checked before audio reaches the browser. There is
no server-side source copy, database migration, or paid separation for this path.
At most eight source files are retained in browser memory for the session.

The existing reviewed license resolver blocks incompatible multi-source
exports; it also checks new raw layers before adding them. Downloads identify
each original title, creator, source URL, license and filename. Unknown/ported
terms remain blocked pending review. Local browser edits are not rights proof.

## Further UX work, in order

- Clip selection: waveform overview, trim start/end, then loop regions. Use one
  clip-time model for preview, speed/reverse and export; test their combinations.
- Arrangement: visible timeline, drag/numeric placement, duplicate clips,
  fades, undo/redo, keyboard/touch equivalents, and audible clipping feedback.
- Recoverable projects: explicit browser-local autosave/reopen and project
  export/import, with bounded storage, per-account isolation, source-expiry
  handling and no claims of server persistence.
- Export: offline WAV rendering and progress/cancel after preview/render parity
  is proven; keep credits inseparable from the delivery bundle.
- Live acceptance: signed-in Crate access, real authorized multi-source audio,
  mobile/iOS playback, complete audio inspection, long-session memory stress,
  denied licenses/expired membership, and a reviewed feature-flag promotion.

Local fixture-browser screenshots are not live-provider or production evidence.

## Local verification

- 319 shared unit tests, 42 server tests and 12 Cloudflare adapter/security
  tests pass. Root, server and Cloudflare typechecks pass.
- Two Cloudflare browser scenarios passed using fixture upstream audio: the
  original signed-in flow and Crate-to-recording-to-credited-download workflow.
- The broader browser run completed 18 of 19 tests successfully. The remaining
  export assertion checked transient confirmation after filesystem inspection;
  it now observes confirmation alongside the download. Its isolated rerun
  timed out during browser setup/teardown, so this correction is not yet verified.
- No commit, remote push, deployment or feature-flag promotion was performed.
  Railway's live frontend and deployed system prompt match the original main
  versions; it has none of the adversarial Remixer changes.
