# YouTube Import, 4/6-Stem Choice, Labels & Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YouTube-link import, per-job 4/6-stem model choice, shared editable stem labels, and shared seek-bar time annotations to the stem-splitter app.

**Architecture:** Single Cloudflare Worker (Hono) + vanilla-JS frontend, per the existing app. YouTube audio is fetched in-Worker via `youtubei.js` behind a `fetchYouTubeAudio()` seam and stored in R2 exactly like an upload. Labels live as a JSON column on `jobs`; annotations get their own D1 table; both ride along on `GET /api/jobs/:id`. Spec: `docs/superpowers/specs/2026-07-09-youtube-6stem-labels-annotations-design.md`.

**Tech Stack:** TypeScript (Worker), Hono, D1, R2, `youtubei.js` (new dependency), vanilla JS frontend (no build step).

## Global Constraints

- **No test framework exists.** The check per task is `npm run typecheck` (`tsc --noEmit`); bundle validity is checked with `npx wrangler deploy --dry-run --outdir dist`. Final task does a deployed end-to-end pass. Do not add a test framework.
- **Frontend stays vanilla JS, no build step.** `youtubei.js` is a Worker-side (src/) dependency only.
- **Uploads never pass through the Worker** (presigned R2 PUTs). The YouTube path is the deliberate exception: the Worker fetches from YouTube and writes to R2 itself.
- **`/api/files/*` serves only `stems/` keys** — never serve `uploads/` originals.
- **All writes require the `x-class-code` header** (existing `requireClassCode` middleware); reads stay unauthenticated-but-unguessable.
- **Model allowlist is exactly** `htdemucs_ft` (4 stems, default) and `htdemucs_6s` (6 stems).
- **YouTube guards:** max video duration 15 minutes; reject live streams; max audio bytes = existing `MAX_SOURCE_BYTES` (100 MB).
- **Copy limits:** labels max 40 chars; annotation text max 200 chars; `atSeconds >= 0`.
- **Don't remove the reconciliation polling** in `GET /api/jobs/:id`.
- Commit after every task with the message given in the task.

---

### Task 1: Schema migration (model, labels, annotations)

**Files:**
- Create: `migrations/0002-features.sql`
- Modify: `schema.sql`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: `jobs.model TEXT`, `jobs.labels TEXT` columns; `annotations` table (`id TEXT PK, job_id TEXT, at_seconds REAL, text TEXT, created_at TEXT`); npm scripts `db:migrate:2` / `db:migrate:2:local`.

- [ ] **Step 1: Create the additive migration file**

Create `migrations/0002-features.sql`:

```sql
-- Additive migration: per-job model choice, shared stem labels, time annotations.
-- Run once against an existing DB (ALTER TABLE fails if re-run — that's expected).
ALTER TABLE jobs ADD COLUMN model TEXT;
ALTER TABLE jobs ADD COLUMN labels TEXT;

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_job ON annotations (job_id);
```

- [ ] **Step 2: Update the canonical fresh-install schema**

In `schema.sql`, replace the `jobs` table definition so it includes the two new columns, and append the annotations table. The full new file content:

```sql
-- Job tracking for stem separation requests.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source_key TEXT NOT NULL,            -- R2 key of the uploaded original
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  external_id TEXT,                    -- id of the job at the separation backend (e.g. Replicate prediction id)
  stems TEXT,                          -- JSON array: [{ "name": "vocals", "key": "stems/<job>/vocals.mp3" }, ...]
  error TEXT,
  model TEXT,                          -- Demucs variant: htdemucs_ft (4 stems) | htdemucs_6s (6 stems)
  labels TEXT,                         -- JSON map: { "<stem name>": "<display label>" }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);

-- Shared time-anchored notes on a track, shown as seek-bar markers.
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_job ON annotations (job_id);
```

- [ ] **Step 3: Add migration scripts to package.json**

In `package.json`, add to `"scripts"` (after `"db:migrate:local"`):

```json
"db:migrate:2": "wrangler d1 execute stem-splitter --remote --file=migrations/0002-features.sql",
"db:migrate:2:local": "wrangler d1 execute stem-splitter --local --file=migrations/0002-features.sql"
```

- [ ] **Step 4: Verify the migration applies locally**

Run: `npm run db:migrate:2:local`
Expected: success output listing executed commands (creates a throwaway local sqlite under `.wrangler/`). If the local DB has never had `schema.sql` applied, first run `npm run db:migrate:local`.

**Do NOT run the remote migration yet** — that happens in the final deploy task.

- [ ] **Step 5: Commit**

