import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from './env';
import {
  getRetainedAudio,
  isLocalHosting,
  maintainLocalAudioRetention,
  presignUpload,
  presignDownload,
  verifyLocalSource,
} from './r2';
import { getBackend, type SeparationResult } from './separation';
import {
  DEFAULT_DEMUCS_MODEL,
  getSeparationOption,
  getSeparationOptions,
  modelIsAllowed,
  StemContractError,
  validateAndOrderStems,
} from './separation/options';
import { fetchYouTubeAudio, parseYouTubeVideoId, YouTubeError } from './youtube';
import {
  archiveContentType,
  ArchiveError,
  ARCHIVE_SCOPES,
  fetchArchiveAudio,
  fetchArchiveItem,
  isArchiveScope,
  parseArchiveIdentifier,
  searchArchive,
} from './archive';
import {
  AssistantError,
  COACH_DOWN,
  COACH_UNCONFIGURED,
  getGuide,
  streamGuide,
  streamChat,
  validateTurns,
  type GuideRecord,
} from './assistant';
import { buildSystemPrompt } from './assistant/prompt';
import {
  clearedSessionCookie,
  cookiesShouldBeSecure,
  createSession,
  destroySession,
  getAmendment,
  MAX_AMENDMENT_CHARS,
  normalizeAmendment,
  readSessionCookie,
  resolveSession,
  sessionCookie,
  setAmendment,
  syncTeachersFromSeed,
  verifyLogin,
} from './teacher/auth';

const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aiff', '.aif'];
const MAX_SOURCE_BYTES = 100 * 1024 * 1024; // 100 MB
const INGEST_LEASE_PREFIX = 'ingesting:';
const INGEST_LEASE_MS = 5 * 60 * 1000;
const MP3_FRAME_SCAN_BYTES = 64 * 1024;
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

// Miniflare does not inherit the production R2 bucket lifecycle. Fail closed
// if local retention maintenance cannot run, rather than accumulating audio.
app.use('/api/*', async (c, next) => {
  if (isLocalHosting(c.env)) {
    try {
      await maintainLocalAudioRetention(c.env);
    } catch (error) {
      console.error('local audio retention cleanup failed', error);
      return c.json({ error: 'Local audio storage maintenance failed' }, 503);
    }
  }
  await next();
});

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

// The static frontend asks which profiles the configured backend can actually
// run. In particular, Replicate must never advertise the local BS-RoFormer
// profile even though the branched frontend knows how to display it.
app.get('/api/separation-options', (c) => c.json(getSeparationOptions(c.env.SEPARATION_BACKEND)));

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

// Local Miniflare R2 cannot issue S3 presigned URLs. When explicitly running
// behind Tailscale Funnel, accept same-origin uploads into the simulated bucket.
app.put('/api/local-uploads/*', requireClassCode, async (c) => {
  if (!isLocalHosting(c.env)) return c.text('Not found', 404);
  const key = localObjectKey(c.req.url, '/api/local-uploads/');
  if (!key?.startsWith('uploads/')) return c.text('Not found', 404);

  const contentLength = c.req.header('content-length');
  if (!contentLength) {
    return c.json({ error: 'Content-Length is required for local uploads' }, 411);
  }
  if (!/^\d+$/.test(contentLength)) {
    return c.json({ error: 'Invalid Content-Length' }, 400);
  }
  const declaredSize = Number(contentLength);
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    return c.json({ error: 'Invalid Content-Length' }, 400);
  }
  if (declaredSize > MAX_SOURCE_BYTES) {
    return c.json({ error: 'File too large (max 100 MB)' }, 413);
  }
  if (!c.req.raw.body) return c.json({ error: 'Upload body is required' }, 400);

  await c.env.AUDIO.put(key, c.req.raw.body, {
    httpMetadata: { contentType: c.req.header('content-type') || 'application/octet-stream' },
  });
  const stored = await c.env.AUDIO.head(key);
  if (!stored || stored.size !== declaredSize) {
    await c.env.AUDIO.delete(key);
    return c.json({ error: 'Upload size did not match Content-Length' }, 400);
  }
  return c.body(null, 204);
});

