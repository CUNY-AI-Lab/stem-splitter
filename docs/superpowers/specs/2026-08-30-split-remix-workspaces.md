# Design plan: SPLIT / REMIX workspaces

**Date:** 2026-08-30

**Status:** Planning only; no public interface change is authorized by this
document.

## Product decision

Use two one-word workspace labels:

- **SPLIT** — the default and primary workspace. It decomposes one recording
  into parts and retains the current upload, import, model selection, Session
  Rack, Listening Guide, export, and teacher-folder behavior.
- **REMIX** — the secondary workspace. It houses the Crate and lets a learner
  recompose openly licensed sources by arranging them as layers.

The pair expresses the application's two complementary actions without
introducing internal language or a third product name. STEM Splitter remains
the application name; `SPLIT` and `REMIX` are navigation labels.

This release records the plan only. It does not move the Crate, expose a remix
route, change production data, or enable another service.

## Why the Crate belongs in REMIX

The current Crate is a source browser embedded below the separation workflow.
It is useful, but it lengthens the primary page and treats every discovery as
an immediate separation job. Moving it to REMIX gives source discovery its own
purpose:

1. Find material that explicitly permits adaptation.
2. Preview a track while keeping its creator and license visible.
3. Add the track—or stems derived through SPLIT—to a project as layers.
4. Arrange, trim, loop, balance, and recombine those layers.
5. Preserve a usable source and attribution record alongside the result.

The Crate remains one shared implementation and one set of Archive endpoints.
It must not be copied into two diverging browsers.

## Information architecture

Place a compact two-item workspace switch immediately below the application
heading:

```text
SPLIT   REMIX
```

Rules:

- `SPLIT` is selected when no workspace is named.
- Each workspace is reachable directly through a stable URL state such as
  `?workspace=split` and `?workspace=remix`.
- The existing `?job=<id>` deep link continues to open `SPLIT`; the job
  parameter must not be discarded while resolving the workspace.
- Switching workspaces does not delete jobs, clear the current remix, restart
  audio, or trigger a network request by itself.
- The switch is a real tablist with arrow-key behavior, visible focus,
  `aria-selected`, and one associated tabpanel per workspace.
- Mobile uses the same two labels. It must not turn either workspace into an
  unlabeled icon or hide the current song title.
- The instructor link remains discrete in the footer and outside the workspace
  switch.

The first implementation should keep the application as one progressively
enhanced page. A second HTML application, duplicate session bootstrap, or
framework migration would add state and deployment risk without helping the
interaction.

## SPLIT boundary

SPLIT initially wraps the current primary interface without changing its
meaning:

- upload and YouTube input;
- separation-model choice and authoritative Auto posture;
- upload/progress feedback;
- Session Rack, Listening Guide, mixer, export, and delete;
- teacher folders when authenticated.

The Crate moves out of this panel only after the workspace switch and REMIX
fallback behavior pass regression tests. Existing Archive job creation remains
available from REMIX through a plainly labeled `SPLIT` action.

## REMIX v1 interaction

REMIX should read as a small studio, not a second administrative dashboard.
Its first useful version contains three regions:

1. **Crate** — search, license filter, result list, preview, and add controls.
2. **Layers** — one row per clip with title, source, start offset, trim, loop,
   gain, mute, solo, reorder, and remove.
3. **Transport** — play/pause, return to start, time display, and a shared
   timeline.

The core sequence is `SEARCH → PREVIEW → ADD → LAYER → PLAY`. Empty-state copy
should teach that sequence in one sentence; it should not explain the product
architecture.

Initial scope:

- native-speed playback only;
- clip offset, in/out trim, loop, gain, mute, solo, and ordering;
- browser-local project state;
- a small practical layer ceiling, established through browser performance
  testing;
- Archive sources that pass the existing license and duration/size gates;
- a `SPLIT` action that uses the existing Archive job path;
- an `ADD TO REMIX` handoff for completed stems after the file-serving and
  provenance boundary is designed and tested.

Explicitly defer tempo detection, beat grids, time stretching, pitch shifting,
effects, automation, real-time collaboration, accounts, server project
persistence, and mixdown export. Those features should not be implied by the
first interface.

## Audio-delivery boundary

The current application deliberately never serves an uploaded or imported
original through `/api/files/*`. REMIX must not silently weaken that rule.

For Archive material, add a separate reviewed delivery contract only after the
license check has passed at item load. It may return a bounded same-source
Archive URL or a narrowly scoped streaming response. It must:

- accept only a validated Archive identifier and selected file;
- re-check the item license and continue to reject NoDerivatives material;
- follow only the existing allowlisted Archive redirect boundary;
- never expose upload, YouTube, temporary analyzer, or arbitrary storage keys;
- cap bytes, duration, redirects, and request time;
- return the provenance fields used by the project before audio is added;
- avoid writing the audio into durable project state.

Completed stems need a separate `job + stem` authorization contract. They must
not be made addressable by accepting a raw storage path.

## Project and provenance model

Start with a versioned browser-local document so schema evolution is explicit:

