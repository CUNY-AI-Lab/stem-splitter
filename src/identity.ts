import type { Env } from './env.ts';

export const STEM_AUDIENCE = 'cail:stem-splitter';
export type AppRole = 'student' | 'instructor' | 'admin';
export interface AppPrincipal { subject: string; role: AppRole; }
export interface AdmissionResolver {
  resolveMembership(input: { subject: string }): Promise<unknown>;
}

export async function equalSecret(provided: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!provided || provided.length > 512 || !expected) return false;
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', bytes.encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, bytes.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, bytes.encode(provided));
}

export function authFailure(code: string, status: number): Response {
  const message = status === 503 ? 'Sign-in is temporarily unavailable. Try again shortly.'
    : status === 403 ? 'You do not have access to this workspace.' : 'Sign in with CUNY Login to continue.';
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function validWriteOrigin(request: Request, env: Env): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  const allowed = [new URL(env.PUBLIC_BASE_URL).origin];
  const requestUrl = new URL(request.url);
  if (env.LOCAL_HOSTING === 'true' && ['127.0.0.1', 'localhost', '[::1]'].includes(requestUrl.hostname)) allowed.push(requestUrl.origin);
  if (env.CAIL_BROWSER_ORIGIN === 'https://tools.ailab.gc.cuny.edu') allowed.push(env.CAIL_BROWSER_ORIGIN);
  return origin !== null && allowed.includes(origin);
}

/** Each request verifies identity, current Admission access, and the local role.
 * No email, raw CUNY identity, cookie, or caller-supplied role is authority. */
export async function authorizeCailRequest(request: Request, env: Env, authenticated: (principal: AppPrincipal) => void = () => {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // Hono decodes route parameters. Do not let an encoded structural path
  // bypass the ownership checks applied to its decoded equivalent.
  if (path.includes('%') && !path.startsWith('/api/local-uploads/') && !path.startsWith('/api/local-sources/')) {
    return Response.json({ error: 'Invalid request path' }, { status: 400 });
  }
  if (path === '/api/runtime' || path === '/api/separation-options' || path === '/api/webhooks/separation') return null;
  if (path.startsWith('/api/local-sources/') && request.method === 'GET') return null; // HMAC capability checked by the source route.
  if (!env.verifyCailIdentity || !env.ADMISSION_RESOLVER) return authFailure('identity_verification_misconfigured', 503);
  const token = request.headers.get('x-cail-identity-jwt');
  if (!token || token.length > 16384) return authFailure('authentication_required', 401);
  const identity = await env.verifyCailIdentity(token, env.CAIL_IDENTITY_JWKS);
  if (identity === 'unavailable') return authFailure('identity_verification_misconfigured', 503);
  if (!identity) return authFailure('invalid_credential', 401);
  if (!validWriteOrigin(request, env)) return authFailure('invalid_credential', 403);
  let resolution: unknown;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    resolution = await Promise.race([
      env.ADMISSION_RESOLVER.resolveMembership({ subject: identity.subject }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 5000); }),
    ]);
  } catch { return authFailure('admission_unavailable', 503); }
  finally { if (timeout) clearTimeout(timeout); }
  if (!resolution || typeof resolution !== 'object') return authFailure('admission_unavailable', 503);
  const membership = resolution as Record<string, unknown>;
  if (membership.ok === false && membership.code === 'not_admitted') return authFailure('admission_required', 403);
  if (membership.ok !== true || !['member', 'admin'].includes(String(membership.accessRole)) ||
      !['person', 'person-plus', 'admin'].includes(String(membership.budgetScope)) ||
      (membership.accessRole === 'admin') !== (membership.budgetScope === 'admin') ||
      !Number.isSafeInteger(membership.revision) || Number(membership.revision) < 0 ||
      typeof membership.expiresAt !== 'string' || !Number.isFinite(Date.parse(membership.expiresAt))) {
    return authFailure('admission_unavailable', 503);
  }
  if (Date.parse(membership.expiresAt) <= Date.now()) return authFailure('admission_required', 403);
  await env.DB.prepare('INSERT OR IGNORE INTO app_users (subject) VALUES (?)').bind(identity.subject).run();
  const user = await env.DB.prepare('SELECT role, disabled, role_expires_at FROM app_users WHERE subject = ?')
    .bind(identity.subject).first<{ role: string; disabled: number; role_expires_at: string | null }>();
  if (!user || user.disabled) return authFailure('admission_required', 403);
  const role: AppRole = membership.accessRole === 'admin' ? 'admin'
    : user.role === 'instructor' && user.role_expires_at && Date.parse(user.role_expires_at) > Date.now()
      ? 'instructor' : 'student';
  const principal = { subject: identity.subject, role };
  if (path === '/api/teacher/login' || path === '/api/teacher/logout') return authFailure('admission_required', 403);
  if (path.startsWith('/api/admin/') && role !== 'admin') return authFailure('admission_required', 403);
  if (path.startsWith('/api/teacher/') && path !== '/api/teacher/me' && path !== '/api/teacher/logout' && role === 'student') {
    return authFailure('admission_required', 403);
  }
  const jobId = /^\/api\/(?:teacher\/)?jobs\/([^/]+)/.exec(path)?.[1] ?? /^\/api\/files\/stems\/([^/]+)/.exec(path)?.[1];
  if (jobId) {
    const owner = await env.DB.prepare('SELECT subject FROM job_owners WHERE job_id = ?').bind(jobId).first<{ subject: string }>();
    // Existing unclaimed jobs are deliberately unavailable until a reviewed data import assigns ownership.
    if (!owner || (role !== 'admin' && owner.subject !== identity.subject)) return Response.json({ error: 'Job not found' }, { status: 404 });
  }
  const folderId = /^\/api\/teacher\/folders\/([^/]+)/.exec(path)?.[1];
  if (folderId) {
    const folder = await env.DB.prepare('SELECT created_by FROM folders WHERE id = ?').bind(folderId).first<{ created_by: string }>();
    if (!folder || (role !== 'admin' && folder.created_by !== identity.subject)) return Response.json({ error: 'Folder not found' }, { status: 404 });
  }
  authenticated(principal);
  return null;
}
