import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from '../server/d1.ts';
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { AssistantError } from '../src/assistant/openrouter.ts';
import { assistantReceipt, reserveAssistant } from '../src/reliability/assistant.ts';
import { beginAttempt, finishAttempt, readOperation, reserveOperation, settleOperation } from '../src/reliability/ledger.ts';
import { listeningUsage, recoverListeningOperations } from '../src/reliability/listening.ts';
import { purgeOperationContent } from '../src/reliability/retention.ts';
import { courseFixture } from './course-fixture.ts';
import { STEM_COURSE_ID } from '../src/classroom/contract.ts';
import { gatewayForRequest } from './gateway.ts';

const alice=`cail-${'1'.repeat(32)}`,bob=`cail-${'2'.repeat(32)}`;
async function setup() {
 const local=new SqliteD1(':memory:');local.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const db=local as unknown as D1Database;let calls=0,valid=true,mode='ok';
 for(const subject of [alice,bob])await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
 const env={DB:db,AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',CAIL_COURSE_IDS:STEM_COURSE_ID,ASSISTANT_MODEL:'fixture',
  verifyCailIdentity:async(token:string)=>valid&&[alice,bob].includes(token)?{subject:token,name:'Fixture'}:null,
  ADMISSION_RESOLVER:{resolveMembership:async()=>({ok:true,accessRole:'member',budgetScope:'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),
   resolveCourseAccessV2:async({subject,classId}:{subject:string;classId:string})=>courseFixture(subject,classId)},
  assistantTransport:async(e:Env,_input:unknown,delta:(s:string)=>Promise<void>)=>{
   calls++;
   if(mode==='failed')throw new AssistantError(503,'Provider temporarily unavailable.');
   if(mode==='partial'){await delta('Partial private reply');throw new AssistantError(503,'The provider stopped.');}
   if(mode==='uncertain') {
    const op=(await readOperation(db,e.ASSISTANT_OPERATION_ID!))!;
    const id=await beginAttempt(db,op,'fixture');await finishAttempt(db,id,'uncertain');
    throw new AssistantError(503,'The provider timed out.',{code:'upstream_timeout',shouldRetry:true});
   }
   await delta('Private fixture reply.');return {content:'Private fixture reply.',model:'fixture',toolCalls:[],finishReason:'stop'};
  },
 } as unknown as Env;
 const request=(path:string,method='GET',body?:unknown,subject=alice)=>app.fetch(new Request(`https://split.test${path}`,{method,
  headers:{'x-cail-identity-jwt':subject,origin:'https://split.test','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 const job=async(id:string,course=false)=>{
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES(?,?,?,'done','htdemucs_ft','[]')").bind(id,'Synthetic audio',`uploads/${id}/source.mp3`).run();
  await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id,alice).run();
  if(course)await db.prepare("INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES(?,?,?,?,'course-work-v1')").bind(id,STEM_COURSE_ID,(await courseFixture(alice,STEM_COURSE_ID)).memberId,alice).run();
 };
 const chat=(id:string,key:string,revision?:number)=>({messageId:key,messages:[{role:'user',content:'What should I listen for?'}],...(revision===undefined?{}:{revision})});
 const events=async(response:Response)=>(await response.text()).split('\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
 return {db,env,request,job,chat,events,calls:()=>calls,mode:(v:string)=>{mode=v;},expire:()=>{valid=false;}};
}

test('signed-in cue and chat continue beyond five replies without a pause; cached and replayed reads stay free',async()=>{
 const f=await setup();await f.job('personal');
 const cue=await f.events(await f.request('/api/jobs/personal/guide','POST',{messageId:'cue-request-number-0001'}));
 assert.equal(cue.at(-1).type,'done');assert.equal(cue.at(-1).usage.successfulTurns,0,'cues retain their separate daily allowance');
 const body=f.chat('personal','chat-request-number-0001');
 for(let i=1;i<=6;i++) {
  const events=await f.events(await f.request('/api/jobs/personal/chat','POST',{...body,messageId:`chat-request-number-000${i}`}));
  assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).usage.successfulTurns,i);
  assert.equal(events.at(-1).usage.remainingTurns,50-i);assert.equal(events.at(-1).usage.cooldownUntil,null);
 }
 const replay=await f.events(await f.request('/api/jobs/personal/chat','POST',body));
 assert.equal(replay.at(-1).replayed,true);assert.equal(replay.at(-1).usage.successfulTurns,6);assert.equal(f.calls(),7);
 const cached=await f.events(await f.request('/api/jobs/personal/guide','POST',{messageId:'cue-request-number-0001'}));
 assert.equal(cached.at(-1).cached,true);assert.equal(f.calls(),7);
 const usage=await(await f.request('/api/listening-usage')).json() as any;
 assert.equal(usage.limit,50);assert.equal(usage.remainingTurns,44);assert.equal(usage.cooldownUntil,null);
});

test('parallel signed-in requests retain burst protection beyond five and charge completion once',async()=>{
 const f=await setup();
 const results=await Promise.allSettled(Array.from({length:16},(_,i)=>reserveAssistant(f.env,alice,null,i%2?'chat':'guide',`parallel-request-${String(i).padStart(4,'0')}`,`job-${i}`,{i})));
 const admitted=results.flatMap(r=>r.status==='fulfilled'?[r.value.operation]:[]);assert.equal(admitted.length,10);
 const chatCount=admitted.filter(op=>op.kind==='chat').length;
 const held=await listeningUsage(f.db,alice);assert.equal(held.inProgress,chatCount);assert.equal(held.remainingTurns,50-chatCount);assert.equal(held.cooldownUntil,null);
 for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'listening_attempt_limit');
 await Promise.all(admitted.map(op=>assistantReceipt(f.env,op).complete('Successful reply')));
 await assert.rejects(assistantReceipt(f.env,admitted[0]).complete('Duplicate'),/ended/);
 const used=await listeningUsage(f.db,alice);assert.equal(used.successfulTurns,chatCount);assert.equal(used.inProgress,0);assert.equal(used.cooldownUntil,null);
 const other=await reserveAssistant(f.env,bob,null,'chat','another-user-request-01','job',{});assert.equal(other.replay,false);
});

test('failures, partial streams and timeouts use no successful turn; uncertain retry has bounded explicit recovery',async t=>{
 const f=await setup();await f.job('failure');let now=Date.now();t.mock.method(Date,'now',()=>now);
 for(const mode of ['failed','partial','uncertain']) {
  f.mode(mode);const body=f.chat('failure',`failure-request-${mode}-01`);
  const result=await f.events(await f.request('/api/jobs/failure/chat','POST',body));
  assert.equal(result.at(-1).type,'error');assert.equal(result.at(-1).usage.successfulTurns,0);assert.equal(result.at(-1).usage.remainingTurns,50);
  const retry=await f.request('/api/jobs/failure/chat','POST',body);assert.equal(retry.status,409);
  const failure=await retry.json() as any;assert.equal(failure.newAttemptAllowed,mode!=='uncertain');
  if(mode==='uncertain') {
   assert.equal(failure.code,'listening_attempt_uncertain');assert.equal(retry.headers.get('retry-after'),'120');
   now+=120000;const recovered=await(await f.request('/api/jobs/failure/chat','POST',body)).json() as any;
   assert.equal(recovered.newAttemptAllowed,true);assert.equal(recovered.code,'listening_attempt_failed');
  }
 }
 assert.equal(f.calls(),3);f.mode('ok');const fresh=await f.events(await f.request('/api/jobs/failure/chat','POST',f.chat('failure','explicit-new-attempt-01')));
 assert.equal(fresh.at(-1).usage.successfulTurns,1);assert.equal(f.calls(),4);
});

test('course cue/chat failure diagnostics preserve the uncertain-attempt retry floor and filter unsafe metadata', async () => {
 const f=await setup();
 const supportId='01900000-0000-7000-8000-000000000002';
 let calls=0;
 for(const [index,code] of ['empty_response','incomplete_response','upstream_timeout','upstream_unavailable','private_provider_secret'].entries()) {
  for(const kind of ['guide','chat']) {
   const id=`diagnostic-${index}-${kind}`;await f.job(id,true);
   f.env.assistantTransport=async e=>{
    calls++;
    const operation=(await readOperation(f.db,e.ASSISTANT_OPERATION_ID!))!;
    const attempt=await beginAttempt(f.db,operation,'fixture');await finishAttempt(f.db,attempt,'uncertain');
    throw new AssistantError(503,'The Listening Guide is unavailable right now.',{code,requestId:code==='private_provider_secret'?'private credential':supportId,shouldRetry:true,retryAfterSeconds:code==='upstream_timeout'?300:45});
   };
   const body=kind==='guide'?{messageId:`diagnostic-key-${index}-${kind}`}:f.chat(id,`diagnostic-key-${index}-${kind}`,0);
   const events=await f.events(await f.request(`/api/jobs/${id}/${kind}`,'POST',body)), error=events.at(-1);
   assert.equal(error.type,'error');assert.equal(error.code,'listening_attempt_uncertain');
   assert.equal(error.providerCode,code==='private_provider_secret'?'assistant_unavailable':code);
   assert.equal(error.requestId,code==='private_provider_secret'?undefined:supportId);
   assert.equal(error.newAttemptAllowed,false);assert.ok(error.retryAfterSeconds>=119);
   if(code==='upstream_timeout')assert.equal(error.retryAfterSeconds,300);
   assert.match(error.message,/provider outcome could be verified/);
   assert.match(error.message,/retry this request to recover or start a new attempt/);
   assert.ok(!error.message.includes('two minutes'));
   assert.equal(error.usage.successfulTurns,0);assert.equal(error.usage.remainingTurns,50);
   assert.ok(!JSON.stringify(events).includes('private'));
   const before=calls;assert.equal((await f.request(`/api/jobs/${id}/${kind}`,'POST',body)).status,409);assert.equal(calls,before);
  }
 }
 assert.equal(calls,10);
});

test('real Gateway adapter rejects empty and truncated cue/chat output without charging or caching; complete output counts once',async()=>{
 const f=await setup();await f.job('gateway-output');
 let calls=0,content='',finishReason='length';
 const transport=gatewayForRequest({fetch:async(outbound:Request)=>{
  calls++;const body=await outbound.json() as any;
  assert.deepEqual(body.reasoning,{enabled:false});
  assert.equal(body.max_tokens,body.tools?600:500);
  return new Response(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:finishReason}]})}\n\ndata: [DONE]\n\n`,
   {headers:{'Content-Type':'text/event-stream'}});
 }} as unknown as Fetcher,'synthetic-test-credential',new Request('https://split.test'),'test');
 f.env.assistantTransport=transport.stream;f.env.ASSISTANT_MODEL='glm-5.2';f.env.ASSISTANT_FALLBACK_MODELS='deepseek-v4-flash-0731';
 let index=0;
 for(const [text,reason] of [['','length'],['Unfinished sentence','length'],['','stop']]) {
  content=text;finishReason=reason;
  for(const kind of ['guide','chat']) {
   const messageId=`bad-output-${kind}-${index++}`;
   const body=kind==='guide'?{messageId}:f.chat('gateway-output',messageId);
   const events=await f.events(await f.request(`/api/jobs/gateway-output/${kind}`,'POST',body));
   assert.equal(events.at(-1).type,'error');assert.equal(events.at(-1).usage.successfulTurns,0);
   assert.equal(events.at(-1).newAttemptAllowed,true);
   assert.equal((await f.request(`/api/jobs/gateway-output/${kind}`,'POST',body)).status,409);
  }
 }
 assert.equal(calls,6);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM guides').first<any>()).n,0);
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM app_operations WHERE state='succeeded'").first<any>()).n,0);
 content='Listen for the bass.';finishReason='stop';
 const result=await f.events(await f.request('/api/jobs/gateway-output/guide','POST',{messageId:'complete-output-guide-01'}));
 assert.equal(result.at(-1).type,'done');assert.equal(result.at(-1).usage.successfulTurns,0);
 const cached=await f.events(await f.request('/api/jobs/gateway-output/guide','POST',{messageId:'complete-output-guide-01'}));
 assert.equal(cached.at(-1).cached,true);assert.equal(cached.at(-1).usage.successfulTurns,0);assert.equal(calls,7);
});

test('lost runner and in-flight retry cannot regenerate or deliver after their lease; expired identity cannot read replay',async()=>{
 const f=await setup();await f.job('lease');
 const input=[1],key='same-inflight-request-01';const reserved=await reserveAssistant(f.env,alice,null,'chat',key,'lease',input);
 await assert.rejects(reserveAssistant(f.env,alice,null,'chat',key,'lease',input),(e:any)=>e.code==='listening_in_progress'&&!e.details.newAttemptAllowed);
 await recoverListeningOperations(f.db,alice,Date.now()+90001);
 await assert.rejects(assistantReceipt(f.env,reserved.operation).complete('Too late'),/ended/);
 assert.equal((await listeningUsage(f.db,alice)).remainingTurns,50);
 const body=f.chat('lease','saved-before-expiry-01');await f.events(await f.request('/api/jobs/lease/chat','POST',body));
 f.expire();assert.equal((await f.request('/api/listening-usage')).status,401);
 assert.equal((await f.request('/api/jobs/lease/chat','POST',body)).status,401);assert.equal(f.calls(),1);
});

test('ten failed attempts per rolling minute are bounded; same-key retry does not use an attempt and boundary releases',async t=>{
 const f=await setup();let now=Date.now();t.mock.method(Date,'now',()=>now);
 for(let i=0;i<10;i++) {const op=await reserveAssistant(f.env,alice,null,i%2?'chat':'guide',`short-window-request-${i}`,'job',{});await assistantReceipt(f.env,op.operation).failed();}
 await assert.rejects(reserveAssistant(f.env,alice,null,'chat','short-window-request-10','job',{}),(e:any)=>e.code==='listening_attempt_limit'&&e.retryAfter===60);
 await assert.rejects(reserveAssistant(f.env,alice,null,'chat','short-window-request-1','job',{}),(e:any)=>e.code==='listening_attempt_failed');
 assert.equal((await listeningUsage(f.db,alice)).successfulTurns,0);
 now+=60000;await reserveAssistant(f.env,alice,null,'chat','short-window-request-10','job',{});
});

test('signed-in use continues beyond five while daily and global cue protection stay in force',async t=>{
 const f=await setup();let now=Date.parse('2026-10-21T12:00:00Z');t.mock.method(Date,'now',()=>now);
 for(let i=0;i<30;i++) {
  const op=await reserveAssistant(f.env,alice,null,i%2?'chat':'guide',`continued-request-${String(i).padStart(4,'0')}`,'job',{});
  await assistantReceipt(f.env,op.operation).complete('Complete');now+=6000;
 }
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM app_operations').first<any>()).n,30);
 // Existing shared guide protection is independent of the per-person allowance.
 const day=new Date(now).toISOString().slice(0,10);
 for(let i=0;i<185;i++)await f.db.prepare(`INSERT INTO app_operations(id,subject,quota_class,kind,idempotency_key,fingerprint,day,state,phase,request_json,deadline,created_at,updated_at)
   VALUES(?,?,'member','guide',?,'fixture',?,'failed','guide','{}',?,?,?)`).bind(`global-${i}`,bob,`global-guide-${i}`,day,now+1000,now-120000,now-120000).run();
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM app_operations WHERE kind='guide' AND day=?").bind(day).first<any>()).n,200);
 await assert.rejects(reserveAssistant(f.env,alice,null,'guide','global-limit-request-01','job',{}),(e:any)=>e.code==='guide_attempt_limit');
 await reserveAssistant(f.env,alice,null,'chat','chat-after-guide-cap-01','job',{});
 // The global protection really is daily: it holds through the last millisecond
 // of this day and permits a fresh cue at midnight without changing its limit.
 now=Date.parse(`${day}T23:59:59.999Z`);
 await assert.rejects(reserveAssistant(f.env,alice,null,'guide','global-before-midnight-01','job',{}),
  (e:any)=>e.code==='guide_attempt_limit'&&e.retryAfter===1);
 now++;
 const next=await reserveAssistant(f.env,alice,null,'guide','global-after-midnight-01','job',{});
 assert.equal(next.operation.day,'2026-10-22');
});

test('course replay keeps exact owner scope, current usage and revision without a second model call',async()=>{
 const f=await setup();await f.job('course',true);const body=f.chat('course','course-replay-request-01',0);
 const original=await f.events(await f.request('/api/jobs/course/chat','POST',body));assert.equal(original.at(-1).revision,2);
 const replay=await f.events(await f.request('/api/jobs/course/chat','POST',body));assert.equal(replay.at(-1).text,original.at(-1).text);
 assert.equal(replay.at(-1).replayed,true);assert.equal(replay.at(-1).usage.successfulTurns,1);assert.equal(f.calls(),1);
 assert.equal((await f.request('/api/jobs/course/chat','POST',body,bob)).status,404);assert.equal(f.calls(),1);
 await f.request('/api/jobs/course/listening-conversation','DELETE',{revision:2});
 assert.equal((await f.request('/api/jobs/course/chat','POST',body)).status,409);assert.equal(f.calls(),1);
});

test('personal replay receipts remain private, expire within job retention, purge on reset/deletion, and never enter accounting',async()=>{
 const f=await setup();await f.job('private');const body=f.chat('private','private-replay-request-01');
 await f.events(await f.request('/api/jobs/private/chat','POST',body));
 const receipt=await f.db.prepare('SELECT * FROM listening_reply_receipts').first<any>();assert.match(receipt.response_json,/Private fixture reply/);
 assert.ok(receipt.expires_at<=Date.now()+86400000);
 assert.doesNotMatch(JSON.stringify((await f.db.prepare('SELECT * FROM app_operations').all()).results),/Private fixture reply/);
 assert.doesNotMatch(JSON.stringify((await f.db.prepare('SELECT * FROM operation_events').all()).results),/Private fixture reply/);
 assert.equal((await f.request('/api/jobs/private/chat','POST',body,bob)).status,404);
 await f.request('/api/jobs/private/listening-conversation','DELETE');assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM listening_reply_receipts').first<any>()).n,0);
 await f.events(await f.request('/api/jobs/private/chat','POST',{...body,messageId:'private-replay-request-02'}));
 await purgeOperationContent(f.db,Date.now()+86400001);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM listening_reply_receipts').first<any>()).n,0);
 await f.events(await f.request('/api/jobs/private/chat','POST',{...body,messageId:'private-replay-request-03'}));
 await f.db.prepare("DELETE FROM jobs WHERE id='private'").run();assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM listening_reply_receipts').first<any>()).n,0);
});

test('personal reset atomically fences a live runner and cannot recreate erased reply readback',async()=>{
 const f=await setup();await f.job('reset');
 const {operation}=await reserveAssistant(f.env,alice,null,'chat','reset-inflight-request-01','reset',{});
 const receipt=assistantReceipt(f.env,operation);await receipt.delta('Discarded private partial');
 assert.equal((await f.request('/api/jobs/reset/listening-conversation','DELETE')).status,200);
 await assert.rejects(receipt.delta('Late delta'),/ended/);
 await assert.rejects(receipt.effect(),/ended/);
 await assert.rejects(receipt.complete('Discarded private reply',{text:'Discarded private reply'}),/ended/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM listening_reply_receipts').first<any>()).n,0);
 assert.equal((await readOperation(f.db,operation.id))?.state,'cancelled');assert.equal((await listeningUsage(f.db,alice)).remainingTurns,50);
});

test('lost database acknowledgement after completion preserves the same key for free readback',async()=>{
 const f=await setup();await f.job('ack');const batch=f.db.batch.bind(f.db);let lost=false;
 f.db.batch=(async(statements:D1PreparedStatement[])=>{
  const result=await batch(statements);
  if(!lost && (await f.db.prepare('SELECT COUNT(*) AS n FROM listening_reply_receipts').first<any>()).n) {lost=true;throw new Error('Synthetic lost acknowledgement');}
  return result;
 }) as typeof f.db.batch;
 const body=f.chat('ack','lost-ack-request-0001');const first=await f.events(await f.request('/api/jobs/ack/chat','POST',body));
 assert.equal(first.at(-1).code,'listening_result_available');assert.equal(first.at(-1).newAttemptAllowed,false);
 assert.equal(first.at(-1).usage.successfulTurns,1);
 const replay=await f.events(await f.request('/api/jobs/ack/chat','POST',body));assert.equal(replay.at(-1).replayed,true);assert.equal(f.calls(),1);
});

test('personal and course completion readback repeats local mixer calls but never repeats persisted notes',async()=>{
 for(const course of [false,true]) {
  const f=await setup();await f.job('tools',course);
  await f.db.prepare("UPDATE jobs SET stems='[{\"name\":\"vocals\",\"key\":\"stems/tools/vocals.mp3\"}]' WHERE id='tools'").run();
  let calls=0;f.env.assistantTransport=async(_env,_input,delta)=>{
   calls++;await delta('Seek and listen.');return {content:'Seek and listen.',model:'fixture',finishReason:'stop',toolCalls:[
    {id:'seek-tool',type:'function',function:{name:'seek',arguments:JSON.stringify({seconds:12})}},
    {id:'note-tool',type:'function',function:{name:'add_note',arguments:JSON.stringify({seconds:12,text:'Synthetic note'})}},
   ]};
  };
  const body=f.chat('tools','tool-replay-request-01',course?0:undefined);
  const original=await f.events(await f.request('/api/jobs/tools/chat','POST',body));
  assert.equal(original.at(-1).type,'done');const before=(await f.db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE job_id='tools'").first<any>()).n;assert.equal(before,1);
  const replay=await f.events(await f.request('/api/jobs/tools/chat','POST',body));
  assert.equal(replay[0].type,'tool_calls');assert.deepEqual(replay[0].calls,[{id:'seek-tool',name:'seek',args:{seconds:12}}]);
  assert.equal(replay.at(-1).replayed,true);assert.equal(calls,1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE job_id='tools'").first<any>()).n,1);
 }
});

test('authenticated accounts retain fifty successful daily chat turns and failed turns release their place',async()=>{
 const f=await setup(), now=Date.now(), day=new Date(now).toISOString().slice(0,10);
 for(let i=0;i<49;i++) await f.db.prepare(`INSERT INTO app_operations(id,subject,kind,idempotency_key,fingerprint,day,state,phase,deadline,created_at,updated_at)
 VALUES(?,?,'chat',?,'fixture',?,'succeeded','chat',?,?,?)`).bind(`daily-${i}`,alice,`daily-member-chat-${i}`,day,now+100000,now-120000,now-120000).run();
 const failed=await reserveAssistant(f.env,alice,null,'chat','daily-failure-request-01','job',{});
 await assistantReceipt(f.env,failed.operation).failed();
 assert.equal((await listeningUsage(f.db,alice)).remainingTurns,1);
 const last=await reserveAssistant(f.env,alice,null,'chat','daily-final-request-001','job',{});
 await assistantReceipt(f.env,last.operation).complete('Complete reply');
 assert.equal((await listeningUsage(f.db,alice)).remainingTurns,0);
 await assert.rejects(reserveAssistant(f.env,alice,null,'chat','daily-over-cap-request-1','job',{}),{code:'chat_daily_limit'});
 await reserveAssistant(f.env,alice,null,'guide','daily-cue-independent-01','job',{});
});
