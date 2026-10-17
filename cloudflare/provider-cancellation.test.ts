import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import { beginAttempt, readOperation, reserveOperation } from '../src/reliability/ledger.ts';
import { cancelOperation, claimNext, recoverExpired, transition } from '../src/reliability/queue.ts';
import { drainSplitQueue, operationWebhook, recoverCallback, reconcileSplit } from '../src/reliability/splits.ts';
import { MPEGDecoder } from 'mpg123-decoder';
import { validateMp3Pcm } from '../src/reliability/media.ts';
import { splitAllowance } from '../src/daily-allowance.ts';
import { courseFixture } from './course-fixture.ts';
import app, { runReliableJobs } from '../src/index.ts';

const subject='cail-'+ 'e'.repeat(32);
async function setup(t:{after:(f:()=>void)=>void}) {
 const directory=mkdtempSync(join(tmpdir(),'stem-recovery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const local=new SqliteD1(join(directory,'db'));local.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const db=local as unknown as D1Database;await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
 const env={DB:db,AUDIO:new FsR2Bucket(join(directory,'audio')),AUTH_MODE:'cail',SEPARATION_BACKEND:'replicate',LOCAL_HOSTING:'true',
  PUBLIC_BASE_URL:'https://split.test',WEBHOOK_SECRET:'fixture-only',REPLICATE_API_TOKEN:'mock-only',REPLICATE_MODEL_VERSION:'separator-pin',REPLICATE_YT_MODEL_VERSION:'import-pin',
  validateStemAudio:(data:ArrayBuffer)=>validateMp3Pcm(data,()=>new MPEGDecoder()),
  ADMISSION_RESOLVER:{resolveCourseAccess:({subject,classId}:{subject:string;classId:string})=>courseFixture(subject,classId)}} as unknown as Env;
 async function split(key='test-operation-0001',phase:'fetch'|'split'='split') {
  const id=crypto.randomUUID();
  return (await reserveOperation(db,{subject,role:'student',courseId:null,kind:'split',key,fingerprint:key,phase,jobId:id,
   request:{sourceType:phase==='fetch'?'youtube':'upload',youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk',filename:'private fixture',model:'htdemucs_ft',key:'uploads/fixture/audio.wav'},
   statements:op=>[db.prepare("INSERT INTO jobs(id,filename,source_key,status,model) SELECT id,'private fixture','uploads/fixture/audio.wav','queued','htdemucs_ft' FROM app_operations WHERE id=?").bind(op)]})).operation;
 }
 return {db,env,split,directory};
}


import { replicateBackend, cancelReplicatePrediction } from '../src/separation/replicate.ts';

test('separator preserves existing runtime policy; browser fields cannot supply a new cutoff',async t=>{
 const {env}=await setup(t);let creates=0;
 t.mock.method(globalThis,'fetch',async(_url:any,init?:RequestInit)=>{
  creates++;assert.equal(new Headers(init?.headers).get('Cancel-After'),null);
  const body=JSON.parse(String(init?.body));assert.equal(body.version,'separator-pin');assert.equal(body.input.model,'htdemucs_ft');
  assert.equal(body.cancelAfter,undefined);return Response.json({id:'prediction'});
 });
 await replicateBackend(env).start({jobId:'job',audioUrl:'https://split.test/audio',webhookUrl:'https://split.test/callback',cancelAfter:86400} as any);
 assert.equal(creates,1);
});

test('provider cancellation validates IDs, confirms terminal status and never follows provider URLs',async t=>{
 const {env}=await setup(t);const requests:string[]=[];let canceled=false;
 t.mock.method(globalThis,'fetch',async(url:any,init?:RequestInit)=>{
  requests.push(`${init?.method??'GET'} ${url}`);assert.equal(init?.redirect,'manual');
  if(init?.method==='POST'){canceled=true;return Response.json({status:'canceled',urls:{get:'https://untrusted.test'}});}
  return Response.json({id:'prediction',status:canceled?'canceled':'processing'});
 });
 await assert.rejects(cancelReplicatePrediction(env,'../elsewhere'));assert.equal(requests.length,0);
 assert.equal(await cancelReplicatePrediction(env,'prediction'),true);
 assert.deepEqual(requests,['GET https://api.replicate.com/v1/predictions/prediction','POST https://api.replicate.com/v1/predictions/prediction/cancel','GET https://api.replicate.com/v1/predictions/prediction']);
});

for(const terminal of ['succeeded','failed','canceled'])test(`already ${terminal} prediction requires no cancel POST`,async t=>{
 const {env}=await setup(t);let reads=0;
 t.mock.method(globalThis,'fetch',async(_url:any,init?:RequestInit)=>{assert.notEqual(init?.method,'POST');reads++;return Response.json({id:'prediction',status:terminal});});
 assert.equal(await cancelReplicatePrediction(env,'prediction'),true);assert.equal(reads,1);
});

for(const phase of ['fetch','split'] as const)test(`${phase} cancellation retains reservation until terminal and refunds once without another submission`,async t=>{
 const {db,env,split}=await setup(t);const op=await split('cancel-active-operation',phase);
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(op.id).run();
 await db.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(op.id).run();
 await cancelOperation(db,op.id,subject);
 let terminal=false,cancels=0,creates=0,downloads=0;
 t.mock.method(globalThis,'fetch',async(url:any,init?:RequestInit)=>{
  if(String(url)==='https://api.replicate.com/v1/predictions'){creates++;throw Error('must never create');}
  if(!String(url).startsWith('https://api.replicate.com/')){downloads++;throw Error('must not download cancelled output');}
  if(init?.method==='POST'){cancels++;return Response.json({status:'canceled'});}
  return Response.json({id:'prediction',status:terminal?'canceled':'processing'});
 });
 await Promise.all([reconcileSplit(env,(await readOperation(db,op.id))!,async()=>assert.fail('cancelled result ingested')),reconcileSplit(env,(await readOperation(db,op.id))!,async()=>assert.fail('duplicate completion'))]);
 assert.equal(cancels,1);assert.equal((await splitAllowance(db,subject)).inProgress,1,'acknowledgement is not terminal proof');
 terminal=true;await db.prepare('UPDATE app_operations SET not_before=0 WHERE id=?').bind(op.id).run();
 await runReliableJobs(env);await runReliableJobs(env);
 const final=(await readOperation(db,op.id))!;assert.equal(final.state,'cancelled');assert.equal(final.provider_id,'prediction');
 const usage=await splitAllowance(db,subject);assert.equal(usage.inProgress,0);assert.equal(usage.completed,0);assert.equal(usage.remaining,15);
 assert.equal(creates,0);assert.equal(downloads,0);assert.equal(cancels,1);
});

for(const failure of ['timeout','429','503','404','wrong-id','unknown-status'])test(`uncertain cancellation ${failure} retains exact prediction and allowance`,async t=>{
 const {db,env,split}=await setup(t);const op=await split();
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(op.id).run();await cancelOperation(db,op.id,subject);
 let creates=0,reads=0;
 t.mock.method(globalThis,'fetch',async(url:any,init?:RequestInit)=>{
  if(init?.method!=='POST' && ++reads===1)return Response.json({id:'prediction',status:'processing'});
  if(String(url).endsWith('/predictions')&&init?.method==='POST')creates++;
  if(failure==='timeout')throw new DOMException('Timed out','TimeoutError');
  if(['429','503','404'].includes(failure))return new Response('',{status:Number(failure),headers:{'Retry-After':'90'}});
  return Response.json({id:failure==='wrong-id'?'other':'prediction',status:failure==='unknown-status'?'unknown':'canceled'});
 });
 const before=Date.now();await runReliableJobs(env);await runReliableJobs(env);
 const current=(await readOperation(db,op.id))!;assert.equal(current.provider_id,'prediction');assert.equal(current.state,'processing');
 assert.equal((await splitAllowance(db,subject)).inProgress,1);assert.equal((await splitAllowance(db,subject)).completed,0);assert.equal(creates,0);
 if(failure==='429')assert.ok(current.not_before>=before+90000);
});

test('completion racing cancel refusal is verified then refunded without downloading',async t=>{
 const {db,env,split}=await setup(t);const op=await split();await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(op.id).run();await cancelOperation(db,op.id,subject);
 let canceled=false;
 t.mock.method(globalThis,'fetch',async(_url:any,init?:RequestInit)=>{if(init?.method==='POST'){canceled=true;return new Response('',{status:409});}return Response.json({id:'prediction',status:canceled?'succeeded':'processing',output:{vocals:'https://must-not-download.test'}});});
 await runReliableJobs(env);assert.equal((await readOperation(db,op.id))?.state,'cancelled');assert.equal((await splitAllowance(db,subject)).remaining,15);
});

test('cancel arriving during status read discards terminal success before ingestion',async t=>{
 const {db,env,split}=await setup(t);const op=await split();await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(op.id).run();
 t.mock.method(globalThis,'fetch',async()=>{await cancelOperation(db,op.id,subject);return Response.json({id:'prediction',status:'succeeded',output:{}});});
 await reconcileSplit(env,(await readOperation(db,op.id))!,async()=>assert.fail('late cancellation must fence ingestion'));
 assert.equal((await readOperation(db,op.id))?.state,'cancelled');assert.equal((await splitAllowance(db,subject)).completed,0);
});

test('cancel during source preparation fences the paid attempt; queued cancellation never POSTs',async t=>{
 const {db,env,split}=await setup(t);const op=await split();const claimed=(await claimNext(db,'split'))!;
 await transition(db,claimed,'starting');await cancelOperation(db,op.id,subject);
 await assert.rejects(beginAttempt(db,claimed,'replicate','separator-pin'));
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
 await recoverExpired(db,claimed.lease_until+1);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('no provider call allowed');});
 await runReliableJobs(env);assert.equal(calls,0);assert.equal((await splitAllowance(db,subject)).remaining,15);
});

test('lost start followed by cancellation adopts the confirmed callback ID and never recreates it',async t=>{
 const {db,env,split}=await setup(t);const op=await split();let creates=0,terminal=false;
 t.mock.method(globalThis,'fetch',async(url:any,init?:RequestInit)=>{
  if(String(url).endsWith('/predictions')&&init?.method==='POST'){creates++;assert.equal(new Headers(init.headers).get('Cancel-After'),null);throw Error('response lost after acceptance');}
  if(String(url).endsWith('/cancel')){terminal=true;return new Response(null,{status:202});}
  return Response.json({id:'accepted',status:terminal?'canceled':'processing',version:'separator-pin',webhook:operationWebhook(env,op.id,'split')});
 });
 await runReliableJobs(env);await cancelOperation(db,op.id,subject);await recoverExpired(db,Date.now()+300001);
 await runReliableJobs(env);assert.equal(creates,1);assert.equal((await splitAllowance(db,subject)).inProgress,1);
 await recoverCallback(env,(await readOperation(db,op.id))!,'accepted');await runReliableJobs(env);await runReliableJobs(env);
 assert.equal(creates,1);assert.equal((await readOperation(db,op.id))?.state,'cancelled');assert.equal((await splitAllowance(db,subject)).remaining,15);
});

test('provider deadline cancellation releases a guest place without recording a successful split',async t=>{
 const {db,env}=await setup(t);const guest=`guest-${'b'.repeat(64)}`,now=Date.now();
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now,now+86400000,new Date().toISOString().slice(0,10)).run();
 const id=crypto.randomUUID();const {operation}=await reserveOperation(db,{subject:guest,quotaClass:'guest',courseId:null,kind:'split',key:'guest-deadline-test-01',fingerprint:'guest-deadline',phase:'split',jobId:id,
 statements:op=>[db.prepare("INSERT INTO jobs(id,filename,source_key,status,model) SELECT id,'fixture','uploads/fixture/audio.wav','processing','htdemucs_ft' FROM app_operations WHERE id=?").bind(op)]});
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(operation.id).run();
 t.mock.method(globalThis,'fetch',async(_url:any,init?:RequestInit)=>{assert.notEqual(init?.method,'POST');return Response.json({id:'prediction',status:'canceled'});});
 await runReliableJobs(env);await runReliableJobs(env);
 const usage=await splitAllowance(db,guest,new Date(),'guest');assert.equal(usage.remaining,5);assert.equal(usage.completed,0);assert.equal(usage.inProgress,0);
 assert.equal((await readOperation(db,operation.id))?.state,'failed');
});