```bash
git add migrations/0002-features.sql schema.sql package.json
git commit -m "feat: schema for model choice, stem labels, annotations"
```

---

### Task 2: Per-job model choice through the backend seam

**Files:**
- Modify: `src/separation/types.ts` (add `model` to `SeparationStartRequest`)
- Modify: `src/separation/replicate.ts:35` (use `req.model`)
- Modify: `src/index.ts` (validate + persist + forward `model`; expose it in responses)

**Interfaces:**
- Consumes: `jobs.model` column (Task 1).
- Produces: `SeparationStartRequest.model?: string`; `POST /api/jobs` accepts `model` (`'htdemucs_ft' | 'htdemucs_6s'`, default `'htdemucs_ft'`); job JSON responses gain `model: string`.

- [ ] **Step 1: Add `model` to the seam type**

In `src/separation/types.ts`, add to `SeparationStartRequest` (after `webhookUrl`):

```ts
  /** Model variant to run (e.g. Demucs "htdemucs_ft" | "htdemucs_6s"). Backends may ignore it. */
  model?: string;
```

- [ ] **Step 2: Forward it in the Replicate backend**

In `src/separation/replicate.ts`, inside `start()`'s `input`, replace:

```ts
            model: 'htdemucs_ft',
```

with:

```ts
            model: req.model ?? 'htdemucs_ft',
```

- [ ] **Step 3: Accept, validate, persist, and return `model` in the Worker**

In `src/index.ts`:

(a) After the `MAX_SOURCE_BYTES` constant, add:

```ts
const ALLOWED_MODELS = ['htdemucs_ft', 'htdemucs_6s'];
```

(b) Add `model` and `labels` to `JobRow` (after `error`):

```ts
  model: string | null;
  labels: string | null;
```

(c) In `POST /api/jobs`, widen the body type and validate the model. Replace:

```ts
  const body = (await c.req.json().catch(() => null)) as { key?: string; filename?: string } | null;
```

with:

```ts
  const body = (await c.req.json().catch(() => null)) as
    | { key?: string; filename?: string; model?: string }
    | null;

  const model = body?.model ?? 'htdemucs_ft';
  if (!ALLOWED_MODELS.includes(model)) {
    return c.json({ error: `Unknown model. Allowed: ${ALLOWED_MODELS.join(', ')}` }, 400);
  }
```

(d) Persist it — replace the INSERT:

```ts
  await c.env.DB.prepare('INSERT INTO jobs (id, filename, source_key, status, model) VALUES (?, ?, ?, ?, ?)')
    .bind(id, filename, key, 'pending', model)
    .run();
```

(e) Forward it — replace the `start(...)` call:

```ts
    const { externalId } = await getBackend(c.env).start({ jobId: id, audioUrl, webhookUrl, model });
```

(f) In `jobResponse`, add to the returned object (after `error`):

```ts
    model: row.model ?? 'htdemucs_ft',
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/separation/types.ts src/separation/replicate.ts src/index.ts
git commit -m "feat: per-job 4/6-stem model choice through the separation seam"
```

---

### Task 3: Shared stem labels API

**Files:**
- Modify: `src/index.ts` (new `PUT /api/jobs/:id/labels` route; labels in `jobResponse`)

**Interfaces:**
- Consumes: `jobs.labels` column (Task 1); `JobRow.labels` (Task 2).
- Produces: `PUT /api/jobs/:id/labels` (class-code gated) with body `{ labels: Record<string, string> }`, returns `{ labels }`; job JSON responses gain `labels: Record<string, string>`.

- [ ] **Step 1: Add the route**

In `src/index.ts`, after the `GET /api/jobs/:id` handler, add:

```ts
// Shared, class-wide display labels for stem channels.
app.put('/api/jobs/:id/labels', requireClassCode, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);

  const body = (await c.req.json().catch(() => null)) as { labels?: Record<string, unknown> } | null;
  if (!body?.labels || typeof body.labels !== 'object' || Array.isArray(body.labels)) {
    return c.json({ error: 'labels object is required' }, 400);
  }

  // Only label stems the job actually has; trim and cap length.
  const stemNames = new Set(
    (row.stems ? (JSON.parse(row.stems) as { name: string }[]) : []).map((s) => s.name)
  );
  const labels: Record<string, string> = {};
  for (const [name, value] of Object.entries(body.labels)) {
    if (!stemNames.has(name)) continue;
    const label = String(value).trim().slice(0, 40);
    if (label) labels[name] = label;
  }

  await c.env.DB.prepare('UPDATE jobs SET labels = ? WHERE id = ?')
    .bind(JSON.stringify(labels), id)
    .run();
  return c.json({ labels });
});
```

