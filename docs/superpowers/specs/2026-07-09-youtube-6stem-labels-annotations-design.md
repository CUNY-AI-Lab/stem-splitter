# Design: YouTube import, 4/6-stem choice, editable labels, time annotations

**Date:** 2026-07-09
**Status:** Approved pending user review

## Goal

Four additions to the stem-splitter app for music students:

1. Create a job from a YouTube link, not just a file upload.
2. Let each job choose 4-stem or 6-stem separation (Demucs caps at 6; arbitrary per-instrument splitting is not possible with this model family).
3. Editable display labels for stem channels, shared class-wide.
4. Time-anchored annotations on a track, shared class-wide, shown as markers on the seek bar.

## Non-goals

- More than 6 stems (would require a different model family than Demucs).
- Per-student private labels/annotations.
- Loop/practice regions (possible later on top of the annotation model).
- Any auth beyond the existing class-code header for writes.

## 1. YouTube import (in-Worker fetch)

**Approach:** resolve and download the audio in the Worker itself using `youtubei.js` (pure-JS YouTube client; works on Workers because it ships its own JS interpreter for YouTube's stream cipher — no `eval`). No new infrastructure, single-stage pipeline, free.

**Flow:**

- Upload card gets two modes: drop a file (unchanged) or paste a YouTube URL.
- `POST /api/jobs` accepts `{ youtubeUrl, model }` as an alternative to `{ key, filename, model }`. Accepted URL shapes: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`. Reject anything else with a clear error.
- The Worker (behind the class-code gate):
  1. Resolves video info via youtubei.js; rejects videos longer than **15 minutes** (cost/scope guard) and live streams.
  2. Picks the best audio-only stream (M4A/AAC preferred — Demucs ingests M4A directly, so no transcoding).
  3. Streams it into R2 at `uploads/<jobId>/source.m4a` (same lifecycle/copyright posture as file uploads; originals are never served back out).
  4. Uses the video title as the job's `filename` (sanitized).
  5. Starts the Demucs prediction exactly as the upload path does.
- The fetch happens synchronously inside the job-creation request (a few seconds for ~5–10 MB); the frontend shows "FETCHING FROM YOUTUBE…" while the request is in flight.

**Seam:** the fetch lives behind a small module (`src/youtube.ts`, exporting `fetchYouTubeAudio(url): { stream, title, durationSec }`) so it can be swapped for a Replicate yt-dlp model later without touching job routes.

**Accepted risks (explicit):**

- Downloading YouTube audio violates YouTube's ToS; the user accepts this for classroom use.
- YouTube-side changes can break `youtubei.js` until its next release; file uploads keep working regardless. Failure surfaces as a normal failed request with a clear error, never a stuck job.
- Datacenter-IP bot checks may intermittently reject requests (same risk as any server-side approach).
- If the Worker is on the free plan, cipher solving may exceed the 10 ms CPU budget; may require the $5/mo paid plan. Verify on first deploy.

## 2. Per-job 4/6-stem choice

- The upload UI uses a segmented toggle with **4 stems (vocals, drums, bass, other)** or **6 stems (vocals, drums, bass, other, guitar, piano)**. Four stems remains the default for both file and YouTube modes.
- Job creation accepts `model`, validated against an allowlist: `htdemucs_ft` (4) | `htdemucs_6s` (6). Stored on the job row; passed through `SeparationStartRequest` so the provider seam stays generic (Replicate backend forwards it; default remains `htdemucs_ft`).
- Frontend already orders/colors guitar and piano stems (`STEM_ORDER`, `--c-guitar`, `--c-piano`); the processing note reflects the chosen split.
- Quality trade-off (6s guitar/piano can bleed) is stated in the toggle's hint text.

## 3. Editable stem labels (shared)

- New `labels` TEXT column on `jobs`: JSON map `{ "<stem name>": "<display label>" }`. Empty/missing map = default names.
- `PUT /api/jobs/:id/labels` (class-code required): body `{ labels: { vocals: "Lead vox", ... } }`; keys validated against the job's actual stems; values trimmed, max 40 chars. Full-map replace (last writer wins — fine at class scale).
- Labels ride along on the job payload (`GET /api/jobs/:id`). Anyone viewing the job sees them.
- Mixer UI: click a channel name → inline text input → Enter/blur saves. The stem's canonical name still drives channel color and download filename; only display text changes.

## 4. Time annotations (shared, seek-bar markers)

**Schema (new table, additive migration):**

```sql
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_annotations_job ON annotations (job_id);
```

**API:**

- Annotations are included in `GET /api/jobs/:id` (no extra fetch; reads stay open-but-unguessable, matching the stem-URL posture).
- `POST /api/jobs/:id/annotations` (class-code required): `{ atSeconds, text }` — text trimmed, max 200 chars; `atSeconds` ≥ 0.
- `DELETE /api/jobs/:id/annotations/:annotationId` (class-code required).

**Mixer UI:**

- A "＋ NOTE" button in the transport stamps the current playback time and opens a small inline text input.
- Each annotation renders as a colored tick overlaid on the seek bar at `atSeconds / duration`. Hover/tap reveals the text (and a ✕ to delete); click seeks playback to that moment.
- Markers refresh when the job payload refreshes; after add/delete the frontend updates optimistically.

## Cross-cutting

- **Migrations:** `schema.sql` stays the canonical fresh-install schema (gains `labels`, `model` columns and the `annotations` table). Additive changes for the existing DB ship as `migrations/0002-features.sql` (`ALTER TABLE jobs ADD COLUMN …` + `CREATE TABLE annotations …`) with a `db:migrate:2` npm script.
- **Auth posture unchanged:** all writes require the class code; reads are unauthenticated but unguessable (UUID ids).
- **Costs:** YouTube fetch free (Worker CPU); 6-stem separation same Replicate price as 4-stem (~$0.045/song).
- **No build step is introduced:** `youtubei.js` is a Worker (src/) dependency bundled by wrangler; the frontend stays vanilla JS.

## Error handling summary

- Invalid/unsupported YouTube URL, >15 min, live stream, or extraction failure → 4xx/502 with a human-readable message shown in the upload card; no orphan job row (job row is created only after audio lands in R2).
- Label/annotation writes validate shape and length; 404 on unknown job; 401 without class code.
- Existing reconciliation polling is untouched (YouTube fetch happens before the separation stage, so stuck-job guarantees are preserved).

## Testing

No test framework exists (`npm run typecheck` is the check). Verification plan:

- `tsc --noEmit` clean.
- `wrangler deploy --dry-run` to validate bundle (youtubei.js must bundle for the workerd runtime).
- Manual end-to-end on the deployed Worker: YouTube import (short video), 6-stem job, label rename across two browsers, annotation add/seek/delete across two browsers.
