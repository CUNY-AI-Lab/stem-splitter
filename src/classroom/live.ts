import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { readBoundedJsonRequest } from '../http/bounded-request.ts';
import { boundedRpc, CourseError, jobPermission, resolveCourse } from './access.ts';

const SESSION_LEASE_MS = 90_000;
const POLL_AFTER_MS = 2500;
type Context = { Bindings: Env; Variables: { principal?: AppPrincipal } };
type LiveRow = {
  job_id: string; course_id: string; host_subject: string; active: number; revision: number;
  playing: number; position: number; playback_rate: number; focus_stem: string | null;
  focus_mode: 'behind' | 'only' | null; selection_start: number | null; selection_end: number | null;
  updated_at: number; expires_at: number;
};
type Job = { stems: string };
type Transport = {
  playing: boolean; position: number; playbackRate: number; focusStem: string | null;
  focusMode: 'behind' | 'only' | null; selection: { start: number; end: number } | null;
};

function isInstructor(principal: AppPrincipal, courseId: string) {
  const course = principal.course;
  return !!course && course.classId === courseId && course.capabilities.instructorPanel &&
    (course.owner || course.guestInstructor);
}

async function readableJob(env: Env, principal: AppPrincipal, courseId: string, jobId: string): Promise<Job> {
  if (env.CAIL_CLASSROOM_ENABLED === 'false') throw new CourseError(503, 'course_work_paused');
  // The stored course wins over caller selectors. Personal/public audio shares
  // never acquire live-room access, even for an app administrator.
  const job = await env.DB.prepare(`SELECT j.stems FROM jobs j JOIN job_courses c ON c.job_id=j.id
    WHERE j.id=? AND c.course_id=? AND j.status='done' AND j.created_at>datetime('now','-90 days')
    AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)`)
    .bind(jobId, courseId).first<Job>();
  if (!job) throw new CourseError(404, 'not_found');
  const permission = await jobPermission(env, principal, jobId);
  if (!permission?.read || permission.courseId !== courseId) throw new CourseError(404, 'not_found');
  return job;
}

async function currentHost(env: Env, row: LiveRow, viewer: AppPrincipal): Promise<boolean> {
  // The requesting host already passed current identity, membership, course,
  // local disablement and recording checks in this request.
  if (row.host_subject === viewer.subject) return isInstructor(viewer, row.course_id);
  const user = await env.DB.prepare('SELECT disabled FROM app_users WHERE subject=?').bind(row.host_subject).first<{ disabled: number }>();
  if (!user || user.disabled) return false;
  try {
    if (!env.ADMISSION_RESOLVER) throw new CourseError(503, 'course_authority_unavailable');
    const result = await boundedRpc(() => env.ADMISSION_RESOLVER!.resolveMembership({ subject: row.host_subject }));
    if (!result || typeof result !== 'object') throw new CourseError(503, 'course_authority_unavailable');
    const membership = result as Record<string, unknown>;
    if (membership.ok === false && membership.code === 'not_admitted') return false;
    if (membership.ok !== true || !['member', 'admin'].includes(String(membership.accessRole)) ||
      !['person', 'person-plus', 'admin'].includes(String(membership.budgetScope)) ||
      (membership.accessRole === 'admin') !== (membership.budgetScope === 'admin') ||
      !Number.isSafeInteger(membership.revision) || Number(membership.revision) < 0 ||
      typeof membership.expiresAt !== 'string' || !Number.isFinite(Date.parse(membership.expiresAt))) {
      throw new CourseError(503, 'course_authority_unavailable');
    }
    if (Date.parse(membership.expiresAt) <= Date.now()) return false;
    const course = await resolveCourse(env, row.host_subject, row.course_id);
    if (!course.capabilities.instructorPanel || !(course.owner || course.guestInstructor)) return false;
    const permission = await jobPermission(env, { subject: row.host_subject, role: 'member', quotaClass: 'member', displayName: '', course, courseId: row.course_id }, row.job_id);
    return !!permission?.read && permission.courseId === row.course_id;
  } catch (error) {
    if (error instanceof CourseError && error.status !== 503) return false;
    throw error; // Authority outages must not be mistaken for an ended session.
  }
}

async function snapshot(env: Env, principal: AppPrincipal, row: LiveRow | null, courseId: string) {
  const authorized = !!row && !!row.active && row.expires_at > Date.now() && await currentHost(env, row, principal);
  const now = Date.now();
  const active = authorized && row!.expires_at > now;
  return {
    session: row ? {
      active, revision: row.revision, playing: active && !!row.playing,
      position: row.position, playbackRate: row.playback_rate, focusStem: row.focus_stem,
      focusMode: row.focus_mode,
      selection: row.selection_start === null ? null : { start: row.selection_start, end: row.selection_end! },
      updatedAt: row.updated_at, expiresAt: row.expires_at,
    } : null,
    revision: row?.revision ?? 0,
    canControl: isInstructor(principal, courseId),
    isHost: active && row!.host_subject === principal.subject,
    serverTime: now, pollAfterMs: POLL_AFTER_MS,
  };
}

