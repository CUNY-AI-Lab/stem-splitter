// Teacher authentication: PBKDF2 password verification + opaque session cookies.
//
// Passwords are never stored, transmitted, or committed in plaintext. Accounts
// are seeded from the TEACHER_SEED secret (already-hashed records produced by
// scripts/hash-teacher-password.mjs), so provisioning a teacher never requires
// a plaintext password to touch the repository or the database.
import type { Env } from '../env';

const PBKDF2_ITERATIONS = 210_000; // OWASP guidance for PBKDF2-HMAC-SHA256
const KEY_BITS = 256;
const SESSION_TTL_DAYS = 30;
const SESSION_COOKIE = 'teacher_session';
const MAX_AMENDMENT_CHARS = 2000;
const MAX_CHANGE_NOTE_CHARS = 240;
const PROMPT_HISTORY_LIMIT = 40;
const UNKNOWN_ACCOUNT_SALT = '9f89c84a559f573636a47ff8abed1e4f';

interface LoginFailureState {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
  lastSeenAt: number;
}

export interface TeacherLoginThrottleOptions {
  maximumFailures?: number;
  windowMs?: number;
  blockMs?: number;
  maximumEntries?: number;
}

/**
 * Bounded process-level login throttle for the current single-replica Railway
 * host. It is defense in depth, not a substitute for distributed edge limits
 * before a multi-replica or Cloudflare rollout.
 */
export class TeacherLoginThrottle {
  private readonly states = new Map<string, LoginFailureState>();
  private readonly maximumFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly maximumEntries: number;

  constructor(options: TeacherLoginThrottleOptions = {}) {
    this.maximumFailures = options.maximumFailures ?? 5;
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.blockMs = options.blockMs ?? 2 * 60_000;
    this.maximumEntries = options.maximumEntries ?? 1024;
  }

  private key(username: string): string {
    return username.trim().toLowerCase().slice(0, 64) || '<invalid>';
  }

  private pruneFor(newKey: string): void {
    if (this.states.has(newKey) || this.states.size < this.maximumEntries) return;
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, state] of this.states) {
      if (state.lastSeenAt < oldest) {
        oldest = state.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.states.delete(oldestKey);
  }

  check(username: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const key = this.key(username);
    const state = this.states.get(key);
    if (!state) return { allowed: true, retryAfterSeconds: 0 };
    state.lastSeenAt = now;
    if (state.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000)),
      };
    }
    if (state.blockedUntil > 0) {
      this.states.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (now - state.windowStartedAt >= this.windowMs) this.states.delete(key);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(username: string, now = Date.now()): void {
    const key = this.key(username);
    this.pruneFor(key);
    let state = this.states.get(key);
    if (!state || now - state.windowStartedAt >= this.windowMs) {
      state = { failures: 0, windowStartedAt: now, blockedUntil: 0, lastSeenAt: now };
    }
    state.failures += 1;
    state.lastSeenAt = now;
    if (state.failures >= this.maximumFailures) state.blockedUntil = now + this.blockMs;
    this.states.set(key, state);
  }

  recordSuccess(username: string): void {
    this.states.delete(this.key(username));
  }
}

export interface TeacherRecord {
  username: string;
  displayName: string;
}

interface TeacherRow {
  username: string;
  display_name: string;
  salt: string;
  password_hash: string;
  iterations: number;
}

/** One entry of the TEACHER_SEED JSON array. */
interface SeedEntry {
  username?: unknown;
  name?: unknown;
  salt?: unknown;
  hash?: unknown;
  iterations?: unknown;
}

interface NormalizedSeedEntry {
  username: string;
  displayName: string;
  salt: string;
  hash: string;
  iterations: number;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Length-independent equality so a wrong password leaks no timing signal. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function derivePasswordHash(
  password: string,
  saltHex: string,
  iterations = PBKDF2_ITERATIONS
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    KEY_BITS
  );
  return toHex(bits);
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/**
 * Seeds teacher rows from the TEACHER_SEED secret. Idempotent and re-runnable:
 * rotating a password means updating the secret, and the next login picks it up.
 * Keeping the secret authoritative also means a lost volume (Railway) or a fresh
 * D1 re-provisions the same accounts with no manual SQL.
 */
export async function syncTeachersFromSeed(env: Env): Promise<void> {
  const raw = env.TEACHER_SEED?.trim();
  if (!raw) return;

  let entries: SeedEntry[];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    console.error('TEACHER_SEED is not valid JSON — teacher accounts not seeded');
    return;
  }

