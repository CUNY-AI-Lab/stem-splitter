# Plan: Workshop stations — Splitter | Remixer

**Design:** `docs/superpowers/specs/2026-09-01-splitter-remixer-stations-design.md`
**Date:** 2026-09-01

The station UI and crate move use `public/index.html`, `public/styles.css`,
and `public/app.js`. Task 5 extends the existing chat route and governed prompt.
There are no migrations or new secrets.

## Task 1 — `public/index.html`

- `role="tablist"` bench tabs (01 · SPLITTER / 02 · REMIXER) above the shared
  masthead; station word and tagline get ids for the swap.
- Wrap existing sections in `#view-splitter` (tabpanel); add the "next
  station" aside at its foot.
- New `#view-remixer` (tabpanel, hidden): shelf, remix deck (transport,
  layers, takes), devil's advocate panel, then the crate markup moved
  verbatim (ids intact so crate JS is untouched) plus `#crate-import-status`
  and the remix-clearance note.
- Bump both `?v=` cache-busting params.

## Task 2 — `public/styles.css`

Append: bench tabs (amber current-tab, bench-edge rule), station-next aside,
shelf items/chips/stem pulls, remix transport (`rplay`, `rt-*`), layer rows
(`rlayer`, `rl-*` flags, per-stem `--ch` color vars), takes, devil's-advocate
panel (`da-*`, red accent vs. the coach's amber), crate note/import status,
and a small-viewport block. No existing rules edited.

## Task 3 — `public/app.js`

- Stations: `STATIONS` copy map, `switchStation()` (visibility, aria,
  masthead swap, `benchTab` persistence), `setSplitterKicker()` threaded
  through the two `splitSummary` writers, `initStations()` (clicks, arrow
  keys, `#remixer` hash, ?job= forces splitter).
- Shelf: `renderShelf()` from `getJobs()` + `jobStates`, called from
  `renderJobs()` so polling keeps it live.
- Deck engine: `remix` state, layer add/remove/clear, gain→pan→master graph,
  wall-clock timeline (`remixNow`), entry timers, drift herding, loop math,
  reversed-buffer cache, TAPE via `preservesPitch`, capture via
  `MediaStreamAudioDestinationNode` + `MediaRecorder`, takes list.
- Mixer: SEND TO REMIXER button in the console sub-line
  (`.share-btn:not(.to-remix-btn)` keeps COPY LINK's binding).
- Crate: `showCrateImportMessage()` mirrors import status into the crate.
- Devil's advocate: `daSend()` mirrors `Mixer.sendChat()` against
  `/api/jobs/:id/chat` with the deck snapshot in the user turn;
  `daHandleToolCalls()` maps solo/set_mute onto layers and narrates the rest.
- Init: `initStations()`, `initRemixDeck()`, `initDevilsAdvocate()`.

## Task 4 — Specs

- `local-hosting.spec.mjs` (both crate tests) and
  `live-archive-crate.spec.mjs`: click the REMIXER tab before BROWSE THE
  CRATE; the live spec returns to SPLITTER before the `.dl` download click.

## Task 5 — Server-side remix register (same-day follow-up)

Promote the devil's advocate from client-side framing to a Listening Guy
variant tailored to the task:

- `src/assistant/types.ts`: mode `'remix'` + optional `deck` on the context.
- `src/assistant/prompt.ts`: remix deck data fence, "ACTING ON THE DECK"
  tool rules (solo/set_mute only, ≤2 calls), devil's-advocate task block;
  bump `SYSTEM_PROMPT_VERSION` → 2026-09-01.1; fourth fingerprint variant.
- `src/assistant/tools.ts`: `buildMixerTools(names, 'deck')` surface +
  `sanitizeToolCalls` allowed-name filter.
- `src/assistant/index.ts`: `streamChat` options `{ mode, deck }`,
  `MAX_DECK_CHARS` (1000), deck-aware narration follow-up.
- `src/index.ts`: chat route validates `mode` ('chat' default | 'remix') and
  `deck` (string, trimmed, capped).
- `public/app.js`: DA sends `mode: 'remix'` + `deck`; history holds only the
  student's typed text.
- `docs/prompt-changelog.md` entry; governance test covers the new arm;
  `tests/assistant-remix-tools.test.mts` pins the tool narrowing.

## Verify

- `node --check public/app.js`; CSS brace balance.
- `npx playwright test --config playwright.config.mjs` (full mocked-provider
  browser suite, crate tests included).
- Manual pass in the browser: tab switch, shelf pull, layered playback with
  REV/TAPE/LOOP/IN, capture take, devil's-advocate stream against a real key
  or the documented 503 when unconfigured.

## September 7 reconciliation

- Preserve the original feature above current main and its current README.
- Keep takes reachable after clearing the deck and keep each recording's
  chunks local to that recorder, including when another take starts promptly.
- Release cached reverse buffers when their final layer leaves the deck;
  ignore decode completion for removed layers. Require loaded duration before
  reverse and verify the decoded duration cap, reversing samples in place.
- Surface load/playback failures and preserve the student's current layer
  settings when an assistant reply arrives after an arrangement edit.
- Add `test:workshop` to CI: actual Node host/browser/storage integration,
  native recording/save, existing data readback, and deterministic chat
  protocol acceptance with an explicitly substituted model response.
