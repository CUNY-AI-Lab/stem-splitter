import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import { beginAttempt, finishAttempt, readOperation, reserveOperation, settleOperation } from '../src/reliability/ledger.ts';
import { cancelOperation, claimNext, recoverExpired, transition } from '../src/reliability/queue.ts';
import { drainSplitQueue, operationWebhook, recoverCallback, reconcileSplit } from '../src/reliability/splits.ts';
import { purgeOperationContent } from '../src/reliability/retention.ts';
import { assistantReceipt, reserveAssistant } from '../src/reliability/assistant.ts';
import { MPEGDecoder } from 'mpg123-decoder';
import { validMp3Frames, mp3FrameInfo, validateMp3Pcm } from '../src/reliability/media.ts';
import { splitAllowance, operationAllowance } from '../src/daily-allowance.ts';
import { courseFixture } from './course-fixture.ts';
import { runReliableJobs } from '../src/index.ts';

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

test('expiry before attempt fences the stale runner; accepted response after expiry is adopted without another start',async t=>{
 const {db,split}=await setup(t);await split();const old=(await claimNext(db,'split'))!;
 await transition(db,old,'starting');await recoverExpired(db,old.lease_until+1);
 await assert.rejects(beginAttempt(db,old,'replicate','separator-pin'));
 const next=(await claimNext(db,'split'))!;await transition(db,next,'starting');
 const attempt=await beginAttempt(db,next,'replicate','separator-pin');await recoverExpired(db,next.lease_until+1);
 await finishAttempt(db,attempt,'accepted',{externalId:'paid-start'});
 assert.equal(await transition(db,next,'processing',{providerId:'paid-start'}),false);
 await recoverExpired(db,next.lease_until+2);const recovered=(await readOperation(db,next.id))!;
 assert.equal(recovered.provider_id,'paid-start');assert.equal(recovered.state,'reconciling');assert.equal(await claimNext(db,'split'),null);
});

test('queued cancellation releases once; unknown cancellation prevents deletion and rejects late success',async t=>{
 const {db,split}=await setup(t);const queued=await split();await cancelOperation(db,queued.id,subject);await cancelOperation(db,queued.id,subject);
 assert.equal((await readOperation(db,queued.id))!.state,'cancelled');await db.prepare('DELETE FROM jobs WHERE id=?').bind(queued.id).run();
 const accepted=await split('test-operation-0002');const lease=(await claimNext(db,'split'))!;await transition(db,lease,'starting');await beginAttempt(db,lease,'replicate','separator-pin');
 await recoverExpired(db,lease.lease_until+1);await cancelOperation(db,accepted.id,subject);
 await assert.rejects(db.prepare('DELETE FROM jobs WHERE id=?').bind(accepted.id).run());
 await assert.rejects(db.prepare("UPDATE jobs SET status='done' WHERE id=?").bind(accepted.id).run());
 assert.equal((await splitAllowance(db,subject)).inProgress,1);
 await db.prepare("UPDATE jobs SET status='failed' WHERE id=?").bind(accepted.id).run();
 await db.prepare("UPDATE jobs SET status='failed' WHERE id=?").bind(accepted.id).run();assert.equal((await splitAllowance(db,subject)).remaining,15);
});

test('provider 429 observes full cooldown, confirmed 402 releases, 5xx/network stay uncertain and cannot replay',async t=>{
 for(const status of [429,402,503,0]) {
  const {db,env,split}=await setup(t);const op=await split();let posts=0;
  const mock=t.mock.method(globalThis,'fetch',async()=>{posts++;if(!status)throw new Error('lost response');return new Response('',{status,headers:{'Retry-After':'90'}});});
  const before=Date.now();await drainSplitQueue(env,async()=>{});const state=(await readOperation(db,op.id))!;
  assert.equal(state.state,status===429?'queued':status===402?'failed':'reconciling');
  if(status===429){assert.ok(state.not_before>=before+90000);assert.equal(await claimNext(db,'split',before+89999),null);}
  await drainSplitQueue(env,async()=>{});assert.equal(posts,1);
  const count=await splitAllowance(db,subject);assert.equal(count.completed,0);assert.equal(count.inProgress,status===402?0:1);mock.mock.restore();
 }
});