  const normalized: NormalizedSeedEntry[] = [];
  const usernames = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      console.error('TEACHER_SEED entries must be JSON objects — no accounts changed');
      return;
    }
    const { username, name, salt, hash, iterations } = entry;
    if (
      typeof username !== 'string' ||
      typeof salt !== 'string' ||
      typeof hash !== 'string' ||
      !username ||
      !salt ||
      !hash ||
      !/^[a-z0-9._-]{1,64}$/i.test(username.trim()) ||
      !/^[a-f0-9]{32}$/i.test(salt) ||
      !/^[a-f0-9]{64}$/i.test(hash) ||
      (iterations !== undefined &&
        (typeof iterations !== 'number' ||
          !Number.isInteger(iterations) ||
          iterations < PBKDF2_ITERATIONS ||
          iterations > 10_000_000)) ||
      (name !== undefined && typeof name !== 'string') ||
      (typeof name === 'string' && name.trim().length > 120)
    ) {
      console.error('TEACHER_SEED entry has invalid credential fields — no accounts changed');
      return;
    }
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername || usernames.has(normalizedUsername)) {
      console.error('TEACHER_SEED usernames must be non-empty and unique — no accounts changed');
      return;
    }
    usernames.add(normalizedUsername);
    normalized.push({
      username: normalizedUsername,
      displayName: typeof name === 'string' && name.trim() ? name.trim() : username,
      salt: salt.toLowerCase(),
      hash: hash.toLowerCase(),
      iterations: typeof iterations === 'number' ? iterations : PBKDF2_ITERATIONS,
    });
  }

  const statements = normalized.flatMap((entry) => [
    // A password rotation revokes existing sessions for that teacher, while an
    // unchanged seed leaves active sessions alone across isolate starts.
    env.DB.prepare(
      `DELETE FROM teacher_sessions
       WHERE username = ?
         AND EXISTS (
           SELECT 1 FROM teachers
           WHERE username = ? AND (password_hash <> ? OR salt <> ? OR iterations <> ?)
         )`
    ).bind(
      entry.username,
      entry.username,
      entry.hash,
      entry.salt,
      entry.iterations
    ),
    env.DB.prepare(
      `INSERT INTO teachers (username, display_name, salt, password_hash, iterations)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         display_name = excluded.display_name,
         salt = excluded.salt,
         password_hash = excluded.password_hash,
         iterations = excluded.iterations`
    ).bind(
      entry.username,
      entry.displayName,
      entry.salt,
      entry.hash,
      entry.iterations
    ),
  ]);

  if (normalized.length) {
    const placeholders = normalized.map(() => '?').join(', ');
    const keep = normalized.map((entry) => entry.username);
    statements.push(
      env.DB.prepare(
        `DELETE FROM teacher_sessions WHERE username NOT IN (${placeholders})`
      ).bind(...keep),
      env.DB.prepare(`DELETE FROM teachers WHERE username NOT IN (${placeholders})`).bind(...keep)
    );
  } else {
    // An explicit [] is the intentional "deprovision everyone" value. An
    // absent secret still returns above and leaves the database untouched.
    statements.push(
      env.DB.prepare('DELETE FROM teacher_sessions'),
      env.DB.prepare('DELETE FROM teachers')
    );
  }

  await env.DB.batch(statements);
}

/** Returns the teacher on success, null on any failure (never says which). */
export async function verifyLogin(
  env: Env,
  username: string,
  password: string
): Promise<TeacherRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM teachers WHERE username = ?')
    .bind(username.trim().toLowerCase())
    .first<TeacherRow>();
  // Unknown usernames still perform the same PBKDF2 class of work. The route
  // bounds password length and concurrent checks before reaching this call.
  const candidate = await derivePasswordHash(
    password,
    row?.salt ?? UNKNOWN_ACCOUNT_SALT,
    row?.iterations ?? PBKDF2_ITERATIONS
  );
  if (!row || !timingSafeEqual(candidate, row.password_hash)) return null;
  return { username: row.username, displayName: row.display_name };
}

export async function createSession(env: Env, username: string): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();

  await env.DB.prepare(
    'INSERT INTO teacher_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)'
  )
    .bind(await sha256Hex(token), username, expiresAt)
    .run();

  // Sessions are stored as ISO-8601 (`T`/`Z`) while SQLite's datetime('now')
  // uses a space separator. Parse both sides before comparing; a raw lexical
  // comparison otherwise keeps a same-day expired ISO timestamp alive.
  await env.DB.prepare(
    "DELETE FROM teacher_sessions WHERE datetime(expires_at) <= datetime('now')"
  ).run();
  return token;
}

