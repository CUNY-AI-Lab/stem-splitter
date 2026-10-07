import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import app from '../src/index.ts';
import { SqliteD1 } from '../server/d1.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';
import { STEM_COURSE_ID as A, validAccess, validAssignment, validPage, validFailure } from '../src/classroom/contract.ts';
import { courseFixture } from './course-fixture.ts';
import { beginCourseTurn, finishCourseTurn, conversationPage, resetCourseConversation, recoverExpiredCourseTurn } from '../src/classroom/conversations.ts';
import { cacheGuideIfPromptCurrent, getGuide } from '../src/assistant/index.ts';
import { hashSystemPromptFingerprint } from '../src/assistant/prompt.ts';
import { authorizeStoredCourseWork } from '../src/classroom/access.ts';
import { saveCoursePrompt } from '../src/classroom/prompts.ts';
import { purgeExpiredListeningConversations } from './retention.ts';
import { assistantReceipt, reserveAssistant } from '../src/reliability/assistant.ts';
import { recoverExpired } from '../src/reliability/queue.ts';
const B='another-reviewed-course';
const ids={alice:`cail-${'1'.repeat(32)}`,bob:`cail-${'2'.repeat(32)}`,ownerA:`cail-${'3'.repeat(32)}`,ownerB:`cail-${'4'.repeat(32)}`,outsider:`cail-${'5'.repeat(32)}`,admin:`cail-${'6'.repeat(32)}`};
type Person=keyof typeof ids;
async function setup(){
  const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const revoked=new Set<string>();let calls=0;
  const assignments=async(subject:string,classId:string)=>{
    const role=(classId===A&&subject===ids.ownerA)||(classId===B&&subject===ids.ownerB)?'owner'
      :[ids.alice,ids.bob].includes(subject as never)||classId===B&&subject===ids.outsider?'participant':null;
    if(!role||revoked.has(`${subject}:${classId}`))return {ok:false,code:'not_enrolled',retryable:false};
    return {...await courseFixture(subject,classId,role==='owner'),displayName:subject===ids.alice?'<b>Alice</b>':'Student'};
  };
  const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',CAIL_COURSE_IDS:`${A},${B}`,DB:db,
    verifyCailIdentity:async(token:string)=>Object.values(ids).includes(token as never)?{subject:token,name:'Ignored JWT fallback'}:null,
    ADMISSION_RESOLVER:{resolveMembership:async({subject}:{subject:string})=>({ok:true,accessRole:subject===ids.admin?'admin':'member',budgetScope:subject===ids.admin?'admin':'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),
      resolveCourseAccess:async({subject,classId}:{subject:string;classId:string})=>assignments(subject,classId),
      listCourseAssignments:async({subject}:{subject:string})=>{const a=await assignments(subject,A),b=await assignments(subject,B);return {ok:true,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),revision:1,assignments:[a,b].filter(a=>a.ok).map(({ok,...row})=>row),nextCursor:null};},
      listCourseRoster:async({subject,classId,cursor}:{subject:string;classId:string;cursor?:string})=>{const authority=await assignments(subject,classId);if(!('owner'in authority)||!authority.owner)return {ok:false,code:'not_owner',retryable:false};const people=await Promise.all(Array.from({length:45},(_,i)=>courseFixture(i===0?ids.alice:`cail-${i.toString(16).padStart(32,'0')}`,classId)));const start=cursor==='next'?40:0;return {ok:true,classId,checkedAt:authority.checkedAt,expiresAt:authority.expiresAt,revision:1,participants:people.slice(start,start+40).map(({memberId,displayName,displayNameSource,startsAt,expiresAt})=>({memberId,displayName,displayNameSource,startsAt,expiresAt})),nextCursor:start===0?'next':null};}},
    ASSISTANT_MODEL:'fixture',assistantTransport:async(_env:unknown,input:{messages:Array<{content:string}>},delta:(text:string)=>Promise<void>)=>{calls++;await delta('A server reply.');return {content:'A server reply.',model:'fixture',toolCalls:[],finishReason:'stop'};},
  } as unknown as Env;
  const request=(path:string,who:Person='alice',method='GET',body?:unknown,headers:Record<string,string>={})=>app.fetch(new Request(`https://split.test${path}`,{method,headers:{'x-cail-identity-jwt':ids[who],origin:'https://split.test','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  for(const subject of Object.values(ids))await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  async function job(id:string,who:Person='alice',courseId:string|null=A){
    await db.prepare(`INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES(?,?,?,'done','htdemucs_ft','[]')`).bind(id,`${id} private title`,`uploads/${id}/source.wav`).run();
    await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id,ids[who]).run();
    if(courseId)await db.prepare("INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES(?,?,?,?,'course-work-v1')").bind(id,courseId,(await courseFixture(ids[who],courseId)).memberId,ids[who]).run();
  }
  return {db,env,request,job,revoked,calls:()=>calls,principal:async(who:Person='alice',courseId=A)=>({subject:ids[who],role:'student',displayName:'Alice',course:await courseFixture(ids[who],courseId),courseId} as AppPrincipal)};
}
test('current target enrollment and independent course ownership protect direct APIs and course boundaries',async()=>{
  const {request,job,revoked,env}=await setup();await job('a');await job('b','alice',B);await job('personal','alice',null);
  assert.equal((await request('/api/account','outsider')).status,403);
  assert.equal((await request('/api/uploads','outsider','POST',{filename:'x.wav'},{'x-stem-course':B})).status,403);
  assert.equal((await request('/api/classroom/courses/'+B+'/folders','outsider')).status,403);
  assert.equal((await request('/api/jobs/b','alice')).status,200);
  assert.equal((await request('/api/jobs/a','ownerA')).status,200);
  for(const who of ['bob','ownerB','admin'] as Person[])assert.equal((await request('/api/jobs/a',who)).status,who==='bob'?404:403);
  assert.equal((await request('/api/jobs/personal','ownerA')).status,404);
  assert.equal((await request('/api/jobs/personal','admin')).status,200);
  assert.equal((await request('/api/jobs/personal/listening-conversation','admin')).status,404);
  assert.equal((await request('/api/classroom/courses/'+B+'/roster','ownerA')).status,403);
  assert.equal((await request('/api/admin/users','ownerA')).status,403);
  assert.equal((await request('/api/teacher/folders','ownerA')).status,403);
  assert.equal((await request('/api/jobs','alice','POST',{youtubeUrl:'https://www.youtube.com/watch?v=fixture'},{'x-stem-course':A})).status,400);
  assert.equal((await request('/api/account','ownerB')).status,200);
  assert.equal((await request('/api/jobs/%61','alice')).status,400);
  revoked.add(`${ids.alice}:${A}`);
  for(const path of ['/api/jobs/a','/api/jobs/b','/api/jobs','/api/uploads','/api/jobs/a/chat','/api/files/stems/a/vocals.mp3'])assert.equal((await request(path,'alice',path.endsWith('chat')||path.endsWith('uploads')?'POST':'GET',path.endsWith('chat')||path.endsWith('uploads')?{}:undefined)).status,403);
  env.ADMISSION_RESOLVER!.resolveCourseAccess=async()=>{throw new Error('private detail');};assert.equal((await request('/api/account')).status,503);
  const anonymous=await app.fetch(new Request('https://split.test/api/account'),env);assert.equal(anonymous.status,401);
});
test('roster includes zero-work students and stable pages; scoped counts and split cursors',async()=>{
  const {request,job,db}=await setup();await job('a');await job('b','alice',B);
  let queries=0;const original=db.prepare.bind(db);db.prepare=((sql:string)=>{queries++;return original(sql);}) as typeof db.prepare;
  const first=await(await request(`/api/classroom/courses/${A}/roster`,'ownerA')).json() as any;
  assert.equal(first.participants.length,40);assert.equal(first.participants[0].splitCount,1);assert.equal(first.participants[1].splitCount,0);assert.ok(queries<=5,`queries ${queries}`);
  const second=await(await request(`/api/classroom/courses/${A}/roster?cursor=next`,'ownerA')).json() as any;assert.equal(second.participants.length,5);assert.equal(new Set([...first.participants,...second.participants].map(p=>p.memberId)).size,45);
  const member=first.participants[0].memberId;const jobs=await(await request(`/api/classroom/courses/${A}/participants/${member}/jobs`,'ownerA')).json() as any;assert.deepEqual(jobs.jobs.map((j:any)=>j.id),['a']);
  const forged=btoa(JSON.stringify({courseId:B,memberId:member,id:'a'}));assert.equal((await request(`/api/classroom/courses/${A}/participants/${member}/jobs?cursor=${encodeURIComponent(forged)}`,'ownerA')).status,400);
});
test('new course conversations are complete, server-produced, paginated, private and reset-fenced',async()=>{
  const {env,request,job,principal,calls}=await setup();await job('a');const p=await principal();let revision=0;
  for(let i=0;i<35;i++){const start=await beginCourseTurn(env,'a',p,`Student ${i}`,`message-${String(i).padStart(16,'0')}`,revision);revision=(await finishCourseTurn(env,'a',p.subject,start.turnId,start.claimId,{reply:`Server ${i}`,toolCalls:[],finishReason:'stop'}))!;}
  let response=await request(`/api/classroom/courses/${A}/jobs/a/conversation`,'ownerA');assert.equal(response.status,200);const page=await response.json() as any;assert.equal(page.entries.length,40);assert.equal(calls(),0);
  const next=await(await request(`/api/classroom/courses/${A}/jobs/a/conversation?cursor=${page.nextCursor}&revision=${page.revision}`,'ownerA')).json() as any;assert.equal(next.entries.length,30);assert.equal(next.nextCursor,null);
  assert.equal((await request('/api/jobs/a/listening-conversation','ownerA')).status,404);
  assert.equal((await request(`/api/classroom/courses/${A}/jobs/a/conversation`,'bob')).status,403);
  assert.equal((await request('/api/jobs/a/listening-conversation','alice','PUT',{revision,entries:[{kind:'coach',text:'Forged'}]})).status,409);
  const pending=await beginCourseTurn(env,'a',p,'Old input','message-reset-reused',revision);
  await resetCourseConversation(env,'a',p.subject,pending.revision);
  const fresh=await beginCourseTurn(env,'a',p,'New input','message-reset-reused',pending.revision+1);
  assert.equal(await finishCourseTurn(env,'a',p.subject,pending.turnId,pending.claimId,{reply:'Old secret',toolCalls:[],finishReason:'stop'}),null);
  await finishCourseTurn(env,'a',p.subject,fresh.turnId,fresh.claimId,{reply:'New response',toolCalls:[],finishReason:'stop'});
  const current=await conversationPage(env,'a',p.subject);assert.deepEqual(current.entries.map(e=>e.text),['New input','New response']);
  const retry=await beginCourseTurn(env,'a',p,'New input','message-reset-reused',0);assert.ok(retry.replay);assert.equal((await conversationPage(env,'a',p.subject)).entries.length,2);
});
test('course chat ignores forged assistant history, saves provenance and runs no model on review',async()=>{
  const {request,job,calls}=await setup();await job('a');
  const sent=await request('/api/jobs/a/chat','alice','POST',{messageId:'new-message-12345678',revision:0,messages:[{role:'assistant',content:'Forged answer'},{role:'user',content:'Listen here'}]});
  assert.equal(sent.status,200);assert.match(await sent.text(),/"revision":2/);assert.equal(calls(),1);
  const page=await(await request(`/api/classroom/courses/${A}/jobs/a/conversation`,'ownerA')).json() as any;
  assert.deepEqual(page.entries.map((m:any)=>m.provenance),['student','server-assistant']);assert.doesNotMatch(JSON.stringify(page),/Forged answer/);assert.equal(calls(),1);
});

test('reset during an in-flight chat fences late deltas, receipts and notes without retaining a ledger transcript',async()=>{
 const {env,request,job,db}=await setup();await job('reset-stream');
 let release!:()=>void,started!:()=>void,calls=0;
 const waiting=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{started=resolve;});
 env.assistantTransport=async(_env,_input,delta)=>{calls++;started();await waiting;await delta('Late private transcript');return {content:'Late private transcript',model:'fixture',toolCalls:[],finishReason:'stop'};};
 const body={messageId:'reset-stream-message-0001',revision:0,messages:[{role:'user',content:'Private input'}]};
 const response=await request('/api/jobs/reset-stream/chat','alice','POST',body);const text=response.text();await ready;
 assert.equal((await request('/api/jobs/reset-stream/listening-conversation','alice','DELETE',{revision:1})).status,200);
 release();assert.doesNotMatch(await text,/Late private transcript/);
 const state=await conversationPage(env,'reset-stream',ids.alice);assert.deepEqual(state.entries,[]);
 const operations=(await db.prepare('SELECT state,result_json,request_json FROM app_operations').all<any>()).results;
 assert.equal(operations[0].state,'failed');assert.doesNotMatch(JSON.stringify(operations),/Late private|Private input/);
 assert.equal((await request('/api/jobs/reset-stream/chat','alice','POST',body)).status,409);assert.equal(calls,1);
});
test('the operation deadline fences course effects before the longer conversation lease expires',async()=>{
 for(const recovered of [false,true]) {
  const {env,job,db,principal}=await setup();await job('deadline');const p=await principal();
  const {operation}=await reserveAssistant(env,p.subject,A,'chat','operation-fenced-turn-01','deadline',[]);
  const receipt=assistantReceipt(env,operation),turn=await beginCourseTurn(env,'deadline',p,'Listen','operation-fenced-turn-01',0);
  receipt.bindCourseClaim(turn.claimId);await receipt.effect();
  if(recovered)await recoverExpired(db as unknown as D1Database,Date.now()+90001);
  else await db.prepare('UPDATE app_operations SET lease_until=0 WHERE id=?').bind(operation.id).run();
  const result={reply:'Late private result',toolCalls:[{name:'add_note' as const,args:{seconds:1,text:'Late note'}}],finishReason:'stop'};
  assert.equal(await finishCourseTurn(env,'deadline',p.subject,turn.turnId,turn.claimId,result,false,p.displayName,operation.id),null);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM annotations').first<any>())!.n,0);
  assert.deepEqual((await conversationPage(env,'deadline',p.subject)).entries.map(e=>e.text),['Listen']);
  await assert.rejects(receipt.complete(result.reply),/input ended/);
  await assert.rejects(receipt.delta('Late delta'),/input ended/);
 }
});
test('reset between durable course completion and final delivery invalidates the completion receipt',async()=>{
 const {env,job,principal}=await setup();await job('reset-finish');const p=await principal();
 const {operation}=await reserveAssistant(env,p.subject,A,'chat','reset-finish-turn-0001','reset-finish',[]);
 const receipt=assistantReceipt(env,operation),turn=await beginCourseTurn(env,'reset-finish',p,'Listen','reset-finish-turn-0001',0);
 receipt.bindCourseClaim(turn.claimId);await receipt.effect();
 const revision=await finishCourseTurn(env,'reset-finish',p.subject,turn.turnId,turn.claimId,{reply:'Private answer',toolCalls:[],finishReason:'stop'},false,p.displayName,operation.id);
 assert.equal(revision,2);await resetCourseConversation(env,'reset-finish',p.subject,revision);
 await assert.rejects(receipt.complete('Private answer'),/input ended/);
 await assert.rejects(receipt.delta('Late delta'),/input ended/);
 assert.deepEqual((await conversationPage(env,'reset-finish',p.subject)).entries,[]);
});
test('course prompt writes conflict, preserve immutable history and invalidate only matching caches',async()=>{
  const {env,job,db}=await setup();await job('a');await job('b','alice',B);await job('personal','alice',null);const empty=await hashSystemPromptFingerprint();
  for(const [id,scope] of [['a',A],['b',B],['personal',null]] as const)assert.equal(await cacheGuideIfPromptCurrent({...env,ASSISTANT_COURSE_ID:scope},{jobId:id,text:'Old guide',model:'fixture',createdAt:new Date().toISOString()},0,empty),true);
  assert.equal((await saveCoursePrompt(env,A,ids.ownerA,{amendment:'Course A instructions',changeNote:'First course policy',expectedRevision:0})).status,200);
  assert.equal(await getGuide(env,'a'),null);assert.ok(await getGuide(env,'b'));assert.ok(await getGuide(env,'personal'));
  assert.equal(await cacheGuideIfPromptCurrent({...env,ASSISTANT_COURSE_ID:A},{jobId:'a',text:'Racing old guide',model:'fixture',createdAt:new Date().toISOString()},0,empty),false);
  assert.equal((await saveCoursePrompt(env,A,ids.ownerA,{amendment:'Stale',changeNote:'Oops',expectedRevision:0})).status,409);
  assert.equal((await saveCoursePrompt(env,A,ids.ownerA,{amendment:'Course A instructions',expectedRevision:1})).changed,false);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM course_prompt_revisions').first<{n:number}>())!.n,1);
  await assert.rejects(db.prepare('DELETE FROM course_prompt_revisions').run(),/immutable/);
});
test('course folders enforce same-course items, grants and author-only notes on every route',async()=>{
  const {request,job,db}=await setup();await job('a');await job('b','alice',B);await job('personal','alice',null);
  const made=await(await request(`/api/classroom/courses/${A}/folders`,'ownerA','POST',{name:'Shared course'})).json() as any;const folder=made.folder.id;
  const base=`/api/classroom/courses/${A}/folders/${folder}`;
  for(const id of ['b','personal'])assert.equal((await request(base+'/items','ownerA','POST',{jobId:id})).status,404);
  assert.equal((await request(base+'/items','ownerA','POST',{jobId:'a'})).status,200);
  assert.equal((await request(base,'bob')).status,404);
  assert.equal((await request(base,'ownerA','PUT',{permission:'comment',revision:0})).status,200);
  assert.equal((await request('/api/jobs/a','bob')).status,200);
  const note=await(await request('/api/jobs/a/annotations','bob','POST',{atSeconds:2,text:'Peer note',authorName:'Forged',authorSubject:ids.alice})).json() as any;assert.equal(note.authorName,'Student');
  assert.equal((await request(`/api/jobs/a/annotations/${note.id}`,'alice','PUT',{text:'Impersonated'})).status,404);
  assert.equal((await request(`/api/jobs/a/annotations/${note.id}`,'bob','PUT',{text:'Edited by author',authorName:'Forged'})).status,200);
  assert.equal((await request(`/api/jobs/a/annotations/${note.id}`,'alice','DELETE')).status,404);
  assert.equal((await request(`/api/jobs/a/annotations/${note.id}`,'ownerA','DELETE')).status,404);
  assert.equal((await request(`/api/jobs/a/annotations/${note.id}`,'bob','DELETE')).status,200);
  await db.prepare("INSERT INTO annotations(id,job_id,at_seconds,text) VALUES('historical','a',0,'Old note')").run();
  const state=await(await request('/api/jobs/a','bob')).json() as any;assert.equal(state.annotations[0].authorName,'Author unavailable');assert.equal(state.annotations[0].canDelete,false);
  assert.equal((await request(base,'ownerA','PUT',{permission:'private',revision:1})).status,200);assert.equal((await request('/api/jobs/a','bob')).status,404);assert.equal((await request('/api/files/stems/a/vocals.mp3','bob')).status,404);
});
test('fresh and additive migration preserve private history, no backfill; retained course messages purge',async()=>{
  const fresh=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
  const legacy=readFileSync(new URL('./fixtures/pre-classroom-schema.sql',import.meta.url),'utf8');
  assert.equal(createHash('sha256').update(legacy).digest('hex'),'daa7333b25af106c1b2db9cf71bcee70601ed59c51642ca4ff8a0c6eb3f13362');
  const db=new SqliteD1(':memory:');db.applySchema(legacy);await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(ids.alice).run();await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('old','Old private','uploads/old/source.wav','done')").run();await db.prepare('INSERT INTO job_owners VALUES(?,?)').bind('old',ids.alice).run();await db.prepare("INSERT INTO listening_conversations(job_id,subject,entries,revision,expires_at) VALUES(?,?,'[{\"kind\":\"coach\",\"text\":\"Private history\"}]',3,datetime('now','+90 days'))").bind('old',ids.alice).run();
  await db.prepare("INSERT INTO annotations(id,job_id,at_seconds,text) VALUES('legacy-note','old',1,'Legacy private note')").run();
  const migration=readFileSync(new URL('../migrations/0021-classroom.sql',import.meta.url),'utf8');db.applySchema(migration);
  await db.prepare("INSERT INTO app_request_reservations(id,subject,scope,day) VALUES('historical-attempt',?,'split','2026-10-05')").bind(ids.alice).run();
  const reliability=readFileSync(new URL('../migrations/0022-reliable-operations.sql',import.meta.url),'utf8');db.applySchema(reliability);db.applySchema(reliability);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM app_request_reservations WHERE id='historical-attempt'").first<any>()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM app_operations').first<any>()).n,0);
  const clean=new SqliteD1(':memory:');clean.applySchema(fresh);clean.applySchema(fresh);
  assert.throws(()=>db.applySchema(migration),/duplicate column name/);
  assert.equal((await db.prepare("SELECT text,author_subject FROM annotations WHERE id='legacy-note'").first<any>()).author_subject,null);
  const schema=async(db:SqliteD1)=>(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results;
  assert.deepEqual(await schema(db),await schema(clean));
  const columns=async(database:SqliteD1,name:string)=>(await database.prepare(`PRAGMA table_info(${name})`).all<any>()).results.map(({cid,...column})=>column).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  for(const {name} of await schema(db) as {name:string}[])assert.deepEqual(await columns(db,name),await columns(clean,name));assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM job_courses').first<any>()).n,0);assert.equal((await db.prepare('SELECT revision FROM listening_conversations').first<any>()).revision,3);
  const fixture=await setup();await fixture.job('expired');const p=await fixture.principal();const start=await beginCourseTurn(fixture.env,'expired',p,'Hi','retained-message-1234',0);await finishCourseTurn(fixture.env,'expired',p.subject,start.turnId,start.claimId,{reply:'Retained reply',toolCalls:[],finishReason:'stop'});await fixture.db.prepare("UPDATE jobs SET created_at=datetime('now','-91 days') WHERE id='expired'").run();
  assert.equal((await conversationPage(fixture.env,'expired',p.subject)).entries.length,0);await purgeExpiredListeningConversations(fixture.env.DB);assert.equal((await fixture.db.prepare('SELECT count(*) AS n FROM course_messages').first<any>()).n,0);
});

test('the exact shared private-wire fixture validates, while stale/extra/mismatched authority fails closed',async()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/stem-course-v1.json',import.meta.url),'utf8'));
 const now=Date.parse(fixture.access.checkedAt);assert.equal(validAccess(fixture.access,now),true);assert.equal(validPage(fixture.roster,now),true);assert.equal(validFailure(fixture.denied),true);
 assert.equal(validAccess({...fixture.access,subject:ids.alice},now),false);assert.equal(validAccess(fixture.access,now+31000),false);
 const {env,request}=await setup();for(const altered of [{startsAt:new Date(Date.now()+60000).toISOString()},{expiresAt:new Date(Date.now()-1).toISOString()},{classId:B},{revision:-1},{owner:false,participant:false},{subject:ids.alice}]){
  env.ADMISSION_RESOLVER!.resolveCourseAccess=async()=>({...await courseFixture(ids.alice,A),...altered});assert.equal((await request('/api/account')).status,503);
 }
 for(const code of ['scheduled','expired','revoked']){env.ADMISSION_RESOLVER!.resolveCourseAccess=async()=>({ok:false,code,retryable:false});assert.equal((await request('/api/account')).status,403);}
});

test('concurrent duplicate course turns claim once; assistant notes retain the verified initiating author',async()=>{
  const {env,job,principal,db}=await setup();await job('race');const p=await principal();
  const attempts=await Promise.allSettled([beginCourseTurn(env,'race',p,'Listen','concurrent-turn-123456',0),beginCourseTurn(env,'race',p,'Listen','concurrent-turn-123456',0)]);
  const successes=attempts.filter(a=>a.status==='fulfilled');assert.equal(successes.length,1);
  const conflict=attempts.find(a=>a.status==='rejected') as PromiseRejectedResult;assert.equal(conflict.reason.status,409);
  const start=(successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof beginCourseTurn>>>).value;
  const result={reply:'Heard it',toolCalls:[{name:'add_note' as const,args:{seconds:2,text:'Server note'}}],finishReason:'stop'};
  await finishCourseTurn(env,'race',p.subject,start.turnId,start.claimId,result,false,p.displayName);
  assert.equal(await finishCourseTurn(env,'race',p.subject,start.turnId,start.claimId,result,false,p.displayName),null);
  const notes=(await db.prepare('SELECT author_subject,author_name,provenance FROM annotations').all()).results;
  assert.deepEqual(JSON.parse(JSON.stringify(notes)),[{author_subject:p.subject,author_name:'Alice',provenance:'server-assistant'}]);
  assert.deepEqual((await conversationPage(env,'race',p.subject)).entries.map((v:any)=>v.provenance),['student','server-assistant','server-tool']);
});
test('maintenance pause preserves assignments and private owner reads while stopping course disclosure and starts',async()=>{
  const {env,request,job,db}=await setup();await job('a');env.CAIL_CLASSROOM_ENABLED='false';
  assert.equal((await request('/api/jobs/a')).status,200);
  assert.equal((await request('/api/jobs/a','ownerA')).status,404);
  assert.equal((await request(`/api/classroom/courses/${A}/roster`,'ownerA')).status,503);
  assert.equal((await request('/api/jobs/a/chat','alice','POST',{})).status,503);
  assert.equal((await request('/api/jobs','alice','POST',{coursePolicy:'course-work-v1'},{'x-stem-course':A})).status,503);
  await assert.rejects(authorizeStoredCourseWork(env,ids.alice,A),/course_work_paused/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM job_courses').first<any>()).n,1);
  env.CAIL_CLASSROOM_ENABLED='true';assert.equal((await request('/api/jobs/a','ownerA')).status,200);
});

test('private course mirror rejects impossible UTC dates, inverted validity windows and access markers on plain assignments',async()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/stem-course-v1.json',import.meta.url),'utf8'));const now=Date.parse(fixture.access.checkedAt);const {ok,...plain}=fixture.access;
 assert.equal(validAssignment(plain,now),true);assert.equal(validAssignment({...plain,ok:true},now),false);assert.equal(validAssignment({...plain,ok:false},now),false);
 assert.equal(validAccess({...plain,ok:false},now),false);assert.equal(validAccess(plain,now),false);
 assert.equal(validAccess({...fixture.access,startsAt:'2026-02-31T00:00:00.000Z'},now),false);
 assert.equal(validAccess({...fixture.access,checkedAt:new Date(now+2000).toISOString(),expiresAt:new Date(now+1000).toISOString()},now),false);
 assert.equal(validPage({...fixture.roster,checkedAt:new Date(now+2000).toISOString(),expiresAt:new Date(now+1000).toISOString()},now),false);
 const {env,request}=await setup();env.ADMISSION_RESOLVER!.listCourseAssignments=async()=>{const access=await courseFixture(ids.alice);return {ok:true,checkedAt:access.checkedAt,expiresAt:access.expiresAt,revision:1,assignments:[{...access,ok:false}],nextCursor:null};};
 assert.equal((await request('/api/classroom/courses')).status,503);
});

test('expired course turn leases recover without deleting prior messages or retrying uncertain inference',async()=>{
 const {env,db,job,principal}=await setup();await job('orphan');const p=await principal();
 const first=await beginCourseTurn(env,'orphan',p,'Earlier question','earlier-turn-123456',0);await finishCourseTurn(env,'orphan',p.subject,first.turnId,first.claimId,{reply:'Earlier verified answer',toolCalls:[],finishReason:'stop'});
 const lost=await beginCourseTurn(env,'orphan',p,'Uncertain request','orphaned-turn-123456',2);
 assert.equal(await recoverExpiredCourseTurn(env,'orphan',p.subject),false);
 await db.prepare("UPDATE course_conversations SET pending_expires_at=datetime('now','-1 second') WHERE job_id='orphan'").run();
 assert.equal(await finishCourseTurn(env,'orphan',p.subject,lost.turnId,lost.claimId,{reply:'Late answer',toolCalls:[{name:'add_note',args:{seconds:1,text:'Late note'}}],finishReason:'stop'}),null);
 const recovered=await Promise.all([recoverExpiredCourseTurn(env,'orphan',p.subject),recoverExpiredCourseTurn(env,'orphan',p.subject)]);assert.equal(recovered.filter(Boolean).length,1);
 const page=await conversationPage(env,'orphan',p.subject);assert.equal(page.pending,false);assert.equal(page.revision,4);assert.deepEqual(page.entries.slice(0,3).map(m=>m.text),['Earlier question','Earlier verified answer','Uncertain request']);assert.equal(page.entries[3].kind,'status');assert.match(page.entries[3].text,/will not be retried automatically/);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM annotations').first<any>()).n,0);
 await assert.rejects(beginCourseTurn(env,'orphan',p,'Uncertain request',lost.turnId,page.revision),error=>(error as any).code==='conversation_interrupted');
 const fresh=await beginCourseTurn(env,'orphan',p,'Fresh question','recovered-turn-1234',page.revision);assert.equal(await recoverExpiredCourseTurn(env,'orphan',p.subject),false);
 assert.equal(await finishCourseTurn(env,'orphan',p.subject,lost.turnId,lost.claimId,{reply:'Very late answer',toolCalls:[],finishReason:'stop'}),null);
 await finishCourseTurn(env,'orphan',p.subject,fresh.turnId,fresh.claimId,{reply:'Fresh answer',toolCalls:[],finishReason:'stop'});assert.equal((await conversationPage(env,'orphan',p.subject)).entries.length,6);
});
test('storage failures before and after finish remain recoverable and never duplicate conversation effects',async()=>{
 const {env,db,job,principal}=await setup();await job('storage');const p=await principal();const original=db.batch.bind(db);
 const pending=await beginCourseTurn(env,'storage',p,'Storage request','storage-turn-123456',0);
 db.batch=(async()=>{throw new Error('injected storage unavailable');}) as typeof db.batch;
 await assert.rejects(finishCourseTurn(env,'storage',p.subject,pending.turnId,pending.claimId,{reply:'Unsaved reply',toolCalls:[],finishReason:'stop'}));db.batch=original;
 await db.prepare("UPDATE course_conversations SET pending_expires_at=datetime('now','-1 second') WHERE job_id='storage'").run();
 const page=await conversationPage(env,'storage',p.subject);assert.equal(page.pending,false);assert.equal(page.entries.length,2);
 const fresh=await beginCourseTurn(env,'storage',p,'Another request','storage-next-123456',page.revision);
 db.batch=(async(statements)=>{await original(statements);throw new Error('injected lost acknowledgment');}) as typeof db.batch;
 await assert.rejects(finishCourseTurn(env,'storage',p.subject,fresh.turnId,fresh.claimId,{reply:'Saved once',toolCalls:[],finishReason:'stop'}));db.batch=original;
 const retry=await beginCourseTurn(env,'storage',p,'Another request',fresh.turnId,fresh.revision);assert.ok(retry.replay);assert.equal(retry.replay.reply,'Saved once');assert.equal((await conversationPage(env,'storage',p.subject)).entries.length,4);
});