test('unknown callback requires matching phase/version and durable attempt; duplicate callback and polls settle once',async t=>{
 const {db,env,split}=await setup(t);const op=await split();const lease=(await claimNext(db,'split'))!;
 await transition(db,lease,'starting');await beginAttempt(db,lease,'replicate','separator-pin');await recoverExpired(db,lease.lease_until+1);
 let version='import-pin',phase:'fetch'|'split'='fetch',reads=0;
 t.mock.method(globalThis,'fetch',async()=>{reads++;return Response.json({id:'candidate',webhook:operationWebhook(env,op.id,phase),version,status:'succeeded',output:{}});});
 await recoverCallback(env,(await readOperation(db,op.id))!,'candidate');assert.equal((await readOperation(db,op.id))!.provider_id,null);
 phase='split';await recoverCallback(env,(await readOperation(db,op.id))!,'candidate');assert.equal((await readOperation(db,op.id))!.provider_id,null);
 version='separator-pin';await recoverCallback(env,(await readOperation(db,op.id))!,'candidate');const accepted=(await readOperation(db,op.id))!;assert.equal(accepted.provider_id,'candidate');
 await recoverCallback(env,accepted,'candidate');assert.equal(reads,3);
 let completed=0;const finish=async()=>{completed++;await db.prepare("UPDATE jobs SET status='done' WHERE id=?").bind(op.id).run();};
 await Promise.all([reconcileSplit(env,accepted,finish),reconcileSplit(env,accepted,finish)]);
 assert.equal(completed,1);assert.equal((await splitAllowance(db,subject)).completed,1);
});

test('ninety-day purge redacts private request/cache content but preserves an uncertain reservation and cost evidence',async t=>{
 const {db,split}=await setup(t);const op=await split();const lease=(await claimNext(db,'split'))!;await transition(db,lease,'starting');
 const attempt=await beginAttempt(db,lease,'replicate','separator-pin');await finishAttempt(db,attempt,'uncertain',{code:'lost_response'});
 await recoverExpired(db,lease.lease_until+1);
 await db.prepare("INSERT INTO import_cache(scope,source,operation_id,object_key,metadata_json,expires_at) VALUES('scope','source',?,'private/key','private title',?)").bind(op.id,Date.now()+1000).run();
 await purgeOperationContent(db,op.created_at+90*86400000+1);const remaining=(await readOperation(db,op.id))!;
 assert.equal(remaining.request_json,'{}');assert.equal(remaining.result_json,null);assert.equal(remaining.cancel_requested,1);assert.equal(remaining.state,'reconciling');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM import_cache').first<{n:number}>())!.n,0);
 assert.equal((await db.prepare('SELECT outcome FROM operation_attempts WHERE id=?').bind(attempt).first<{outcome:string}>())!.outcome,'uncertain');
});

test('chat receipts never copy content; failure releases, partial/unknown count once, settled replay cannot call a model',async t=>{
 const {db,env}=await setup(t);
 const first=await reserveAssistant(env,subject,null,'chat','human-message-0001','job',[]);const receipt=assistantReceipt(env,first.operation);
 await receipt.delta('Secret transcript');await receipt.failed();await assert.rejects(receipt.complete('Late secret'),/input ended/);
 assert.equal((await readOperation(db,first.operation.id))!.state,'partial');assert.doesNotMatch((await readOperation(db,first.operation.id))!.result_json!,/Secret|Late/);
 await assert.rejects(reserveAssistant(env,subject,null,'chat','human-message-0001','job',[]),/already accepted/);
 const second=await reserveAssistant(env,subject,null,'chat','human-message-0002','job',[]);await assistantReceipt(env,second.operation).failed();
 const third=await reserveAssistant(env,subject,null,'chat','human-message-0003','job',[]);await recoverExpired(db,Date.now()+90001);
 assert.equal((await readOperation(db,third.operation.id))!.error_code,'no_usable_response');
 await assert.rejects(assistantReceipt(env,third.operation).delta('Late output'));
 const fourth=await reserveAssistant(env,subject,null,'chat','human-message-0004','job',[]);await assistantReceipt(env,fourth.operation).effect();await recoverExpired(db,Date.now()+90001);
 assert.equal((await readOperation(db,fourth.operation.id))!.error_code,'delivery_uncertain');assert.equal((await operationAllowance(db,subject,'chat')).completed,2);
 await assert.rejects(assistantReceipt(env,fourth.operation).complete('Late usable result'),/input ended/);
 const fifth=await reserveAssistant(env,subject,null,'chat','human-message-0005','job',[]);
 await assert.rejects(assistantReceipt(env,fifth.operation).complete('  '),/could not finish/);
 assert.equal((await readOperation(db,fifth.operation.id))!.state,'failed');
});

