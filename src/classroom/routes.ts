import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { readBoundedJsonRequest } from '../http/bounded-request.ts';
import { buildSystemPromptPreview } from '../assistant/prompt.ts';
import { boundedRpc, courseIds, CourseError, courseErrorResponse } from './access.ts';
import { COURSE_APP, validAssignment, validFailure, validMember, validMemberId, validPage, type CourseAssignment, type CourseMember } from './contract.ts';
import { conversationPage } from './conversations.ts';
import { coursePrompt, promptView, saveCoursePrompt } from './prompts.ts';

type State = { Bindings: Env; Variables: { principal?: AppPrincipal } };
const routes = new Hono<State>();
routes.use('*', async (c,next) => {
  if (c.env.AUTH_MODE !== 'cail' || !c.get('principal')) return c.json({ error:'Not found' },404);
  try { await next(); } catch(error) { if (error instanceof CourseError) return courseErrorResponse(error); throw error; }
});
function owner(p: AppPrincipal) { if (!p.course?.owner) throw new CourseError(403,'not_owner'); }
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
  if (!c.env.ADMISSION_RESOLVER?.listCourseAssignments) throw new CourseError(503,'course_authority_unavailable');
  const value = await boundedRpc(() => c.env.ADMISSION_RESOLVER!.listCourseAssignments!({ subject:p.subject,app:COURSE_APP,limit:100,cursor:cursor(c.req.query('cursor')) }));
  if (validFailure(value)) throw new CourseError(value.code.includes('cursor')?409:403,value.code);
  const result = value as { assignments?: unknown };
  if (!validPage(value) || !Array.isArray(result.assignments) || result.assignments.length>100 || !result.assignments.every(row=>validAssignment(row))) throw new CourseError(503,'course_authority_unavailable');
  const allowed = courseIds(c.env);
  return c.json({ courses:(result.assignments as CourseAssignment[]).filter(row=>allowed.includes(row.classId)), nextCursor:value.nextCursor });
});
routes.get('/courses/:courseId/roster',async c=>{
  const p=c.get('principal')!; owner(p);
  if (!c.env.ADMISSION_RESOLVER?.listCourseRoster) throw new CourseError(503,'course_authority_unavailable');
  const courseId=c.req.param('courseId');
  const value=await boundedRpc(()=>c.env.ADMISSION_RESOLVER!.listCourseRoster!({subject:p.subject,app:COURSE_APP,classId:courseId,limit:40,cursor:cursor(c.req.query('cursor'))}));
  if (validFailure(value)) throw new CourseError(value.code.includes('cursor')?409:403,value.code);
  const result=value as {classId?:unknown;participants?:unknown};
  if (!validPage(value)||result.classId!==courseId||!Array.isArray(result.participants)||result.participants.length>100||!result.participants.every(validMember)) throw new CourseError(503,'course_authority_unavailable');
  const participants=result.participants as CourseMember[];
  // One aggregate query for the whole authority page; students with no work remain present.
  const counts=participants.length ? (await c.env.DB.prepare(`SELECT c.member_id,COUNT(*) AS total,SUM(j.created_at>datetime('now','-90 days')) AS retained
    FROM job_courses c JOIN jobs j ON j.id=c.job_id WHERE c.course_id=? AND c.member_id IN (${participants.map(()=>'?').join(',')}) GROUP BY c.member_id`)
    .bind(courseId,...participants.map(p=>p.memberId)).all<{member_id:string;total:number;retained:number}>()).results : [];
  const byMember=new Map(counts.map(row=>[row.member_id,row]));
  return c.json({course:p.course,participants:participants.map(row=>({...row,splitCount:byMember.get(row.memberId)?.total??0,retainedCount:byMember.get(row.memberId)?.retained??0})),nextCursor:value.nextCursor});
});
routes.get('/courses/:courseId/participants/:memberId/jobs',async c=>{
  owner(c.get('principal')!);
  const courseId=c.req.param('courseId'),memberId=c.req.param('memberId');
  if (!validMemberId(memberId)) throw new CourseError(404,'not_found');
  const after=c.req.query('cursor'); let before='';
  if (after) { try { const v=JSON.parse(atob(after)); if(v.courseId!==courseId||v.memberId!==memberId||typeof v.id!=='string'||!/^[\w-]{1,128}$/.test(v.id)) throw new Error(); before=v.id; } catch {throw new CourseError(400,'cursor_invalid');} }
  const {results}=await c.env.DB.prepare(`SELECT j.id,j.filename,j.model,j.status,j.created_at AS createdAt,(j.created_at>datetime('now','-90 days')) AS retained
    FROM job_courses c JOIN jobs j ON j.id=c.job_id WHERE c.course_id=? AND c.member_id=? AND (?='' OR j.id<?) ORDER BY j.id DESC LIMIT 41`).bind(courseId,memberId,before,before).all<{id:string}>();
  return c.json({jobs:results.slice(0,40),nextCursor:results.length>40?btoa(JSON.stringify({courseId,memberId,id:results[39].id})):null});
});
routes.get('/courses/:courseId/jobs/:jobId/conversation',async c=>{
  owner(c.get('principal')!);
  const job=await c.env.DB.prepare(`SELECT o.subject FROM job_courses jc JOIN jobs j ON j.id=jc.job_id JOIN job_owners o ON o.job_id=j.id
    WHERE jc.course_id=? AND j.id=? AND j.created_at>datetime('now','-90 days')`).bind(c.req.param('courseId'),c.req.param('jobId')).first<{subject:string}>();
  if(!job) throw new CourseError(404,'not_found');
  const after=Number(c.req.query('cursor')??0),revision=c.req.query('revision');
  if(!Number.isSafeInteger(after)||after<0||(revision!==undefined&&!/^\d+$/.test(revision))) throw new CourseError(400,'cursor_invalid');
  return c.json({...await conversationPage(c.env,c.req.param('jobId'),job.subject,after,revision===undefined?undefined:Number(revision)),readOnly:true});
});
routes.get('/courses/:courseId/prompt',async c=>{owner(c.get('principal')!);return c.json(await promptView(c.env,c.req.param('courseId')));});
routes.get('/courses/:courseId/prompt/history',async c=>{owner(c.get('principal')!);const before=Number(c.req.query('before'));if(!Number.isSafeInteger(before)||before<1)throw new CourseError(400,'cursor_invalid');return c.json(await promptView(c.env,c.req.param('courseId'),before));});
routes.get('/courses/:courseId/prompt/preview',async c=>{owner(c.get('principal')!);return c.json({prompt:buildSystemPromptPreview((await coursePrompt(c.env,c.req.param('courseId'))).amendment)});});
routes.put('/courses/:courseId/prompt',async c=>{const p=c.get('principal')!;owner(p);const result=await saveCoursePrompt(c.env,c.req.param('courseId'),p.subject,await body(c.req.raw));return c.json(result,result.status);});

