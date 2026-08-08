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

  for (const entry of entries) {
    const { username, name, salt, hash, iterations } = entry;
    if (
      typeof username !== 'string' ||
      typeof salt !== 'string' ||
      typeof hash !== 'string' ||
      !username ||
      !salt ||
      !hash
    ) {
      console.error('TEACHER_SEED entry is missing username/salt/hash — skipped');
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO teachers (username, display_name, salt, password_hash, iterations)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         display_name = excluded.display_name,
         salt = excluded.salt,
         password_hash = excluded.password_hash,
         iterations = excluded.iterations`
    )
      .bind(
        username.toLowerCase(),
        typeof name === 'string' && name ? name : username,
        salt,
        hash,
        typeof iterations === 'number' ? iterations : PBKDF2_ITERATIONS
      )
      .run();
  }
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
  if (!row) return null;

  const candidate = await derivePasswordHash(password, row.salt, row.iterations);
  if (!timingSafeEqual(candidate, row.password_hash)) return null;
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

  // Opportunistic cleanup keeps the table from growing without a cron.
  await env.DB.prepare("DELETE FROM teacher_sessions WHERE expires_at < datetime('now')").run();
  return token;
}

export async function resolveSession(env: Env, token: string | null): Promise<TeacherRecord | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT t.username, t.display_name FROM teacher_sessions s
     JOIN teachers t ON t.username = s.username
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
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
}

export async function getAmendment(env: Env): Promise<AmendmentRecord> {
  const row = await env.DB.prepare(
    'SELECT amendment, updated_by, updated_at FROM assistant_settings WHERE id = 1'
  ).first<{ amendment: string; updated_by: string | null; updated_at: string | null }>();
  return {
    amendment: row?.amendment ?? '',
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function setAmendment(
  env: Env,
  amendment: string,
  username: string
): Promise<AmendmentRecord> {
  await env.DB.prepare(
    `INSERT INTO assistant_settings (id, amendment, updated_by, updated_at)
     VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       amendment = excluded.amendment,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  )
    .bind(amendment, username)
    .run();
  return getAmendment(env);
}

/** null when the text is unusable; callers turn that into a 400. */
export function normalizeAmendment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > MAX_AMENDMENT_CHARS ? null : trimmed;
}

export { MAX_AMENDMENT_CHARS };