- [ ] **Step 2: Return labels with the job**

In `jobResponse`, add (after `model`):

```ts
    labels: row.labels ? (JSON.parse(row.labels) as Record<string, string>) : {},
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: shared editable stem labels API"
```

---

### Task 4: Annotations API

**Files:**
- Modify: `src/index.ts` (annotation routes; annotations in `GET /api/jobs/:id`)

**Interfaces:**
- Consumes: `annotations` table (Task 1).
- Produces: `POST /api/jobs/:id/annotations` (class-code gated, body `{ atSeconds: number, text: string }`, returns `{ id, atSeconds, text }`); `DELETE /api/jobs/:id/annotations/:annotationId` (class-code gated, returns `{ ok: true }`); job JSON responses gain `annotations: { id, atSeconds, text }[]` sorted by time.

- [ ] **Step 1: Add the row type**

In `src/index.ts`, after the `JobRow` interface:

```ts
interface AnnotationRow {
  id: string;
  job_id: string;
  at_seconds: number;
  text: string;
  created_at: string;
}
```

- [ ] **Step 2: Include annotations in the job payload**

Change `jobResponse`'s signature and returned object:

```ts
function jobResponse(row: JobRow, annotations: AnnotationRow[] = []) {
```

and add to the returned object (after `labels`):

```ts
    annotations: annotations.map((a) => ({ id: a.id, atSeconds: a.at_seconds, text: a.text })),
```

In the `GET /api/jobs/:id` handler, replace the final `return c.json(jobResponse(row));` with:

```ts
  const { results } = await c.env.DB
    .prepare('SELECT * FROM annotations WHERE job_id = ? ORDER BY at_seconds')
    .bind(id)
    .all<AnnotationRow>();
  return c.json(jobResponse(row, results ?? []));
```

(The other `jobResponse` call sites, if any, compile unchanged thanks to the default parameter.)

- [ ] **Step 3: Add create/delete routes**

After the labels route from Task 3, add:

```ts
// Shared time-anchored notes, rendered as seek-bar markers.
app.post('/api/jobs/:id/annotations', requireClassCode, async (c) => {
  const id = c.req.param('id');
  const job = await c.env.DB.prepare('SELECT id FROM jobs WHERE id = ?').bind(id).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const body = (await c.req.json().catch(() => null)) as { atSeconds?: unknown; text?: unknown } | null;
  const atSeconds = Number(body?.atSeconds);
  const text = String(body?.text ?? '').trim().slice(0, 200);
  if (!Number.isFinite(atSeconds) || atSeconds < 0 || !text) {
    return c.json({ error: 'atSeconds (>= 0) and text are required' }, 400);
  }

  const annotationId = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO annotations (id, job_id, at_seconds, text) VALUES (?, ?, ?, ?)')
    .bind(annotationId, id, atSeconds, text)
    .run();
  return c.json({ id: annotationId, atSeconds, text });
});

app.delete('/api/jobs/:id/annotations/:annotationId', requireClassCode, async (c) => {
  await c.env.DB.prepare('DELETE FROM annotations WHERE id = ? AND job_id = ?')
    .bind(c.req.param('annotationId'), c.req.param('id'))
    .run();
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: shared time annotations API"
```

---

### Task 5: YouTube import (Worker-side fetch)

**Files:**
- Create: `src/youtube.ts`
- Modify: `src/index.ts` (`POST /api/jobs` accepts `youtubeUrl`)
- Modify: `package.json` / `package-lock.json` (new dependency)

**Interfaces:**
- Consumes: `ALLOWED_MODELS`, `MAX_SOURCE_BYTES`, `sanitizeFilename` (existing / Task 2).
- Produces: `fetchYouTubeAudio(url: string): Promise<{ data: ArrayBuffer; title: string; durationSec: number }>` and `YouTubeError` from `src/youtube.ts`; `POST /api/jobs` accepts `{ youtubeUrl, model }` as an alternative to `{ key, filename, model }` and behaves identically downstream.

- [ ] **Step 1: Install the dependency**

Run: `npm install youtubei.js`
Expected: added to `dependencies` in `package.json`.

- [ ] **Step 2: Create the fetch seam**

Create `src/youtube.ts`:

