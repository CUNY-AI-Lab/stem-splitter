import type { Env } from './env.ts';
import type { AppPrincipal } from './identity.ts';
import { cleanDisplayName, courseIds, resolveCourse, CourseError } from './classroom/access.ts';
import { fingerprint } from './reliability/ledger.ts';

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
  return {allowed,displayName:name??'Name unavailable'};
}
export async function namedUsers(env:Env,actor:AppPrincipal,review=false) {
  const classes=actor.role==='admin'?courseIds(env):await teachingCourses(env,actor);
  const {results}=await env.DB.prepare(`SELECT subject,role,disabled,role_expires_at,revision FROM app_users ORDER BY created_at DESC,subject LIMIT 200`).all<{subject:string;role:string;disabled:number}>();
  const out:Array<Record<string,unknown>&{subject:string;displayName:string}>=[];
  let next=0;
  await Promise.all(Array.from({length:Math.min(6,results.length)},async()=>{
    while(next<results.length){
      const user=results[next++];
      if(review&&user.subject===actor.subject)continue;
      const details=await profile(env,user.subject,classes,actor.role!=='admin');
      if(details.allowed)out.push({...user,displayName:details.displayName});
    }
  }));
  return out.sort((a,b)=>a.displayName.localeCompare(b.displayName)||a.subject.localeCompare(b.subject));
}
export async function requireStudentReview(env:Env,actor:AppPrincipal,subject:string) {
  if(!/^cail-[0-9a-f]{32}$/.test(subject)||!await env.DB.prepare('SELECT 1 FROM app_users WHERE subject=?').bind(subject).first())throw new CourseError(404,'not_found');
  const classes=await teachingCourses(env,actor);
  const person=await profile(env,subject,actor.role==='admin'?courseIds(env):classes,actor.role!=='admin');
  if(!person.allowed)throw new CourseError(404,'not_found');
  return person;
}
export async function studentActivity(env:Env,actor:AppPrincipal) {
  if(!actor||!['admin','instructor'].includes(actor.role))throw new CourseError(403,'not_owner');
  const users=await namedUsers(env,actor,true);
  const {results}=await env.DB.prepare(`SELECT subject,COUNT(*) AS runs,SUM(completed) AS completed FROM (
    SELECT o.subject,j.id,j.status='done' AS completed FROM job_owners o JOIN jobs j ON j.id=o.job_id
      WHERE NOT EXISTS(SELECT 1 FROM app_operations op WHERE op.job_id=j.id AND op.kind='split')
    UNION ALL SELECT subject,id,state='succeeded' FROM app_operations WHERE kind='split' AND quota_class='member'
  ) GROUP BY subject`).all<{subject:string;runs:number;completed:number}>();
  const counts=new Map(results.map(row=>[row.subject,row]));
  const since=Date.now()-30*86400000;
  const visits=(await env.DB.prepare(`SELECT actor_key,COUNT(*) AS visits FROM usage_events
    WHERE event_type='session_start' AND source='client' AND actor_class='member' AND at>=? GROUP BY actor_key`).bind(since).all<{actor_key:string;visits:number}>()).results;
  const byActor=new Map(visits.map(row=>[row.actor_key,row.visits]));
  return await Promise.all(users.map(async user=>{
    let recordedVisits=0;
    for(let day=0;day<=30;day++)recordedVisits+=byActor.get(await fingerprint(['usage-actor-v1',new Date(Date.now()-day*86400000).toISOString().slice(0,10),user.subject]))??0;
    return {subject:user.subject,displayName:user.displayName,runs:counts.get(user.subject)?.runs??0,completed:counts.get(user.subject)?.completed??0,recordedVisits};
  }));
}
