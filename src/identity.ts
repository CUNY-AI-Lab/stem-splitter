import { courseIds, resolveCourse, jobCourse, jobPermission, cleanDisplayName, CourseError, courseErrorResponse } from './classroom/access.ts';
import { STEM_COURSE_ID } from './classroom/contract.ts';
import type { AdmissionCourseResolver, CourseAssignment } from './classroom/contract.ts';
import type { Env } from './env.ts';

export const STEM_AUDIENCE = 'cail:stem-splitter';
export type AppRole = 'student' | 'instructor' | 'admin';
export interface AppPrincipal { subject: string; role: AppRole; displayName: string; course: CourseAssignment | null; courseId: string | null; }
export interface AdmissionResolver extends AdmissionCourseResolver {
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
  if (['GET', 'HEAD'].includes(request.method) && /^\/api\/shared-jobs\/[a-zA-Z0-9-]+(?:\/stems\/\d+)?$/.test(path)) return null;
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
    : user.role === 'instructor' && (user.role_expires_at === null || Date.parse(user.role_expires_at) > Date.now())
      ? 'instructor' : 'student';
  const jobId = /^\/api\/(?:teacher\/)?jobs\/([^/]+)/.exec(path)?.[1] ?? /^\/api\/files\/stems\/([^/]+)/.exec(path)?.[1];
  try {
    const storedCourse = jobId ? await jobCourse(env, jobId) : null;
    const routeCourse = /^\/api\/classroom\/courses\/([^/]+)/.exec(path)?.[1];
    const selected = storedCourse?.course_id ?? routeCourse ?? request.headers.get('x-stem-course') ?? courseIds(env)[0];
    const personal = selected === 'personal';
    if (env.CAIL_CLASSROOM_ENABLED === 'false' && (routeCourse || path === '/api/classroom/courses' || (storedCourse && !['GET','HEAD'].includes(request.method)) || (!storedCourse && !personal && request.headers.has('x-stem-course') && !['GET','HEAD'].includes(request.method)))) throw new CourseError(503,'course_work_paused');
    // Admin/app roles remain separate. They never create a course-owner grant.
    let course: CourseAssignment | null = null;
    try { course = await resolveCourse(env, identity.subject, personal ? courseIds(env)[0] : selected); }
    catch (error) {
      if (!(error instanceof CourseError) || error.status === 503) throw error;
      if (!request.headers.has('x-stem-course') && !storedCourse && !routeCourse && ['/api/account','/api/teacher/me','/api/classroom/courses'].includes(path)) {
        // Course owners may discover their independently authorized teaching context.
        for (const id of courseIds(env).filter(id=>id!==selected)) {
          try { const candidate=await resolveCourse(env,identity.subject,id); if(candidate.owner){course=candidate;break;} }
          catch(lookup) { if(!(lookup instanceof CourseError)||lookup.status===503)throw lookup; }
        }
      }
      if (!course && (role === 'student' || storedCourse || routeCourse || (!personal && selected !== courseIds(env)[0]))) throw error;
    }
    // The entry policy is the exact MSH245 participant source, independently of
    // which other configured course is selected. Owners use their separate relationship.
    if (course && !course.owner && course.classId !== STEM_COURSE_ID) {
      const entry = await resolveCourse(env,identity.subject,STEM_COURSE_ID);
      if (!entry.participant) throw new CourseError(403,'target_course_enrollment_required');
    }
    const principal: AppPrincipal = { subject: identity.subject, role,
      displayName: cleanDisplayName(identity.name), course,
      courseId: !personal && request.headers.has('x-stem-course') && course ? course.classId : null };
    if (course?.displayNameSource === 'verified_profile') principal.displayName = cleanDisplayName(course.displayName);
    if (path === '/api/teacher/login' || path === '/api/teacher/logout') return authFailure('admission_required', 403);
    if (path.startsWith('/api/admin/') && role !== 'admin') return authFailure('admission_required', 403);
    if (path.startsWith('/api/teacher/') && path !== '/api/teacher/me' && role === 'student') return authFailure('admission_required', 403);
    // Cloudflare amendments belong to a course; the legacy singleton remains Railway-only.
    if (path.startsWith('/api/teacher/prompt')) return Response.json({ error: 'Choose a course in the instructor page.' }, { status: 409 });
    if (jobId) {
      const permission = await jobPermission(env, principal, jobId);
      if (!permission) return Response.json({ error: 'Job not found' }, { status: 404 });
      const annotationWrite = /\/annotations(?:\/[^/]+)?$/.test(path);
      const read = ['GET', 'HEAD'].includes(request.method);
      if (!permission.owner && !permission.administration && ((!read && !(annotationWrite && permission.comment)) || path.includes('/listening-conversation') || path.startsWith('/api/teacher/'))) return Response.json({ error: 'Job not found' }, { status: 404 });
      principal.courseId = permission.courseId;
    }
    authenticated(principal);
  } catch (error) {
    if (error instanceof CourseError) return courseErrorResponse(error);
    throw error;
  }
  const folderId = /^\/api\/teacher\/folders\/([^/]+)/.exec(path)?.[1];
  if (folderId) {
    const folder = await env.DB.prepare('SELECT created_by FROM folders WHERE id = ?').bind(folderId).first<{ created_by: string }>();
    if (!folder || (role !== 'admin' && folder.created_by !== identity.subject)) return Response.json({ error: 'Folder not found' }, { status: 404 });
  }
  return null;
}