function transport(value: Record<string, unknown>, job: Job): Transport {
  const finite = (n: unknown, low: number, high: number) => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
  let names: string[];
  try { names = JSON.parse(job.stems).map((stem: { name: string }) => stem.name); }
  catch { throw new CourseError(503, 'live_media_unavailable'); }
  if (typeof value.playing !== 'boolean' || !finite(value.position, 0, 900) || !finite(value.playbackRate, .5, 2) ||
    !(value.focusStem === null || typeof value.focusStem === 'string' && names.includes(value.focusStem)) ||
    !(value.focusStem === null ? value.focusMode === null : ['behind', 'only'].includes(String(value.focusMode)))) {
    throw new CourseError(400, 'invalid_transport');
  }
  const selection = value.selection as { start?: unknown; end?: unknown } | null;
  if (selection !== null && (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
    Object.keys(selection).some(key => key !== 'start' && key !== 'end') ||
    !finite(selection.start, 0, 900) || !finite(selection.end, 0, 900) || Number(selection.end) <= Number(selection.start))) {
    throw new CourseError(400, 'invalid_transport');
  }
  return value as unknown as Transport;
}

const routes = new Hono<Context>();
const path = '/courses/:courseId/jobs/:jobId/live';
routes.get(path, async c => {
  const principal = c.get('principal')!, courseId = c.req.param('courseId'), jobId = c.req.param('jobId');
  // Use the existing limiter, with an opaque, actor-scoped key. Eight classmates
  // behind one classroom IP do not consume each other's polling allowance.
  if (!c.env.REQUEST_LIMIT) throw new CourseError(503, 'live_temporarily_unavailable');
  const limited = await c.env.REQUEST_LIMIT.limit({ key: `stem-live-read:${principal.subject}:${courseId}:${jobId}` });
  if (!limited.success) return c.json({ error: { code: 'live_poll_limited', message: 'Wait a moment before refreshing the live session.' } }, 429, { 'Retry-After': '60' });
  await readableJob(c.env, principal, courseId, jobId);
  const row = await c.env.DB.prepare('SELECT * FROM course_live_sessions WHERE job_id=? AND course_id=?').bind(jobId, courseId).first<LiveRow>();
  return c.json(await snapshot(c.env, principal, row, courseId));
});
routes.put(path, async c => {
  const principal = c.get('principal')!, courseId = c.req.param('courseId'), jobId = c.req.param('jobId');
  if (!isInstructor(principal, courseId)) throw new CourseError(403, 'not_owner');
  const job = await readableJob(c.env, principal, courseId, jobId);
  let input: Record<string, unknown>;
  try {
    const parsed = await readBoundedJsonRequest(c.req.raw, 2048);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    input = parsed as Record<string, unknown>;
  } catch { throw new CourseError(400, 'invalid_transport'); }
  if (!['start', 'update', 'end'].includes(String(input.action)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 ||
    Object.keys(input).some(key => !['action', 'expectedRevision', 'playing', 'position', 'playbackRate', 'focusStem', 'focusMode', 'selection'].includes(key))) throw new CourseError(400, 'invalid_transport');
  const row = await c.env.DB.prepare('SELECT * FROM course_live_sessions WHERE job_id=? AND course_id=?').bind(jobId, courseId).first<LiveRow>();
  if ((row?.revision ?? 0) !== input.expectedRevision) throw new CourseError(409, 'live_changed');
  const current = await snapshot(c.env, principal, row, courseId);
  if (input.action === 'start') {
    if (current.session?.active && !current.isHost) throw new CourseError(409, 'live_other_instructor');
  } else if (!current.isHost) throw new CourseError(409, 'live_not_host');
  const now = Date.now();
  if (input.action === 'end') {
    const result = await c.env.DB.prepare(`UPDATE course_live_sessions SET active=0,playing=0,revision=revision+1,updated_at=?,expires_at=?
      WHERE job_id=? AND course_id=? AND revision=? AND host_subject=?`).bind(now, now, jobId, courseId, input.expectedRevision, principal.subject).run();
    if (!result.meta.changes) throw new CourseError(409, 'live_changed');
  } else {
    const state = transport(input, job);
    const values = [principal.subject, state.playing ? 1 : 0, state.position, state.playbackRate, state.focusStem, state.focusMode,
      state.selection?.start ?? null, state.selection?.end ?? null, now, now + SESSION_LEASE_MS];
    const result = row
      ? await c.env.DB.prepare(`UPDATE course_live_sessions SET host_subject=?,active=1,playing=?,position=?,playback_rate=?,focus_stem=?,focus_mode=?,
          selection_start=?,selection_end=?,updated_at=?,expires_at=?,revision=revision+1 WHERE job_id=? AND course_id=? AND revision=?`)
          .bind(...values, jobId, courseId, input.expectedRevision).run()
      : await c.env.DB.prepare(`INSERT INTO course_live_sessions(host_subject,playing,position,playback_rate,focus_stem,focus_mode,selection_start,selection_end,updated_at,expires_at,
          job_id,course_id,active,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,1) ON CONFLICT(job_id) DO NOTHING`)
          .bind(...values, jobId, courseId).run();
    if (!result.meta.changes) throw new CourseError(409, 'live_changed');
  }
  const updated = await c.env.DB.prepare('SELECT * FROM course_live_sessions WHERE job_id=? AND course_id=?').bind(jobId, courseId).first<LiveRow>();
  return c.json(await snapshot(c.env, principal, updated, courseId));
});
export default routes;
