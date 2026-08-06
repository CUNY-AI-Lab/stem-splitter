# Plan: Session focus on new upload + per-song session export

Spec: `../specs/2026-08-05-session-focus-and-export-design.md`

Frontend-only change (`public/app.js`, `public/styles.css`); no API, schema, or
Worker changes.

## Steps

1. **Collapse state** — `addJob()` marks existing localStorage job entries
   `collapsed: true`, inserts the new job expanded; add `setJobCollapsed(id,
   collapsed)` helper.
2. **Mixer head controls** — add EXPORT and ▾/▸ buttons to the console head;
   `Mixer.setCollapsed()` toggles a `.collapsed` class (pausing playback when
   collapsing) and `renderJobs()` re-applies the persisted flag on every render.
3. **Export** — `Mixer.exportMarkdown()` (guide, notes, chat, labels) +
   `Mixer.exportZip()` (fetch stems → assemble → download); module-level
   `makeZip()` / `crc32()` / `fileSafe()` helpers (store-method ZIP writer).
4. **Styles** — `.head-btn` pill buttons matching the badge idiom;
   `.console.collapsed > :not(.console-head) { display: none; }`.
5. **Verify** — `npm run typecheck`, `npm run test:e2e`.