test('mocked lifecycle rejects empty/corrupt audio, failed storage and cancelled/failed predictions without a successful charge',async t=>{
 const fixture=readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
 for(const mode of ['empty','corrupt','storage','failed','cancelled','success']) {
  const {db,env,split}=await setup(t);const operation=await split();let posts=0;
  const mock=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
   if(init?.method==='POST'){posts++;return Response.json({id:'prediction'});}
   if(String(input).startsWith('https://api.replicate.com/'))return Response.json({id:'prediction',status:mode==='failed'?'failed':'succeeded',output:Object.fromEntries(['vocals','drums','bass','other'].map(name=>[name,`https://fixtures.replicate.delivery/${name}.mp3`]))});
   return new Response(mode==='empty'?new Uint8Array():mode==='corrupt'?new Uint8Array([255,251,144,0]):fixture,{headers:{'Content-Type':'audio/mpeg'}});
  });
  let storage:ReturnType<typeof t.mock.method>|undefined;
  if(mode==='storage')storage=t.mock.method(env.AUDIO,'put',async()=>{throw new Error('simulated R2 unavailable');});
  await runReliableJobs(env);if(mode==='cancelled')await cancelOperation(db,operation.id,subject);await runReliableJobs(env);await runReliableJobs(env);
  assert.equal(posts,1);const op=(await readOperation(db,operation.id))!;
  assert.equal(op.state,mode==='success'?'succeeded':mode==='cancelled'?'cancelled':'failed',mode);
  const usage=await splitAllowance(db,subject);assert.equal(usage.completed,mode==='success'?1:0,mode);assert.equal(usage.inProgress,0,mode);
  mock.mock.restore();storage?.mock.restore();
 }
});

test('frame validation rejects truncation but documents its inability to establish PCM decodability',async t=>{
 const {directory}=await setup(t);const audio=readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
 assert.ok(validMp3Frames(audio.buffer.slice(audio.byteOffset,audio.byteOffset+audio.length) as ArrayBuffer));
 assert.equal(validMp3Frames(audio.buffer.slice(audio.byteOffset,audio.byteOffset+audio.length-17) as ArrayBuffer),false);
 // Valid MPEG-1 Layer III 128kbps/44.1kHz headers; deliberately impossible
 // side information. The structural checker accepts it; a real decoder fails.
 const corrupt=Buffer.alloc(417*8,255);for(let i=0;i<8;i++)corrupt.set([255,251,144,0],417*i);
 assert.equal(validMp3Frames(corrupt.buffer.slice(corrupt.byteOffset,corrupt.byteOffset+corrupt.length) as ArrayBuffer),true);
 assert.equal(mp3FrameInfo(corrupt.buffer.slice(corrupt.byteOffset,corrupt.byteOffset+corrupt.length) as ArrayBuffer),null);
 assert.equal(await validateMp3Pcm(corrupt.buffer.slice(corrupt.byteOffset,corrupt.byteOffset+corrupt.length) as ArrayBuffer,()=>new MPEGDecoder()),false);
 const path=join(directory,'corrupt.mp3');writeFileSync(path,corrupt);
 const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-xerror','-i',path,'-f','null','-'],{encoding:'utf8'});
 assert.ifError(result.error);assert.notEqual(result.status,0);assert.match(result.stderr,/invalid|error|Error|decode|backstep|big_values/);
});

test('cron recovers abandoned ingestion and admits the next job without browser polling',async t=>{
 const {db,env,split}=await setup(t),first=await split('orphan-ingestion-001'),next=await split('queued-next-work-002');
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(first.id).run();
 await db.prepare("UPDATE jobs SET status='ingesting',external_id='prediction',error=? WHERE id=?").bind(`ingesting:${Date.now()-600000}:old-worker`,first.id).run();
 let posts=0;t.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{if(init?.method==='POST'){posts++;return Response.json({id:'next-prediction'});}return Response.json({id:'prediction',status:'succeeded',output:{}});});
 await runReliableJobs(env);
 assert.equal((await readOperation(db,first.id))?.state,'failed');
 assert.equal((await readOperation(db,next.id))?.state,'processing');assert.equal(posts,1);
});