test('cancel HTTP route forwards promptly, preserves ownership, and starts no other queued job',async t=>{
 const {db,env,split}=await setup(t);const now=Date.now(),guest=`guest-${'c'.repeat(64)}`;
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now,now+86400000,'1970-01-01').run();
 const id=crypto.randomUUID();const {operation}=await reserveOperation(db,{subject:guest,quotaClass:'guest',courseId:null,kind:'split',key:'guest-http-cancel-01',fingerprint:'guest-cancel',phase:'split',jobId:id,
 statements:op=>[db.prepare("INSERT INTO jobs(id,filename,source_key,status,model) SELECT id,'fixture','uploads/fixture/audio.wav','processing','htdemucs_ft' FROM app_operations WHERE id=?").bind(op)]});
 await db.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind(operation.id,guest).run();
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction',not_before=? WHERE id=?").bind(now+5000,operation.id).run();
 const other=await split('unrelated-queued-job');let cancels=0,done=false;
 t.mock.method(globalThis,'fetch',async(url:any,init?:RequestInit)=>{
  assert.notEqual(String(url),'https://api.replicate.com/v1/predictions','cancel must not create unrelated paid work');
  if(init?.method==='POST'){cancels++;done=true;return new Response(null,{status:202});}
  return Response.json({id:'prediction',status:done?'canceled':'processing'});
 });
 const request=(jobId:string)=>app.fetch(new Request(`https://split.test/api/jobs/${jobId}/cancel`,{method:'POST',headers:{Origin:'https://split.test','Content-Type':'application/json'}}),
  {...env,guestRuntimeReady:true,guestSession:{subject:guest,expiresAt:now+86400000,verifiedDay:'1970-01-01'}});
 assert.equal((await request(other.id)).status,404);assert.equal(cancels,0);
 assert.equal((await request(operation.id)).status,200);assert.equal(cancels,1);
 assert.equal((await readOperation(db,other.id))?.state,'queued');assert.equal((await readOperation(db,operation.id))?.state,'cancelled');
 assert.equal((await splitAllowance(db,guest,new Date(),'guest')).remaining,5);
 assert.equal((await request(operation.id)).status,200);assert.equal(cancels,1,'duplicate cancellation is settled locally');
});