```ts
// YouTube audio fetch, isolated behind fetchYouTubeAudio() so it can be
// swapped for an external service (e.g. a Replicate yt-dlp model) if
// YouTube-side changes or bot detection make the in-Worker approach flaky.
import { Innertube } from 'youtubei.js/cf-worker';

const MAX_DURATION_SECONDS = 15 * 60; // cost/scope guard for class use

/** Errors safe to show to students verbatim. */
export class YouTubeError extends Error {}

export interface YouTubeAudio {
  data: ArrayBuffer;
  title: string;
  durationSec: number;
}

export function parseYouTubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v');
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
  }
  return null;
}

export async function fetchYouTubeAudio(url: string): Promise<YouTubeAudio> {
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) {
    throw new YouTubeError('Not a recognizable YouTube link (use youtube.com/watch, youtu.be, or /shorts).');
  }

  const yt = await Innertube.create({ generate_session_locally: true });
  const info = await yt.getBasicInfo(videoId);

  const basic = info.basic_info;
  if (basic.is_live) throw new YouTubeError('Live streams cannot be imported.');
  const durationSec = basic.duration ?? 0;
  if (durationSec > MAX_DURATION_SECONDS) {
    throw new YouTubeError('Video is longer than 15 minutes — pick a shorter one.');
  }
  if (info.playability_status && info.playability_status.status !== 'OK') {
    throw new YouTubeError(
      `Video is not playable (${info.playability_status.reason || info.playability_status.status}).`
    );
  }

  // Audio-only M4A/AAC — Demucs ingests M4A directly, no transcoding needed.
  const stream = await info.download({ type: 'audio', quality: 'best', format: 'mp4' });
  const data = await new Response(stream).arrayBuffer();

  return { data, title: basic.title ?? 'youtube-audio', durationSec };
}
```

Note for the implementer: `youtubei.js/cf-worker` is the library's Cloudflare Workers build. If the import path or `download()` signature differs in the installed version, check `node_modules/youtubei.js/package.json` (`exports` map) and `node_modules/youtubei.js/README.md` — do not guess.

- [ ] **Step 3: Branch `POST /api/jobs` on `youtubeUrl`**

In `src/index.ts`, add imports at the top:

```ts
import { fetchYouTubeAudio, YouTubeError } from './youtube';
```

Then replace the body-parsing / validation / R2-check section of `POST /api/jobs` (everything from `const body = ...` down to just before `const id = crypto.randomUUID();`) with:

```ts
  const body = (await c.req.json().catch(() => null)) as
    | { key?: string; filename?: string; youtubeUrl?: string; model?: string }
    | null;

  const model = body?.model ?? 'htdemucs_ft';
  if (!ALLOWED_MODELS.includes(model)) {
    return c.json({ error: `Unknown model. Allowed: ${ALLOWED_MODELS.join(', ')}` }, 400);
  }

  let key: string;
  let filename: string;

  if (body?.youtubeUrl) {
    // In-Worker YouTube fetch: audio lands in R2 first; the job row is only
    // created after, so a failed fetch never leaves an orphan/stuck job.
    let audio;
    try {
      audio = await fetchYouTubeAudio(body.youtubeUrl);
    } catch (err) {
      const message =
        err instanceof YouTubeError
          ? err.message
          : 'YouTube fetch failed — try again, or upload the audio file instead.';
      console.error('youtube fetch error', err);
      return c.json({ error: message }, 502);
    }
    if (audio.data.byteLength > MAX_SOURCE_BYTES) {
      return c.json({ error: 'Audio too large (max 100 MB)' }, 400);
    }
    key = `uploads/${crypto.randomUUID()}/source.m4a`;
    filename = sanitizeFilename(audio.title) || 'youtube-audio';
    await c.env.AUDIO.put(key, audio.data, { httpMetadata: { contentType: 'audio/mp4' } });
  } else {
    const uploadKey = body?.key;
    filename = sanitizeFilename(body?.filename ?? '');
    if (!uploadKey || !uploadKey.startsWith('uploads/') || !filename) {
      return c.json({ error: 'key and filename are required' }, 400);
    }

    const head = await c.env.AUDIO.head(uploadKey);
    if (!head) return c.json({ error: 'Upload not found — did the file finish uploading?' }, 400);
    if (head.size > MAX_SOURCE_BYTES) {
      await c.env.AUDIO.delete(uploadKey);
      return c.json({ error: 'File too large (max 100 MB)' }, 400);
    }
    key = uploadKey;
  }
```

Everything from `const id = crypto.randomUUID();` onward stays exactly as it is after Task 2 (insert with `model`, presign, `start`, error handling, response).

