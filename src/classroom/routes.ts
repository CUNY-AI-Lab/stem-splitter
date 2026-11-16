import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { readBoundedJsonRequest } from '../http/bounded-request.ts';
import { buildSystemPromptPreview } from '../assistant/prompt.ts';
import { boundedRpc, courseIds, CourseError, courseErrorResponse } from './access.ts';
import { COURSE_APP, DEMO_COURSE_ID, validAssignmentV2, validFailure, validMember, validMemberId, validPage, type CourseAssignmentV2, type CourseMember } from './contract.ts';
import { conversationPage } from './conversations.ts';
import { coursePrompt, promptView, saveCoursePrompt } from './prompts.ts';
import liveRoutes from './live.ts';
import { rosterAppUsage } from './activity.ts';
import type { StudentUsage } from './activity.ts';

type State = { Bindings: Env; Variables: { principal?: AppPrincipal } };
const routes = new Hono<State>();
routes.use('*', async (c,next) => {
  if (c.env.AUTH_MODE !== 'cail' || !c.get('principal')) return c.json({ error:'Not found' },404);
  try { await next(); } catch(error) { if (error instanceof CourseError) return courseErrorResponse(error); throw error; }
});
function instructorPanel(p: AppPrincipal, courseId?: string) {
  if (!p.course?.capabilities.instructorPanel || (courseId && p.course.classId !== courseId)) throw new CourseError(403,'not_owner');
}
function capability(p: AppPrincipal, name: 'rosterRead'|'promptRead'|'promptWrite', courseId: string) {
  if (p.course?.classId !== courseId || !p.course.capabilities[name]) throw new CourseError(403,'not_owner');
}
function cursor(value: string | undefined): string | undefined {
  if (value!==undefined && !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new CourseError(400,'cursor_invalid');
  return value;
}
async function body(request: Request): Promise<Record<string,unknown>> {
  try { const value = await readBoundedJsonRequest(request,16*1024); if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value as Record<string,unknown>; }
  catch { throw new CourseError(400,'invalid_request'); }
}
routes.get('/courses', async c => {
  const p = c.get('principal')!;
  if (!c.env.ADMISSION_RESOLVER?.listCourseAssignmentsV2) throw new CourseError(503,'course_authority_unavailable');
  const value = await boundedRpc(() => c.env.ADMISSION_RESOLVER!.listCourseAssignmentsV2!({ subject:p.subject,app:COURSE_APP,includeAdministrator:true,limit:100,cursor:cursor(c.req.query('cursor')) }));
  if (validFailure(value)) throw new CourseError(value.code.includes('cursor')?409:403,value.code);
  const result = value as { assignments?: unknown };
  if (!validPage(value) || !Array.isArray(result.assignments) || result.assignments.length>100 || !result.assignments.every(row=>validAssignmentV2(row))) throw new CourseError(503,'course_authority_unavailable');
  const allowed = courseIds(c.env);
  return c.json({ courses:(result.assignments as CourseAssignmentV2[]).filter(row=>allowed.includes(row.classId)), nextCursor:value.nextCursor });
});
// The middleware resolves this exact class for the current identity on every
// request. Clients must not keep using capabilities from an old discovery page.
routes.get('/courses/:courseId', c => {
  const course = c.get('principal')!.course;
  if (!course || course.classId !== c.req.param('courseId')) throw new CourseError(403, 'course_not_available');
  c.header('Cache-Control', 'private, no-store');
  return c.json({ course });
});
routes.get('/courses/:courseId/roster',async c=>{
  const p=c.get('principal')!; const courseId=c.req.param('courseId'); capability(p,'rosterRead',courseId);
  if (!c.env.ADMISSION_RESOLVER?.listCourseRosterV2) throw new CourseError(503,'course_authority_unavailable');
  const value=await boundedRpc(()=>c.env.ADMISSION_RESOLVER!.listCourseRosterV2!({subject:p.subject,app:COURSE_APP,classId:courseId,includeAdministrator:true,limit:40,cursor:cursor(c.req.query('cursor'))}));
  if (validFailure(value)) throw new CourseError(value.code.includes('cursor')?409:403,value.code);
  const result=value as {classId?:unknown;participants?:unknown};
  if (!validPage(value)||result.classId!==courseId||!Array.isArray(result.participants)||result.participants.length>100||!result.participants.every(validMember)) throw new CourseError(503,'course_authority_unavailable');
  const participants=result.participants as CourseMember[];
  // One aggregate query for the whole authority page; students with no work remain present.
  const counts=participants.length ? (await c.env.DB.prepare(`SELECT c.member_id,COUNT(*) AS total,SUM(j.status='done') AS completed,SUM(j.created_at>datetime('now','-90 days') AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)) AS retained
    FROM job_courses c JOIN jobs j ON j.id=c.job_id WHERE c.course_id=? AND c.member_id IN (${participants.map(()=>'?').join(',')}) GROUP BY c.member_id`)
    .bind(courseId,...participants.map(p=>p.memberId)).all<{member_id:string;total:number;completed:number;retained:number}>()).results : [];
  const byMember=new Map(counts.map(row=>[row.member_id,row]));
  let appUsage=new Map<string,StudentUsage>(),appUsageStatus:'available'|'unavailable'='available';
  try { appUsage=await rosterAppUsage(c.env,courseId,participants.map(row=>row.memberId)); }
  catch { appUsageStatus='unavailable'; }
  return c.json({course:p.course,appUsageStatus,activityScope:{splits:'recorded-history',guideTurns:'recorded-history',recordedVisitsDays:30,visitsCapture:'best_effort'},
    participants:participants.map(row=>({...row,splitCount:byMember.get(row.memberId)?.total??0,completedCount:byMember.get(row.memberId)?.completed??0,retainedCount:byMember.get(row.memberId)?.retained??0,appUsage:appUsage.get(row.memberId)??null})),
    demonstrationParticipants:courseId===DEMO_COURSE_ID?[{displayName:'Sample student',splitCount:3,retainedCount:2,demonstration:true}]:[],nextCursor:value.nextCursor});
});
const NOTE_PAGE_SIZE=20;
type CourseNote={id:string;jobId:string;atSeconds:number;text:string;authorSubject:string|null;authorName:string|null};
function requireParticipantJobs(p:AppPrincipal,courseId:string,memberId:string){
  if(!validMemberId(memberId))throw new CourseError(404,'not_found');
  const course=p.course?.classId===courseId?p.course:null;
  if(!(course?.participant&&course.memberId===memberId)&&!course?.capabilities.instructorPanel)throw new CourseError(404,'not_found');
}
function notePage(rows:CourseNote[],courseId:string,memberId:string,jobId:string){
  const page=rows.slice(0,NOTE_PAGE_SIZE),last=page.at(-1);
  return {annotations:page.map(note=>({id:note.id,atSeconds:note.atSeconds,text:note.text,
    authorName:note.authorSubject?(note.authorName||'Student'):'Author unavailable',canDelete:false})),
    nextCursor:rows.length>NOTE_PAGE_SIZE&&last?btoa(JSON.stringify({courseId,memberId,jobId,atSeconds:last.atSeconds,id:last.id})):null};
}
routes.get('/courses/:courseId/participants/:memberId/jobs/:jobId/notes',async c=>{
  const courseId=c.req.param('courseId'),memberId=c.req.param('memberId'),jobId=c.req.param('jobId');
  requireParticipantJobs(c.get('principal')!,courseId,memberId);
  if(!/^[\w-]{1,128}$/.test(jobId))throw new CourseError(404,'not_found');
  const params=new URL(c.req.url).searchParams,encoded=params.get('cursor');
  let after:{atSeconds:number;id:string}|null=null;
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1)throw new CourseError(400,'cursor_invalid');
  if(encoded!==null){try{
    if(encoded.length>1024||!/^[-A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error();
    const value=JSON.parse(atob(encoded));
    if(Object.keys(value).sort().join(',')!=='atSeconds,courseId,id,jobId,memberId'||value.courseId!==courseId||value.memberId!==memberId||value.jobId!==jobId
      ||typeof value.atSeconds!=='number'||!Number.isFinite(value.atSeconds)||value.atSeconds<0||typeof value.id!=='string'||!/^[\w-]{1,128}$/.test(value.id))throw new Error();
    after=value;
  }catch{throw new CourseError(400,'cursor_invalid');}}
  const retained=await c.env.DB.prepare(`SELECT 1 FROM job_courses jc JOIN jobs j ON j.id=jc.job_id
    WHERE jc.course_id=? AND jc.member_id=? AND j.id=? AND j.status='done' AND j.created_at>datetime('now','-90 days')
      AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)`).bind(courseId,memberId,jobId).first();
  if(!retained)throw new CourseError(404,'not_found');
  const {results}=await c.env.DB.prepare(`SELECT a.id,a.job_id AS jobId,a.at_seconds AS atSeconds,a.text,a.author_subject AS authorSubject,a.author_name AS authorName
    FROM annotations a JOIN jobs j ON j.id=a.job_id JOIN job_courses jc ON jc.job_id=j.id
    WHERE jc.course_id=? AND jc.member_id=? AND j.id=? AND j.status='done' AND j.created_at>datetime('now','-90 days')
      AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)
      AND (? IS NULL OR a.at_seconds>? OR (a.at_seconds=? AND a.id>?))
    ORDER BY a.at_seconds,a.id LIMIT 21`).bind(courseId,memberId,jobId,after?.atSeconds??null,after?.atSeconds??0,after?.atSeconds??0,after?.id??'').all<CourseNote>();
  c.header('Cache-Control','private, no-store');
  return c.json({courseId,memberId,jobId,...notePage(results,courseId,memberId,jobId)});
});
routes.get('/courses/:courseId/participants/:memberId/jobs',async c=>{
  const p=c.get('principal')!,courseId=c.req.param('courseId'),memberId=c.req.param('memberId');
  requireParticipantJobs(p,courseId,memberId);
  const after=c.req.query('cursor'); let before='';
  if (after) { try { const v=JSON.parse(atob(after)); if(v.courseId!==courseId||v.memberId!==memberId||typeof v.id!=='string'||!/^[\w-]{1,128}$/.test(v.id)) throw new Error(); before=v.id; } catch {throw new CourseError(400,'cursor_invalid');} }
  const {results}=await c.env.DB.prepare(`SELECT j.id,j.filename,j.model,j.status,j.created_at AS createdAt,
      (j.created_at>datetime('now','-90 days') AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)) AS retained
    FROM job_courses c JOIN jobs j ON j.id=c.job_id WHERE c.course_id=? AND c.member_id=? AND (?='' OR j.id<?) ORDER BY j.id DESC LIMIT 41`).bind(courseId,memberId,before,before).all<{id:string;status:string;retained:number}>();
  const jobs=results.slice(0,40),eligible=jobs.filter(row=>row.status==='done'&&row.retained).map(row=>row.id);
  const notes=eligible.length?(await c.env.DB.prepare(`SELECT * FROM (
    SELECT a.id,a.job_id AS jobId,a.at_seconds AS atSeconds,a.text,a.author_subject AS authorSubject,a.author_name AS authorName,
      ROW_NUMBER() OVER(PARTITION BY a.job_id ORDER BY a.at_seconds,a.id) AS noteRank
    FROM annotations a JOIN jobs j ON j.id=a.job_id JOIN job_courses jc ON jc.job_id=j.id
    WHERE jc.course_id=? AND jc.member_id=? AND a.job_id IN (${eligible.map(()=>'?').join(',')}) AND j.status='done'
      AND j.created_at>datetime('now','-90 days') AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)
    ) WHERE noteRank<=21 ORDER BY jobId,atSeconds,id`).bind(courseId,memberId,...eligible).all<CourseNote>()).results:[];
  const byJob=new Map<string,CourseNote[]>();
  for(const note of notes){const rows=byJob.get(note.jobId)??[];rows.push(note);byJob.set(note.jobId,rows);}
  c.header('Cache-Control','private, no-store');
  return c.json({courseId,memberId,jobs:jobs.map(row=>{const page=notePage(byJob.get(row.id)??[],courseId,memberId,row.id);return {...row,annotations:page.annotations,annotationsNextCursor:page.nextCursor};}),nextCursor:results.length>40?btoa(JSON.stringify({courseId,memberId,id:results[39].id})):null});
});
routes.get('/courses/:courseId/jobs/:jobId/conversation',async c=>{
  instructorPanel(c.get('principal')!,c.req.param('courseId'));
  const job=await c.env.DB.prepare(`SELECT o.subject FROM job_courses jc JOIN jobs j ON j.id=jc.job_id JOIN job_owners o ON o.job_id=j.id
    WHERE jc.course_id=? AND j.id=? AND j.created_at>datetime('now','-90 days')`).bind(c.req.param('courseId'),c.req.param('jobId')).first<{subject:string}>();
  if(!job) throw new CourseError(404,'not_found');
  const after=Number(c.req.query('cursor')??0),revision=c.req.query('revision');
  if(!Number.isSafeInteger(after)||after<0||(revision!==undefined&&!/^\d+$/.test(revision))) throw new CourseError(400,'cursor_invalid');
  return c.json({...await conversationPage(c.env,c.req.param('jobId'),job.subject,after,revision===undefined?undefined:Number(revision)),readOnly:true});
});
routes.get('/courses/:courseId/prompt',async c=>{capability(c.get('principal')!,'promptRead',c.req.param('courseId'));return c.json(await promptView(c.env,c.req.param('courseId')));});
routes.get('/courses/:courseId/prompt/history',async c=>{capability(c.get('principal')!,'promptRead',c.req.param('courseId'));const before=Number(c.req.query('before'));if(!Number.isSafeInteger(before)||before<1)throw new CourseError(400,'cursor_invalid');return c.json(await promptView(c.env,c.req.param('courseId'),before));});
routes.get('/courses/:courseId/prompt/preview',async c=>{capability(c.get('principal')!,'promptRead',c.req.param('courseId'));return c.json({prompt:buildSystemPromptPreview((await coursePrompt(c.env,c.req.param('courseId'))).amendment)});});
routes.put('/courses/:courseId/prompt',async c=>{const p=c.get('principal')!;capability(p,'promptWrite',c.req.param('courseId'));const result=await saveCoursePrompt(c.env,c.req.param('courseId'),p.subject,await body(c.req.raw));return c.json(result,result.status);});

type Folder={id:string;course_id:string;name:string;created_by:string;creator_subject:string;permission:string;revision:number};
function canManageFolder(f:Folder,p:AppPrincipal):boolean{
  return p.course?.classId===f.course_id&&(p.course.capabilities.instructorPanel||f.creator_subject===p.subject);
}
function canContributeFolder(f:Folder,p:AppPrincipal):boolean{
  return p.course?.classId===f.course_id&&p.course.participant===true&&f.permission!=='private'&&!canManageFolder(f,p);
}
function folderView(f:Folder,p:AppPrincipal){
  return {id:f.id,name:f.name,permission:f.permission,revision:f.revision,
    canManage:canManageFolder(f,p),canContribute:canContributeFolder(f,p)};
}
async function folder(env:Env,p:AppPrincipal,id:string,courseId:string):Promise<Folder>{
  const row=await env.DB.prepare('SELECT * FROM course_folders WHERE id=? AND course_id=?').bind(id,courseId).first<Folder>();
  if(!row||p.course?.classId!==courseId||(!canManageFolder(row,p)&&!canContributeFolder(row,p)))throw new CourseError(404,'not_found');return row;
}
routes.get('/courses/:courseId/folders',async c=>{
  const p=c.get('principal')!,courseId=c.req.param('courseId');
  if(p.course?.classId!==courseId)throw new CourseError(404,'not_found');
  const {results}=await c.env.DB.prepare(`SELECT id,course_id,name,created_by,creator_subject,permission,revision FROM course_folders
    WHERE course_id=? AND (permission<>'private' OR creator_subject=? OR ?=1) ORDER BY created_at,id LIMIT 100`)
    .bind(courseId,p.subject,p.course.capabilities.instructorPanel?1:0).all<Folder>();
  return c.json({folders:results.map(row=>folderView(row,p))});
});
routes.post('/courses/:courseId/folders',async c=>{
  const p=c.get('principal')!,courseId=c.req.param('courseId');
  if(p.course?.classId!==courseId||(!p.course.participant&&!p.course.capabilities.instructorPanel))throw new CourseError(403,'not_owner');
  const b=await body(c.req.raw);const name=typeof b.name==='string'?b.name.trim():'';
  if(!name||name.length>80)throw new CourseError(400,'invalid_folder');const id=crypto.randomUUID();
  const created=await c.env.DB.prepare('INSERT INTO course_folders(id,course_id,name,created_by,creator_subject) VALUES(?,?,?,?,?)')
    .bind(id,courseId,name,p.subject,p.subject).run();
  const record:Folder={id,course_id:courseId,name,created_by:p.subject,creator_subject:p.subject,permission:'private',revision:0};
  if(!created.meta.changes)throw new CourseError(503,'folder_unavailable');
  return c.json({folder:folderView(record,p)});
});
routes.get('/courses/:courseId/folders/:id',async c=>{
  const p=c.get('principal')!,f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));
  const {results}=await c.env.DB.prepare(`SELECT i.job_id AS jobId,i.filename,i.model,i.added_by,
    (j.id IS NOT NULL AND j.created_at>datetime('now','-90 days') AND j.status='done') AS available
    FROM course_folder_items i LEFT JOIN jobs j ON j.id=i.job_id LEFT JOIN job_courses jc ON jc.job_id=j.id
    WHERE i.folder_id=? AND (jc.course_id=? OR j.id IS NULL) ORDER BY i.added_at,i.job_id`).bind(f.id,f.course_id).all();
  const canManage=canManageFolder(f,p),canContribute=canContributeFolder(f,p);
  return c.json({folder:folderView(f,p),items:results.map(({added_by,...item}:any)=>({...item,canRemove:canManage||(canContribute&&added_by===p.subject)}))});
});
routes.put('/courses/:courseId/folders/:id',async c=>{
  const p=c.get('principal')!,f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));
  if(!canManageFolder(f,p))throw new CourseError(403,'not_owner');
  const b=await body(c.req.raw);
  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 80 || !Number.isSafeInteger(b.revision) || b.permission !== undefined) throw new CourseError(400,'invalid_folder');
    if (f.revision !== b.revision) throw new CourseError(409,'folder_changed');
    if (name === f.name) return c.json({ok:true,revision:f.revision});
    const renamed = await c.env.DB.prepare('UPDATE course_folders SET name=?,revision=revision+1 WHERE id=? AND course_id=? AND revision=?').bind(name,f.id,f.course_id,b.revision).run();
    if (!renamed.meta.changes) throw new CourseError(409,'folder_changed');
    return c.json({ok:true,revision:f.revision+1});
  }
  if(!['private','read','comment'].includes(String(b.permission))||!Number.isSafeInteger(b.revision))throw new CourseError(400,'invalid_grant');
  const result=await c.env.DB.prepare('UPDATE course_folders SET permission=?,revision=revision+1,created_by=? WHERE id=? AND course_id=? AND revision=?').bind(b.permission,p.subject,f.id,f.course_id,b.revision).run();
  if(!result.meta.changes)throw new CourseError(409,'folder_changed');return c.json({ok:true,revision:Number(b.revision)+1,url:`${c.env.APP_BASE_PATH || ''}/classroom.html?course=${encodeURIComponent(f.course_id)}&folder=${f.id}`});
});
routes.post('/courses/:courseId/folders/:id/items',async c=>{
  const p=c.get('principal')!,f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));
  const manager=canManageFolder(f,p),contributor=canContributeFolder(f,p);
  if(!manager&&!contributor)throw new CourseError(403,'not_owner');
  const b=await body(c.req.raw);
  if(typeof b.jobId!=='string')throw new CourseError(400,'invalid_job');
  const result=await c.env.DB.prepare(`INSERT INTO course_folder_items(folder_id,job_id,filename,model,added_by)
    SELECT ?,j.id,j.filename,COALESCE(j.model,'htdemucs_ft'),? FROM jobs j JOIN job_courses jc ON jc.job_id=j.id
      JOIN job_owners o ON o.job_id=j.id
      JOIN course_folders current_folder ON current_folder.id=? AND current_folder.course_id=?
    WHERE j.id=? AND jc.course_id=? AND j.status='done' AND j.created_at>datetime('now','-90 days')
      AND (?=1 OR (o.subject=? AND (current_folder.creator_subject=? OR current_folder.permission IN ('read','comment'))))
    ON CONFLICT(folder_id,job_id) DO UPDATE SET job_id=excluded.job_id`)
    .bind(f.id,p.subject,f.id,f.course_id,b.jobId,f.course_id,p.course?.capabilities.instructorPanel?1:0,p.subject,p.subject).run();
  if(!result.meta.changes)throw new CourseError(404,'not_found');return c.json({ok:true});
});
routes.delete('/courses/:courseId/folders/:id/items/:jobId',async c=>{
  const p=c.get('principal')!,f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));
  const manager=canManageFolder(f,p),contributor=canContributeFolder(f,p);
  if(!manager&&!contributor)throw new CourseError(403,'not_owner');
  const result=await c.env.DB.prepare(`DELETE FROM course_folder_items WHERE folder_id=? AND job_id=?
    AND EXISTS(SELECT 1 FROM course_folders current_folder WHERE current_folder.id=course_folder_items.folder_id
      AND current_folder.course_id=? AND (?=1 OR current_folder.creator_subject=? OR current_folder.permission IN ('read','comment')))
    AND (?=1 OR added_by=?)`)
    .bind(f.id,c.req.param('jobId'),f.course_id,p.course?.capabilities.instructorPanel?1:0,p.subject,manager?1:0,p.subject).run();
  if(!manager&&!result.meta.changes)throw new CourseError(404,'not_found');
  return c.json({ok:true});
});
// Deleting a folder leaves its splits in the class. Its sharing history stays immutable.
routes.delete('/courses/:courseId/folders/:id',async c=>{
  const p=c.get('principal')!,f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));
  if(!canManageFolder(f,p))throw new CourseError(403,'not_owner');
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM course_folder_items WHERE folder_id=?').bind(f.id),c.env.DB.prepare('DELETE FROM course_folders WHERE id=? AND course_id=?').bind(f.id,f.course_id)]);
  return c.json({ok:true});
});
routes.route('/', liveRoutes);
export default routes;
