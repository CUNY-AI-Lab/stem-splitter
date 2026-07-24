import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from './env';
import { presignUpload, presignDownload } from './r2';
import { getBackend, type SeparationResult } from './separation';
import { fetchYouTubeAudio, parseYouTubeVideoId, YouTubeError } from './youtube';
import {
  AssistantError,
  COACH_DOWN,
  getGuide,
  getOrCreateGuide,
  runChat,
  validateTurns,
  type GuideRecord,
} from './assistant';

const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aiff', '.aif'];
const MAX_SOURCE_BYTES = 100 * 1024 * 1024; // 100 MB
const ALLOWED_MODELS = ['htdemucs_ft', 'htdemucs_6s'];

interface JobRow {
  id: string;
  filename: string;
  source_key: string;
  status: string;
  external_id: string | null;
  stems: string | null;
  error: string | null;
  created_at: string;
  model: string | null;
  labels: string | null;
}

interface AnnotationRow {
  id: string;
  job_id: string;
  at_seconds: number;
  text: string;
  created_at: string;
}

const app = new Hono<{ Bindings: Env }>();

// --- auth -------------------------------------------------------------

const requireClassCode = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const code = c.req.header('x-class-code');
  if (!c.env.CLASS_CODE || code !== c.env.CLASS_CODE) {
    return c.json({ error: 'Invalid class code' }, 401);
  }
  await next();
});

// Lets the frontend validate the class code at entry instead of failing
// on the student's first upload. Returns nothing beyond the 200/401.
app.get('/api/auth-check', requireClassCode, (c) => c.json({ ok: true }));

// --- uploads ----------------------------------------------------------

// Issue a presigned PUT so the browser uploads straight to R2.
app.post('/api/uploads', requireClassCode, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { filename?: string } | null;
  const filename = sanitizeFilename(body?.filename ?? '');
  if (!filename) return c.json({ error: 'filename is required' }, 400);

  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return c.json({ error: `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` }, 400);
  }

  const key = `uploads/${crypto.randomUUID()}/${filename}`;
  const uploadUrl = await presignUpload(c.env, key);
  return c.json({ key, uploadUrl });
});

// --- jobs -------------------------------------------------------------

app.post('/api/jobs', requireClassCode, async (c) => {
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
    // Caller error (unrecognizable link) is a 400; upstream failures are 502.
    if (!parseYouTubeVideoId(body.youtubeUrl)) {
      return c.json(
        { error: 'Not a recognizable YouTube link (use youtube.com/watch, youtu.be, or /shorts).' },
        400
      );
    }
    // In-Worker YouTube fetch: audio lands in R2 first; the job row is only
    // created after, so a failed fetch never leaves an orphan/stuck job.
    let audio;
    try {
      audio = await fetchYouTubeAudio(body.youtubeUrl, c.env);
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

  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO jobs (id, filename, source_key, status, model) VALUES (?, ?, ?, ?, ?)')
    .bind(id, filename, key, 'pending', model)
    .run();

  const audioUrl = await presignDownload(c.env, key);
  const webhookUrl = `${c.env.PUBLIC_BASE_URL}/api/webhooks/separation?job=${id}&token=${c.env.WEBHOOK_SECRET}`;

  try {
    const { externalId } = await getBackend(c.env).start({ jobId: id, audioUrl, webhookUrl, model });
    await c.env.DB.prepare('UPDATE jobs SET external_id = ?, status = ? WHERE id = ?')
      .bind(externalId, 'processing', id)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await c.env.DB.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?')
      .bind('failed', message, id)
      .run();
    return c.json({ error: `Failed to start separation: ${message}` }, 502);
  }

  return c.json({ id, status: 'processing', filename });
});

app.get('/api/jobs/:id', async (c) => {
  const id = c.req.param('id');
  let row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);

  // Reconciliation fallback: if we're still 'processing', poll the provider
  // directly in case the completion webhook was missed (also makes local
  // dev work, where webhooks can't reach us).
  if (row.status === 'processing' && row.external_id) {
    try {
      const result = await getBackend(c.env).fetchStatus(row.external_id);
      if (result.status !== 'processing') {
        await ingestResult(c.env, id, result);
        row = (await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>())!;
      }
    } catch {
      // Provider hiccup — stay 'processing', the next poll will retry.
    }
  }

  const { results } = await c.env.DB
    .prepare('SELECT * FROM annotations WHERE job_id = ? ORDER BY at_seconds')
    .bind(id)
    .all<AnnotationRow>();
  // The cached listening guide only exists for finished jobs; skip the extra
  // SELECT on the frequent still-processing polls.
  const guide = row.status === 'done' ? await getGuide(c.env, id) : null;
  return c.json(jobResponse(row, results ?? [], guide));
});

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

// --- listening guy (AI coach) -----------------------------------------