- [ ] **Step 4: Typecheck and validate the bundle**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx wrangler deploy --dry-run --outdir dist`
Expected: bundles successfully. If it fails on Node built-ins (`node:...` imports), add `"compatibility_flags": ["nodejs_compat"]` to `wrangler.jsonc` and re-run; if it fails on the `youtubei.js/cf-worker` subpath, check the library's `exports` map as noted in Step 2.

- [ ] **Step 5: Commit**

```bash
git add src/youtube.ts src/index.ts package.json package-lock.json wrangler.jsonc
git commit -m "feat: YouTube import via in-Worker youtubei.js fetch"
```

(Omit `wrangler.jsonc` if it wasn't modified.)

---

### Task 6: Frontend — import UI (YouTube field + stem toggle)

**Files:**
- Modify: `public/index.html` (import row below the dropzone; copy updates)
- Modify: `public/app.js` (send `model`; YouTube submit flow; processing note copy)
- Modify: `public/styles.css` (import row styles)

**Interfaces:**
- Consumes: `POST /api/jobs` accepting `{ youtubeUrl, model }` or `{ key, filename, model }` (Tasks 2/5); job payload's `model` field.
- Produces: `selectedModel(): string` helper in `app.js` (used by both submit paths).

- [ ] **Step 1: Add the import row to index.html**

Insert between the `#dropzone` section and `#upload-status`:

```html
    <div class="import-row">
      <form id="yt-form" class="yt-form">
        <input id="yt-url" type="url" placeholder="…or paste a YouTube link" aria-label="YouTube link" />
        <button type="submit" class="yt-go">FETCH</button>
      </form>
      <div class="stem-choice" role="radiogroup" aria-label="Stem count">
        <label><input type="radio" name="stem-model" value="htdemucs_ft" checked /><span>4 STEMS · cleanest</span></label>
        <label><input type="radio" name="stem-model" value="htdemucs_6s" /><span>6 STEMS · +guitar&nbsp;&amp;&nbsp;piano</span></label>
      </div>
    </div>
```

Also update copy:
- Kicker: `<p class="kicker">// four channels per song</p>` → `<p class="kicker">// up to six channels per song</p>`
- Footer sig: `SEPARATION ENGINE: DEMUCS&nbsp;HTDEMUCS_FT` → `SEPARATION ENGINE: DEMUCS&nbsp;HTDEMUCS_FT&nbsp;/&nbsp;HTDEMUCS_6S`

- [ ] **Step 2: Wire it up in app.js**

(a) After the `uploadMessage` constant, add:

```js
const ytForm = document.getElementById('yt-form');
const ytUrlInput = document.getElementById('yt-url');

function selectedModel() {
  return document.querySelector('input[name="stem-model"]:checked')?.value || 'htdemucs_ft';
}
```

(b) In `handleFile`, include the model in job creation — replace:

```js
      body: JSON.stringify({ key, filename: file.name }),
```

with:

```js
      body: JSON.stringify({ key, filename: file.name, model: selectedModel() }),
```

(c) After the `dropzone.addEventListener('drop', ...)` block, add:

```js
ytForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = ytUrlInput.value.trim();
  if (!url) return;

  uploadStatus.hidden = false;
  progressBar.style.width = '0%';
  showUploadMessage('FETCHING FROM YOUTUBE…');

  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ youtubeUrl: url, model: selectedModel() }),
    });
    ytUrlInput.value = '';
    addJob(job);
    showUploadMessage('PROCESSING — stems will appear in the rack below. First track after a quiet spell can take a couple of minutes while the model warms up.');
    renderJobs();
    pollSoon();
  } catch (err) {
    showUploadMessage(err.message, true);
  }
});
```

(d) In `renderJobs`, make the processing note reflect the model — replace:

```js
          : `<p class="job-note">Splitting into vocals / drums / bass / other…</p>`
```

with:

```js
          : `<p class="job-note">Splitting into ${
              state.model === 'htdemucs_6s'
                ? 'vocals / drums / bass / guitar / piano / other'
                : 'vocals / drums / bass / other'
            }…</p>`
```

- [ ] **Step 3: Style the import row in styles.css**

Append after the `.deck-meta` rules:

```css
.import-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.9rem;
}

.yt-form { display: flex; gap: 0.5rem; flex: 1 1 260px; }

#yt-url {
  flex: 1;
  background: var(--bg-raise);
  border: 1px solid var(--panel-edge);
  border-radius: 6px;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  padding: 0.55rem 0.7rem;
}
#yt-url::placeholder { color: var(--ink-faint); }
#yt-url:focus { outline: none; border-color: var(--hot); }

.yt-go {
  background: var(--hot-soft);
  border: 1px solid rgba(255, 182, 72, 0.4);
  border-radius: 6px;
  color: var(--hot);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  padding: 0 0.9rem;
  cursor: pointer;
}
.yt-go:hover { background: var(--hot); color: var(--bg); }

.stem-choice { display: flex; gap: 0.4rem; }
.stem-choice label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid var(--panel-edge);
  border-radius: 6px;
  padding: 0.45rem 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--ink-dim);
  cursor: pointer;
  user-select: none;
}
.stem-choice input { accent-color: var(--hot); margin: 0; }
.stem-choice label:has(input:checked) {
  border-color: rgba(255, 182, 72, 0.5);
  color: var(--hot);
  background: var(--hot-soft);
}
```

