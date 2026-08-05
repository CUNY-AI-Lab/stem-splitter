# Design: The Crate — open-licensed catalog import from the Internet Archive

**Date:** 2026-08-04
**Status:** Approved

## Goal

Give students a legal, zero-friction source of music to split. Today the only
inputs are a file upload (students must already hold the audio) and a YouTube
link (costs ~$0.01/fetch, is bot-checked, and has a murky copyright posture for
coursework). "The Crate" adds a third: browse an open-licensed catalog inside the
app, pick a track, and split it.

The catalog is the Internet Archive. It is searched live — there is no local
mirror of the catalog and no sync job.

## Why the Internet Archive and not Magnatune

Magnatune was evaluated first and rejected on evidence:

- Its catalog is genuinely good and machine-readable — `song_info.xml`
  (94 MB, 2.7 MB gzipped) is a flat `<Track>` list with artist, album, track,
  genre, licence, duration, cover art and a `changed.txt` cache token.
- But **every audio and image URL in that XML points at `he3.magnatune.com`,
  which does not resolve**. The catalog is metadata-only in practice: there are
  no bytes to separate.
- Licensing is CC BY-NC-SA but gated on paid membership, which is the wrong
  posture for a class tool.

The Internet Archive has none of these problems, and its import path is strictly
*simpler* than the YouTube one: public HTTP, real `Content-Length`,
`accept-ranges`, no auth and no bot-check. A plain Worker `fetch` is the whole
fetcher — no yt-dlp, no Replicate hop, no per-import cost, and none of the 429
burst-limit fragility that the YouTube path has to retry around.

## Non-goals

- A local catalog mirror in D1 (considered and dropped: live search needs no
  schema change, no migration, and no cron sweep to keep fresh). The seam is
  shaped so this can be added later as a cache without touching the routes.
- Instructor-curated collections / assignment sets — a follow-up that would sit
  on top of the same search route.
- In-browser preview of the archive track before splitting.
- Importing whole albums in one action.

## 1. Licence floor (the load-bearing decision)

Stem separation produces a **derivative work**, so NoDerivatives-licensed
material cannot be split here even though it is otherwise freely available. The
netlabels pool contains a lot of it — `by-nc-nd` and `by-nd` variants show up on
the first page of most queries.

Two enforcement points, both server-side:

1. **Search** pins the query floor: open licence present
   (`licenseurl:(*creativecommons* OR *publicdomain*)`) and
   `NOT licenseurl:*-nd*`.
2. **Item load** re-checks the item's own `licenseurl` and refuses with
   `license_no_derivatives`. This is not redundant: the search index can be
   stale relative to item metadata, and the item check is what the import
   actually depends on.

The licence is shown to students as a badge on every result and in a credit line
under the track list. That is partly pedagogy — a music class should see what
licence it is working under — and partly the honest surface of the constraint.

## 2. Query assembly and injection containment

The search query is assembled in the Worker, never accepted from the client.
Student text is reduced to quoted terms: each token is stripped to
`[\p{L}\p{N}'&.-]`, wrapped in quotes, and ANDed (max 8 tokens, 120 chars). A
term containing Lucene operators or a `licenseurl:` clause therefore cannot
widen the query past the floor — it degrades to a literal search that matches
nothing.

Scope is a fixed enum, not a passthrough:

- `music` (default) — `netlabels` + `audio_music` (~88.5k open-licensed items)
- `all` — adds `opensource_audio` (~385k, mixes in spoken word, radio, podcasts)

Results sort by `downloads desc`. Popularity is a crude relevance proxy, but it
is the one that keeps the first page of a broad query like "piano" on things
students can actually use.

## 3. Module: `src/archive.ts`

Mirrors the `fetchYouTubeAudio()` seam so the job route treats both imports
identically.

- `parseArchiveIdentifier(input)` — accepts a bare identifier or any archive.org
  `/details/`, `/download/`, `/metadata/`, `/embed/` URL; rejects other hosts.
- `searchArchive(term, scope, page)` → normalized `{ results, total, page }`.
  Page is clamped to 1–20.
- `fetchArchiveItem(identifier)` → item + track list, with the licence re-check.
  Items carry several derivatives of the same track (VBR MP3, Ogg, FLAC…); the
  picker collapses them to one entry per base name, ranked MP3-first, so
  students see songs rather than encodings. Each track is flagged `importable`
  against the 15-minute / 100 MB caps rather than hidden, so an over-long track
  reads as "TOO LONG" instead of silently vanishing.
- `fetchArchiveAudio(identifier, fileName, env)` → `{ data, title, durationSec,
  fileName }`, matching the YouTube contract plus the filename needed to pick
  the R2 extension and content type.

Errors are an `ArchiveError` with a `code` and `retryable` flag, mapping to
student-safe strings exactly as `YouTubeError` does.

## 4. Routes

- `GET /api/archive/scopes` — open; static enum for the UI.
- `GET /api/archive/search?q&scope&page` — class-code gated.
- `GET /api/archive/items/:identifier` — class-code gated.
- `POST /api/jobs` gains `{ archiveId, archiveFile? }` beside `{ key, filename }`
  and `{ youtubeUrl }`.

Search and item reads are gated even though they cost nothing: they are the
pathway into a paid separation, and an open search proxy on the Worker is a
thing someone else can point at. Caller errors (bad identifier, ND licence, no
audio) return 400; upstream faults return 502.

The import preserves the ordering invariant from the YouTube path: **bytes land
in R2 before the job row is created**, so a failed fetch never leaves a stuck
job.

## 5. Retention and copyright posture (unchanged)

Imported sources are written to `uploads/<uuid>/source.<ext>` and inherit the
same 30-day R2 lifecycle. `/api/files/*` still serves only `stems/`, so the
imported source is never served back out — the existing posture holds, and open
licensing does not change it.

## Verification

18 assertions against the live archive.org API (identifier parsing, injection
containment, licence filtering, paging clamp, both scopes, item normalization,
ND refusal, and a real 19 MB MP3 download verified by frame header), plus two
Playwright e2e tests against a mocked archive.org boundary: the full
browse → expand → split flow, and the ND refusal path.