type Folder={id:string;course_id:string;name:string;created_by:string;permission:string;revision:number};
async function folder(env:Env,p:AppPrincipal,id:string,courseId:string):Promise<Folder>{
  const row=await env.DB.prepare('SELECT * FROM course_folders WHERE id=? AND course_id=?').bind(id,courseId).first<Folder>();
  if(!row||(!p.course?.owner&&(row.permission==='private'||!p.course?.participant)))throw new CourseError(404,'not_found');return row;
}
routes.get('/courses/:courseId/folders',async c=>{
  const p=c.get('principal')!;const {results}=await c.env.DB.prepare(`SELECT id,name,permission,revision FROM course_folders WHERE course_id=? AND (?=1 OR permission<>'private') ORDER BY created_at,id LIMIT 100`).bind(c.req.param('courseId'),p.course?.owner?1:0).all();return c.json({folders:results});
});
routes.post('/courses/:courseId/folders',async c=>{
  const p=c.get('principal')!;owner(p);const b=await body(c.req.raw);const name=typeof b.name==='string'?b.name.trim():'';
  if(!name||name.length>80)throw new CourseError(400,'invalid_folder');const id=crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO course_folders(id,course_id,name,created_by) VALUES(?,?,?,?)').bind(id,c.req.param('courseId'),name,p.subject).run();return c.json({folder:{id,name,permission:'private',revision:0}});
});
routes.get('/courses/:courseId/folders/:id',async c=>{
  const f=await folder(c.env,c.get('principal')!,c.req.param('id'),c.req.param('courseId'));
  const {results}=await c.env.DB.prepare(`SELECT i.job_id AS jobId,i.filename,i.model,(j.id IS NOT NULL AND j.created_at>datetime('now','-90 days') AND j.status='done') AS available
    FROM course_folder_items i LEFT JOIN jobs j ON j.id=i.job_id LEFT JOIN job_courses jc ON jc.job_id=j.id
    WHERE i.folder_id=? AND (jc.course_id=? OR j.id IS NULL) ORDER BY i.added_at,i.job_id`).bind(f.id,f.course_id).all();
  return c.json({folder:{id:f.id,name:f.name,permission:f.permission,revision:f.revision},items:results});
});
routes.put('/courses/:courseId/folders/:id',async c=>{
  const p=c.get('principal')!;owner(p);const f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));const b=await body(c.req.raw);
  if(!['private','read','comment'].includes(String(b.permission))||!Number.isSafeInteger(b.revision))throw new CourseError(400,'invalid_grant');
  const result=await c.env.DB.prepare('UPDATE course_folders SET permission=?,revision=revision+1,created_by=? WHERE id=? AND course_id=? AND revision=?').bind(b.permission,p.subject,f.id,f.course_id,b.revision).run();
  if(!result.meta.changes)throw new CourseError(409,'folder_changed');return c.json({ok:true,revision:Number(b.revision)+1,url:`/classroom.html?course=${encodeURIComponent(f.course_id)}&folder=${f.id}`});
});
routes.post('/courses/:courseId/folders/:id/items',async c=>{
  const p=c.get('principal')!;owner(p);const f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));const b=await body(c.req.raw);
  if(typeof b.jobId!=='string')throw new CourseError(400,'invalid_job');
  const result=await c.env.DB.prepare(`INSERT INTO course_folder_items(folder_id,job_id,filename,model)
    SELECT ?,j.id,j.filename,COALESCE(j.model,'htdemucs_ft') FROM jobs j JOIN job_courses jc ON jc.job_id=j.id
    WHERE j.id=? AND jc.course_id=? AND j.status='done' AND j.created_at>datetime('now','-90 days')
    ON CONFLICT(folder_id,job_id) DO UPDATE SET job_id=excluded.job_id`).bind(f.id,b.jobId,f.course_id).run();
  if(!result.meta.changes)throw new CourseError(404,'not_found');return c.json({ok:true});
});
routes.delete('/courses/:courseId/folders/:id/items/:jobId',async c=>{
  const p=c.get('principal')!;owner(p);const f=await folder(c.env,p,c.req.param('id'),c.req.param('courseId'));await c.env.DB.prepare('DELETE FROM course_folder_items WHERE folder_id=? AND job_id=?').bind(f.id,c.req.param('jobId')).run();return c.json({ok:true});
});
export default routes;
