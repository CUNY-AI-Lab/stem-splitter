import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from './env';
import {
  getRetainedAudio,
  isLocalHosting,
  usesRoutedAudio,
  isLocalSourceDownloadKey,
  maintainLocalAudioRetention,
  presignAnalysisDownload,
  presignUpload,
  presignDownload,
  verifyLocalSource,
} from './r2';
import {
  audioAnalysisTimeoutMs,
  AUTO_ROUTING_REQUEST,
  AuthoritativeAutoSourceError,
  configuredAudioAnalysisProvider,
  discardAuthoritativeAutoSource,
  prepareAuthoritativeAutoSource,
  redactInstrumentDiscovery,
  requestSourceFingerprint,
  resolveAutoRoutingWithSource,
  serverAutoCapability,
  type AudioSourceIdentityV1,
  type AudioSourceType,
  type AutoRoutingDecisionV1,
} from './analysis';
import {
  parseAutoRoutingDecision,
  parseBrowserAutoSummary,
  AudioAnalysisContractError,
} from './analysis/contract';
import {
  getLatestInstrumentDiscoveryFeedback,
  INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION,
  INSTRUMENT_FEEDBACK_GENRE_FAMILIES,
  InstrumentDiscoveryFeedbackError,
  recordInstrumentDiscoveryFeedback,
  summarizeInstrumentDiscoveryFeedback,
  type InstrumentDiscoveryFeedbackTargetV1,
} from './analysis/instrument-feedback.ts';
import {
  INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
  INSTRUMENT_REVIEW_OPTIONS,
} from './analysis/instrument-review.ts';
import { processingFeatureFlags } from './features';
import { getBackend, type SeparationResult } from './separation';
import {
  DEFAULT_DEMUCS_MODEL,
  allSeparationOptions,
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
import {
  buildSystemPromptPreview,
  hashSystemPromptFingerprint,
  SYSTEM_PROMPT_VERSION,
} from './assistant/prompt';
import {
  clearedSessionCookie,
  cookiesShouldBeSecure,
  createSession,
  destroySession,
  getAmendment,
  getPromptHistoryPage,
  MAX_AMENDMENT_CHARS,
  MAX_CHANGE_NOTE_CHARS,
  normalizeAmendment,
  normalizeChangeNote,
  readSessionCookie,
  resolveSession,
  sessionCookie,
  setAmendment,
  syncTeachersFromSeed,
  TeacherLoginThrottle,
  verifyLogin,
} from './teacher/auth';
import { readBoundedTeacherJson, TeacherRequestError } from './teacher/request';
import { JsonRequestError, readBoundedJsonRequest } from './http/bounded-request.ts';
import {
  createInstrumentIsolation,
  InstrumentIsolationResourceError,
  listInstrumentIsolations,
  summarizeInstrumentIsolation,
} from './isolation/resource.ts';
import {
  normalizeIsolationTarget,
  QueryIsolationContractError,
} from './isolation/contract.ts';
import { audioSepReplicateIdentity } from './isolation/options.ts';
import { authorizeCailRequest, equalSecret, validWriteOrigin, type AppPrincipal } from './identity.ts';
import { readBoundedResponse } from './http/bounded-response.ts';

const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aiff', '.aif'];
const MAX_SOURCE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_SMALL_JSON_BYTES = 4 * 1024;
const MAX_JOB_JSON_BYTES = 32 * 1024;
const MAX_WEBHOOK_JSON_BYTES = 64 * 1024;
const INGEST_LEASE_PREFIX = 'ingesting:';
const INGEST_LEASE_MS = 5 * 60 * 1000;
const MP3_FRAME_SCAN_BYTES = 64 * 1024;
const STORED_CORE_MODELS = allSeparationOptions().map(({ id, stems }) => ({
  id,
  stems: [...stems],
}));
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
  routing_request: string | null;
  source_type: string | null;
  analysis: string | null;
  source_hash: string | null;
  labels: string | null;
}

interface AnnotationRow {
  id: string;
  job_id: string;
  at_seconds: number;
  text: string;
  created_at: string;
}