export async function resolveSession(env: Env, token: string | null): Promise<TeacherRecord | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT t.username, t.display_name FROM teacher_sessions s
     JOIN teachers t ON t.username = s.username
     WHERE s.token_hash = ? AND datetime(s.expires_at) > datetime('now')`
  )
    .bind(await sha256Hex(token))
    .first<{ username: string; display_name: string }>();
  return row ? { username: row.username, displayName: row.display_name } : null;
}

export async function destroySession(env: Env, token: string | null): Promise<void> {
  if (!token) return;
  await env.DB.prepare('DELETE FROM teacher_sessions WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .run();
}

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

/**
 * Whether session cookies should carry the Secure flag. The request protocol
 * alone is wrong behind a TLS-terminating proxy (Railway): the Worker sees
 * plain http there, but the browser-facing origin is https — so trust
 * PUBLIC_BASE_URL first and fall back to the request only when it is unset.
 */
export function cookiesShouldBeSecure(publicBaseUrl: string | undefined, requestUrl: string): boolean {
  if (publicBaseUrl?.startsWith('https:')) return true;
  if (publicBaseUrl?.startsWith('http:')) return false;
  return new URL(requestUrl).protocol === 'https:';
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_DAYS * 86_400}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// --- prompt amendment ----------------------------------------------------

export interface AmendmentRecord {
  amendment: string;
  updatedBy: string | null;
  updatedAt: string | null;
  revision: number;
}

export interface PromptRevision {
  id: number;
  settingsRevision: number;
  amendment: string;
  changeNote: string;
  basePromptVersion: string;
  basePromptHash: string;
  effectivePromptHash: string;
  updatedBy: string;
  createdAt: string;
}

export async function getAmendment(env: Env): Promise<AmendmentRecord> {
  const row = await env.DB.prepare(
    'SELECT amendment, updated_by, updated_at, revision FROM assistant_settings WHERE id = 1'
  ).first<{
    amendment: string;
    updated_by: string | null;
    updated_at: string | null;
    revision: number;
  }>();
  return {
    amendment: row?.amendment ?? '',
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
    revision: row?.revision ?? 0,
  };
}

export async function setAmendment(
  env: Env,
  amendment: string,
  username: string,
  expectedRevision: number,
  trace: {
    changeNote: string;
    basePromptVersion: string;
    basePromptHash: string;
    effectivePromptHash: string;
  }
): Promise<{
  record: AmendmentRecord;
  changed: boolean;
  conflict: boolean;
  revision: PromptRevision | null;
  guidesCleared: number;
}> {
  const current = await getAmendment(env);
  if (current.amendment === amendment) {
    return {
      record: current,
      changed: false,
      conflict: false,
      revision: null,
      guidesCleared: 0,
    };
  }

  const nextRevision = expectedRevision + 1;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE assistant_settings
       SET amendment = ?, updated_by = ?, updated_at = datetime('now'), revision = revision + 1
       WHERE id = 1 AND revision = ? AND amendment <> ?`
    ).bind(amendment, username, expectedRevision, amendment),
    // SQLite changes() here refers to the completed compare-and-swap above.
    // A losing request inserts nothing. A winner must insert exactly one new
    // audit row: a pre-existing next revision is integrity drift and must fail
    // the batch, rolling the setting back instead of silently reusing history.
    env.DB.prepare(
      `INSERT INTO assistant_prompt_revisions
         (settings_revision, amendment, change_note, base_prompt_version, base_prompt_hash,
          effective_prompt_hash, updated_by)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE changes() = 1`
    ).bind(
      nextRevision,
      amendment,
      trace.changeNote,
      trace.basePromptVersion,
      trace.basePromptHash,
      trace.effectivePromptHash,
      username
    ),
    // changes() now refers to the history insert. This matters for two
    // identical concurrent requests: the loser must not invalidate a guide
    // regenerated after the winner committed.
    env.DB.prepare(
      `DELETE FROM guides
       WHERE changes() = 1`
    ),
  ]);

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    return {
      record: await getAmendment(env),
      changed: false,
      conflict: true,
      revision: null,
      guidesCleared: 0,
    };
  }

  // Read back the immutable row created by this request, not the mutable
  // settings singleton. Another teacher may save after our batch commits but
  // before this response is assembled; mixing that later amendment with this
  // request's hashes would produce a false audit response.
  const revision = await getPromptRevision(env, nextRevision);
  if (!revision) throw new Error('Prompt revision missing after successful save');
  return {
    record: {
      amendment: revision.amendment,
      updatedBy: revision.updatedBy,
      updatedAt: revision.createdAt,
      revision: revision.settingsRevision,
    },
    changed: true,
    conflict: false,
    revision,
    guidesCleared: results[2]?.meta?.changes ?? 0,
  };
}