test('cancel during stem storage cannot publish late success and removes uncommitted stems',async t=>{
 const {db,env,split}=await setup(t);const op=await split();await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(op.id).run();
 await db.prepare("UPDATE jobs SET status='processing',external_id='prediction' WHERE id=?").bind(op.id).run();
 const fixture=readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
 t.mock.method(globalThis,'fetch',async(url:any,init?:RequestInit)=>{
  assert.notEqual(init?.method,'POST');
  if(String(url).startsWith('https://api.replicate.com/'))return Response.json({id:'prediction',status:'succeeded',output:Object.fromEntries(['vocals','drums','bass','other'].map(name=>[name,`https://fixtures.replicate.delivery/${name}.mp3`]))});
  return new Response(fixture,{headers:{'Content-Type':'audio/mpeg'}});
 });
 const keys:string[]=[],put=env.AUDIO.put.bind(env.AUDIO);
 t.mock.method(env.AUDIO,'put',async(key:string,...args:any[])=>{keys.push(key);const result=await (put as any)(key,...args);await cancelOperation(db,op.id,subject);return result;});
 await runReliableJobs(env);assert.equal((await readOperation(db,op.id))?.state,'cancelled');
 assert.ok(keys.length>0);for(const key of keys)assert.equal(await env.AUDIO.head(key),null);
 assert.equal((await splitAllowance(db,subject)).remaining,15);
});