- [ ] **Step 4: Visual sanity check**

Run: `npx wrangler dev --remote` and open the printed localhost URL (or just inspect the static HTML/CSS by opening a browser on the deployed site after the final task). Verify: import row renders below the dropzone, radio toggle highlights the selected option, YouTube field + FETCH button lay out on one line on desktop and wrap on narrow widths.

If avoiding `--remote` costs: this step can be deferred to the final deployed E2E pass — CSS/HTML here have no backend dependency.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat: YouTube import field and 4/6-stem toggle in the upload UI"
```

---

### Task 7: Frontend — editable stem labels

**Files:**
- Modify: `public/app.js` (Mixer: display labels, inline rename)
- Modify: `public/styles.css` (label input styles)

**Interfaces:**
- Consumes: job payload `labels` map; `PUT /api/jobs/:id/labels` (Task 3); existing `api()` helper and `esc()`.
- Produces: `Mixer.label(name)`, `Mixer.editLabel(stemName, nameEl)` — used only within the Mixer.

- [ ] **Step 1: Render labels and wire inline editing**

In `public/app.js`, inside `Mixer.build()`, replace the channel row innerHTML:

```js
      row.innerHTML = `
        <span class="ch-id"><span class="ch-dot"></span><span class="ch-name" tabindex="0" title="Click to rename">${esc(this.label(stem.name))}</span></span>
        <span class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <button class="mute-btn" aria-pressed="false" aria-label="Mute ${esc(this.label(stem.name))}">MUTE</button>
        <a class="dl" href="${stem.url}?download" title="Download ${esc(stem.name)}">↓</a>
      `;
```

and after the existing mute-button listener, add:

```js
      const nameEl = row.querySelector('.ch-name');
      nameEl.addEventListener('click', () => this.editLabel(stem.name, nameEl));
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.editLabel(stem.name, nameEl);
      });
