import type { Env } from './env.ts';
import type { AppPrincipal } from './identity.ts';
import { boundedRpc, cleanDisplayName, courseIds, resolveCourse, CourseError } from './classroom/access.ts';
import { COURSE_APP, validAssignmentV2, validPage } from './classroom/contract.ts';
import { usageBySubject } from './classroom/activity.ts';

export async function rememberDisplayName(env:Env,subject:string,value:unknown) {
  const name=cleanDisplayName(value);
  if(name==='Student'||/^cail-[0-9a-f]{32}$/.test(name))return;
  await env.DB.prepare(`INSERT INTO account_display_names(subject,display_name,updated_at) VALUES(?,?,?)
    ON CONFLICT(subject) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at
    WHERE display_name<>excluded.display_name OR updated_at<?`).bind(subject,name,Date.now(),Date.now()-86400000).run();
}
export async function teachingCourses(env:Env,actor:AppPrincipal):Promise<string[]> {
  if(!actor)throw new CourseError(403,'not_owner');
  if(actor.role==='admin')return [];
  if(actor.role!=='instructor')throw new CourseError(403,'not_owner');
  const owned:string[]=[];
  for(const id of courseIds(env)) {
    try {if((await resolveCourse(env,actor.subject,id)).owner)owned.push(id);}
    catch(error){if(!(error instanceof CourseError)||error.status===503)throw error;}
  }
  return owned;
}
async function profile(env:Env,subject:string,classes:string[],requireParticipant:boolean) {
  const cached=await env.DB.prepare('SELECT display_name,updated_at FROM account_display_names WHERE subject=?').bind(subject).first<{display_name:string;updated_at:number}>();
  let name=cached?.display_name??null,allowed=!requireParticipant;
  if(!requireParticipant&&cached&&cached.updated_at>Date.now()-86400000)return {allowed,displayName:cached.display_name};
  // Course profiles backfill names for people who signed in before this release.
  for(const id of classes) {
    try {
      const course=await resolveCourse(env,subject,id);
      if(course.participant)allowed=true;
      if(course.displayNameSource==='verified_profile') {
        name=cleanDisplayName(course.displayName);
        await rememberDisplayName(env,subject,name);
      }
      if(allowed&&name)break;
    } catch(error){if(requireParticipant&&(!(error instanceof CourseError)||error.status===503))throw error;}
  }
  // An administrator may review older app accounts whose original course ended.
  // Another current assignment can supply their verified name without granting access.
  if(allowed&&!name&&env.ADMISSION_RESOLVER?.listCourseAssignmentsV2) {
    try {
      const value=await boundedRpc(()=>env.ADMISSION_RESOLVER!.listCourseAssignmentsV2!({subject,app:COURSE_APP,limit:100}));
      if(validPage(value)&&'assignments' in value&&Array.isArray(value.assignments)&&value.assignments.length<=100&&value.assignments.every(row=>validAssignmentV2(row))) {
        const verified=value.assignments.find(row=>row.displayNameSource==='verified_profile');
        if(verified){name=cleanDisplayName(verified.displayName);await rememberDisplayName(env,subject,name);}
      }
    } catch { /* A missing profile leaves existing review permissions unchanged. */ }
  }
  return {allowed,displayName:name??'Name unavailable'};
}
// Bound each authority lookup page; a raw-account cursor also advances through
// pages containing no currently eligible course members.
const ACCOUNT_PAGE_SIZE = 25;
function accountCursor(value?: string): number | null {
  if (value === undefined) return null;
  // The raw page boundary must not disclose a filtered account's subject/name.
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CourseError(400, 'invalid_cursor');
  return Number(value);
}
export async function namedUsers(env:Env,actor:AppPrincipal,cursor?:string) {
  const before=accountCursor(cursor);
  const classes=actor.role==='admin'?courseIds(env):await teachingCourses(env,actor);
  const query = env.DB.prepare(`SELECT rowid AS account_cursor,subject,role,disabled,role_expires_at,revision,created_at AS firstSeenAt FROM app_users
    ${before !== null ? 'WHERE rowid < ?' : ''}
    ORDER BY rowid DESC LIMIT ?`);
  const {results}=await (before !== null ? query.bind(before,ACCOUNT_PAGE_SIZE+1)
    : query.bind(ACCOUNT_PAGE_SIZE+1)).all<{subject:string;role:string;disabled:number;account_cursor:number}>();
  const page=results.slice(0,ACCOUNT_PAGE_SIZE);
  const out:Array<Record<string,unknown>&{subject:string;displayName:string}>=[];
  let next=0;
  await Promise.all(Array.from({length:Math.min(6,page.length)},async()=>{
    while(next<page.length){
      const {account_cursor,...user}=page[next++];
      const details=await profile(env,user.subject,classes,actor.role!=='admin'&&user.subject!==actor.subject);
      if(details.allowed)out.push({...user,displayName:details.displayName});
    }
  }));
  const last=page.at(-1);
  const nextCursor=results.length>ACCOUNT_PAGE_SIZE&&last ? String(last.account_cursor) : null;
  return {users:out.sort((a,b)=>a.displayName.localeCompare(b.displayName)||a.subject.localeCompare(b.subject)),nextCursor,complete:nextCursor===null};
}
export async function requireStudentReview(env:Env,actor:AppPrincipal,subject:string) {
  if(!/^cail-[0-9a-f]{32}$/.test(subject)||!await env.DB.prepare('SELECT 1 FROM app_users WHERE subject=?').bind(subject).first())throw new CourseError(404,'not_found');
  const classes=await teachingCourses(env,actor);
  const person=await profile(env,subject,actor.role==='admin'?courseIds(env):classes,actor.role!=='admin'&&subject!==actor.subject);
  if(!person.allowed)throw new CourseError(404,'not_found');
  return person;
}
export async function studentActivity(env:Env,actor:AppPrincipal,cursor?:string) {
  if(!actor||!['admin','instructor'].includes(actor.role))throw new CourseError(403,'not_owner');
  const page=await namedUsers(env,actor,cursor);
  const users=page.users;
  const usage=await usageBySubject(env,users.map(user=>user.subject));
  return {students:users.map(user=>({subject:user.subject,displayName:user.displayName,firstSeenAt:user.firstSeenAt,...usage.get(user.subject)!})),nextCursor:page.nextCursor,complete:page.complete};
}

export async function guestActivity(env:Env,actor:AppPrincipal) {
  if(!actor||!['admin','instructor'].includes(actor.role))throw new CourseError(403,'not_owner');
  const since=Date.now()-30*86400000;
  const [sessions,splits,claims]=await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM guest_sessions WHERE created_at>=?').bind(since).first<{n:number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS attempts,SUM(state='succeeded') AS completed,COUNT(DISTINCT subject) AS sessions
      FROM app_operations WHERE quota_class='guest' AND kind='split' AND created_at>=?`).bind(since).first<{attempts:number;completed:number|null;sessions:number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM guest_job_claims c JOIN app_operations o ON o.job_id=c.job_id
      AND o.subject=c.guest_subject WHERE o.kind='split' AND o.state='succeeded' AND o.created_at>=?`).bind(since).first<{n:number}>(),
  ]);
  if(!sessions||!splits||!claims)throw new Error('Guest activity unavailable');
  return {days:30,browserSessions:sessions.n,splitAttempts:splits.attempts,completedSplits:splits.completed??0,
    sessionsWithSplits:splits.sessions,splitsSavedToAccounts:claims.n};
}
