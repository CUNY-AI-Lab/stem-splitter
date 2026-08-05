# Plan: The Crate — Internet Archive catalog import

**Design:** `docs/superpowers/specs/2026-08-04-archive-crate-design.md`
**Date:** 2026-08-04

Execution order; `npm run typecheck` after every backend task.
No migration and no new secrets — live search needs neither.

## Task 1 — `src/archive.ts`

- Constants: 15-minute / 100 MB caps matching the YouTube path, 24 rows/page,
  page clamp 1–20, term clamp 120 chars / 8 tokens.
- `LICENSE_FILTER` and the `ARCHIVE_SCOPES` enum (`music`, `all`) as module
  constants — the licence floor lives here, not in the routes.
- `ArchiveError { code, retryable }` mirroring `YouTubeError`.
- `parseArchiveIdentifier`, `buildQuery` (quoted-token sanitizer),
  `licenseLabel`, `parseLength` (handles both `"540.03"` and `"MM:SS"`).
- `searchArchive`, `fetchArchiveItem` (dedupes derivatives by base name,
  MP3-first ranking, licence re-check), `fetchArchiveAudio`,
  `archiveContentType`.
- Verify: bundle with esbuild and exercise against the live API — identifier
  parsing, injection containment, ND refusal, real download.

## Task 2 — Routes in `src/index.ts`

- Import the archive module beside the YouTube one.
- `GET /api/archive/scopes` (open), `GET /api/archive/search` and
  `GET /api/archive/items/:identifier` (both `requireClassCode`).
- `archiveErrorResponse()` helper: caller errors → 400, upstream → 502.
- `POST /api/jobs`: widen the body type, add the `archiveId` branch between the
  YouTube branch and the upload branch. Bytes to R2 first, then the job row.
  R2 key extension and content type come from the chosen track's filename.
- Verify: `npm run typecheck`.

## Task 3 — Frontend

- `public/index.html`: `<section id="crate">` between the import row and the
  upload status — collapsible toggle, search form with scope `<select>`, results
  `<ul>`, pager.
- `public/app.js`: crate state (`term`, `scope`, `page`, `total`, `busy`), a
  `crateItems` Map caching track lists per identifier, `runCrateSearch`,
  `renderCrateResults`, `loadCrateTracks`, `renderCrateTracks`,
  `importArchiveTrack`. Reuse the existing `api()`, `addJob()`, `renderJobs()`,
  `pollSoon()` and `fmt()` helpers — do not duplicate them.
- `public/styles.css`: `.crate-*` rules using the existing console vars; licence
  badge in `--ok`, SPLIT button in `--hot-soft`/`--hot` like `.yt-go`.
- Verify: `node --check public/app.js`.

## Task 4 — e2e coverage

- `tests/e2e/local-hosting.spec.mjs`, two tests, mocking archive.org through the
  existing MSW `network` fixture:
  1. Browse → expand → split: asserts the pinned query floor reaches
     archive.org, the Ogg derivative collapses away, the over-long track renders
     disabled, the split completes to 4 channels, and the stored source is
     byte-identical at `uploads/<uuid>/source.mp3`.
  2. ND refusal: a stale index row whose item metadata carries `by-nc-nd` must
     fail closed on expand.
- `ARCHIVE_QA_SCREENSHOT` env var for a visual check, mirroring
  `YOUTUBE_QA_SCREENSHOT`.
- Verify: `npm run test:e2e` fully green.

## Task 5 — Docs

- Spec + plan pair (this file and its design doc).
- `CLAUDE.md`: new step 2c in the request flow describing the Archive import and
  the licence floor.

## Follow-ups (not in this change)

- Instructor-curated assignment sets on top of the same search route.
- Optional D1 catalog cache if instant search or curation is wanted later.
- In-app preview of the archive track before committing to a split.