// Replicate needs a public URL for locally stored source audio. The URL is
// short-lived and HMAC-signed so uploaded originals are not generally exposed.
app.get('/api/local-sources/*', async (c) => {
  if (!isLocalHosting(c.env)) return c.text('Not found', 404);
  const key = localObjectKey(c.req.url, '/api/local-sources/');
  if (!key?.startsWith('uploads/')) return c.text('Not found', 404);
  if (!(await verifyLocalSource(c.env, key, c.req.query('expires'), c.req.query('signature')))) {
    return c.text('Forbidden', 403);
  }

  const obj = await getRetainedAudio(c.env, key);
  if (!obj) return c.text('Not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Length', String(obj.size));
  headers.set('Cache-Control', 'private, no-store');
  return new Response(obj.body, { headers });
});

// --- teacher backend ---------------------------------------------------
//
// Separate from the class code: the class code is a shared secret every
// student holds, so it cannot gate anything that edits what the Listening Guide says.

/** Seeding runs at most once per isolate; the seed itself is idempotent. */
let teacherSeedPromise: Promise<void> | null = null;
function ensureTeachersSeeded(c: Context<{ Bindings: Env }>): Promise<void> {
  teacherSeedPromise ??= syncTeachersFromSeed(c.env).catch((err) => {
    console.error('teacher seed failed', err);
    teacherSeedPromise = null; // let the next request retry
  });
  return teacherSeedPromise;
}

async function currentTeacher(c: Context<{ Bindings: Env }>) {
  await ensureTeachersSeeded(c);
  return resolveSession(c.env, readSessionCookie(c.req.header('Cookie')));
}

const requireTeacher = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const teacher = await currentTeacher(c);
  if (!teacher) return c.json({ error: 'Sign in to continue.' }, 401);
  c.set('teacher' as never, teacher as never);
  await next();
});

function isSecureRequest(c: Context<{ Bindings: Env }>): boolean {
  return cookiesShouldBeSecure(c.env.PUBLIC_BASE_URL, c.req.url);
}

app.post('/api/teacher/login', async (c) => {
  await ensureTeachersSeeded(c);
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;

  if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
    return c.json({ error: 'Username and password are required.' }, 400);
  }

  const teacher = await verifyLogin(c.env, body.username, body.password);
  // One message for both unknown-user and wrong-password: no account enumeration.
  if (!teacher) return c.json({ error: 'Incorrect username or password.' }, 401);

  const token = await createSession(c.env, teacher.username);
  c.header('Set-Cookie', sessionCookie(token, isSecureRequest(c)));
  return c.json({ username: teacher.username, displayName: teacher.displayName });
});

app.post('/api/teacher/logout', async (c) => {
  await destroySession(c.env, readSessionCookie(c.req.header('Cookie')));
  c.header('Set-Cookie', clearedSessionCookie(isSecureRequest(c)));
  return c.json({ ok: true });
});

app.get('/api/teacher/me', async (c) => {
  const teacher = await currentTeacher(c);
  if (!teacher) return c.json({ error: 'Not signed in.' }, 401);
  return c.json({ username: teacher.username, displayName: teacher.displayName });
});

app.get('/api/teacher/prompt', requireTeacher, async (c) => {
  const record = await getAmendment(c.env);
  return c.json({ ...record, maxChars: MAX_AMENDMENT_CHARS });
});

app.put('/api/teacher/prompt', requireTeacher, async (c) => {
  const teacher = (await currentTeacher(c))!;
  const body = (await c.req.json().catch(() => null)) as { amendment?: unknown } | null;

  const amendment = normalizeAmendment(body?.amendment);
  if (amendment === null) {
    return c.json({ error: `Amendment must be text under ${MAX_AMENDMENT_CHARS} characters.` }, 400);
  }

  const record = await setAmendment(c.env, amendment, teacher.username);

  // Guides are cached per job and were written under the previous prompt, so a
  // stale cache would silently outlive the edit. Clear it; guides regenerate
  // lazily (~$0.005 each) the next time a student opens one.
  const cleared = await c.env.DB.prepare('DELETE FROM guides').run();
  return c.json({
    ...record,
    maxChars: MAX_AMENDMENT_CHARS,
    guidesCleared: cleared.meta?.changes ?? 0,
  });
});

