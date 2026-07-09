import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from './env';
import { presignUpload, presignDownload } from './r2';
import { getBackend, type SeparationResult } from './separation';

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

const app = new Hono<{ Bindings: Env }>();

// --- auth -------------------------------------------------------------

const requireClassCode = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const code = c.req.header('x-class-code');
  if (!c.env.CLASS_CODE || code !== c.env.CLASS_CODE) {
    return c.json({ error: 'Invalid class code' }, 401);
  }
  await next();
});

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
    | { key?: string; filename?: string; model?: string }
    | null;

  const model = body?.model ?? 'htdemucs_ft';
  if (!ALLOWED_MODELS.includes(model)) {
    return c.json({ error: `Unknown model. Allowed: ${ALLOWED_MODELS.join(', ')}` }, 400);
  }

  const key = body?.key;
  const filename = sanitizeFilename(body?.filename ?? '');
  if (!key || !key.startsWith('uploads/') || !filename) {
    return c.json({ error: 'key and filename are required' }, 400);
  }

  const head = await c.env.AUDIO.head(key);
  if (!head) return c.json({ error: 'Upload not found — did the file finish uploading?' }, 400);
  if (head.size > MAX_SOURCE_BYTES) {
    await c.env.AUDIO.delete(key);
    return c.json({ error: 'File too large (max 100 MB)' }, 400);
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

  return c.json(jobResponse(row));
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

function jobResponse(row: JobRow) {
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
    stems,
    createdAt: row.created_at,
  };
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120);
}
