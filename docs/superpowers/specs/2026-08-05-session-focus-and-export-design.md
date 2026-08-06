# Design: Session focus on new upload + per-song session export

**Date:** 2026-08-05
**Status:** Approved

## Goal

1. When a student uploads (or imports) a new song, the previous sessions in the
   rack should get out of the way so the new song is the focus — **without
   deleting anything**. Earlier consoles collapse to a one-line head; one click
   reopens them.
2. Students can export a finished session as a single ZIP: the stem MP3s plus a
   markdown file containing the listening guide, the Listening Guy chat
   transcript, the shared time-anchored notes, and the (relabeled) track names.

## Non-goals

- Deleting jobs client- or server-side (the 30-day R2 lifecycle remains the only
  cleanup; class-shared notes on old jobs survive).
- A server-side export endpoint or new storage — the ZIP is assembled entirely
  in the browser from data the page already has.
- Exporting the original uploaded song (copyright posture: originals are never
  served back out).

## Collapse-on-new-upload

- Job entries in localStorage gain a `collapsed` flag. `addJob()` marks every
  existing entry collapsed and inserts the new job expanded.
- A collapsed **done** console renders only its head row (title, READY badge,
  EXPORT, expand caret) via a `.collapsed` CSS class; the Mixer instance and all
  its state (chat history, players) persist in the `mixers` Map.
- Collapsing a playing console pauses it first — no invisible audio.
- Each console head gets a ▾/▸ toggle; the choice persists per job in
  localStorage. Processing/failed cards are unaffected (they stay visible while
  active).
- No confirmation dialog: since nothing is destroyed, the prompt would be noise.

## Session export (ZIP)

- EXPORT button on each done console head. Clicking it:
  1. Fetches each stem MP3 from `/api/files/stems/…` (same URLs the players use).
  2. Builds `guide-chat-and-notes.md`: export date, model, track labels, guide
     text (if generated), notes as `m:ss — text` bullets, and the client-held
     chat transcript (last ≤12 turns — the same window the coach itself sees).
  3. Packs everything into a ZIP with a minimal in-page ZIP writer (store
     method, CRC-32, UTF-8 names — no compression, since MP3s are already
     compressed, and no library/CDN dependency).
  4. Triggers a download named `<song>-export.zip`; stems live under `stems/`
     named by their current (possibly student-edited) labels, deduped on
     collision.
- Failures (expired stems, network) surface through the existing upload-status
  message strip; the button re-enables.

## Accepted trade-offs

- The chat transcript is per-browser and capped at 12 turns; the export captures
  what the current student's session holds, not a class-wide history.
- The ZIP is assembled in memory (~50 MB worst case for six stems) — fine at
  class scale on modern machines.
