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

Same voice, opposite job — a server-side variant of Listening Guy tailored to
the task (added 2026-09-01, prompt v2026-09-01.1). The panel rides the
existing `POST /api/jobs/:id/chat` endpoint against the source split whose
layers dominate the deck (most layers wins), passing `mode: 'remix'` and a
`deck` snapshot (layers, sources, reverse/speed/loop/entry/pan/mute states;
client caps at 900 chars, server at `MAX_DECK_CHARS` 1000). The remix
register in `src/assistant/prompt.ts` keeps the persona and every fixed
guardrail (markdown ban, one idea per message, no fabrication, instructor
amendment) but flips the job: each reply argues against the weakest or safest
choice in the fenced deck snapshot and ends with one riskier experiment or a
question that makes the student defend the choice. The toolset narrows twice:
`buildMixerTools(names, 'deck')` offers only `solo`/`set_mute` in deck
language, and `sanitizeToolCalls` drops anything else a model calls anyway —
`seek`/`add_note` never reach the browser because the deck has no song
timeline. History is client-held (≤12 turns of plain typed text), streaming
and rendering mirror the coach; returned calls translate onto matching deck
layers. The new conditional arm is covered by a fourth prompt-fingerprint
variant and `docs/prompt-changelog.md`.

## Non-goals

- No persistence of the deck or takes (localStorage or server). A remix is a
  session object; students save takes with the download link. Clearing layers
  keeps existing takes available until the page is closed or reloaded.
- No new routes, schema changes, or secrets. The existing chat route adds the
  bounded `mode` and `deck` fields described above; the fixed prompt version
  advances to 2026-09-01.1.
- No offline rendering (`OfflineAudioContext`) bounce; CAPTURE records the
  live transport instead.

## Test posture

The crate e2e coverage moves with the crate: specs click the REMIXER tab
before BROWSE THE CRATE, and back to SPLITTER before interacting with the
finished console (count/text assertions pass on hidden panels; clicks do not).
New UI classes (`shelf-*`, `rlayer/rl-*`, `da-*`, `bench-tab`) deliberately do
not reuse `badge`, `channel`, `coach-*`, or `play-btn`, which live specs match
with strict-mode locators.

## September 7 reconciliation acceptance

Owner: workshop-stations reconciliation. The affected action is reopening a
finished class split, sending its layers to the deck, recording and saving a
take, and asking the advocate to adjust the arrangement.

The browser calls the existing Node host for stored stems and remix chat. The
host reads SQLite/filesystem state and sends the bounded prompt to OpenRouter.
`bun run test:workshop` runs the actual browser, `server/index.ts`, shared Hono
routes, SQLite and filesystem adapter with isolated existing-job fixtures.
Only OpenRouter is substituted; no new separation or paid provider call is
claimed. Native Web Audio and MediaRecorder create a downloaded recording,
which FFmpeg decodes and checks for audible samples. Labels, annotations and
stem records are compared before and after. A delayed reply cannot apply
mixer actions after the student changes the arrangement.

Observed locally on September 7: 3 workshop browser tests, 316 worker tests,
42 Node tests, 19 existing browser tests, 6 Auto browser tests, and the
teacher-isolation shadow browser test pass. Both application and Node-host
typechecks pass. The workshop test also verifies no horizontal page overflow
at 390 pixels. These results cover local integration, with the provider
substitutions described above; CI and future live rollout are separate gates.

Release the reviewed server and static assets together on the active Node
service; there are no migrations or new configuration requirements. The
prompt version invalidates old guide cache identities through the existing
governance path. A future authorized rollout still needs live acceptance of
an existing split, remix playback/save, and the real assistant route. No
merge, deployment, model-quality claim, or production-state mutation is part
of this reconciliation.