```json
{
  "schemaVersion": 1,
  "projectId": "local UUID",
  "title": "Untitled remix",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "sources": [
    {
      "sourceId": "local UUID",
      "kind": "archive",
      "archiveIdentifier": "item identifier",
      "archiveFile": "selected filename",
      "title": "track title",
      "creator": "credited creator",
      "detailsUrl": "https://archive.org/details/...",
      "licenseName": "display label",
      "licenseUrl": "canonical license URL"
    }
  ],
  "clips": [
    {
      "clipId": "local UUID",
      "sourceId": "local UUID",
      "timelineStartSec": 0,
      "sourceInSec": 0,
      "sourceOutSec": 12.5,
      "loop": false,
      "gainDb": 0,
      "muted": false,
      "solo": false
    }
  ]
}
```

Store identifiers and editorial state, not audio bytes, tokens, signed URLs,
or storage paths. Signed delivery is resolved just in time. Reject unknown
schema versions rather than guessing how to migrate them.

Every layer displays a compact credit affordance. A project-level credits view
deduplicates sources and records title, creator, source URL, license name, and
license URL. A future export must include the same attribution manifest.

Individually remixable sources are not automatically compatible when combined.
Before multi-source export, define and institutionally review a compatibility
policy for Public Domain, CC BY, CC BY-SA, CC BY-NC, and CC BY-NC-SA materials.
Until then, the interface must preserve each obligation and must not claim that
a combination is cleared merely because every source passed the existing
NoDerivatives exclusion.

## Delivery phases

### Phase 0 — navigation and contracts

- Add a false-default `REMIX_WORKSPACE_ENABLED` bootstrap flag.
- Add direct-link parsing that preserves `job` and rejects unknown workspace
  values by falling back to SPLIT.
- Wrap the current experience in the SPLIT tabpanel with no DOM-id or behavior
  changes.
- Add unit and browser tests for keyboard navigation, history, deep links,
  refresh, mobile title visibility, and flags-off visual equivalence.

**Gate:** with the flag off, the rendered application and all current journeys
are unchanged. With it on, SPLIT remains the default and completes the existing
upload, Archive import, mixer, guide, export, delete, and teacher-folder tests.

### Phase 1 — move the Crate

- Move the existing Crate DOM and controller into REMIX; do not fork them.
- Preserve search cancellation, pagination, Archive license checks, and current
  `SPLIT` job creation.
- Add a focused empty studio state but no layer controls yet.
- Preserve the Crate search state while switching tabs.

**Gate:** no Crate API or license regression, no duplicate event listeners, and
no loss of the selected split model when an Archive track is sent to SPLIT.

### Phase 2 — browser-local layers

- Implement the reviewed Archive preview/delivery boundary.
- Add a Web Audio transport and the v1 project schema.
- Add source preview and layer operations in small independently tested steps.
- Persist one local project only after reload, quota, corruption, and schema
  failure behavior is defined.

**Gate:** two or more licensed sources can play in sync on supported desktop
and mobile browsers; pause/resume and seeking do not drift beyond the accepted
budget; keyboard and screen-reader operation works; a failed source leaves the
remaining layers usable.

### Phase 3 — SPLIT to REMIX and export

- Add completed stems to REMIX through a job-scoped authorization contract.
- Define project duplication and recovery before supporting multiple projects.
- Add offline mix rendering only after cross-browser and memory testing.
- Generate a credits/attribution manifest with every export.
- Apply the reviewed license-compatibility policy and fail closed where the
  combination or required terms are unresolved.

**Gate:** rendered duration, channel layout, clipping, source attribution,
license trace, deletion behavior, and a real listening pass all succeed.

### Phase 4 — classroom hardening

- Evaluate optional teacher-provided starter projects without exposing private
  prompt or credential state.
- Add project size and source-count policy only if classroom evidence requires
  it.
- Measure low-memory mobile behavior and AudioContext recovery.
- Decide whether server persistence or sharing has an educational need before
  adding accounts, storage, or another service.

## Breaking-change shields

- Keep the new workspace behind a false-default flag until every phase gate is
  evidenced.
- Do not change existing job, stem, Archive, teacher, or Listening Guide
  response contracts merely to fit the REMIX UI.
- Preserve the `jobs` and `classCode` local-storage keys. Use a distinct,
  versioned remix key and test migration before changing it.
- Never persist signed URLs, credentials, raw audio, or provider responses in a
  remix project.
- Never let REMIX start paid separation or model inference implicitly. `SPLIT`
  is a deliberate action with the current cost and progress feedback.
- Keep Auto and instrument discovery decisions independent from the workspace
  change.
- Do not provision another Railway service for navigation or the browser-local
  prototype.
- Do not include REMIX in the Cloudflare migration critical path; it must first
  work and be released on the active Railway architecture.

## First implementation slice

The next implementation branch should include only Phase 0 and the non-layering
portion of Phase 1:

1. false-default bootstrap flag;
2. accessible SPLIT / REMIX switch and URL state;
3. current page wrapped as SPLIT without behavior changes;
4. the existing Crate moved—not copied—into REMIX when the flag is on;
5. the existing Archive `SPLIT` action retained;
6. flags-off, desktop, mobile, keyboard, deep-link, and Crate regression tests.

Preview, layering, Web Audio project state, stem handoff, and export remain
separate reviewable increments.

## Decisions required before Phase 2

- Whether a Crate source should enter REMIX as a full track or require an
  explicit clip selection first.
- The initial maximum number and duration of simultaneous layers, based on
  measured mobile memory and decode behavior.
- The reviewed Archive audio-delivery contract.
- The exact license-compatibility and export posture.
- Whether the first saved project is one autosaved local project or an explicit
  save/load flow.