async function getPromptRevision(
  env: Env,
  settingsRevision: number
): Promise<PromptRevision | null> {
  const row = await env.DB.prepare(
    `SELECT id, settings_revision, amendment, change_note, base_prompt_version, base_prompt_hash,
            effective_prompt_hash, updated_by, created_at
     FROM assistant_prompt_revisions
     WHERE settings_revision = ?`
  )
    .bind(settingsRevision)
    .first<{
      id: number;
      settings_revision: number;
      amendment: string;
      change_note: string;
      base_prompt_version: string;
      base_prompt_hash: string;
      effective_prompt_hash: string;
      updated_by: string;
      created_at: string;
    }>();
  return row
    ? {
        id: row.id,
        settingsRevision: row.settings_revision,
        amendment: row.amendment,
        changeNote: row.change_note,
        basePromptVersion: row.base_prompt_version,
        basePromptHash: row.base_prompt_hash,
        effectivePromptHash: row.effective_prompt_hash,
        updatedBy: row.updated_by,
        createdAt: row.created_at,
      }
    : null;
}

export async function getPromptHistory(
  env: Env,
  limit = PROMPT_HISTORY_LIMIT
): Promise<PromptRevision[]> {
  return (await getPromptHistoryPage(env, undefined, limit)).revisions;
}

export interface PromptHistoryPage {
  revisions: PromptRevision[];
  hasMore: boolean;
  nextBeforeId: number | null;
}

/** Bounded newest-first keyset page; every retained revision remains reachable. */
export async function getPromptHistoryPage(
  env: Env,
  beforeId?: number,
  limit = PROMPT_HISTORY_LIMIT
): Promise<PromptHistoryPage> {
  const safeLimit = Math.max(1, Math.min(PROMPT_HISTORY_LIMIT, Math.floor(limit)));
  if (
    beforeId !== undefined &&
    (!Number.isSafeInteger(beforeId) || beforeId < 1)
  ) {
    throw new Error('Invalid prompt history cursor');
  }
  const query = `SELECT id, settings_revision, amendment, change_note, base_prompt_version,
                        base_prompt_hash, effective_prompt_hash, updated_by, created_at
                 FROM assistant_prompt_revisions
                 ${beforeId === undefined ? '' : 'WHERE id < ?'}
                 ORDER BY id DESC
                 LIMIT ?`;
  const statement = env.DB.prepare(query);
  const result = await (beforeId === undefined
    ? statement.bind(safeLimit + 1)
    : statement.bind(beforeId, safeLimit + 1))
    .all<{
      id: number;
      settings_revision: number;
      amendment: string;
      change_note: string;
      base_prompt_version: string;
      base_prompt_hash: string;
      effective_prompt_hash: string;
      updated_by: string;
      created_at: string;
    }>();

  const rows = result.results ?? [];
  const hasMore = rows.length > safeLimit;
  const revisions = rows.slice(0, safeLimit).map((row) => ({
    id: row.id,
    settingsRevision: row.settings_revision,
    amendment: row.amendment,
    changeNote: row.change_note,
    basePromptVersion: row.base_prompt_version,
    basePromptHash: row.base_prompt_hash,
    effectivePromptHash: row.effective_prompt_hash,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
  }));
  return {
    revisions,
    hasMore,
    nextBeforeId: hasMore ? revisions.at(-1)?.id ?? null : null,
  };
}

/** null when the text is unusable; callers turn that into a 400. */
export function normalizeAmendment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > MAX_AMENDMENT_CHARS ? null : trimmed;
}

export function normalizeChangeNote(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CHANGE_NOTE_CHARS) return null;
  return trimmed;
}

export { MAX_AMENDMENT_CHARS, MAX_CHANGE_NOTE_CHARS, PROMPT_HISTORY_LIMIT };
