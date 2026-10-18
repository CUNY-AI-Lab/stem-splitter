import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import { reserveOperation, readOperation } from '../src/reliability/ledger.ts';
import { recoverExpired, claimNext } from '../src/reliability/queue.ts';
import { reconcileSplit } from '../src/reliability/splits.ts';
import { resumeAdaptiveOutput } from '../src/index.ts';
import { splitAllowance } from '../src/daily-allowance.ts';
import worker, { type WorkerEnv } from './worker.ts';
const subject='cail-'+ 'd'.repeat(32);
const names=['vocals','drums','bass','other','guitar','piano'];
async function setup(t:{after:(f:()=>void)=>void}) {
 const root=mkdtempSync(join(tmpdir(),'stem-p0-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const local=new SqliteD1(join(root,'db'));local.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const db=local as unknown as D1Database;await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
 const env={DB:db,AUDIO:new FsR2Bucket(join(root,'audio')),AUTH_MODE:'cail',SEPARATION_BACKEND:'replicate',REPLICATE_API_TOKEN:'fixture-only',validateStemAudio:async()=>true} as unknown as Env;
 async function reserve(key:string) {
  const id=crypto.randomUUID();return (await reserveOperation(db,{subject,courseId:null,kind:'split',key,fingerprint:key,phase:'split',jobId:id,
   request:{sourceType:'upload',model:'htdemucs_6s',filename:'Fixture'},statements:op=>[db.prepare("INSERT INTO jobs(id,filename,source_key,status,model,routing_request) SELECT id,'Fixture','uploads/fixture/audio.mp3','queued','htdemucs_6s','adaptive:4' FROM app_operations WHERE id=?").bind(op)]})).operation;
 }
 return {db,env,reserve};
}
for(const state of ['queued','running','starting','processing','reconciling'] as const)test(`deadline sweep settles ${state} work once and releases the global slot`,async t=>{
 const {db,env,reserve}=await setup(t);const expired=await reserve('expired-request-'+state),next=await reserve('following-request-'+state);const now=Date.now();
 await db.prepare("UPDATE app_operations SET state=?,deadline=?,lease_owner='old-worker',lease_until=?,not_before=? WHERE id=?").bind(state,now-1,now+300000,now+3600000,expired.id).run();
 await db.prepare("UPDATE jobs SET status='ingesting',error='ingesting:1:old-worker' WHERE id=?").bind(expired.id).run();
 await recoverExpired(db,now);await recoverExpired(db,now+1);
 const done=(await readOperation(db,expired.id))!;assert.equal(done.state,'failed');assert.equal(done.error_code,'deadline_exceeded');assert.equal(done.lease_until,0);
 assert.match((await db.prepare('SELECT error FROM jobs WHERE id=?').bind(expired.id).first<{error:string}>())!.error,/No allowance was used\./);
 assert.equal((await splitAllowance(db,subject)).inProgress,1);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM operation_events WHERE operation_id=? AND quota_effect='released'").bind(expired.id).first<{n:number}>())!.n,1);
 assert.equal((await claimNext(db,'split',now+2))!.id,next.id);
 t.mock.method(globalThis,'fetch',async()=>assert.fail('Expired queue delivery must never fetch a provider'));
 assert.equal(await resumeAdaptiveOutput(env,expired.id),true);
 // A stale callback cannot revive the terminal job or spend another attempt.
 await reconcileSplit(env,done,async()=>assert.fail('Expired job cannot publish'));
});
function mockAudio(t:any) {
 const bytes=readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>String(input).startsWith('https://api.replicate.com/')
  ? Response.json({id:'p0-prediction',status:'succeeded',output:Object.fromEntries(names.map(name=>[name,`https://fixture.replicate.delivery/${name}.mp3`]))})
  : new Response(bytes,{headers:{'content-type':'audio/mpeg'}}));
}
test('expired queue delivery settles locally despite an active lease and future provider cooldown',async t=>{
 const {db,env,reserve}=await setup(t),op=await reserve('expired-queue-delivery');const now=Date.now();
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='existing-prediction',deadline=?,lease_owner='busy',lease_until=?,not_before=? WHERE id=?")
  .bind(now-1,now+300000,now+3600000,op.id).run();
 await db.prepare("UPDATE jobs SET status='ingesting',error='ingesting:1:busy' WHERE id=?").bind(op.id).run();
 await db.prepare("INSERT INTO provider_cooldowns(provider,until_ms) VALUES('replicate',?)").bind(now+3600000).run();
 const stale=(await readOperation(db,op.id))!;
 t.mock.method(globalThis,'fetch',async()=>assert.fail('Expired jobs must settle without provider requests'));
 assert.equal(await resumeAdaptiveOutput(env,op.id),true);
 await reconcileSplit(env,stale,async()=>assert.fail('Stale worker cannot publish'));
 assert.equal((await readOperation(db,op.id))!.state,'failed');
 assert.equal((await splitAllowance(db,subject)).inProgress,0);
});
test('deadline crossing during provider reconciliation settles before the next poll',async t=>{
 const {db,env,reserve}=await setup(t),op=await reserve('deadline-during-status');let now=Date.now();const deadline=now+30000;
 t.mock.method(Date,'now',()=>now);
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='existing-prediction',deadline=? WHERE id=?").bind(deadline,op.id).run();
 await db.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(op.id).run();
 t.mock.method(globalThis,'fetch',async()=>{now=deadline;return Response.json({id:'existing-prediction',status:'processing'});});
 assert.equal(await resumeAdaptiveOutput(env,op.id),true);
 assert.equal((await readOperation(db,op.id))!.state,'failed');
});
test('deadline passing mid-composition terminates the retry and frees the next split',async t=>{
 const {db,env,reserve}=await setup(t),expired=await reserve('deadline-in-composition'),next=await reserve('after-composition-expiry');
 let now=Date.now();const deadline=now+30000;t.mock.method(Date,'now',()=>now);mockAudio(t);
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='p0-prediction',deadline=? WHERE id=?").bind(deadline,expired.id).run();
 await db.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(expired.id).run();
 env.composeStemAudio=async input=>{now=deadline;await input.checkpoint!();throw new Error('expired checkpoint must throw');};
 assert.equal(await resumeAdaptiveOutput(env,expired.id),true);
 assert.equal((await readOperation(db,expired.id))!.state,'failed');
 assert.equal((await claimNext(db,'split',now))!.id,next.id);
 assert.equal((await env.AUDIO.list()).objects.length,0,'Partial output must be cleaned');
});
test('deadline passing just before publication fails without waiting for a lease timeout',async t=>{
 const {db,env,reserve}=await setup(t),op=await reserve('deadline-at-publication');let now=Date.now();const deadline=now+30000;
 t.mock.method(Date,'now',()=>now);mockAudio(t);
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='p0-prediction',deadline=? WHERE id=?").bind(deadline,op.id).run();
 await db.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(op.id).run();
 env.composeStemAudio=async()=>{now=deadline;return {plan:{parts:6,model:'htdemucs_6s'},stored:[]} as any;};
 assert.equal(await resumeAdaptiveOutput(env,op.id),true);
 assert.equal((await readOperation(db,op.id))!.state,'failed');
 assert.equal((await env.AUDIO.list()).objects.length,0);
});
test('unexpired storage failures remain retryable on the same provider prediction',async t=>{
 const {db,env,reserve}=await setup(t),op=await reserve('unexpired-output-outage');mockAudio(t);
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='p0-prediction' WHERE id=?").bind(op.id).run();
 await db.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(op.id).run();
 env.composeStemAudio=async()=>{throw new Error('untrusted https://x.test/?token=secret-value');};
 const logs:string[]=[];t.mock.method(console,'error',(line:unknown)=>logs.push(String(line)));
 assert.equal(await resumeAdaptiveOutput(env,op.id),false);
 const current=(await readOperation(db,op.id))!;assert.equal(current.state,'processing');assert.equal(current.provider_id,'p0-prediction');
 assert.ok(logs.some(line=>JSON.parse(line).event==='split_reconcile_failed'));
 assert.ok(logs.every(line=>!line.includes('secret-value')&&!line.includes('https://')));
});
test('queue failures log safe structured diagnostics and retry',async t=>{
 const logs:string[]=[];t.mock.method(console,'error',(line:unknown)=>logs.push(String(line)));let delay=0;
 const jobId=crypto.randomUUID();const env={DB:{prepare(){throw new Error('Bearer secret-token https://x.test/?token=secret-token');}}} as unknown as WorkerEnv;
 await worker.queue({messages:[{body:{jobId},ack:()=>assert.fail('failure must retry'),retry:(o:{delaySeconds:number})=>delay=o.delaySeconds}]} as unknown as MessageBatch,env);
 assert.equal(delay,30);assert.equal(logs.length,1);const event=JSON.parse(logs[0]);
 assert.equal(event.event,'adaptive_queue_failed');assert.equal(event.jobId,jobId);assert.equal(event.stage,'adaptive_output');
 assert.equal(event.errorName,'Error');assert.ok(event.message);assert.doesNotMatch(logs[0],/secret-token|https:\/\/|Bearer/);
});
test('adaptive queue retries have a separate durable dead-letter destination',()=>{
 const config=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8'));
 const consumer=config.queues.consumers.find((c:any)=>c.queue==='cail-stem-splitter-adaptive-output');
 assert.equal(consumer.dead_letter_queue,'cail-stem-splitter-adaptive-output-dlq');assert.notEqual(consumer.dead_letter_queue,consumer.queue);
});