// Generate (once) and return the class-shared listening guide. Generation is
// class-code-gated because it costs money; reading the cached guide rides
// along on the open GET /api/jobs/:id like labels and annotations.
app.post('/api/jobs/:id/guide', requireClassCode, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.status !== 'done') {
    return c.json({ error: "Stems aren't ready yet — the coach needs the finished song." }, 409);
  }

  const body = (await c.req.json().catch(() => null)) as { durationSec?: unknown } | null;
  const { results } = await c.env.DB
    .prepare('SELECT * FROM annotations WHERE job_id = ? ORDER BY at_seconds')
    .bind(id)
    .all<AnnotationRow>();

  try {
    const { guide, cached } = await getOrCreateGuide(c.env, row, results ?? [], parseDuration(body?.durationSec));
    return c.json({ guide, cached });
  } catch (err) {
    return assistantFailure(c, err);
  }
});

// Chat with the coach about one song. The conversation lives client-side and
// is resent each call; replies may carry validated mixer tool calls that the
// browser executes (solo / set_mute / seek / add_note).
app.post('/api/jobs/:id/chat', requireClassCode, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.status !== 'done') {
    return c.json({ error: "Stems aren't ready yet — the coach needs the finished song." }, 409);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { messages?: unknown; durationSec?: unknown }
    | null;
  const turns = validateTurns(body?.messages);
  if (!turns) {
    return c.json({ error: 'messages must be 1-12 turns (each ≤2000 chars) ending with a user message' }, 400);
  }

  const { results } = await c.env.DB
    .prepare('SELECT * FROM annotations WHERE job_id = ? ORDER BY at_seconds')
    .bind(id)
    .all<AnnotationRow>();

  try {
    return c.json(await runChat(c.env, row, results ?? [], turns, parseDuration(body?.durationSec)));
  } catch (err) {
    return assistantFailure(c, err);
  }
});

// --- separation webhook -----------------------------------------------

app.post('/api/webhooks/separation', async (c) => {
  const token = c.req.query('token');
  const jobId = c.req.query('job');
  if (!token || token !== c.env.WEBHOOK_SECRET) return c.text('Forbidden', 403);
  if (!jobId) return c.text('Missing job', 400);

  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<JobRow>();
  if (!row) return c.text('Unknown job', 404);
  if (row.status === 'done' || row.status === 'failed') return c.json({ ok: true }); // already ingested

  const payload = await c.req.json().catch(() => null);
  if (!payload) return c.text('Bad payload', 400);

  const result = getBackend(c.env).parseResult(payload);
  try {
    await ingestResult(c.env, jobId, result);
  } catch (err) {
    // 500 so the provider retries the webhook.
    const message = err instanceof Error ? err.message : String(err);
    return c.text(`Ingest failed: ${message}`, 500);
  }
  return c.json({ ok: true });
});

// --- stem file serving ------------------------------------------------

app.get('/api/files/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice('/api/files/'.length));
  // Only serve generated stems, never uploaded originals.
  if (!key.startsWith('stems/')) return c.text('Not found', 404);

  const obj = await c.env.AUDIO.get(key);
  if (!obj) return c.text('Not found', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=3600');
  if (c.req.query('download') !== undefined) {
    headers.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
  }
  return new Response(obj.body, { headers });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;

// --- helpers ------------------------------------------------------------

/** Download finished stems from the provider and store them in R2. */
async function ingestResult(env: Env, jobId: string, result: SeparationResult): Promise<void> {
  if (result.status === 'failed') {
    await env.DB.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?')
      .bind('failed', result.error ?? 'Separation failed', jobId)
      .run();
    return;
  }
  if (result.status !== 'succeeded') return;
  if (!result.stems?.length) {
    await env.DB.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?')
      .bind('failed', 'Separation succeeded but returned no stems', jobId)
      .run();
    return;
  }

  const stored: { name: string; key: string }[] = [];
  for (const stem of result.stems) {
    const res = await fetch(stem.url);
    if (!res.ok) throw new Error(`Failed to download stem "${stem.name}" (${res.status})`);
    const key = `stems/${jobId}/${stem.name}.mp3`;
    await env.AUDIO.put(key, await res.arrayBuffer(), {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    stored.push({ name: stem.name, key });
  }

  await env.DB.prepare('UPDATE jobs SET status = ?, stems = ? WHERE id = ?')
    .bind('done', JSON.stringify(stored), jobId)
    .run();
}

function jobResponse(row: JobRow, annotations: AnnotationRow[] = [], guide: GuideRecord | null = null) {
  const stems = row.stems
    ? (JSON.parse(row.stems) as { name: string; key: string }[]).map((s) => ({
        name: s.name,
        url: `/api/files/${s.key}`,
      }))
    : [];
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    error: row.error,
    model: row.model ?? 'htdemucs_ft',
    labels: row.labels ? (JSON.parse(row.labels) as Record<string, string>) : {},
    annotations: annotations.map((a) => ({ id: a.id, atSeconds: a.at_seconds, text: a.text })),
    stems,
    guide,
    createdAt: row.created_at,
  };
}

/** Client-supplied advisory duration; the browser is the only reliable source. */
function parseDuration(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 7200 ? n : undefined;
}

function assistantFailure(c: Context<{ Bindings: Env }>, err: unknown) {
  if (err instanceof AssistantError) return c.json({ error: err.studentMessage }, err.httpStatus);
  console.error('assistant error', err);
  return c.json({ error: COACH_DOWN }, 502);
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120);
}