test('cancellation after committed success does not refund or alter completed work',async t=>{
 const {db,env,split}=await setup(t);const op=await split();await db.prepare("UPDATE jobs SET status='done' WHERE id=?").bind(op.id).run();
 t.mock.method(globalThis,'fetch',async()=>assert.fail('settled work has no provider request'));
 await cancelOperation(db,op.id,subject);await runReliableJobs(env);
 assert.equal((await readOperation(db,op.id))?.state,'succeeded');assert.equal((await splitAllowance(db,subject)).completed,1);assert.equal((await splitAllowance(db,subject)).remaining,14);
});

test('cancellation while create response is in flight cancels that accepted prediction without replacement',async t=>{
 const {db,env,split}=await setup(t);const op=await split();let creates=0,cancels=0,terminal=false;
 t.mock.method(globalThis,'fetch',async(url:any,init?:RequestInit)=>{
  if(String(url).endsWith('/predictions')&&init?.method==='POST'){
   creates++;await cancelOperation(db,op.id,subject);return Response.json({id:'accepted-in-flight'});
  }
  if(String(url).endsWith('/cancel')){cancels++;terminal=true;return new Response(null,{status:202});}
  return Response.json({id:'accepted-in-flight',status:terminal?'canceled':'processing'});
 });
 await runReliableJobs(env);assert.equal((await readOperation(db,op.id))?.provider_id,'accepted-in-flight');
 await runReliableJobs(env);await runReliableJobs(env);
 assert.equal(creates,1);assert.equal(cancels,1);assert.equal((await readOperation(db,op.id))?.state,'cancelled');
 assert.equal((await splitAllowance(db,subject)).remaining,15);
});

test('cancel arriving during a processing status read reaches the provider in the same reconciliation',async t=>{
 const {db,env,split}=await setup(t);const op=await split();await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(op.id).run();let reads=0,cancels=0;
 t.mock.method(globalThis,'fetch',async(_url:any,init?:RequestInit)=>{
  if(init?.method==='POST'){cancels++;return new Response(null,{status:202});}
  if(++reads===1)await cancelOperation(db,op.id,subject);
  return Response.json({id:'prediction',status:cancels?'canceled':'processing'});
 });
 await reconcileSplit(env,(await readOperation(db,op.id))!,async()=>assert.fail('cancelled result cannot be published'));
 assert.equal(cancels,1);assert.equal((await readOperation(db,op.id))?.state,'cancelled');assert.equal((await splitAllowance(db,subject)).remaining,15);
});
