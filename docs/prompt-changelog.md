# Listening Guide system prompt changelog

The fixed system prompt lives in `src/assistant/prompt.ts`. Its exported
`SYSTEM_PROMPT_VERSION` is stored beside every runtime instructor amendment.
The instructor API fingerprints a deterministic multi-variant policy bundle,
so a text change in any current conditional prompt arm remains traceable even
if a version bump is accidentally omitted. The readable instructor preview is
deliberately separate from that audit material.

## 2026-09-01.1

Adds the Remixer's devil's-advocate register — a third prompt mode, `remix`,
selected by `mode: 'remix'` on `POST /api/jobs/:id/chat`. Guide and chat mode
text is unchanged; the bump exists because the fixed prompt gained a new
conditional arm (and the fingerprint bundle a fourth variant covering it).

- Same persona, opposite job: instead of opening the song up, Listening Guy
  argues against the student's remix — one weakest/safest choice per reply,
  the case against it in plain words, then one riskier experiment or one
  question that makes the student defend the choice. Concedes well-defended
  choices and moves on.
- New data fence: the request's `deck` snapshot (layers, sources, speed /
  reverse / loop / entry / pan / mute) renders as an escaped one-line data
  block, explicitly not instructions; the register forbids inventing layers
  or settings not in it.
- Tool rules swap to "ACTING ON THE DECK": solo and set_mute only, acting on
  this song's layers on the deck, at most 2 calls per turn. No seek, no
  add_note — the remix has its own timeline, not the song's. The server also
  narrows the offered toolset and drops off-register calls on return.

## 2026-08-20.1

Synthesized from instructor prompt-amendment revisions 2–4 (2026-08-19), which
kept overwriting one another at runtime; the class-specific blues syllabus
(revision 1) intentionally stays in the amendment layer.

- Opening message now contextualizes the genre before any minutia: name it,
  what makes it tick, and the telltale signs that let an untrained listener
  tell it apart. Word cap raised ~80 → ~110 to make room.
- Knowledge first, action second — in both the opening's mixer move and the
  tool-narration rule: the Listening Guide must say what to listen FOR and
  why before naming the move, never a bare "solo the guitar".
- The opening engages with mixer work the class did before the cue (renamed
  channels, timeline notes), and teaching rule 2 now turns a student's
  mistakes and virtues alike into the next listening exercise.

## 2026-08-19.1

- De-determinized the mixer-move pedagogy. The guide's opening beat (b) and
  teaching-approach rule 2 both effectively mandated "mute everything but one
  channel" every time; both now present isolation as one tool among several
  (mute one part to hear what disappears, play two channels together, listen
  for one part inside the full mix) and tell the model to pick the move that
  fits the song rather than follow a formula.

## 2026-08-10.2

- Encoded provider titles plus student-authored labels and notes before placing
  them in the system message. Embedded quotes, newlines, and Unicode line
  separators remain literal data and cannot visually create a fixed-prompt
  heading or rule block.
- Explicitly classified the title, labels, and notes as untrusted data. The
  authenticated instructor amendment remains the only runtime instruction
  layer.
- Added an injection-shaped fingerprint variant so changing or removing the
  escaping behavior changes both the base/effective policy SHA-256 and guide
  cache identity.
- Bound successful prompt-save responses to the immutable revision inserted by
  that request, preventing a later teacher save from mixing its amendment with
  the first request's hashes during response readback.
- Corrected teacher-session expiry to parse ISO timestamps before comparing
  them with SQLite time, and made confirmed logout scrub teacher content from
  the page while a failed logout leaves the console visibly active.
- Versioned the instructor stylesheet and script together so Railway/browser
  caches cannot retain older editor behavior. The upward caret now focuses and
  brings the read-only prompt container into the viewport as it scrolls to the
  true first line, rather than changing content above the visible page.
- Validation: both TypeScript checks, 4 focused prompt-policy tests, all 28
  Railway host/migration tests, and the targeted instructor browser journey
  pass. Complete Phase 0 commands are green but explicitly rejected because
  concurrent bakeoff source changed during the corrected all-source guard.
  This remains focused local evidence, not current combined acceptance or a
  GitHub/Railway release.

## 2026-08-10.1

- Replaced the single-example prompt fingerprint with schema
  `stem-splitter.system-prompt-fingerprint.v1`, a deterministic bundle covering
  guide and chat tasks, four-stem `other` and two-stem `instrumental` guidance,
  empty and populated notes, known and unknown duration, and canonical and
  customized channel labels.
- Kept the instructor's Markdown-formatted prompt view as one readable example;
  its display text is no longer misrepresented as the complete audit surface.
- Required cached guide rows to match the current effective policy SHA-256 as
  well as version and amendment revision. A fixed-text change missed by a
  manual version bump therefore regenerates rather than serving stale prose.
- Enforced the runtime changelog's append-only contract in the database: fresh
  schema, Railway boot, and numbered migration 13 reject updates, deletes, and
  replacement/conflicting inserts against existing revision identities.
- Replaced the console's silent 40-row history ceiling with authenticated,
  newest-first keyset pagination. Each response stays bounded while every
  retained runtime revision remains reachable through **LOAD EARLIER
  REVISIONS**.
- Made authoritative seed reconciliation reject a supplied non-string teacher
  display name before any account mutation, matching the documented
  all-or-nothing provisioning boundary.
- Left the fixed instructional prose unchanged. The version advances because
  the stored base/effective hash semantics and guide-cache identity changed.

## 2026-08-08.1

- Established the current Listening Guide v3 prompt as the versioned baseline.
- Kept the code-owned persona, turn-taking pedagogy, anti-fabrication rules,
  timestamp safeguards, student-data boundary, and mixer tool rules fixed.
- Added a read-only, formatted instructor view that opens at the end of the
  fixed prompt and can jump to the top.
- Added a separate appended-instructions editor with required change notes,
  monotonic optimistic concurrency, base/effective SHA-256 fingerprints, and
  append-only revision history.

## Updating the fixed prompt

A fixed-prompt change is complete only when the same commit:

1. edits `src/assistant/prompt.ts`;
2. increments `SYSTEM_PROMPT_VERSION`;
3. adds a dated entry here explaining the behavioral change;
4. updates the fingerprint bundle whenever a new conditional rendering arm is
   added, plus prompt and instructor-console tests;
5. passes shared and Railway-host typechecks, unit/server migration tests, the
   instructor browser journey, and the complete Phase 0 gate. The Wrangler
   dry-run belongs only to the deferred finished-product migration.

Runtime instructor edits do not belong in this file. Their changelog is stored
in `assistant_prompt_revisions`, keyed back to this code history through the
base version and fingerprint.