test('stale imported audio cleans up only its own object and cannot cancel a newer fenced operation',async t=>{
 const {db,env,split}=await setup(t),op=await split('stale-import-work-01','fetch');
 Object.assign(env,{REPLICATE_API_TOKEN:'fixture-replicate-token',REPLICATE_YT_MODEL:'test/importer',REPLICATE_YT_MODEL_VERSION:'a'.repeat(64)});
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='import-prediction' WHERE id=?").bind(op.id).run();
 await db.prepare("UPDATE jobs SET status='importing' WHERE id=?").bind(op.id).run();
 const data=Buffer.alloc(65536);data.write('ftyp',4);
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>String(input).includes('api.replicate.com')?Response.json({id:'import-prediction',status:'succeeded',output:{audio:'https://fixtures.replicate.delivery/audio.m4a',title:'Fixture',duration:2}}):new Response(data,{headers:{'Content-Type':'audio/mp4'}}));
 const put=env.AUDIO.put.bind(env.AUDIO);let staleKey='';
 t.mock.method(env.AUDIO,'put',async(key:string,...args:any[])=>{staleKey=key;const saved=await (put as any)(key,...args);await db.prepare("UPDATE app_operations SET fence=fence+1,phase='split',state='processing',provider_id='new-separator',lease_owner='new-worker' WHERE id=?").bind(op.id).run();await db.prepare("UPDATE jobs SET status='processing',external_id='new-separator' WHERE id=?").bind(op.id).run();return saved;});
 await reconcileSplit(env,(await readOperation(db,op.id))!,async()=>{});
 const current=(await readOperation(db,op.id))!;assert.equal(current.state,'processing');assert.equal(current.provider_id,'new-separator');assert.equal(current.error_code,null);
 assert.equal(await env.AUDIO.head(staleKey),null);
});

test('missing provider configuration creates no attempt or paid start and releases the reservation',async t=>{
 const {db,env,split}=await setup(t);env.REPLICATE_MODEL_VERSION='';const op=await split('no-provider-pin-0001');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not fetch');});await runReliableJobs(env);
 assert.equal(calls,0);assert.equal((await readOperation(db,op.id))?.state,'failed');assert.equal((await readOperation(db,op.id))?.error_code,'provider_configuration');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>())?.n,0);assert.equal((await splitAllowance(db,subject)).remaining,15);
});

test('separation status429 shares the complete Retry-After floor across queue drains and callbacks',async t=>{
 const {db,env,split}=await setup(t),op=await split('poll-rate-limit-0001');
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='prediction' WHERE id=?").bind(op.id).run();
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:429,headers:{'Retry-After':'120'}});});
 const before=Date.now();await runReliableJobs(env);const current=(await readOperation(db,op.id))!;
 assert.ok(current.not_before>=before+120000);assert.ok((await db.prepare("SELECT until_ms FROM provider_cooldowns WHERE provider='replicate'").first<any>())!.until_ms>=before+120000);
 await runReliableJobs(env);assert.equal(calls,1);
 const {default:app}=await import('../src/index.ts');
 const response=await app.fetch(new Request(operationWebhook(env,op.id,'split'),{method:'POST',body:'{}'}),env);
 assert.equal(response.status,200);assert.equal(calls,1);assert.ok((await readOperation(db,op.id))!.not_before>=before+120000);
});

