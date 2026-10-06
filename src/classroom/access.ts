import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { COURSE_APP, STEM_COURSE_ID, validAccess, validClassId, validFailure, type CourseAssignment } from './contract.ts';

export class CourseError extends Error {
  status: 400 | 403 | 404 | 409 | 503;
  code: string;
  constructor(status: 400 | 403 | 404 | 409 | 503, code: string) { super(code); this.status=status; this.code=code; }
}
export const courseIds = (env: Env): string[] => {
  const ids = env.CAIL_COURSE_IDS?.split(',').map(s => s.trim()) ?? [STEM_COURSE_ID];
  if (!ids.length || ids.length > 20 || ids.some(id => !validClassId(id))) throw new CourseError(503, 'course_configuration_unavailable');
  return [...new Set(ids)];
};
export async function boundedRpc<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); })]); }
  catch { throw new CourseError(503, 'course_authority_unavailable'); }
  finally { if (timer) clearTimeout(timer); }
}
export async function resolveCourse(env: Env, subject: string, classId: string): Promise<CourseAssignment> {
  if (!courseIds(env).includes(classId)) throw new CourseError(403, 'course_not_available');
  if (!env.ADMISSION_RESOLVER?.resolveCourseAccess) throw new CourseError(503, 'course_authority_unavailable');
  const value = await boundedRpc(() => env.ADMISSION_RESOLVER!.resolveCourseAccess!({ subject, app: COURSE_APP, classId }));
  if (validFailure(value)) throw new CourseError(403, value.code);
  if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true || !validAccess(value) || value.classId !== classId) throw new CourseError(503, 'course_authority_unavailable');
  return value;
}
/** Used again by delayed operation workers; a remembered launch is not permission. */
export async function authorizeStoredCourseWork(env: Env, subject: string, courseId: string | null): Promise<CourseAssignment> {
  if (courseId && env.CAIL_CLASSROOM_ENABLED === 'false') throw new CourseError(503, 'course_work_paused');
  const user = await env.DB.prepare('SELECT disabled FROM app_users WHERE subject=?').bind(subject).first<{ disabled: number }>();
  if (!user || user.disabled) throw new CourseError(403, 'workspace_disabled');
  const access=await resolveCourse(env,subject,courseId??STEM_COURSE_ID);
  if(!access.owner&&access.classId!==STEM_COURSE_ID){const entry=await resolveCourse(env,subject,STEM_COURSE_ID);if(!entry.participant)throw new CourseError(403,'target_course_enrollment_required');}
  return access;
}
export interface JobCourse { course_id: string; member_id: string; policy_version: string }
export async function jobCourse(env: Env, jobId: string): Promise<JobCourse | null> {
  if (env.AUTH_MODE !== 'cail') return null;
  return env.DB.prepare('SELECT course_id, member_id, policy_version FROM job_courses WHERE job_id=?').bind(jobId).first<JobCourse>();
}
export function courseAssignmentStatement(env: Env, id: string, principal: AppPrincipal): D1PreparedStatement | null {
  return principal.courseId && principal.course ? env.DB.prepare(
    `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) SELECT ?,?,?,?,'course-work-v1' WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?)`
  ).bind(id, principal.courseId, principal.course.memberId, principal.subject,id) : null;
}
export function cleanDisplayName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160) || 'Student' : 'Student';
}
export interface JobPermission { owner: boolean; read: boolean; comment: boolean; courseId: string | null; instructor: boolean; administration?: boolean }
export async function jobPermission(env: Env, principal: AppPrincipal, id: string): Promise<JobPermission | null> {
  const row = await env.DB.prepare(`SELECT o.subject,j.created_at,c.course_id FROM jobs j JOIN job_owners o ON o.job_id=j.id
    LEFT JOIN job_courses c ON c.job_id=j.id WHERE j.id=? AND j.created_at>datetime('now','-90 days')`).bind(id)
    .first<{ subject: string; course_id: string | null }>();
  if (!row) return null;
  if (!row.course_id) return row.subject === principal.subject || principal.role === 'admin' ? { owner:row.subject===principal.subject,read:true,comment:true,courseId:null,instructor:false,administration:principal.role==='admin' } : null;
  const course = principal.course?.classId === row.course_id ? principal.course : await resolveCourse(env, principal.subject, row.course_id);
  const owner = row.subject === principal.subject;
  if (env.CAIL_CLASSROOM_ENABLED === 'false') return owner ? {owner:true,read:true,comment:false,courseId:row.course_id,instructor:false} : null;
  if (owner || course.owner) return { owner, read: true, comment: true, courseId: row.course_id, instructor: course.owner };
  const grant = await env.DB.prepare(`SELECT MAX(f.permission='comment') AS comment FROM course_folders f
    JOIN course_folder_items i ON i.folder_id=f.id WHERE i.job_id=? AND f.course_id=? AND f.permission IN ('read','comment')
    HAVING COUNT(*)>0`).bind(id, row.course_id).first<{ comment: number }>();
  return grant && course.participant ? { owner: false, read: true, comment: !!grant.comment, courseId: row.course_id, instructor: false } : null;
}
export function courseErrorResponse(error: CourseError): Response {
  const message = error.status === 503 ? 'Course access is temporarily unavailable. Try again shortly.'
    : error.code === 'conversation_interrupted' ? 'The previous reply could not be confirmed. Reload the conversation and send a new message; the old request will not be retried.'
    : error.status === 409 ? 'This course changed. Refresh and try again.' : 'This course work is not available to your account.';
  return Response.json({ error: { code: error.code, message } }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
}