async function sha256Audio(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Text(value: string): Promise<string> {
  return sha256Audio(new TextEncoder().encode(value).slice().buffer as ArrayBuffer);
}

type AppContext = { Bindings: Env; Variables: { principal?: AppPrincipal } };
const app = new Hono<AppContext>();

app.use('/api/*', async (c, next) => {
  if (c.env.AUTH_MODE === 'cail') {
    const denied = await authorizeCailRequest(c.req.raw, c.env, (principal) => c.set('principal', principal));
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const principal = c.get('principal');
    const scope = c.req.method !== 'POST' ? null : c.req.path === '/api/jobs' ? 'split'
      : !c.env.assistantTransport && /^\/api\/jobs\/[^/]+\/(?:guide|chat)$/.test(c.req.path) ? 'guide' : null;
    if (scope && principal) {
      // An atomic database reservation, not a per-isolate counter. Reserve
      // before imports or provider calls; failure never refunds an uncertain call.
      const day = new Date().toISOString().slice(0, 10);
      const reservation = await c.env.DB.prepare(`INSERT INTO app_request_reservations (id, subject, scope, day)
        SELECT ?, ?, ?, ? WHERE
        (SELECT COUNT(*) FROM app_request_reservations WHERE scope = ? AND day = ? AND subject = ?) < ? AND
        (SELECT COUNT(*) FROM app_request_reservations WHERE scope = ? AND day = ?) < ?`)
        .bind(crypto.randomUUID(), principal.subject, scope, day, scope, day, principal.subject,
          scope === 'split' ? 5 : 100, scope, day, scope === 'split' ? 20 : 500).run();
      if (!reservation.meta.changes) return c.json({ error: 'The daily allowance has been reached. Please try again tomorrow.' }, 429);
    }
  } else if (c.req.path.startsWith('/api/teacher/') && !['GET', 'HEAD'].includes(c.req.method)) {
    if (c.req.header('origin') && !validWriteOrigin(c.req.raw, c.env)) return c.json({ error: 'Request origin not allowed' }, 403);
  }
  await next();
});

app.get('/api/runtime', (c) => c.json({
  authMode: c.env.AUTH_MODE === 'cail' ? 'cail' : 'class-code',
  loginUrl: c.env.CAIL_LOGIN_URL || null,
  remixer: c.env.REMIXER_ENABLED === 'true',
}));

app.get('/api/account', (c) => {
  const principal = c.get('principal');
  return principal ? c.json({ account: principal }) : c.json({ account: null }, 401);
});

app.get('/api/model-quota', async (c) => {
  if (!c.get('principal') || !c.env.assistantQuota) return c.json({ quota: null }, 503);
  try { return c.json({ quota: await c.env.assistantQuota() }); }
  catch { return c.json({ quota: null }, 503); }
});

app.get('/api/admin/users', async (c) => {
  if (c.get('principal')?.role !== 'admin') return c.json({ error: 'Not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT subject, role, disabled, role_expires_at, revision FROM app_users ORDER BY created_at DESC, subject LIMIT 200').all();
  return c.json({ users: results });
});

app.put('/api/admin/users/:subject', async (c) => {
  const actor = c.get('principal');
  if (actor?.role !== 'admin') return c.json({ error: 'Not found' }, 404);
  const subject = c.req.param('subject');
  if (!/^cail-[0-9a-f]{32}$/.test(subject) || subject === actor.subject) return c.json({ error: 'Choose another workspace member.' }, 400);
  const parsed = await boundedJson(c, MAX_SMALL_JSON_BYTES);
  if (parsed.response) return parsed.response;
  const body = parsed.value as { role?: unknown; disabled?: unknown; expiresAt?: unknown; revision?: unknown } | null;
  if (!body || !['student', 'instructor'].includes(String(body.role)) || typeof body.disabled !== 'boolean' ||
      !Number.isSafeInteger(body.revision) || Number(body.revision) < 0 ||
      (body.role === 'instructor' && (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()))) {
    return c.json({ error: 'Choose a role and a future expiry for instructor access.' }, 400);
  }
  const result = await c.env.DB.prepare('UPDATE app_users SET role = ?, disabled = ?, role_expires_at = ?, updated_by = ?, revision = revision + 1 WHERE subject = ? AND revision = ?')
    .bind(body.role, body.disabled ? 1 : 0, body.role === 'instructor' ? new Date(String(body.expiresAt)).toISOString() : null, actor.subject, subject, body.revision).run();
  if (!result.meta.changes) return c.json({ error: 'This account changed. Reload and try again.' }, 409);
  return c.json({ ok: true });
});

type BoundedJsonResult =
  | { value: unknown; response?: never }
  | { value?: never; response: Response };

async function boundedJson(
  c: Context<AppContext>,
  maximumBytes: number
): Promise<BoundedJsonResult> {
  try {
    return { value: await readBoundedJsonRequest(c.req.raw, maximumBytes) };
  } catch (error) {
    if (error instanceof JsonRequestError) {
      return { response: c.json({ error: error.message }, error.status) };
    }
    throw error;
  }
}

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

const requireClassCode = createMiddleware<AppContext>(async (c, next) => {
  if (c.env.AUTH_MODE === 'cail' && c.get('principal')) { await next(); return; }
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
app.get('/api/separation-options', (c) => {
  const options = getSeparationOptions(c.env.SEPARATION_BACKEND);
  const auto = serverAutoCapability(c.env);
  // Flags off must keep the pre-change response shape byte-for-byte compatible.
  return auto ? c.json({ ...options, routing: { auto: auto.mode } }) : c.json(options);
});

// --- uploads ----------------------------------------------------------

// Issue a presigned PUT so the browser uploads straight to R2.
app.post('/api/uploads', requireClassCode, async (c) => {
  const parsed = await boundedJson(c, MAX_SMALL_JSON_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.value as { filename?: string } | null;
  const filename = sanitizeFilename(body?.filename ?? '');
  if (!filename) return c.json({ error: 'filename is required' }, 400);

  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return c.json({ error: `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` }, 400);
  }

  const key = `uploads/${crypto.randomUUID()}/${filename}`;
  const uploadUrl = await presignUpload(c.env, key);
  const principal = c.get('principal');
  if (principal) await c.env.DB.prepare('INSERT INTO upload_owners (object_key, subject, expires_at) VALUES (?, ?, ?)')
    .bind(key, principal.subject, new Date(Date.now() + 3600000).toISOString()).run();
  return c.json({ key, uploadUrl });
});

// Local Miniflare R2 cannot issue S3 presigned URLs. When explicitly running
// behind Tailscale Funnel, accept same-origin uploads into the simulated bucket.
app.put('/api/local-uploads/*', requireClassCode, async (c) => {
  if (!usesRoutedAudio(c.env)) return c.text('Not found', 404);
  const key = localObjectKey(c.req.url, '/api/local-uploads/');
  if (!key?.startsWith('uploads/')) return c.text('Not found', 404);
  const principal = c.get('principal');
  if (principal && !(await c.env.DB.prepare('SELECT object_key FROM upload_owners WHERE object_key = ? AND subject = ? AND expires_at > ?')
    .bind(key, principal.subject, new Date().toISOString()).first())) return c.text('Not found', 404);

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

  if (principal) {
    const claim = await c.env.DB.prepare("UPDATE upload_owners SET state = 'uploading' WHERE object_key = ? AND subject = ? AND state = 'issued' AND expires_at > ?")
      .bind(key, principal.subject, new Date().toISOString()).run();
    if (!claim.meta.changes) return c.json({ error: 'This upload has already been used. Choose the file again.' }, 409);
  }

  await c.env.AUDIO.put(key, c.req.raw.body, {
    httpMetadata: { contentType: c.req.header('content-type') || 'application/octet-stream' },
  });
  const stored = await c.env.AUDIO.head(key);
  if (!stored || stored.size !== declaredSize) {
    await c.env.AUDIO.delete(key);
    return c.json({ error: 'Upload size did not match Content-Length' }, 400);
  }
  if (principal) await c.env.DB.prepare("UPDATE upload_owners SET state = 'ready' WHERE object_key = ? AND subject = ? AND state = 'uploading'")
    .bind(key, principal.subject).run();
  return c.body(null, 204);
});

// Replicate needs a public URL for locally stored source audio. The URL is
// short-lived and HMAC-signed so uploaded originals are not generally exposed.
app.get('/api/local-sources/*', async (c) => {
  if (!usesRoutedAudio(c.env)) return c.text('Not found', 404);
  const key = localObjectKey(c.req.url, '/api/local-sources/');
  if (!key || !isLocalSourceDownloadKey(key)) return c.text('Not found', 404);
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
const teacherLoginThrottle = new TeacherLoginThrottle();
let activeTeacherPasswordChecks = 0;
const MAX_TEACHER_PASSWORD_CHECKS = 2;
function ensureTeachersSeeded(c: Context<AppContext>): Promise<void> {
  teacherSeedPromise ??= syncTeachersFromSeed(c.env).catch((err) => {
    console.error('teacher seed failed', err);
    teacherSeedPromise = null; // let the next request retry
  });
  return teacherSeedPromise;
}

async function currentTeacher(c: Context<AppContext>) {
  if (c.env.AUTH_MODE === 'cail') {
    const principal = c.get('principal');
    return principal && principal.role !== 'student' ? { username: principal.subject, displayName: 'Instructor' } : null;
  }
  await ensureTeachersSeeded(c);
  return resolveSession(c.env, readSessionCookie(c.req.header('Cookie')));
}

const requireTeacher = createMiddleware<AppContext>(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const teacher = await currentTeacher(c);
  if (!teacher) return c.json({ error: 'Sign in to continue.' }, 401);
  c.set('teacher' as never, teacher as never);
  await next();
});

function isSecureRequest(c: Context<AppContext>): boolean {
  return cookiesShouldBeSecure(c.env.PUBLIC_BASE_URL, c.req.url);
}

app.post('/api/teacher/login', async (c) => {
  c.header('Cache-Control', 'no-store');
  await ensureTeachersSeeded(c);
  let body: { username?: unknown; password?: unknown } | null;
  try {
    const parsed = await readBoundedTeacherJson(c.req.raw);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { username?: unknown; password?: unknown })
      : null;
  } catch (error) {
    if (error instanceof TeacherRequestError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }

  if (
    typeof body?.username !== 'string' ||
    typeof body?.password !== 'string' ||
    !/^[a-z0-9._-]{1,64}$/i.test(body.username.trim()) ||
    body.password.length < 1 ||
    body.password.length > 512
  ) {
    return c.json({ error: 'Incorrect username or password.' }, 401);
  }

  const throttle = teacherLoginThrottle.check(body.username);
  if (!throttle.allowed) {
    c.header('Retry-After', String(throttle.retryAfterSeconds));
    return c.json({ error: 'Too many sign-in attempts. Try again later.' }, 429);
  }
  if (activeTeacherPasswordChecks >= MAX_TEACHER_PASSWORD_CHECKS) {
    c.header('Retry-After', '1');
    return c.json({ error: 'Sign-in is busy. Try again.' }, 429);
  }

  activeTeacherPasswordChecks += 1;
  let teacher;
  try {
    teacher = await verifyLogin(c.env, body.username, body.password);
  } finally {
    activeTeacherPasswordChecks -= 1;
  }
  // One message for both unknown-user and wrong-password: no account enumeration.
  if (!teacher) {
    teacherLoginThrottle.recordFailure(body.username);
    return c.json({ error: 'Incorrect username or password.' }, 401);
  }
  teacherLoginThrottle.recordSuccess(body.username);

  const token = await createSession(c.env, teacher.username);
  c.header('Set-Cookie', sessionCookie(token, isSecureRequest(c)));
  return c.json({ username: teacher.username, displayName: teacher.displayName });
});

app.post('/api/teacher/logout', async (c) => {
  c.header('Cache-Control', 'no-store');
  await destroySession(c.env, readSessionCookie(c.req.header('Cookie')));
  c.header('Set-Cookie', clearedSessionCookie(isSecureRequest(c)));
  return c.json({ ok: true });
});

app.get('/api/teacher/me', async (c) => {
  c.header('Cache-Control', 'no-store');
  const teacher = await currentTeacher(c);
  // 200 either way: the student page probes this on every load to decide
  // whether to reveal instructor controls, and a 401 would put a red console
  // error in front of every signed-out visitor.
  return c.json({
    teacher: teacher ? { username: teacher.username, displayName: teacher.displayName } : null,
  });
});

app.get('/api/teacher/prompt', requireTeacher, async (c) => {
  const record = await getAmendment(c.env);
  const basePrompt = buildSystemPromptPreview();
  const [basePromptHash, effectivePromptHash, historyPage] = await Promise.all([
    hashSystemPromptFingerprint(),
    hashSystemPromptFingerprint(record.amendment),
    getPromptHistoryPage(c.env),
  ]);
  return c.json({
    ...record,
    maxChars: MAX_AMENDMENT_CHARS,
    maxChangeNoteChars: MAX_CHANGE_NOTE_CHARS,
    basePrompt,
    basePromptVersion: SYSTEM_PROMPT_VERSION,
    basePromptHash,
    effectivePromptHash,
    history: historyPage.revisions,
    historyHasMore: historyPage.hasMore,
    historyNextBeforeId: historyPage.nextBeforeId,
  });
});

app.get('/api/teacher/prompt/history', requireTeacher, async (c) => {
  const beforeValue = c.req.query('before');
  if (!beforeValue || !/^\d+$/.test(beforeValue)) {
    return c.json({ error: 'A valid prompt history cursor is required.' }, 400);
  }
  const beforeId = Number(beforeValue);
  if (!Number.isSafeInteger(beforeId) || beforeId < 1) {
    return c.json({ error: 'A valid prompt history cursor is required.' }, 400);
  }
  const historyPage = await getPromptHistoryPage(c.env, beforeId);
  return c.json({
    history: historyPage.revisions,
    historyHasMore: historyPage.hasMore,
    historyNextBeforeId: historyPage.nextBeforeId,
  });
});

app.put('/api/teacher/prompt', requireTeacher, async (c) => {
  const teacher = (await currentTeacher(c))!;
  let body: { amendment?: unknown; changeNote?: unknown; expectedRevision?: unknown } | null;
  try {
    const parsed = await readBoundedTeacherJson(c.req.raw, 16 * 1024);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { amendment?: unknown; changeNote?: unknown; expectedRevision?: unknown })
      : null;
  } catch (error) {
    if (error instanceof TeacherRequestError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }

  const amendment = normalizeAmendment(body?.amendment);
  if (amendment === null) {
    return c.json({ error: `Amendment must be text under ${MAX_AMENDMENT_CHARS} characters.` }, 400);
  }

  const current = await getAmendment(c.env);
  if (typeof body?.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision)) {
    return c.json({ error: 'The prompt revision is required before saving.' }, 400);
  }
  if (body.expectedRevision !== current.revision) {
    return c.json(
      { error: 'This prompt changed after you opened it. Reload before saving your edit.' },
      409
    );
  }

  const changed = amendment !== current.amendment;
  const changeNote = changed ? normalizeChangeNote(body?.changeNote) : '';
  if (changed && changeNote === null) {
    return c.json(
      { error: `Describe this change in 1-${MAX_CHANGE_NOTE_CHARS} characters.` },
      400
    );
  }

  const [basePromptHash, effectivePromptHash] = await Promise.all([
    hashSystemPromptFingerprint(),
    hashSystemPromptFingerprint(amendment),
  ]);

  const result = await setAmendment(
    c.env,
    amendment,
    teacher.username,
    body.expectedRevision,
    {
      changeNote: changeNote ?? '',
      basePromptVersion: SYSTEM_PROMPT_VERSION,
      basePromptHash,
      effectivePromptHash,
    }
  );
  if (result.conflict) {
    return c.json(
      { error: 'This prompt changed after you opened it. Reload before saving your edit.' },
      409
    );
  }

  return c.json({
    ...result.record,
    changed: result.changed,
    revision: result.revision,
    maxChars: MAX_AMENDMENT_CHARS,
    maxChangeNoteChars: MAX_CHANGE_NOTE_CHARS,
    basePromptVersion: SYSTEM_PROMPT_VERSION,
    basePromptHash,
    effectivePromptHash,
    guidesCleared: result.guidesCleared,
  });
});

/** Preview one readable prompt example with the active instructor amendment. */
app.get('/api/teacher/prompt/preview', requireTeacher, async (c) => {
  const { amendment } = await getAmendment(c.env);
  return c.json({ prompt: buildSystemPromptPreview(amendment) });
});

// --- teacher folders ----------------------------------------------------
//
// Named sets of finished splits an instructor keeps for teaching. Server-side
// (not localStorage) so they survive browsers and devices; teacher-gated
// because the class code is a shared student secret and cannot own curation.
// Items snapshot filename/model: the 30-day cleanup may remove the job row,
// and the folder should say what was lost rather than silently shrink.

const MAX_FOLDER_NAME_CHARS = 80;

interface FolderRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  item_count?: number;
}

function normalizeFolderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_FOLDER_NAME_CHARS ? trimmed : null;
}

app.get('/api/teacher/folders', requireTeacher, async (c) => {
  const principal = c.get('principal');
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.name, f.created_by, f.created_at,
            (SELECT COUNT(*) FROM folder_items i WHERE i.folder_id = f.id) AS item_count
     FROM folders f
     WHERE (? IS NULL OR f.created_by = ?)
     ORDER BY f.created_at DESC, f.id DESC`
  ).bind(principal && principal.role !== 'admin' ? principal.subject : null, principal?.subject ?? null).all<FolderRow>();
  return c.json({
    folders: (results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      itemCount: row.item_count ?? 0,
    })),
  });
});

app.post('/api/teacher/folders', requireTeacher, async (c) => {
  const teacher = (await currentTeacher(c))!;
  const parsed = await boundedJson(c, MAX_SMALL_JSON_BYTES);
  if (parsed.response) return parsed.response;
  const name = normalizeFolderName((parsed.value as { name?: unknown } | null)?.name);
  if (!name) {
    return c.json({ error: `A folder needs a name (up to ${MAX_FOLDER_NAME_CHARS} characters).` }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO folders (id, name, created_by) VALUES (?, ?, ?)')
    .bind(id, name, teacher.username)
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM folders WHERE id = ?').bind(id).first<FolderRow>();
  return c.json({
    folder: { id, name, createdBy: teacher.username, createdAt: row?.created_at ?? null, itemCount: 0 },
  });
});

app.get('/api/teacher/folders/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const folder = await c.env.DB.prepare('SELECT * FROM folders WHERE id = ?').bind(id).first<FolderRow>();
  if (!folder) return c.json({ error: 'Folder not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT i.job_id, i.filename, i.model, i.added_by, i.added_at,
            (j.id IS NOT NULL AND j.status = 'done') AS available
     FROM folder_items i
     LEFT JOIN jobs j ON j.id = i.job_id
     WHERE i.folder_id = ?
     ORDER BY i.added_at DESC, i.job_id DESC`
  )
    .bind(id)
    .all<{ job_id: string; filename: string; model: string; added_by: string; added_at: string; available: number }>();
  return c.json({
    folder: {
      id: folder.id,
      name: folder.name,
      createdBy: folder.created_by,
      createdAt: folder.created_at,
    },
    items: (results ?? []).map((row) => ({
      jobId: row.job_id,
      filename: row.filename,
      model: row.model,
      addedBy: row.added_by,
      addedAt: row.added_at,
      available: !!row.available,
    })),
  });
});

app.delete('/api/teacher/folders/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
  // No FK cascade on purpose: delete items explicitly so the shim never
  // depends on a PRAGMA foreign_keys setting.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM folder_items WHERE folder_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

app.post('/api/teacher/folders/:id/items', requireTeacher, async (c) => {
  const teacher = (await currentTeacher(c))!;
  const folderId = c.req.param('id');
  const folder = await c.env.DB.prepare('SELECT id FROM folders WHERE id = ?')
    .bind(folderId)
    .first<{ id: string }>();
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  const parsed = await boundedJson(c, MAX_SMALL_JSON_BYTES);
  if (parsed.response) return parsed.response;
  const jobId = (parsed.value as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== 'string' || !jobId) return c.json({ error: 'A jobId is required.' }, 400);
  const principal = c.get('principal');
  if (principal && principal.role !== 'admin' && !(await c.env.DB.prepare('SELECT job_id FROM job_owners WHERE job_id = ? AND subject = ?')
    .bind(jobId, principal.subject).first())) return c.json({ error: 'Job not found' }, 404);

  const job = await c.env.DB.prepare('SELECT id, filename, status, model FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<Pick<JobRow, 'id' | 'filename' | 'status' | 'model'>>();
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== 'done') {
    return c.json({ error: 'Only finished splits can be saved to a folder.' }, 409);
  }

  const insert = await c.env.DB.prepare(
    `INSERT INTO folder_items (folder_id, job_id, filename, model, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(folder_id, job_id) DO NOTHING`
  )
    .bind(folderId, jobId, job.filename, job.model ?? DEFAULT_DEMUCS_MODEL, teacher.username)
    .run();
  return c.json({ ok: true, already: (insert.meta?.changes ?? 0) === 0 });
});

app.delete('/api/teacher/folders/:id/items/:jobId', requireTeacher, async (c) => {
  await c.env.DB.prepare('DELETE FROM folder_items WHERE folder_id = ? AND job_id = ?')
    .bind(c.req.param('id'), c.req.param('jobId'))
    .run();
  return c.json({ ok: true });
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

// Cloudflare candidate only: authenticated, rate-limited, bounded delivery of
// reviewed public Crate audio into this browser session. No split, upload row,
// Replicate call, arbitrary URL proxy, or durable copy is created.
app.post('/api/remix/archive-audio', requireClassCode, async (c) => {
  if (c.env.AUTH_MODE !== 'cail' || c.env.REMIXER_ENABLED !== 'true') {
    return c.json({ error: 'Remixer is unavailable.' }, 404);
  }
  const parsed = await boundedJson(c, MAX_JOB_JSON_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('archiveId' in body) || !('archiveFile' in body)
    || typeof body.archiveId !== 'string' || typeof body.archiveFile !== 'string' || body.archiveFile.length > 512) {
    return c.json({ error: 'Choose a track from the Crate.' }, 400);
  }
  const identifier = parseArchiveIdentifier(body.archiveId);
  if (!identifier) return c.json({ error: 'Choose a valid Internet Archive item.' }, 400);
  try {
    const audio = await fetchArchiveAudio(identifier, body.archiveFile, c.env, { maximumBytes: 10 * 1024 * 1024, remix: true });
    return new Response(audio.data, { headers: {
      'Content-Type': archiveContentType(audio.fileName),
      'Content-Length': String(audio.data.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Remix-Source': encodeURIComponent(JSON.stringify({ attribution: audio.attribution, durationSec: audio.durationSec })),
    } });
  } catch (err) {
    return archiveErrorResponse(c, err, 'Could not load this track. Try again.');
  }
});

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

function archiveErrorResponse(c: Context<AppContext>, err: unknown, fallback: string) {
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
  const parsed = await boundedJson(c, MAX_JOB_JSON_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.value as
    | {
        key?: string;
        filename?: string;
        youtubeUrl?: string;
        archiveId?: string;
        archiveFile?: string;
        model?: string;
        routingRequest?: string;
        browserAnalysis?: unknown;
      }
    | null;

  const options = getSeparationOptions(c.env.SEPARATION_BACKEND);
  const submittedModel = body?.model ?? options.defaultModel;
  const autoCapability = serverAutoCapability(c.env);
  const autoRequested = Boolean(
    autoCapability &&
      (submittedModel === AUTO_ROUTING_REQUEST || body?.routingRequest === AUTO_ROUTING_REQUEST)
  );
  const authoritativeRequest = Boolean(
    autoRequested && autoCapability?.mode === 'authoritative'
  );
  const submittedConcreteModel = modelIsAllowed(c.env.SEPARATION_BACKEND, submittedModel);
  if (
    (submittedModel === AUTO_ROUTING_REQUEST && !authoritativeRequest) ||
    (submittedModel !== AUTO_ROUTING_REQUEST && !submittedConcreteModel)
  ) {
    return c.json({ error: `Unknown model. Allowed: ${options.models.map((item) => item.id).join(', ')}` }, 400);
  }
  const currentModel = authoritativeRequest ? options.defaultModel : submittedModel;
  let browserAnalysis;
  if (autoRequested) {
    try {
      browserAnalysis = parseBrowserAutoSummary(
        body?.browserAnalysis,
        options.models
      );
    } catch (error) {
      if (error instanceof AudioAnalysisContractError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  }

  let key: string;
  let filename: string;
  let sourceType: AudioSourceType;
  let sourceHash: string | null = null;
  let expectedSourceIdentity: AudioSourceIdentityV1 | undefined;
  let expectedSourceBytes: number | undefined;
  let autoSnapshotKey: string | null = null;
  let attribution: unknown = null;
  const id = crypto.randomUUID();

  if (body?.youtubeUrl) {
    sourceType = 'youtube';
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
    sourceHash = await sha256Audio(audio.data);
    expectedSourceIdentity = {
      schemaVersion: '1',
      sha256: sourceHash,
      bytes: audio.data.byteLength,
    };
    await c.env.AUDIO.put(key, audio.data, { httpMetadata: { contentType: 'audio/mp4' } });
  } else if (body?.archiveId) {
    sourceType = 'archive';
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
      attribution = audio.attribution;
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
    sourceHash = await sha256Audio(audio.data);
    expectedSourceIdentity = {
      schemaVersion: '1',
      sha256: sourceHash,
      bytes: audio.data.byteLength,
    };
    await c.env.AUDIO.put(key, audio.data, {
      httpMetadata: { contentType: archiveContentType(audio.fileName) },
    });
  } else {
    sourceType = 'upload';
    const uploadKey = body?.key;
    filename = sanitizeFilename(body?.filename ?? '');
    if (!uploadKey || !uploadKey.startsWith('uploads/') || !filename) {
      return c.json({ error: 'key and filename are required' }, 400);
    }

    const head = await c.env.AUDIO.head(uploadKey);
    const principal = c.get('principal');
    if (principal && !(await c.env.DB.prepare("SELECT object_key FROM upload_owners WHERE object_key = ? AND subject = ? AND expires_at > ? AND state = 'ready'")
      .bind(uploadKey, principal.subject, new Date().toISOString()).first())) return c.json({ error: 'Upload not found' }, 404);
    if (!head) return c.json({ error: 'Upload not found — did the file finish uploading?' }, 400);
    if (head.size > MAX_SOURCE_BYTES) {
      await c.env.AUDIO.delete(uploadKey);
      return c.json({ error: 'File too large (max 100 MB)' }, 400);
    }
    if (authoritativeRequest) {
      try {
        const snapshot = await prepareAuthoritativeAutoSource(c.env, {
          jobId: id,
          sourceKey: uploadKey,
        });
        key = snapshot.snapshotKey;
        autoSnapshotKey = snapshot.snapshotKey;
        expectedSourceBytes = snapshot.bytes;
      } catch (error) {
        if (!(error instanceof AuthoritativeAutoSourceError)) throw error;
        if (error.code === 'invalid_request' || error.code === 'source_too_large') {
          return c.json({ error: error.message, code: error.code, retryable: false }, 400);
        }
        if (error.code === 'source_unavailable') {
          return c.json({ error: error.message, code: error.code, retryable: true }, 409);
        }
        return c.json({ error: error.message, code: error.code, retryable: true }, 503);
      }
    } else {
      key = uploadKey;
    }
  }

  let audioUrl: string;
  let model = currentModel;
  let autoRouting: AutoRoutingDecisionV1 | undefined;
  try {
    audioUrl = await presignDownload(c.env, key);
    if (autoRequested && autoCapability) {
      const analysisUrl = await presignAnalysisDownload(c.env, key);
      const flags = processingFeatureFlags(c.env);
      const resolution = await resolveAutoRoutingWithSource({
        sourceUrl: analysisUrl,
        sourceType,
        mode: autoCapability.mode,
        currentModel,
        fallbackModel: options.defaultModel,
        coreModels: options.models,
        ...(expectedSourceIdentity ? { expectedSourceIdentity } : {}),
        ...(expectedSourceBytes !== undefined ? { expectedSourceBytes } : {}),
        ...(browserAnalysis ? { browserAnalysis } : {}),
        provider: configuredAudioAnalysisProvider(c.env),
        timeoutMs: audioAnalysisTimeoutMs(c.env),
        instrumentDiscovery: flags.instrumentDiscovery,
      });
      autoRouting = resolution.decision;
      if (resolution.sourceIdentity && !sourceHash) sourceHash = resolution.sourceIdentity.sha256;
      model = autoRouting.resolvedCoreModel;
    }

    const insertJob = c.env.DB.prepare(
      `INSERT INTO jobs
        (id, filename, source_key, status, model, routing_request, source_type, source_hash, analysis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        filename,
        key,
        'pending',
        model,
        autoRouting ? AUTO_ROUTING_REQUEST : null,
        sourceType,
        sourceHash,
        autoRouting ? JSON.stringify(autoRouting) : null
      );
    const statements = [insertJob];
    const principal = c.get('principal');
    if (principal) statements.push(c.env.DB.prepare('INSERT INTO job_owners (job_id, subject) VALUES (?, ?)').bind(id, principal.subject));
    if (attribution) statements.push(c.env.DB.prepare('INSERT INTO job_attributions (job_id, attribution) VALUES (?, ?)').bind(id, JSON.stringify(attribution)));
    await c.env.DB.batch(statements);
  } catch (error) {
    if (autoSnapshotKey) {
      try {
        await discardAuthoritativeAutoSource(c.env, autoSnapshotKey);
      } catch {
        console.error('authoritative Auto source rollback failed');
      }
    }
    throw error;
  }

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
    ...(autoRouting
      ? {
          routingRequest: AUTO_ROUTING_REQUEST,
          sourceType,
          autoRouting: redactInstrumentDiscovery(autoRouting),
        }
      : {}),
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
  const attribution = await c.env.DB.prepare('SELECT attribution FROM job_attributions WHERE job_id = ?').bind(id).first<{ attribution: string }>();
  return c.json({ ...jobResponse(row, results ?? [], guide), attribution: attribution ? JSON.parse(attribution.attribution) : null });
});

app.get('/api/teacher/jobs/:id/analysis', requireTeacher, async (c) => {
  c.header('Cache-Control', 'no-store');
  const row = await c.env.DB
    .prepare('SELECT id, routing_request, analysis FROM jobs WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Pick<JobRow, 'id' | 'routing_request' | 'analysis'>>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.routing_request !== AUTO_ROUTING_REQUEST || !row.analysis) {
    return c.json({ error: 'This job has no Auto analysis.' }, 404);
  }
  try {
    return c.json({
      jobId: row.id,
      autoRouting: parseAutoRoutingDecision(JSON.parse(row.analysis), STORED_CORE_MODELS),
    });
  } catch {
    return c.json({ error: 'Stored analysis is unavailable.' }, 500);
  }
});

interface InstrumentFeedbackJobRow {
  id: string;
  routing_request: string | null;
  source_hash: string | null;
  analysis: string | null;
}

async function loadInstrumentFeedbackTarget(
  c: Context<AppContext>,
  reviewer: string
): Promise<{ target: InstrumentDiscoveryFeedbackTargetV1 } | { response: Response }> {
  const row = await c.env.DB.prepare(
    'SELECT id, routing_request, source_hash, analysis FROM jobs WHERE id = ?'
  )
    .bind(c.req.param('id'))
    .first<InstrumentFeedbackJobRow>();
  if (!row) return { response: c.json({ error: 'Job not found' }, 404) };
  if (row.routing_request !== AUTO_ROUTING_REQUEST || !row.analysis) {
    return { response: c.json({ error: 'This job has no Auto analysis.' }, 404) };
  }
  if (!row.source_hash || !/^[0-9a-f]{64}$/.test(row.source_hash)) {
    return {
      response: c.json(
        { error: 'This analysis has no verified source identity for review.' },
        409
      ),
    };
  }
  try {
    const autoRouting = parseAutoRoutingDecision(JSON.parse(row.analysis), STORED_CORE_MODELS);
    const discovery = autoRouting.analysis.instrumentDiscovery;
    const classifier = autoRouting.analysis.vocabularyClassifier;
    if (discovery?.status !== 'complete' || !classifier) {
      return {
        response: c.json(
          { error: 'This analysis has no complete candidate discovery to review.' },
          409
        ),
      };
    }
    return {
      target: {
        jobId: row.id,
        reviewer,
        rawAnalysis: row.analysis,
        analysisSha256: await sha256Text(row.analysis),
        sourceSha256: row.source_hash,
        classifierVersion: classifier.version,
        vocabularyVersion: classifier.vocabularyVersion,
        vocabularySha256: classifier.vocabularySha256,
        detectedInstrumentIds: autoRouting.analysis.detectedInstruments.map(({ id }) => id),
      },
    };
  } catch {
    return { response: c.json({ error: 'Stored analysis is unavailable.' }, 500) };
  }
}

function instrumentFeedbackPolicy() {
  return {
    evidenceStatus: 'unreviewed-candidate' as const,
    deidentified: false as const,
    trainingEligible: false as const,
    affectsCoreRouting: false as const,
    requestsIsolation: false as const,
    overlapHandling: 'review-separately-do-not-double-count' as const,
  };
}

function instrumentFeedbackContext(
  target: InstrumentDiscoveryFeedbackTargetV1,
  latest: Awaited<ReturnType<typeof getLatestInstrumentDiscoveryFeedback>>
) {
  return {
    schemaVersion: INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION,
    jobId: target.jobId,
    provenance: {
      analysisSha256: target.analysisSha256,
      classifierVersion: target.classifierVersion,
      vocabularyVersion: target.vocabularyVersion,
      reviewOntologyVersion: INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
    },
    detectedInstrumentIds: target.detectedInstrumentIds,
    genreFamilies: INSTRUMENT_FEEDBACK_GENRE_FAMILIES,
    reviewOptions: INSTRUMENT_REVIEW_OPTIONS,
    policy: instrumentFeedbackPolicy(),
    currentRevision: latest?.revision ?? 0,
    latest: latest ? summarizeInstrumentDiscoveryFeedback(latest) : null,
  };
}

// Historical feedback remains readable while discovery is off. It is tied to
// the current teacher, exact stored analysis bytes, source identity, and pins.
app.get('/api/teacher/jobs/:id/instrument-feedback', requireTeacher, async (c) => {
  const teacher = (await currentTeacher(c))!;
  const loaded = await loadInstrumentFeedbackTarget(c, teacher.username);
  if ('response' in loaded) return loaded.response;
  const latest = await getLatestInstrumentDiscoveryFeedback(c.env, loaded.target);
  return c.json(instrumentFeedbackContext(loaded.target, latest));
});

app.post('/api/teacher/jobs/:id/instrument-feedback', requireTeacher, async (c) => {
  let body: {
    expectedRevision?: unknown;
    genreFamily?: unknown;
    observations?: unknown;
  } | null;
  try {
    const parsed = await readBoundedTeacherJson(c.req.raw, 16 * 1024);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as {
          expectedRevision?: unknown;
          genreFamily?: unknown;
          observations?: unknown;
        })
      : null;
  } catch (error) {
    if (error instanceof TeacherRequestError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
  if (
    !body ||
    Object.keys(body).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(body, 'expectedRevision') ||
    !Object.prototype.hasOwnProperty.call(body, 'genreFamily') ||
    !Object.prototype.hasOwnProperty.call(body, 'observations') ||
    !Number.isSafeInteger(body.expectedRevision) ||
    (body.expectedRevision as number) < 0 ||
    typeof body.genreFamily !== 'string' ||
    !INSTRUMENT_FEEDBACK_GENRE_FAMILIES.includes(body.genreFamily as never) ||
    !Array.isArray(body.observations)
  ) {
    return c.json({ error: 'Instrument feedback body is invalid.' }, 400);
  }

  const teacher = (await currentTeacher(c))!;
  const loaded = await loadInstrumentFeedbackTarget(c, teacher.username);
  if ('response' in loaded) return loaded.response;
  try {
    const result = await recordInstrumentDiscoveryFeedback(c.env, {
      ...loaded.target,
      expectedRevision: body.expectedRevision as number,
      genreFamily: body.genreFamily as (typeof INSTRUMENT_FEEDBACK_GENRE_FAMILIES)[number],
      observations: body.observations as never,
    });
    return c.json(
      {
        jobId: loaded.target.jobId,
        changed: result.changed,
        policy: instrumentFeedbackPolicy(),
        feedback: summarizeInstrumentDiscoveryFeedback(result.record),
      },
      result.changed ? 201 : 200
    );
  } catch (error) {
    if (error instanceof InstrumentDiscoveryFeedbackError) {
      if (error.code === 'job_not_found') return c.json({ error: error.message }, 404);
      if (error.code === 'analysis_changed' || error.code === 'conflict') {
        return c.json({ error: error.message }, 409);
      }
      if (error.code === 'stored_invalid') {
        return c.json({ error: 'Stored instrument feedback is unavailable.' }, 500);
      }
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// Historical readback stays available when the rollout flag is off.
app.get('/api/teacher/jobs/:id/isolations', requireTeacher, async (c) => {
  const jobId = c.req.param('id');
  const job = await c.env.DB.prepare('SELECT id FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<{ id: string }>();
  if (!job) return c.json({ error: 'Job not found' }, 404);
  const isolations = await listInstrumentIsolations(c.env, jobId);
  return c.json({
    jobId,
    isolations: isolations.map(summarizeInstrumentIsolation),
  });
});

// Shadow records teacher demand against verified source bytes and an exact
// reviewed provider identity. It cannot claim the row or start a prediction.
app.post('/api/teacher/jobs/:id/isolations', requireTeacher, async (c) => {
  if (processingFeatureFlags(c.env).queryIsolationMode !== 'shadow') {
    return c.json({ error: 'Optional isolation is unavailable.' }, 404);
  }

  let body: { target?: unknown } | null;
  try {
    const parsed = await readBoundedTeacherJson(c.req.raw, MAX_SMALL_JSON_BYTES);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { target?: unknown })
      : null;
  } catch (error) {
    if (error instanceof TeacherRequestError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(body, 'target') ||
    typeof body.target !== 'string'
  ) {
    return c.json({ error: 'target is required' }, 400);
  }

  let normalizedTarget: string;
  try {
    normalizedTarget = normalizeIsolationTarget(body.target);
  } catch (error) {
    if (error instanceof QueryIsolationContractError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }

  const jobId = c.req.param('id');
  const job = await c.env.DB.prepare(
    'SELECT id, status, source_key, source_type, source_hash, routing_request, analysis FROM jobs WHERE id = ?'
  )
    .bind(jobId)
    .first<Pick<
      JobRow,
      | 'id'
      | 'status'
      | 'source_key'
      | 'source_type'
      | 'source_hash'
      | 'routing_request'
      | 'analysis'
    >>();
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== 'done') {
    return c.json({ error: 'The core split must finish before optional isolation.' }, 409);
  }
  if (!job.source_type || !['upload', 'youtube', 'archive'].includes(job.source_type)) {
    return c.json({ error: 'This legacy job has no verifiable source type.' }, 409);
  }
  const sourceType = job.source_type as AudioSourceType;

  let sourceHash = job.source_hash;
  if (!sourceHash) {
    try {
      const sourceUrl = await presignAnalysisDownload(c.env, job.source_key);
      const identity = await requestSourceFingerprint({
        sourceUrl,
        sourceType,
        provider: configuredAudioAnalysisProvider(c.env),
        timeoutMs: audioAnalysisTimeoutMs(c.env),
      });
      const updated = await c.env.DB.prepare(
        `UPDATE jobs SET source_hash = ?
         WHERE id = ?
           AND source_hash IS NULL
           AND status = 'done'
           AND source_key = ?
           AND source_type = ?`
      )
        .bind(identity.sha256, job.id, job.source_key, sourceType)
        .run();
      if (updated.meta.changes === 1) {
        sourceHash = identity.sha256;
      } else {
        const current = await c.env.DB.prepare('SELECT source_hash FROM jobs WHERE id = ?')
          .bind(job.id)
          .first<Pick<JobRow, 'source_hash'>>();
        if (!current?.source_hash || current.source_hash !== identity.sha256) {
          return c.json({ error: 'The stored source identity changed; retry this request.' }, 409);
        }
        sourceHash = current.source_hash;
      }
    } catch {
      return c.json({ error: 'The stored audio could not be verified for isolation.' }, 503);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) {
    return c.json({ error: 'The stored source identity is unavailable.' }, 500);
  }

  let identity;
  try {
    identity = audioSepReplicateIdentity(c.env);
  } catch {
    return c.json({ error: 'The reviewed isolation identity is unavailable.' }, 503);
  }

  let analysisVocabularyVersion: string | null = null;
  if (job.routing_request === AUTO_ROUTING_REQUEST && job.analysis) {
    try {
      analysisVocabularyVersion =
        parseAutoRoutingDecision(JSON.parse(job.analysis), STORED_CORE_MODELS).analysis
          .vocabularyClassifier?.vocabularyVersion ?? null;
    } catch {
      // The stored Auto trace is advisory here. Its absence must not invent a
      // vocabulary pin or invalidate the server-verified source identity.
    }
  }

  const teacher = (await currentTeacher(c))!;
  try {
    const result = await createInstrumentIsolation(c.env, {
      jobId,
      requestedBy: teacher.username,
      sourceHash,
      sourceType,
      normalizedTarget,
      analysisVocabularyVersion,
      identity,
      rolloutStage: 'shadow',
    });
    const payload = {
      jobId,
      isolation: summarizeInstrumentIsolation(result.record),
      created: result.created,
      rollout: 'shadow' as const,
      providerStarted: false as const,
    };
    return result.created ? c.json(payload, 201) : c.json(payload, 200);
  } catch (error) {
    if (error instanceof InstrumentIsolationResourceError) {
      if (error.code === 'job_not_found') return c.json({ error: 'Job not found' }, 404);
      if (
        error.code === 'core_split_incomplete' ||
        error.code === 'source_type_mismatch' ||
        error.code === 'source_identity_mismatch' ||
        error.code === 'cache_identity_mismatch' ||
        error.code === 'maximum_reached'
      ) {
        return c.json({ error: error.message }, 409);
      }
      if (error.code === 'invalid_request') return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// Shared, class-wide display labels for stem channels.
app.put('/api/jobs/:id/labels', requireClassCode, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);

  const parsed = await boundedJson(c, MAX_SMALL_JSON_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.value as { labels?: Record<string, unknown> } | null;
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

  const parsed = await boundedJson(c, MAX_SMALL_JSON_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.value as { atSeconds?: unknown; text?: unknown } | null;
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
  if ((!c.env.assistantTransport && !c.env.OPENROUTER_API_KEY) || !c.env.ASSISTANT_MODEL) {
    return c.json({ error: COACH_UNCONFIGURED }, 503);
  }
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.status !== 'done') {
    return c.json({ error: "Stems aren't ready yet — the Listening Guide needs the finished song." }, 409);
  }

  const parsed = await boundedJson(c, MAX_SMALL_JSON_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.value as { durationSec?: unknown } | null;
  const { results } = await c.env.DB
    .prepare('SELECT * FROM annotations WHERE job_id = ? ORDER BY at_seconds')
    .bind(id)
    .all<AnnotationRow>();

  return sseResponse(c, async (emit, signal) => {
    const { guide, cached } = await streamGuide(
      { ...c.env, ASSISTANT_ABORT_SIGNAL: signal }, row, results ?? [], parseDuration(body?.durationSec),
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
  if ((!c.env.assistantTransport && !c.env.OPENROUTER_API_KEY) || !c.env.ASSISTANT_MODEL) {
    return c.json({ error: COACH_UNCONFIGURED }, 503);
  }
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.status !== 'done') {
    return c.json({ error: "Stems aren't ready yet — the Listening Guide needs the finished song." }, 409);
  }

  const parsed = await boundedJson(c, MAX_JOB_JSON_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.value as
    | { messages?: unknown; durationSec?: unknown; mode?: unknown; deck?: unknown }
    | null;
  const turns = validateTurns(body?.messages);
  if (!turns) {
    return c.json({ error: 'messages must be 1-12 turns (each ≤2000 chars) ending with a user message' }, 400);
  }
  if (body?.mode !== undefined && body.mode !== 'chat') {
    return c.json({ error: 'Listening Guy is available in the Splitter.' }, 400);
  }

  const { results } = await c.env.DB
    .prepare('SELECT * FROM annotations WHERE job_id = ? ORDER BY at_seconds')
    .bind(id)
    .all<AnnotationRow>();

  return sseResponse(c, async (emit, signal) => {
    const result = await streamChat(
      { ...c.env, ASSISTANT_ABORT_SIGNAL: signal }, row, results ?? [], turns, parseDuration(body?.durationSec),
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
  if (!(await equalSecret(token, c.env.WEBHOOK_SECRET))) return c.text('Forbidden', 403);
  if (!jobId) return c.text('Missing job', 400);

  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<JobRow>();
  if (!row) return c.text('Unknown job', 404);
  if (row.status === 'done' || row.status === 'failed') return c.json({ ok: true }); // already ingested

  let result: SeparationResult;
  if (c.env.AUTH_MODE === 'cail') {
    // The payload is only a notification. Retrieve this job's stored prediction
    // so even an authenticated mismatched/replayed payload cannot choose audio.
    await c.req.raw.body?.cancel().catch(() => undefined);
    if (!row.external_id) return c.text('Prediction is not registered yet', 409);
    try { result = await getBackend(c.env).fetchStatus(row.external_id); }
    catch { return c.text('Status is temporarily unavailable', 503); }
  } else {
    const parsed = await boundedJson(c, MAX_WEBHOOK_JSON_BYTES);
    if (parsed.response) {
      if (parsed.response.status !== 413 || !row.external_id) return parsed.response;
    // Replicate webhook bodies routinely exceed any sane JSON bound (they
    // carry the model's full progress logs, and new cog builds inline file
    // outputs as data URIs). The webhook is only a completion signal, so for
    // an oversized body ask the provider for the authoritative prediction
    // instead of 413ing and stranding the job until a browser poll.
    try {
      result = await getBackend(c.env).fetchStatus(row.external_id);
    } catch (err) {
      // 500 so the provider retries the webhook.
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`Status fetch failed: ${message}`, 500);
    }
    } else {
      if (!parsed.value) return c.text('Bad payload', 400);
      result = getBackend(c.env).parseResult(parsed.value);
    }
  }
  try {
    await ingestResult(c.env, jobId, result);
  } catch (err) {
    // 500 so the provider retries the webhook.
    return c.text('Audio processing is temporarily unavailable', 503);
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
  headers.set('Cache-Control', c.env.AUTH_MODE === 'cail' ? 'private, no-store' : 'private, max-age=3600');
  if (c.req.query('download') !== undefined) {
    headers.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
  }
  return new Response(obj.body, { headers });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((_error, c) => {
  console.error(JSON.stringify({ event: 'request_failed', method: c.req.method }));
  return c.json({ error: 'The service is temporarily unavailable. Please try again.' }, 503);
});

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
      if (env.AUTH_MODE === 'cail' && env.SEPARATION_BACKEND === 'replicate') {
        const url = new URL(stem.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !(url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))) {
          throw new InvalidStemAudioError('The separator returned an unsupported audio address');
        }
      }
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
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
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
        const audio = await readBoundedResponse(response, {
          maximumBytes: 32 * 1024 * 1024,
          timeoutMs: 30000,
          errors: {
            tooLarge: () => new InvalidStemAudioError('The separator returned an oversized track'),
            timedOut: () => new Error('Audio download timed out'),
            unreadable: () => new Error('Audio download could not be read'),
          },
        });
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
  let autoRouting: AutoRoutingDecisionV1 | undefined;
  if (row.analysis) {
    try {
      autoRouting = parseAutoRoutingDecision(JSON.parse(row.analysis), STORED_CORE_MODELS);
    } catch {
      // Corrupt optional metadata must not hide an otherwise playable core split.
    }
  }
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
    ...(row.routing_request === AUTO_ROUTING_REQUEST && autoRouting
      ? {
          routingRequest: AUTO_ROUTING_REQUEST,
          sourceType: row.source_type,
          autoRouting: redactInstrumentDiscovery(autoRouting),
        }
      : {}),
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
  c: Context<AppContext>,
  run: (emit: (event: Record<string, unknown>) => Promise<void>, signal: AbortSignal) => Promise<void>
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const aborted = new AbortController();
  const signal = AbortSignal.any([c.req.raw.signal, aborted.signal]);
  void writer.closed.catch(() => aborted.abort(new DOMException('Response closed', 'AbortError')));
  const encoder = new TextEncoder();
  const emit = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const pump = (async () => {
    try {
      await run(emit, signal);
    } catch (err) {
      if (!(err instanceof AssistantError) && !c.env.assistantTransport) console.error('assistant error', err);
      const message = err instanceof AssistantError ? err.studentMessage : COACH_DOWN;
      if (!signal.aborted) await emit({ type: 'error', message, ...(err instanceof AssistantError ? { code: err.code, shouldRetry: err.shouldRetry, requestId: err.requestId } : {}) }).catch(() => {});
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