test('lost final database acknowledgement preserves committed stem objects and charges once',async t=>{
 for(const mode of ['before_commit','lost_ack','lost_ack_read_unavailable']) {
  const {db,env,split}=await setup(t),op=await split(`ingest-commit-${mode}`);const fixture=readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  const mock=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json({id:'prediction'}):String(input).includes('api.replicate.com')?Response.json({id:'prediction',status:'succeeded',output:Object.fromEntries(['vocals','drums','bass','other'].map(name=>[name,`https://fixtures.replicate.delivery/${name}.mp3`]))}):new Response(fixture));
  const prepare=db.prepare.bind(db);let injected=false;
  const dbMock=t.mock.method(db,'prepare',(sql:string)=>{
   if(mode==='lost_ack_read_unavailable'&&injected&&sql.startsWith('SELECT status,stems,error FROM jobs'))throw new Error('reread unavailable');
   const statement=prepare(sql);
   if(sql.includes('SET status = ?, stems = ?')) {
    const bind=statement.bind.bind(statement);statement.bind=(...args:any[])=>{const bound=bind(...args),run=bound.run.bind(bound);bound.run=async()=>{if(!injected){injected=true;if(mode==='before_commit')throw new Error('before commit');await run();throw new Error('lost acknowledgement');}return run();};return bound;};
   }
   return statement;
  });
  await runReliableJobs(env);await runReliableJobs(env);
  const job=await db.prepare('SELECT status,stems FROM jobs WHERE id=?').bind(op.id).first<any>();assert.equal(injected,true);
  assert.equal(job.status,mode.startsWith('lost_ack')?'done':'failed');assert.equal((await splitAllowance(db,subject)).completed,mode.startsWith('lost_ack')?1:0);
  if(mode.startsWith('lost_ack'))for(const stem of JSON.parse(job.stems))assert.ok(await env.AUDIO.head(stem.key),stem.key);
  mock.mock.restore();dbMock.mock.restore();
 }
});

test('a shared provider cooldown fences reconciliation of other operations in both phases',async t=>{
 const {db,env,split}=await setup(t),fetch=await split('shared-floor-fetch-01','fetch'),separate=await split('shared-floor-split-01');
 for(const op of [fetch,separate])await db.prepare("UPDATE app_operations SET state='processing',provider_id='known-provider-id',not_before=0 WHERE id=?").bind(op.id).run();
 await db.prepare("INSERT INTO provider_cooldowns(provider,until_ms) VALUES('replicate',?)").bind(Date.now()+120000).run();
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('shared floor must prevent any network');});
 await runReliableJobs(env);assert.equal(calls,0);
 for(const op of [fetch,separate])assert.equal((await readOperation(db,op.id))!.fence,0);
});

test('a crash after chat reservation but before its running transition releases without usable output',async t=>{
 const {db}=await setup(t);const now=Date.now();
 const {operation}=await reserveOperation(db,{subject,courseId:null,kind:'chat',phase:'chat',key:'queued-chat-crash-01',fingerprint:'input',now});
 await recoverExpired(db,now+89999);assert.equal((await readOperation(db,operation.id))!.state,'queued');
 await recoverExpired(db,now+90001);assert.equal((await readOperation(db,operation.id))!.state,'failed');
 assert.equal((await operationAllowance(db,subject,'chat')).remaining,50);
});
test('a confirmed oversize import releases its allowance and shows the supported limit and upload alternative',async t=>{
 const {db,env,split}=await setup(t),op=await split('oversize-import-0001','fetch');
 env.REPLICATE_YT_MODEL='fixture/import';env.REPLICATE_YT_MODEL_VERSION='a'.repeat(64);env.REPLICATE_API_TOKEN='mock-only-import-token-0000';
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='oversize-fixture' WHERE id=?").bind(op.id).run();
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>String(input).startsWith('https://api.replicate.com/')
  ?Response.json({id:'oversize-fixture',status:'succeeded',output:{audio:'https://fixtures.replicate.delivery/source.m4a',title:'Fixture',duration:240}})
  :new Response(new Uint8Array([0,0,0,24]),{headers:{'Content-Length':String(12*1024*1024+1),'Content-Type':'audio/mp4'}}));
 await reconcileSplit(env,(await readOperation(db,op.id))!,async()=>assert.fail('Import must not reach separation'));
 assert.equal((await readOperation(db,op.id))!.error_code,'audio_too_large');
 const job=await db.prepare('SELECT status,error FROM jobs WHERE id=?').bind(op.id).first<any>();
 assert.equal(job!.status,'failed');assert.match(job!.error,/12 MiB/);assert.match(job!.error,/upload an original or licensed file/);
 assert.equal((await splitAllowance(db,subject)).completed,0);assert.equal((await splitAllowance(db,subject)).inProgress,0);
});

