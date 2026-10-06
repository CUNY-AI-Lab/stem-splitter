import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { dailyWindow } from '../daily-allowance.ts';

export interface GuestSession {
  subject: string;
  expiresAt: number;
  verifiedDay: string;
}
export interface GuestSettings {
  GUEST_ENABLED?: string;
  GUEST_COOKIE_SECRET?: string;
  GUEST_TURNSTILE_SITE_KEY?: string;
  GUEST_TURNSTILE_SECRET?: string;
  GUEST_GATEWAY_API_KEY?: string;
  /** Computed by the private Worker adapter, never taken from browser input. */
  guestRuntimeReady?: boolean;
  guestStartAllowed?: boolean;
  /** Verified cookie and live server session, set by the private adapter only. */
  guestSession?: GuestSession;
}
export const GUEST_SESSION_MS = 7 * 86400000;
export const GUEST_SUBJECT = /^guest-[0-9a-f]{64}$/;
export const guestPrincipal = (principal: AppPrincipal | undefined): boolean => principal?.quotaClass === 'guest';
export const ownershipTable = (principal: AppPrincipal | undefined, kind: 'job' | 'upload') =>
  guestPrincipal(principal) ? kind === 'job' ? 'guest_job_owners' : 'guest_upload_owners'
    : kind === 'job' ? 'job_owners' : 'upload_owners';
export const conversationTable = (principal: AppPrincipal) => guestPrincipal(principal) ? 'guest_listening_conversations' : 'listening_conversations';

export async function activeGuest(db: D1Database, subject: string, now = Date.now()): Promise<GuestSession | null> {
  if (!GUEST_SUBJECT.test(subject)) return null;
  const row = await db.prepare(`SELECT subject,expires_at AS expiresAt,verified_day AS verifiedDay FROM guest_sessions
    WHERE subject=? AND expires_at>? AND revoked_at IS NULL`).bind(subject, now).first<GuestSession>();
  return row && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now && /^\d{4}-\d{2}-\d{2}$/.test(row.verifiedDay) ? row : null;
}
export async function guestOwnsJob(env: Env, subject: string, id: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM guest_job_owners o JOIN jobs j ON j.id=o.job_id
    JOIN guest_sessions s ON s.subject=o.subject LEFT JOIN job_courses c ON c.job_id=j.id
    WHERE o.subject=? AND j.id=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND c.job_id IS NULL AND j.created_at>datetime('now','-90 days')`).bind(subject,id,Date.now()).first());
}
export function guestFailure(code: string, status: 401 | 403 | 429 | 503, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control':'private, no-store' } });
}

/** Guests have a separate authority and an explicit route allowlist. A guest
 * session cannot resolve Admission, select a course, or use member ownership. */
export async function authorizeGuestRequest(request: Request, env: Env, authenticated: (principal: AppPrincipal) => void): Promise<Response | null> {
  const supplied = env.guestSession;
  const session = env.guestRuntimeReady && supplied && await activeGuest(env.DB,supplied.subject);
  if (!session || session.expiresAt !== supplied?.expiresAt) return guestFailure('guest_session_expired',401,'This guest session has ended. Start a new guest session or sign in.');
  const path = new URL(request.url).pathname, method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  if (!read && (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site')) return guestFailure('guest_origin_invalid',403,'Open Stem Splitter directly to continue.');
  if (request.headers.has('x-stem-course') && request.headers.get('x-stem-course') !== 'personal') return guestFailure('guest_course_forbidden',403,'Sign in with an enrolled account to use course work.');
  const job = /^\/api\/jobs\/([a-zA-Z0-9-]+)(?:\/(labels|annotations|guide|chat|cancel|listening-conversation)(?:\/([a-zA-Z0-9-]+))?)?$/.exec(path);
  const file = /^\/api\/files\/stems\/([a-zA-Z0-9-]+)\/(?:[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_.-]+$/.exec(path);
  const general = read && ['/api/account','/api/auth-check','/api/jobs','/api/teacher/me','/api/archive/scopes','/api/archive/search'].includes(path)
    || read && /^\/api\/archive\/items\/[a-zA-Z0-9_.-]+$/.test(path)
    || method === 'POST' && ['/api/uploads','/api/jobs','/api/usage-events'].includes(path)
    || method === 'PUT' && path.startsWith('/api/local-uploads/');
  const jobAllowed = job && (!job[2] ? read : job[2] === 'labels' ? method === 'PUT'
    : ['guide','chat','cancel'].includes(job[2]) ? method === 'POST' && !job[3]
    : job[2] === 'listening-conversation' ? ['GET','PUT','DELETE'].includes(method) && !job[3]
    : job[2] === 'annotations' ? job[3] ? ['PUT','DELETE'].includes(method) : method === 'POST' : false);
  if (!general && !jobAllowed && !(file && read)) return guestFailure('guest_route_forbidden',403,'This feature requires an authorized signed-in account.');
  if ((job || file) && !await guestOwnsJob(env,session.subject,(job ?? file)![1])) return Response.json({error:'Job not found'},{status:404});
  // A saved guest session can read its work after midnight, but paid starts
  // require a fresh daily server-verified human check.
  const paid = method === 'POST' && (path === '/api/jobs' || job && ['guide','chat'].includes(job[2]));
  if (paid && session.verifiedDay !== dailyWindow().day) return guestFailure('guest_verification_required',403,'Complete the guest check again to continue today. Your saved work is still available.');
  authenticated({ subject:session.subject,role:'guest',quotaClass:'guest',displayName:'Guest',course:null,courseId:null });
  return null;
}
