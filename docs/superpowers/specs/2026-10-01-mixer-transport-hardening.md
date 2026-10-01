# Mixer transport hardening

The reported Firefox failure is a timer and slider stuck at 0:43 while audio
continues, after a seek and a bass ONLY -> vocals FRONT switch. The precise
production event ordering is not captured. A normal run of that public split
in automated Firefox advanced from 0:43 through 0:50; do not describe that as
reproducing the intermittent report.

## Required behavior

- The transport displays the first stem's actual media clock, never a wall-clock estimate.
- Dragging previews a position without repeatedly seeking all audio buffers.
  Release commits once. Missing change, late input, cancellation, lost capture,
  keyboard input and changing controls must not leave preview latched forever.
- Media time updates also refresh the display if animation frames are suspended.
  A failed decorative analyser must not stop timer updates.
- FRONT, ONLY and ordinary playback retain their existing meaning. MUTE on the
  audible focused instrument ends its focus and silences it. Other stored mute
  choices are retained. Explicitly focusing a muted instrument still auditions it.
- A pending playback start can be cancelled and is bounded to 15 seconds; a failed
  start pauses all stems and offers a concise retry message. Retry and collapse
  must not leave a stale start or duplicate playback loop.
- Seek targets must be finite and clamped to the media duration.
- If any stem's actual clock fails to advance for five seconds during playback,
  pause the whole mix and show a retry message rather than silently continuing
  with missing or misaligned instruments. Seeking resets that observation window.

## Boundaries

Cloudflare branch only; no Railway release, provider changes, account/data writes,
or schema changes. Shared frontend code must retain legacy class-code behavior.
Automated tests use generated 70-second tones with range-capable delivery and
actual media clocks; they are playback tests, not separation-quality or listening
acceptance. Firefox, Chrome, desktop and narrow layout are release checks.