for(const failure of ['503','network','stream-reset','429'])test(`accepted YouTube output recovers from ${failure} using GETs of the same prediction`,async t=>{
 const {db,env,split}=await setup(t),op=await split(`delivery-recovery-${failure}`,'fetch');
 Object.assign(env,{REPLICATE_API_TOKEN:'fixture-replicate-token',REPLICATE_YT_MODEL:'test/importer',REPLICATE_YT_MODEL_VERSION:'a'.repeat(64)});
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='delivery-fixture' WHERE id=?").bind(op.id).run();
 await db.prepare("UPDATE jobs SET status='importing' WHERE id=?").bind(op.id).run();
 const data=new Uint8Array(2048);data.set([0,0,0,24,102,116,121,112]);
 let now=Date.now(),reads=0,downloads=0;
 t.mock.method(Date,'now',()=>now);t.mock.method(console,'error',()=>{});
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  assert.equal(init?.method??'GET','GET');
  if(String(input).startsWith('https://api.replicate.com/')) {
   assert.equal(String(input),'https://api.replicate.com/v1/predictions/delivery-fixture');reads++;
   return Response.json({id:'delivery-fixture',status:'succeeded',output:{audio:'https://fixtures.replicate.delivery/source.m4a',title:'Fixture',duration:19}});
  }
  assert.equal(String(input),'https://fixtures.replicate.delivery/source.m4a');downloads++;
  if(downloads===1) {
   if(failure==='network')throw new Error('Temporary connection failure');
   if(failure==='stream-reset')return new Response(new ReadableStream({start(controller){controller.error(new TypeError('Connection reset'));}}),{headers:{'Content-Type':'audio/mp4'}});
   return new Response('',{status:Number(failure),headers:{'Retry-After':'90'}});
  }
  return new Response(data,{headers:{'Content-Type':'audio/mp4'}});
 });
 const complete=async()=>assert.fail('An import cannot complete separation');
 await reconcileSplit(env,(await readOperation(db,op.id))!,complete);
 let current=(await readOperation(db,op.id))!;
 assert.equal(current.state,'processing');assert.equal(current.phase,'fetch');assert.equal(current.provider_id,'delivery-fixture');
 assert.equal(current.error_code,'import_delivery_unavailable');
 assert.equal(current.deadline,op.deadline);assert.equal((await splitAllowance(db,subject)).inProgress,1);
 assert.ok(current.not_before>=now+(failure==='429'?90000:5000));
 await reconcileSplit(env,current,complete);assert.equal(reads,1);assert.equal(downloads,1);
 now=current.not_before+1;
 await reconcileSplit(env,(await readOperation(db,op.id))!,complete);
 current=(await readOperation(db,op.id))!;
 assert.equal(current.state,'queued');assert.equal(current.phase,'split');assert.equal(current.provider_id,null);
 assert.equal(current.error_code,null);
 assert.equal(current.deadline,op.deadline);assert.equal(reads,2);assert.equal(downloads,2);
 const job=await db.prepare('SELECT source_key,source_hash FROM jobs WHERE id=?').bind(op.id).first<{source_key:string;source_hash:string}>();
 const stored=await env.AUDIO.get(job!.source_key);
 assert.deepEqual(new Uint8Array(await new Response(stored!.body).arrayBuffer()),data);
 const digest=await crypto.subtle.digest('SHA-256',data);
 assert.equal(job!.source_hash,Buffer.from(digest).toString('hex'));
 assert.equal((await splitAllowance(db,subject)).inProgress,1);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts WHERE operation_id=?').bind(op.id).first<{n:number}>())!.n,0);
});