```

- [ ] **Step 2: Add the label methods to Mixer**

After the `paint()` method, add:

```js
  label(name) {
    return (this.job.labels && this.job.labels[name]) || name;
  }

  editLabel(stemName, nameEl) {
    const input = document.createElement('input');
    input.className = 'ch-name-input';
    input.maxLength = 40;
    input.value = this.label(stemName);
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const done = async (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim().slice(0, 40);
      input.replaceWith(nameEl);
      if (!save || !value || value === this.label(stemName)) return;

      this.job.labels = { ...(this.job.labels || {}), [stemName]: value };
      nameEl.textContent = value;
      try {
        await api(`/api/jobs/${this.job.id}/labels`, {
          method: 'PUT',
          body: JSON.stringify({ labels: this.job.labels }),
        });
      } catch (err) {
        showUploadMessage(err.message, true);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }
```

- [ ] **Step 3: Style the inline input**

Append to `public/styles.css`:

```css
.ch-name { cursor: text; }
.ch-name:hover { color: var(--hot); }

.ch-name-input {
  background: var(--bg-raise);
  border: 1px solid var(--hot);
  border-radius: 4px;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  padding: 0.15rem 0.4rem;
  width: 9rem;
  max-width: 40vw;
}
.ch-name-input:focus { outline: none; }
```

- [ ] **Step 4: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "feat: inline-editable stem labels in the mixer"
```

---

### Task 8: Frontend — annotation markers on the seek bar

**Files:**
- Modify: `public/app.js` (Mixer: markers, add-note form, tips/delete)
- Modify: `public/styles.css` (marker/note styles)

**Interfaces:**
- Consumes: job payload `annotations: { id, atSeconds, text }[]`; `POST`/`DELETE` annotation endpoints (Task 4); `api()`, `esc()`, `fmt()`.
- Produces: `Mixer.renderMarkers()`, `Mixer.seekTo(t)`, `Mixer.addNote()`, `Mixer.showNoteTip(note, marker)`, `Mixer.hideNoteTip()` — internal to the Mixer.

- [ ] **Step 1: Restructure the transport and track annotations**

In `Mixer` constructor, after `this.playing = false;`, add:

```js
    this.annotations = [...(job.annotations || [])];
```

In `Mixer.build()`, replace the transport block of the innerHTML:

```js
      <div class="transport">
        <button class="play-btn" aria-label="Play all stems">▶</button>
        <span class="timecode tc-now">0:00</span>
        <div class="seek-wrap">
          <input class="seek" type="range" min="0" max="1000" value="0" aria-label="Seek" />
          <div class="markers" aria-hidden="false"></div>
        </div>
        <span class="timecode tc-end">·:··</span>
        <button class="note-btn" title="Add a note at the current time">＋&nbsp;NOTE</button>
      </div>
```

After the existing `this.tcEnd = ...` line, add:

```js
    this.markers = li.querySelector('.markers');
    this.noteBtn = li.querySelector('.note-btn');
    this.noteBtn.addEventListener('click', () => this.addNote());
```

And extend the `loadedmetadata` listener to also draw markers (duration is needed to place them):

```js
    master.addEventListener('loadedmetadata', () => {
      this.tcEnd.textContent = fmt(master.duration);
      this.renderMarkers();
    });
```

- [ ] **Step 2: Add the annotation methods to Mixer**

After `editLabel` (Task 7), add:

```js
  seekTo(t) {
    for (const a of this.audios) a.currentTime = t;
    this.paint();
  }

  renderMarkers() {
    const dur = this.audios[0].duration;
    this.markers.innerHTML = '';
    if (!dur || !isFinite(dur)) return;
    for (const note of this.annotations) {
      const m = document.createElement('button');
      m.className = 'marker';
      m.style.left = `${Math.min(100, (note.atSeconds / dur) * 100)}%`;
      m.setAttribute('aria-label', `Note at ${fmt(note.atSeconds)}: ${note.text}`);
      m.title = `${fmt(note.atSeconds)} — ${note.text}`;
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        this.seekTo(note.atSeconds);
        this.showNoteTip(note, m);
      });
      this.markers.appendChild(m);
    }
  }

  showNoteTip(note, marker) {
    this.hideNoteTip();
    const tip = document.createElement('div');
    tip.className = 'note-tip';
    tip.innerHTML = `<span class="note-tip-time mono">${fmt(note.atSeconds)}</span><span class="note-tip-text">${esc(note.text)}</span><button class="note-del" title="Delete note">✕</button>`;
    tip.querySelector('.note-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      this.annotations = this.annotations.filter((n) => n.id !== note.id);
      this.renderMarkers();
      this.hideNoteTip();
      try {
        await api(`/api/jobs/${this.job.id}/annotations/${note.id}`, { method: 'DELETE' });
      } catch (err) {
        showUploadMessage(err.message, true);
      }
    });
    marker.appendChild(tip);
    this.tip = tip;
    setTimeout(() => {
      document.addEventListener('click', () => this.hideNoteTip(), { once: true });
    }, 0);
  }

  hideNoteTip() {
    if (this.tip) {
      this.tip.remove();
      this.tip = null;
    }
  }

  addNote() {
    if (this.el.querySelector('.note-form')) return;
    const t = this.audios[0].currentTime;
    const form = document.createElement('form');
    form.className = 'note-form';
    form.innerHTML = `
      <span class="mono note-form-time">${fmt(t)}</span>
      <input maxlength="200" placeholder="e.g. chorus starts — listen to the bass" aria-label="Note text" />
      <button type="submit">SAVE</button>
    `;
    this.el.querySelector('.transport').after(form);
    const input = form.querySelector('input');
    input.focus();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') form.remove();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      form.remove();
      if (!text) return;
      try {
        const note = await api(`/api/jobs/${this.job.id}/annotations`, {
          method: 'POST',
          body: JSON.stringify({ atSeconds: t, text }),
        });
        this.annotations.push(note);
        this.annotations.sort((a, b) => a.atSeconds - b.atSeconds);
        this.renderMarkers();
      } catch (err) {
        showUploadMessage(err.message, true);
      }
    });
  }
```

- [ ] **Step 3: Style markers, tip, and note form**

Append to `public/styles.css`:

```css
.seek-wrap { position: relative; flex: 1; display: flex; align-items: center; }
.seek-wrap .seek { width: 100%; flex: 1; }

.markers { position: absolute; inset: 0; pointer-events: none; }
.marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: var(--hot);
  box-shadow: 0 0 6px rgba(255, 182, 72, 0.5);
  cursor: pointer;
  pointer-events: auto;
}
.marker:hover { background: var(--ink); }

.note-tip {
  position: absolute;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--bg-raise);
  border: 1px solid var(--panel-edge);
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  white-space: nowrap;
  max-width: 60vw;
  z-index: 5;
  font-size: 0.75rem;
  color: var(--ink);
}
.note-tip-time { color: var(--hot); font-size: 0.7rem; }
.note-tip-text { overflow: hidden; text-overflow: ellipsis; }
.note-del {
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0 0.1rem;
}

.note-btn {
  background: none;
  border: 1px solid var(--panel-edge);
  border-radius: 6px;
  color: var(--ink-dim);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  padding: 0.35rem 0.55rem;
  cursor: pointer;
  white-space: nowrap;
}
.note-btn:hover { color: var(--hot); border-color: rgba(255, 182, 72, 0.5); }

.note-form {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.6rem;
}
.note-form-time { color: var(--hot); font-size: 0.75rem; }
.note-form input {
  flex: 1;
  background: var(--bg-raise);
  border: 1px solid var(--hot);
  border-radius: 6px;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.8rem;
  padding: 0.4rem 0.6rem;
}
.note-form input:focus { outline: none; }
.note-form button {
  background: var(--hot-soft);
  border: 1px solid rgba(255, 182, 72, 0.4);
  border-radius: 6px;
  color: var(--hot);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  padding: 0.4rem 0.7rem;
  cursor: pointer;
}
```

- [ ] **Step 4: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "feat: shared annotation markers on the mixer seek bar"
```

---

### Task 9: Deploy, migrate, end-to-end verification, docs

**Files:**
- Modify: `CLAUDE.md` (document new features/endpoints)
- No code changes expected (fixes only if E2E finds issues).

**Interfaces:**
- Consumes: everything above.
- Produces: live deployment with migrated DB; updated project docs.

- [ ] **Step 1: Final static checks**

Run: `npm run typecheck` — expected: clean.
Run: `npx wrangler deploy --dry-run --outdir dist` — expected: bundles clean.

- [ ] **Step 2: Confirm deploy with the user, then apply migration and deploy**

This touches production. Confirm the user is ready, then:

Run: `npm run db:migrate:2` — expected: ALTER/CREATE statements succeed against remote D1 (if it errors with "duplicate column", the migration already ran — fine).
Run: `npm run deploy` — expected: deployed to https://stem-splitter.ailab-452.workers.dev.

- [ ] **Step 3: End-to-end verification on the deployed app**

Manual checklist (class code `music101`):

1. **YouTube import:** paste a short (<15 min) YouTube link, FETCH. Expect "FETCHING FROM YOUTUBE…" then a processing console named after the video title, then stems. If it fails with a bot-check error, note it — that's the known youtubei.js risk; retry once before investigating.
2. **6-stem:** select "6 STEMS", import or upload a song with guitar/piano. Expect guitar and piano channels with their own colors.
3. **4-stem default:** upload with the default toggle. Expect the original 4 channels.
4. **Labels:** click a channel name, rename it, Enter. Reload the page in a second browser/incognito with the same job open — the label persists (labels are on the job payload).
5. **Annotations:** play a track, click "＋ NOTE" mid-song, save text. Expect a marker tick at that point; clicking it seeks there and shows the text; ✕ deletes it. Check it appears in the second browser after reload.
6. **Guards:** paste a >15-min video (clear error), a non-YouTube URL (clear error), and confirm uploads still work end-to-end unchanged.
7. Run `npx wrangler tail` in the background during the above and check for unexpected errors.

- [ ] **Step 4: Update CLAUDE.md**

Add to the **Request flow** section of CLAUDE.md, after item 1:

```markdown
1b. **YouTube import:** `POST /api/jobs` with `{ youtubeUrl }` fetches audio in-Worker via `youtubei.js` (`src/youtube.ts`, behind `fetchYouTubeAudio()` so it can be swapped for an external fetcher), stores it at `uploads/<uuid>/source.m4a`, then proceeds like a normal job. 15-min cap, no live streams. Known risk: YouTube-side changes/bot checks can break this until a `youtubei.js` update — file uploads are unaffected.
```

And add to the **Architecture** section (after the Frontend paragraph):

```markdown
**Per-job model choice:** jobs carry `model` (`htdemucs_ft` = 4 stems, default; `htdemucs_6s` = +guitar/piano), validated in the Worker, forwarded through `SeparationStartRequest`. **Shared labels/annotations:** `jobs.labels` JSON column (`PUT /api/jobs/:id/labels`) and an `annotations` table (`POST/DELETE /api/jobs/:id/annotations[/:annotationId]`); both ride along on `GET /api/jobs/:id`. Writes require the class code; reads stay unauthenticated-but-unguessable. Migrations: `schema.sql` is the canonical fresh install; additive changes live in `migrations/` (`npm run db:migrate:2`).
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document YouTube import, model choice, labels, annotations"
```
