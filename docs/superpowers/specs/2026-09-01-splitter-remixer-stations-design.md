# Design: Workshop stations — Splitter | Remixer

**Date:** 2026-09-01
**Status:** Approved

## Goal

Reshape the single-page app into a two-station makerspace. Discrete upper-left
tabs divide the page into **01 · SPLITTER** (the existing flow: insert a track,
split it, listen and annotate in the Session Rack) and **02 · REMIXER** (the new
reverse flow: pull finished layers back onto a deck and reconstruct them into
new remixes and experimental forms). The Splitter's progression points forward
to the Remixer; the Crate of openly licensed songs and audio — musical and not —
moves to the Remixer, where it belongs as remix source material. Listening Guy
gets a second register there: devil's advocate, arguing against the student's
arrangement instead of opening the song up.

The pedagogy is the point: splitting is analysis, remixing is synthesis, and
the devil's advocate makes the student defend the choices between them.

## Why tabs and not a second page

One page keeps every piece of working state alive: mixers keep playing, the
crate keeps its search, jobs keep polling. The tabs flip `hidden` on two
`role="tabpanel"` wrappers and nothing else — no teardown, no re-fetch, no
second HTML entry point to version. A second page would fork `app.js` state
(localStorage job list, jobStates, class code) across documents for no gain.

## Station 01 — Splitter (unchanged flow, new hand-off)

- Existing sections unchanged: dropzone, YouTube disclosure, split picker,
  upload status, Session Rack, instructor folders.
- Each finished console gains **SEND TO REMIXER** beside COPY LINK: stacks all
  of that split's stems on the Remixer deck and switches stations.
- A closing "next station" aside points to the Remixer.
- The masthead is shared; the station word (SPLITTER/REMIXER), tagline, and
  kicker swap on tab change. Async split-option loads write the kicker through
  `setSplitterKicker()` so a slow load cannot stamp splitter copy onto the
  Remixer masthead.

## Station 02 — Remixer

Order mirrors a work progression:

1. **The Shelf** (`01 · pull layers`) — every job in the local rack, rendered
   as remix material: finished splits expand into per-stem pull buttons (class
   labels honored) plus STACK ALL; in-flight splits show as SPLITTING…, so a
   crate import is visible from here without changing tabs.
2. **Remix Deck** (`02 · stack & bend`) — the reverse of the Splitter's fan-out.
   Each layer is an `HTMLAudio` routed through gain → stereo-pan → master gain
   (the shared page `AudioContext`), with per-layer: volume, pan, entry point
   (IN seconds), speed (0.5–1.5×), TAPE (pitch follows speed via
   `preservesPitch=false`), LOOP, MUTE, and REV — backwards playback from a
   decoded, sample-reversed `AudioBuffer` played on a `AudioBufferSourceNode`
   (10-minute decode cap; one decode per stem URL, shared across layers).
   Transport is play/pause/stop plus a running timecode — deliberately no
   master seek bar, because per-layer rates and loops mean the remix timeline
   is not the song timeline. A wall-clock master timeline starts layers at
   their entry points and herds `HTMLAudio` drift (600 ms tick, 250 ms
   tolerance, loop seams excluded); a remix with no loops auto-stops.
   **CAPTURE** bounces the deck: master gain also feeds a
   `MediaStreamAudioDestinationNode` recorded by `MediaRecorder`
   (webm/opus first, mp4 fallback), takes listed with inline players and a
   SAVE link. Capture is hidden where `MediaRecorder` or Web Audio is missing.
3. **Devil's advocate** (Listening Guy) — see below.
4. **The Crate** — moved wholesale (same element ids, same server routes, same
   licence floor). Reframed copy: openly licensed songs & sounds, musical and
   not; a note explains imports run through the Splitter and land on the shelf
   when ready. Import status now mirrors into a crate-local line
   (`showCrateImportMessage`) because the splitter's upload strip is on a
   hidden panel while importing from here.

## Devil's advocate

Same voice, opposite job — no new server surface. The panel rides the existing
`POST /api/jobs/:id/chat` endpoint against the source split whose layers
dominate the deck (most layers wins). Each user turn carries a bracketed deck
snapshot (layers, sources, reverse/speed/loop/entry/pan/mute states, ≤900
chars) as fenced student data, so the critique is about the actual stack;
CHALLENGE ME sends a canned turn asking for the weakest choice, the case
against it, and one riskier experiment. History is client-held (≤12 turns,
2000-char cap respected), streaming and rendering mirror the coach. Replies
may carry mixer tool calls: `solo`/`set_mute` translate onto matching deck
layers; `seek`/`add_note` are narrated as Splitter-side suggestions, never
executed — the deck has no song timeline to seek.

## Non-goals

- No persistence of the deck or takes (localStorage or server). A remix is a
  session object; EXPORT-style durability can come later if teaching wants it.
- No server changes of any kind: no new routes, no schema change, no prompt
  version bump. The devil's advocate framing lives entirely in the user turn.
- No offline rendering (`OfflineAudioContext`) bounce; CAPTURE records the
  live transport instead.

## Test posture

The crate e2e coverage moves with the crate: specs click the REMIXER tab
before BROWSE THE CRATE, and back to SPLITTER before interacting with the
finished console (count/text assertions pass on hidden panels; clicks do not).
New UI classes (`shelf-*`, `rlayer/rl-*`, `da-*`, `bench-tab`) deliberately do
not reuse `badge`, `channel`, `coach-*`, or `play-btn`, which live specs match
with strict-mode locators.
