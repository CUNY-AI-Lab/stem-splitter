/** Private Admission course wire v1, mirrored from admission-contract/src/course.ts
 * at cail-tools-admission 5f13f332c120c6712aead2a355b3cf5bcc6dae58.
 * Keep runtime validation here dependency-free; never derive authority from a summary. */
export const COURSE_APP = 'stem-splitter' as const;
export const STEM_COURSE_ID = 'msh-245-the-american-musical-experience-fall-2026-01';
export const DEMO_COURSE_ID = 'cail-teaching-tools-demo';
export interface CourseAssignment {
  classId: string; className: string; term: string; section: string;
  memberId: string; displayName: string | null; displayNameSource: 'verified_profile' | 'unavailable';
  participant: boolean; owner: boolean; startsAt: string; checkedAt: string; expiresAt: string; revision: number;
}
export interface CourseCapabilities {
  instructorPanel: boolean; rosterRead: boolean; promptRead: boolean; promptWrite: boolean;
}
export interface CourseAssignmentV2 extends CourseAssignment {
  guestInstructor: boolean; capabilities: CourseCapabilities;
}
export interface CourseFailure { ok: false; code: 'invalid' | 'not_admitted' | 'not_enrolled' | 'scheduled' | 'expired' | 'revoked' | 'not_owner' | 'cursor_invalid' | 'stale_cursor'; retryable: false }
export type CourseAccessResult = (CourseAssignment & { ok: true }) | CourseFailure;
export interface CoursePage { ok: true; checkedAt: string; expiresAt: string; revision: number; nextCursor: string | null }
export interface CourseMember { memberId: string; displayName: string | null; displayNameSource: 'verified_profile' | 'unavailable'; startsAt: string; expiresAt: string }
export interface AdmissionCourseResolver {
  /** V1 remains available for unchanged consumers; this app authorizes with V2 only. */
  resolveCourseAccess?(input: { subject: string; app: typeof COURSE_APP; classId: string }): Promise<unknown>;
  listCourseAssignments?(input: { subject: string; app: typeof COURSE_APP; limit?: number; cursor?: string }): Promise<unknown>;
  listCourseRoster?(input: { subject: string; app: typeof COURSE_APP; classId: string; limit?: number; cursor?: string }): Promise<unknown>;
  resolveCourseAccessV2?(input: { subject: string; app: typeof COURSE_APP; classId: string }): Promise<unknown>;
  listCourseAssignmentsV2?(input: { subject: string; app: typeof COURSE_APP; limit?: number; cursor?: string }): Promise<unknown>;
  listCourseRosterV2?(input: { subject: string; app: typeof COURSE_APP; classId: string; limit?: number; cursor?: string }): Promise<unknown>;
}
const classIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const validClassId = (value: unknown): value is string => typeof value === 'string' && classIdPattern.test(value) && value !== 'search';
export const validMemberId = (value: unknown): value is string => typeof value === 'string' && /^stem-member-v1-[0-9a-f]{64}$/.test(value);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const bounded = (v: unknown, n: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= n && !/[\u0000-\u001f\u007f]/.test(v);
export function validClock(v: Record<string, unknown>, now = Date.now()): boolean {
  return date(v.checkedAt) && date(v.expiresAt) && Date.parse(v.checkedAt) <= now + 5000 &&
    now - Date.parse(v.checkedAt) < 30000 && Date.parse(v.expiresAt) > now && Date.parse(v.checkedAt) < Date.parse(v.expiresAt) &&
    Number.isSafeInteger(v.revision) && Number(v.revision) >= 0;
}
function memberFields(v: unknown): v is CourseMember {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return validMemberId(r.memberId) && date(r.startsAt) && date(r.expiresAt) &&
    ((r.displayName === null && r.displayNameSource === 'unavailable') ||
    (bounded(r.displayName, 160) && r.displayNameSource === 'verified_profile'));
}
export function validMember(v: unknown): v is CourseMember {
  return memberFields(v) && Object.keys(v).every(k=>['memberId','displayName','displayNameSource','startsAt','expiresAt'].includes(k));
}
function assignment(v: unknown, now: number, access: boolean, v2=false): v is CourseAssignment {
  if (!memberFields(v)) return false;
  const r = v as unknown as Record<string, unknown>;
  return validClassId(r.classId) && bounded(r.className, 200) && bounded(r.term, 120) && bounded(r.section, 120) &&
    typeof r.owner === 'boolean' && typeof r.participant === 'boolean' && (r.owner || r.participant || (v2 && r.guestInstructor === true)) &&
    Object.keys(r).every(k=>[...(access?['ok']:[]),...(v2?['guestInstructor','capabilities']:[]),'classId','className','term','section','memberId','displayName','displayNameSource','participant','owner','startsAt','checkedAt','expiresAt','revision'].includes(k)) &&
    (!access || r.ok === true) && validClock(r,now) && Date.parse(r.startsAt as string) <= Date.parse(r.checkedAt as string);
}
export const validAssignment = (v: unknown, now=Date.now()): v is CourseAssignment => assignment(v,now,false);
export const validAccess = (v: unknown, now=Date.now()): v is CourseAssignment & {ok:true} => assignment(v,now,true);
const capabilityNames = ['instructorPanel','rosterRead','promptRead','promptWrite'] as const;
export function validAssignmentV2(v: unknown, now=Date.now(), access=false): v is CourseAssignmentV2 {
  if (!v || typeof v !== 'object') return false;
  const r=v as Record<string,unknown>, c=r.capabilities;
  if (!assignment(v,now,access,true) || typeof r.guestInstructor !== 'boolean' || !c || typeof c !== 'object') return false;
  const capabilities=c as Record<string,unknown>;
  if (Object.keys(capabilities).length!==capabilityNames.length || !capabilityNames.every(key=>typeof capabilities[key]==='boolean')) return false;
  const all=capabilityNames.every(key=>capabilities[key]===true), none=capabilityNames.every(key=>capabilities[key]===false);
  if (r.guestInstructor===true) return r.classId===DEMO_COURSE_ID && r.owner===false && r.participant===false && all &&
    Date.parse(r.expiresAt as string)-Date.parse(r.checkedAt as string)===300000;
  if (r.owner===true) return all;
  if (r.participant===true) return none;
  return false;
}
export function validPage(v: unknown,now = Date.now()): v is CoursePage {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.ok === true && Object.keys(r).every(k=>['ok','checkedAt','expiresAt','revision','nextCursor',...('participants'in r?['classId','participants']:['assignments'])].includes(k)) && validClock(r,now) && (r.nextCursor === null ||
    (typeof r.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(r.nextCursor)));
}
export function validFailure(v: unknown): v is CourseFailure {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).length===3 && r.ok === false && r.retryable === false && ['invalid', 'not_admitted', 'not_enrolled', 'scheduled', 'expired', 'revoked', 'not_owner', 'cursor_invalid', 'stale_cursor'].includes(String(r.code));
}