/** Preview the exact system prompt the Listening Guide will receive. */
app.get('/api/teacher/prompt/preview', requireTeacher, async (c) => {
  const { amendment } = await getAmendment(c.env);
  const model = getSeparationOption(DEFAULT_DEMUCS_MODEL);
  return c.json({
    prompt: buildSystemPrompt({
      title: 'Example Track.mp3',
      model: DEFAULT_DEMUCS_MODEL,
      stems: (model?.stems ?? ['vocals', 'drums', 'bass', 'other']).map((name) => ({
        name,
        label: name,
      })),
      annotations: [],
      durationSec: 210,
      amendment,
      mode: 'guide',
    }),
  });
});

// --- internet archive browse ------------------------------------------
//
// Reads are gated the same way the assistant endpoints are: they are cheap,
// but they are also the pathway into a paid separation, so keep them behind
// the class code rather than leaving an open search proxy on the Worker.

app.get('/api/archive/scopes', (c) =>
  c.json({
    scopes: Object.entries(ARCHIVE_SCOPES).map(([id, scope]) => ({ id, label: scope.label })),
  })
);

app.get('/api/archive/search', requireClassCode, async (c) => {
  const term = c.req.query('q') ?? '';
  const scopeParam = c.req.query('scope') ?? 'music';
  const scope = isArchiveScope(scopeParam) ? scopeParam : 'music';
  const page = Number.parseInt(c.req.query('page') ?? '1', 10) || 1;

  try {
    return c.json(await searchArchive(term, scope, page));
  } catch (err) {
    return archiveErrorResponse(c, err, 'Internet Archive search failed.');
  }
});

app.get('/api/archive/items/:identifier', requireClassCode, async (c) => {
  const identifier = parseArchiveIdentifier(c.req.param('identifier'));
  if (!identifier) {
    return c.json({ error: 'That is not a valid Internet Archive item.' }, 400);
  }

  try {
    return c.json(await fetchArchiveItem(identifier));
  } catch (err) {
    return archiveErrorResponse(c, err, 'Could not load that Internet Archive item.');
  }
});

function archiveErrorResponse(c: Context<{ Bindings: Env }>, err: unknown, fallback: string) {
  console.error('archive request failed', err);
  if (err instanceof ArchiveError) {
    // Bad identifiers and licence rejections are caller errors, not upstream faults.
    const clientError = ['invalid_identifier', 'item_not_found', 'license_missing', 'license_no_derivatives', 'no_audio_files'].includes(
      err.code
    );
    return c.json(
      { error: err.message, code: err.code, retryable: err.retryable },
      clientError ? 400 : 502
    );
  }
  return c.json({ error: fallback }, 502);
}

// --- jobs -------------------------------------------------------------