for(const failure of ['denied','delivery-403','invalid-audio','invalid-length','expired'])test(`YouTube ${failure} ends the import without another paid start`,async t=>{
 const {db,env,split}=await setup(t),op=await split(`delivery-terminal-${failure}`,'fetch');
 Object.assign(env,{REPLICATE_API_TOKEN:'fixture-replicate-token',REPLICATE_YT_MODEL:'test/importer',REPLICATE_YT_MODEL_VERSION:'a'.repeat(64)});
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='terminal-fixture',deadline=? WHERE id=?").bind(failure==='expired'?Date.now()-1:op.deadline,op.id).run();
 let reads=0,downloads=0;t.mock.method(console,'error',()=>{});
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  assert.equal(init?.method??'GET','GET');
  if(String(input).startsWith('https://api.replicate.com/')) {
   reads++;return Response.json(failure==='denied'?{id:'terminal-fixture',status:'failed',error:'source_denied_bot_verification'}
    :{id:'terminal-fixture',status:'succeeded',output:{audio:'https://fixtures.replicate.delivery/source.m4a',title:'Fixture',duration:19}});
  }
  downloads++;return failure==='delivery-403'?new Response('',{status:403}):new Response(new Uint8Array(2048),{headers:{'Content-Type':'audio/mp4',...(failure==='invalid-length'?{'Content-Length':'invalid'}:{})}});
 });
 const complete=async()=>assert.fail('Import must not reach separation');
 await reconcileSplit(env,(await readOperation(db,op.id))!,complete);
 const current=(await readOperation(db,op.id))!;
 assert.equal(current.state,'failed');
 assert.equal(current.error_code,{denied:'youtube_source_denied','delivery-403':'youtube_fetch_unavailable','invalid-audio':'invalid_audio_response','invalid-length':'invalid_audio_response',expired:'youtube_fetch_timeout'}[failure]);
 await reconcileSplit(env,current,complete);
 assert.equal(reads,failure==='expired'?0:1);assert.equal(downloads,['denied','expired'].includes(failure)?0:1);
 assert.equal((await splitAllowance(db,subject)).completed,0);assert.equal((await splitAllowance(db,subject)).inProgress,0);
});

for(const failure of ['status-outage','cooldown'])test(`completed extraction expires locally through a later ${failure}`,async t=>{
 const {db,env,split}=await setup(t),op=await split(`delivery-expiry-${failure}`,'fetch');
 Object.assign(env,{REPLICATE_API_TOKEN:'fixture-replicate-token',REPLICATE_YT_MODEL:'test/importer',REPLICATE_YT_MODEL_VERSION:'a'.repeat(64),SPLIT_STARTS_DISABLED:'true'});
 let now=Date.now(),reads=0,downloads=0;const deadline=now+12000;
 t.mock.method(Date,'now',()=>now);t.mock.method(console,'error',()=>{});
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='expiry-fixture',deadline=? WHERE id=?").bind(deadline,op.id).run();
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  assert.equal(init?.method??'GET','GET');assert.ok(now<deadline,'Expiration must settle locally');
  if(String(input).startsWith('https://api.replicate.com/')) {
   reads++;
   if(reads>1)throw new Error('Temporary status outage');
   return Response.json({id:'expiry-fixture',status:'succeeded',output:{audio:'https://fixtures.replicate.delivery/source.m4a',title:'Fixture',duration:19}});
  }
  downloads++;return new Response('',{status:failure==='cooldown'?429:503,headers:{'Retry-After':'90'}});
 });
 const complete=async()=>assert.fail('Import must not reach separation');
 await drainSplitQueue(env,complete);
 let current=(await readOperation(db,op.id))!;
 assert.equal(current.error_code,'import_delivery_unavailable');assert.ok(current.not_before<=deadline);
 now+=5001;await drainSplitQueue(env,complete);
 assert.equal(reads,failure==='cooldown'?1:2);assert.equal(downloads,1);
 current=(await readOperation(db,op.id))!;assert.equal(current.state,'processing');assert.equal(current.error_code,'import_delivery_unavailable');
 const requests=reads+downloads;now=deadline;
 await drainSplitQueue(env,complete);
 current=(await readOperation(db,op.id))!;
 assert.equal(current.state,'failed');assert.equal(current.error_code,'youtube_fetch_timeout');
 assert.equal(reads+downloads,requests);assert.equal((await splitAllowance(db,subject)).inProgress,0);
});