app.post('/api/jobs', requireClassCode, async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | {
        key?: string;
        filename?: string;
        youtubeUrl?: string;
        archiveId?: string;
        archiveFile?: string;
        model?: string;
      }
    | null;

  const options = getSeparationOptions(c.env.SEPARATION_BACKEND);
  const model = body?.model ?? options.defaultModel;
  if (!modelIsAllowed(c.env.SEPARATION_BACKEND, model)) {
    return c.json({ error: `Unknown model. Allowed: ${options.models.map((item) => item.id).join(', ')}` }, 400);
  }

  let key: string;
  let filename: string;

  if (body?.youtubeUrl) {
    // Caller error (unrecognizable link) is a 400; upstream failures are 502.
    if (!parseYouTubeVideoId(body.youtubeUrl)) {
      return c.json(
        {
          error: 'Paste a full YouTube video link.',
          code: 'invalid_youtube_url',
          retryable: false,
        },
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
      return c.json(
        {
          error: message,
          ...(err instanceof YouTubeError
            ? { code: err.code, retryable: err.retryable }
            : {}),
        },
        502
      );
    }
    if (audio.data.byteLength > MAX_SOURCE_BYTES) {
      return c.json({ error: 'Audio too large (max 100 MB)' }, 400);
    }
    key = `uploads/${crypto.randomUUID()}/source.m4a`;
    filename = sanitizeFilename(audio.title) || 'youtube-audio';
    await c.env.AUDIO.put(key, audio.data, { httpMetadata: { contentType: 'audio/mp4' } });
  } else if (body?.archiveId) {
    const identifier = parseArchiveIdentifier(body.archiveId);
    if (!identifier) {
      return c.json(
        {
          error: 'That is not a valid Internet Archive item.',
          code: 'invalid_archive_id',
          retryable: false,
        },
        400
      );
    }
    // Same ordering rule as the YouTube path: bytes land in R2 first, and the
    // job row is only created after, so a failed fetch leaves no stuck job.
    let audio;
    try {
      audio = await fetchArchiveAudio(identifier, body.archiveFile, c.env);
    } catch (err) {
      const message =
        err instanceof ArchiveError
          ? err.message
          : 'Internet Archive fetch failed — try another track, or upload the audio file instead.';
      console.error('archive fetch error', err);
      return c.json(
        {
          error: message,
          ...(err instanceof ArchiveError
            ? { code: err.code, retryable: err.retryable }
            : {}),
        },
        502
      );
    }
    if (audio.data.byteLength > MAX_SOURCE_BYTES) {
      return c.json({ error: 'Audio too large (max 100 MB)' }, 400);
    }
    const extension = audio.fileName.slice(audio.fileName.lastIndexOf('.')).toLowerCase();
    key = `uploads/${crypto.randomUUID()}/source${extension}`;
    filename = sanitizeFilename(audio.title) || 'archive-audio';
    await c.env.AUDIO.put(key, audio.data, {
      httpMetadata: { contentType: archiveContentType(audio.fileName) },
    });
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

  return c.json({
    id,
    status: 'processing',
    filename,
    model,
    expectedStems: getSeparationOption(model)?.stems ?? [],
  });
});

app.get('/api/jobs/:id', async (c) => {
  const id = c.req.param('id');
  let row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);

  // A Worker termination can strand an ingestion claim. Re-open only expired
  // leases; active winners keep exclusive ownership.
  if (row.status === 'ingesting' && ingestLeaseExpired(row.error)) {
    await c.env.DB.prepare(
      "UPDATE jobs SET status = 'processing', error = NULL WHERE id = ? AND status = 'ingesting' AND error = ?"
    )
      .bind(id, row.error)
      .run();
    row = (await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>())!;
  }

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

// --- listening guy (the Listening Guide) -----------------------------------------

// Generate (once) and return the class-shared listening guide, streamed as
// SSE (`data: {type: delta|done|error}` events); the done event carries the
// full cached record. Generation is class-code-gated because it costs money;
// reading the cached guide rides along on the open GET /api/jobs/:id like
// labels and annotations. Validation failures stay plain JSON — streaming
// starts only after them.
app.post('/api/jobs/:id/guide', requireClassCode, async (c) => {
  // Keep the documented pre-stream 503 for unconfigured deployments — once
  // streaming starts, errors can only arrive as in-stream events.
  if (!c.env.OPENROUTER_API_KEY || !c.env.ASSISTANT_MODEL) {
    return c.json({ error: COACH_UNCONFIGURED }, 503);
  }
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.status !== 'done') {
    return c.json({ error: "Stems aren't ready yet — the Listening Guide needs the finished song." }, 409);
  }

  const body = (await c.req.json().catch(() => null)) as { durationSec?: unknown } | null;
  const { results } = await c.env.DB
    .prepare('SELECT * FROM annotations WHERE job_id = ? ORDER BY at_seconds')
    .bind(id)
    .all<AnnotationRow>();

  return sseResponse(c, async (emit) => {
    const { guide, cached } = await streamGuide(
      c.env, row, results ?? [], parseDuration(body?.durationSec),
      (text) => emit({ type: 'delta', text })
    );
    await emit({ type: 'done', text: guide.text, model: guide.model, createdAt: guide.createdAt, cached, finishReason: 'stop' });
  });
});

// Chat with the Listening Guide about one song, streamed as SSE. The conversation lives
// client-side and is resent each call; the reply prose streams as delta
// events, then validated mixer tool calls (solo / set_mute / seek / add_note)
// arrive in one tool_calls event for the browser to execute, then done.
app.post('/api/jobs/:id/chat', requireClassCode, async (c) => {
  if (!c.env.OPENROUTER_API_KEY || !c.env.ASSISTANT_MODEL) {
    return c.json({ error: COACH_UNCONFIGURED }, 503);
  }
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.status !== 'done') {
    return c.json({ error: "Stems aren't ready yet — the Listening Guide needs the finished song." }, 409);
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

  return sseResponse(c, async (emit) => {
    const result = await streamChat(
      c.env, row, results ?? [], turns, parseDuration(body?.durationSec),
      (text) => emit({ type: 'delta', text })
    );
    if (result.toolCalls.length) await emit({ type: 'tool_calls', calls: result.toolCalls });
    await emit({ type: 'done', text: result.reply, finishReason: result.finishReason });
  });
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
  const key = localObjectKey(c.req.url, '/api/files/');
  // Only serve generated stems, never uploaded originals.
  if (!key?.startsWith('stems/')) return c.text('Not found', 404);

  const obj = await getRetainedAudio(c.env, key);
  if (!obj) return c.text('Not found', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Length', String(obj.size));
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
  if (result.status !== 'failed' && result.status !== 'succeeded') return;

  const job = await env.DB.prepare('SELECT model FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<Pick<JobRow, 'model'>>();
  if (!job) return;

  // A webhook and a browser poll can observe the same terminal provider state
  // concurrently. Claim ingestion atomically so stems are downloaded exactly
  // once and the losing path can return successfully without racing R2 writes.
  // Store a private lease marker in the otherwise-unused active-job error field
  // so a later poll can recover if this Worker dies before releasing the claim.
  const lease = `${INGEST_LEASE_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
  const claim = await env.DB.prepare(
    "UPDATE jobs SET status = 'ingesting', error = ? WHERE id = ? AND status = 'processing'"
  )
    .bind(lease, jobId)
    .run();
  if (!claim.meta.changes) return;

  const stored: { name: string; key: string }[] = [];
  try {
    if (result.status === 'failed') {
      await env.DB.prepare(
        "UPDATE jobs SET status = ?, error = ? WHERE id = ? AND status = 'ingesting' AND error = ?"
      )
        .bind('failed', result.error ?? 'Separation failed', jobId, lease)
        .run();
      return;
    }
    let stems;
    try {
      stems = validateAndOrderStems(job.model ?? DEFAULT_DEMUCS_MODEL, result.stems);
    } catch (error) {
      const message =
        error instanceof StemContractError
          ? error.message
          : 'The separator returned an invalid set of tracks';
      await env.DB.prepare(
        "UPDATE jobs SET status = ?, error = ? WHERE id = ? AND status = 'ingesting' AND error = ?"
      )
        .bind('failed', message, jobId, lease)
        .run();
      return;
    }

    for (const stem of stems) {
      const audio = await downloadStem(stem.name, stem.url);
      const key = `stems/${jobId}/${stem.name}.mp3`;
      await env.AUDIO.put(key, audio, {
        httpMetadata: { contentType: 'audio/mpeg' },
      });
      stored.push({ name: stem.name, key });
    }

    await env.DB.prepare(
      "UPDATE jobs SET status = ?, stems = ?, error = NULL WHERE id = ? AND status = 'ingesting' AND error = ?"
    )
      .bind('done', JSON.stringify(stored), jobId, lease)
      .run();
  } catch (error) {
    const cleanup = await Promise.allSettled(stored.map(({ key }) => env.AUDIO.delete(key)));
    if (cleanup.some((result) => result.status === 'rejected')) {
      console.error('failed to remove partial stem files', { jobId });
    }
    if (error instanceof InvalidStemAudioError) {
      await env.DB.prepare(
        "UPDATE jobs SET status = 'failed', error = ? WHERE id = ? AND status = 'ingesting' AND error = ?"
      )
        .bind(error.message, jobId, lease)
        .run();
      return;
    }
    // Let a provider retry or the next browser poll make another attempt.
    await env.DB.prepare(
      "UPDATE jobs SET status = 'processing', error = NULL WHERE id = ? AND status = 'ingesting' AND error = ?"
    )
      .bind(jobId, lease)
      .run();
    throw error;
  }
}

class InvalidStemAudioError extends Error {}

async function downloadStem(name: string, url: string): Promise<ArrayBuffer> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(`Failed to download stem "${name}"`);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
      continue;
    }

    if (response.ok) {
      try {
        const audio = await response.arrayBuffer();
        if (!looksLikeMp3(audio)) {
          lastError = new InvalidStemAudioError(
            `The "${name}" track was empty or was not a playable MP3`
          );
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 100));
          }
          continue;
        }
        return audio;
      } catch (error) {
        if (error instanceof InvalidStemAudioError) {
          lastError = error;
          continue;
        }
        lastError =
          error instanceof Error
            ? error
            : new Error(`Failed to read stem "${name}"`);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
        }
        continue;
      }
    }

    lastError = new Error(`Failed to download stem "${name}" (${response.status})`);
    await response.body?.cancel().catch(() => {});
    if (response.status !== 429 && response.status < 500) throw lastError;

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }

  throw lastError ?? new Error(`Failed to download stem "${name}"`);
}

function looksLikeMp3(audio: ArrayBuffer): boolean {
  const bytes = new Uint8Array(audio);
  if (bytes.length < 4) return false;

  let scanStart = 0;
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    const tagSize =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    scanStart = Math.min(bytes.length - 1, 10 + tagSize);
  }

  const scanEnd = Math.min(bytes.length - 1, scanStart + MP3_FRAME_SCAN_BYTES);
  for (let index = scanStart; index < scanEnd; index += 1) {
    if (
      bytes[index] === 0xff &&
      (bytes[index + 1] & 0xe0) === 0xe0 &&
      (bytes[index + 1] & 0x18) !== 0x08 &&
      (bytes[index + 1] & 0x06) !== 0
    ) {
      return true;
    }
  }
  return false;
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
    error: row.status === 'failed' ? row.error : null,
    model: row.model ?? DEFAULT_DEMUCS_MODEL,
    expectedStems: getSeparationOption(row.model ?? DEFAULT_DEMUCS_MODEL)?.stems ?? [],
    labels: row.labels ? (JSON.parse(row.labels) as Record<string, string>) : {},
    annotations: annotations.map((a) => ({ id: a.id, atSeconds: a.at_seconds, text: a.text })),
    stems,
    guide,
    createdAt: row.created_at,
  };
}

function ingestLeaseExpired(value: string | null): boolean {
  if (!value?.startsWith(INGEST_LEASE_PREFIX)) return false;
  const startedAt = Number(value.slice(INGEST_LEASE_PREFIX.length).split(':', 1)[0]);
  return Number.isFinite(startedAt) && Date.now() - startedAt >= INGEST_LEASE_MS;
}

/** Client-supplied advisory duration; the browser is the only reliable source. */
function parseDuration(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 7200 ? n : undefined;
}

// SSE transport for the assistant: the handler emits `data:` JSON events while
// waitUntil keeps the pump alive past the returned Response. Failures inside
// the stream become a terminal error event with a student-safe message.
function sseResponse(
  c: Context<{ Bindings: Env }>,
  run: (emit: (event: Record<string, unknown>) => Promise<void>) => Promise<void>
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const pump = (async () => {
    try {
      await run(emit);
    } catch (err) {
      if (!(err instanceof AssistantError)) console.error('assistant error', err);
      const message = err instanceof AssistantError ? err.studentMessage : COACH_DOWN;
      await emit({ type: 'error', message }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  try {
    c.executionCtx.waitUntil(pump);
  } catch {
    // Node adapter (Railway staging): no ExecutionContext — the pump runs as
    // a detached promise, which Node keeps alive on its own.
  }
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120);
}

function localObjectKey(requestUrl: string, prefix: string): string | null {
  const encoded = new URL(requestUrl).pathname.slice(prefix.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