for(const code of ['transient','denied','unknown'])test(`terminal YouTube ${code} obeys bounded durable retry policy`,async t=>{
 const {db,env,split}=await setup(t),op=await split(`fetch-retry-policy-${code}`,'fetch');
 Object.assign(env,{REPLICATE_API_TOKEN:'fixture-replicate-token',REPLICATE_YT_MODEL:'test/importer',REPLICATE_YT_MODEL_VERSION:'a'.repeat(64)});
 let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.method(Math,'random',()=>0);
 t.mock.method(globalThis,'fetch',async()=>Response.json({id:'retry-fixture',status:'failed',error:code==='transient'?'Source download is temporarily unavailable.':code==='denied'?'Source blocked this import.':'Unknown failure'}));
 for(let attempt=1;attempt<=3;attempt++) {
  await db.prepare("UPDATE app_operations SET state='processing',provider_id='retry-fixture',lease_owner=NULL,lease_until=0,not_before=0 WHERE id=?").bind(op.id).run();
  await db.prepare("INSERT INTO operation_attempts(id,operation_id,phase,provider,model,external_id,outcome,created_at,updated_at) VALUES(?,?,'fetch','replicate','fixture','retry-fixture','accepted',?,?)").bind(crypto.randomUUID(),op.id,now,now).run();
  await reconcileSplit(env,(await readOperation(db,op.id))!,async()=>assert.fail('No split before a source exists'));
  const current=(await readOperation(db,op.id))!;
  if(code!=='transient'||attempt===3) {assert.equal(current.state,'failed');break;}
  assert.equal(current.state,'queued',JSON.stringify({attempt,current}));assert.equal(current.provider_id,null);
  assert.ok(current.not_before>=now+16000);assert.equal(current.error_code,'source_fetch_unavailable');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM operation_attempts WHERE operation_id=? AND outcome='accepted'").bind(op.id).first<{n:number}>())!.n,0);
  now=current.not_before+1;
 }
 assert.equal((await splitAllowance(db,subject)).completed,0);
});

test('a retired fetch callback cannot adopt the next uncertain retry',async t=>{
 const {db,env,split}=await setup(t),op=await split('fetch-retry-stale-callback','fetch');
 await db.prepare("UPDATE app_operations SET state='starting' WHERE id=?").bind(op.id).run();
 const now=Date.now();
 for(const [id,external,outcome] of [['old-attempt','retired-prediction','failed'],['new-attempt',null,'uncertain']])
  await db.prepare("INSERT INTO operation_attempts(id,operation_id,phase,provider,model,external_id,outcome,created_at,updated_at) VALUES(?,?,'fetch','replicate','same-model',?,?,?,?)").bind(id,op.id,external,outcome,now,now).run();
 let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('Old prediction must not be inspected or adopted');});
 await recoverCallback(env,(await readOperation(db,op.id))!,'retired-prediction');
 const current=(await readOperation(db,op.id))!;
 assert.equal(current.state,'starting');assert.equal(current.provider_id,null);assert.equal(requests,0);
 assert.equal((await db.prepare("SELECT outcome FROM operation_attempts WHERE id='new-attempt'").first<{outcome:string}>())!.outcome,'uncertain');
});

test('deleting a completed run preserves its charged allowance; uncertain work remains fenced',async t=>{
 const {deleteOwnedRun,purgeDeletedRuns}=await import('../src/run-deletion.ts');
 const {db,env,split}=await setup(t);env.RUN_DELETION_ENABLED='true';
 const principal={subject,role:'student',displayName:'Fixture',course:null,courseId:null} as const;
 const completed=await split();await db.prepare('INSERT INTO job_owners VALUES(?,?)').bind(completed.id,subject).run();
 await db.prepare("UPDATE jobs SET status='done' WHERE id=?").bind(completed.id).run();
 const before=await splitAllowance(db,subject);assert.equal(before.completed,1);
 assert.equal(await deleteOwnedRun(env,principal,completed.id),true);await purgeDeletedRuns(env);
 assert.deepEqual(await splitAllowance(db,subject),before);
 const uncertain=await split('deletion-uncertain-0001');await db.prepare('INSERT INTO job_owners VALUES(?,?)').bind(uncertain.id,subject).run();
 const lease=(await claimNext(db,'split'))!;await transition(db,lease,'starting');await beginAttempt(db,lease,'replicate','separator-pin');
 await recoverExpired(db,lease.lease_until+1);
 assert.equal(await deleteOwnedRun(env,principal,uncertain.id),true);await purgeDeletedRuns(env);
 assert.ok(await db.prepare('SELECT 1 FROM jobs WHERE id=?').bind(uncertain.id).first());
 assert.equal((await splitAllowance(db,subject)).inProgress,1);assert.equal(await claimNext(db,'split'),null);
});
