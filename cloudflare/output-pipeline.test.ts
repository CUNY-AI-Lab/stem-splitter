import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteD1} from '../server/d1.ts';
import {FsR2Bucket} from '../server/r2.ts';
import type {Env} from '../src/env.ts';
import {reserveOperation,readOperation,type Operation} from '../src/reliability/ledger.ts';
import {claimNext,cancelOperation,expireSplitOperations} from '../src/reliability/queue.ts';
import {reconcileSplit} from '../src/reliability/splits.ts';
import {dispatchOutput,handoffOutput,runOutputStep,outputProgress,multipartSink,OUTPUT_LEASE_MS} from '../src/reliability/output.ts';
import {InvalidStemAudioError} from '../src/reliability/media.ts';
import {splitAllowance} from '../src/daily-allowance.ts';
const subject='cail-'+ 'e'.repeat(32), names=['vocals','drums','bass','other','guitar','piano'];
const bytes=readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
async function setup(t:any,adaptive=false) {
 const root=mkdtempSync(join(tmpdir(),'stem-output-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const local=new SqliteD1(join(root,'db'));local.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const db=local as unknown as D1Database;await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
 const audio=new FsR2Bucket(join(root,'audio'));let aborts=0;
 const bucket=new Proxy(audio,{get(target,key){if(key==='createMultipartUpload')return async(path:string)=>{const parts:Uint8Array[]=[];return {
  uploadPart:async(n:number,part:Uint8Array)=>{parts[n-1]=new Uint8Array(part);return {partNumber:n,etag:String(n)};},
  complete:async()=>audio.put(path,Buffer.concat(parts)),abort:async()=>{aborts++;},
 };};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as R2Bucket;
 let sends=0,downloads=0;
 const env={DB:db,AUDIO:bucket,AUTH_MODE:'cail',SEPARATION_BACKEND:'replicate',deferAdaptiveOutput:async()=>{sends++;},validateStemAudio:async()=>true,
  outputAudio:{measure:async(_data:any,name:string)=>({name,rmsDb:-20,peak:.2,samples:88200,sampleRate:44100}),gain:async()=>1,encode:async(input:any)=>input.append(bytes)}} as unknown as Env;
 async function reserve(key=crypto.randomUUID(),who=subject) {
  await db.prepare('INSERT OR IGNORE INTO app_users(subject) VALUES(?)').bind(who).run();
  const id=crypto.randomUUID();return (await reserveOperation(db,{subject:who,courseId:null,kind:'split',key,fingerprint:key,phase:'split',jobId:id,
   request:{sourceType:'upload',model:adaptive?'htdemucs_6s':'vocals_instrumental',filename:'Fixture'},statements:op=>[db.prepare("INSERT INTO jobs(id,filename,source_key,status,model) SELECT id,'Fixture','uploads/fixture/audio.mp3','queued',? FROM app_operations WHERE id=?").bind(adaptive?'htdemucs_6s':'vocals_instrumental',op)]})).operation;
 }
 const first=await reserve();
 await db.prepare("UPDATE app_operations SET state='processing',provider_id='paid-once',lease_owner='reconciler',lease_until=? WHERE id=?").bind(Date.now()+300000,first.id).run();
 await db.prepare("UPDATE jobs SET status='processing' WHERE id=?").bind(first.id).run();
 const op=(await readOperation(db,first.id))!;
 const result={externalId:'paid-once',status:'succeeded',stems:(adaptive?names:['vocals','instrumental']).map(name=>({name,url:`https://fixture.replicate.delivery/${name}.mp3`}))} as const;
 await handoffOutput(env,op,result as any,adaptive?'htdemucs_6s':'vocals_instrumental',adaptive?4:null);
 const download=async()=>{downloads++;return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;};
 const run=()=>runOutputStep(env,op.id,download);
 return {db,env,op,reserve,run,download,sends:()=>sends,downloads:()=>downloads,aborts:()=>aborts};
}
test('durable handoff frees provider capacity, keeps allowance, and deduplicates callbacks without provider polling',async t=>{
 const s=await setup(t);const next=await s.reserve();
 assert.equal((await claimNext(s.db,'split'))?.id,next.id);
 assert.equal((await splitAllowance(s.db,subject)).inProgress,2);
 assert.equal(s.sends(),1);
 t.mock.method(globalThis,'fetch',async()=>assert.fail('Completed provider must not be polled'));
 for(let i=0;i<5;i++)await reconcileSplit(s.env,(await readOperation(s.db,s.op.id))!,async()=>assert.fail('No inline composition'));
 assert.equal(s.sends(),1);
});
test('a failed queue send is recoverable from the D1 outbox',async t=>{
 const s=await setup(t);await s.db.prepare('UPDATE app_operations SET not_before=0 WHERE id=?').bind(s.op.id).run();
 let sends=0;s.env.deferAdaptiveOutput=async()=>{if(++sends===1)throw Error('queue offline');};
 await assert.rejects(dispatchOutput(s.env,s.op.id));await dispatchOutput(s.env,s.op.id);assert.equal(sends,2);
});
test('duplicate deliveries claim one stage; later stages reuse saved sources and settle once',async t=>{
 const s=await setup(t);
 await Promise.all([s.run(),s.run(),s.run()]);assert.equal(s.downloads(),1);
 assert.equal(outputProgress((await readOperation(s.db,s.op.id))!)!.sources.length,1);
 await s.run();assert.equal(s.downloads(),2);assert.equal(await s.run(),true);assert.equal(await s.run(),true);
 assert.equal((await splitAllowance(s.db,subject)).completed,1);
 assert.equal((await s.db.prepare("SELECT COUNT(*) n FROM operation_events WHERE operation_id=? AND quota_effect='charged'").bind(s.op.id).first<{n:number}>())!.n,1);
});
test('transient download failure preserves the previous source and does not recreate provider attempts',async t=>{
 const s=await setup(t);await s.run();const first=outputProgress((await readOperation(s.db,s.op.id))!)!.sources[0];
 await assert.rejects(runOutputStep(s.env,s.op.id,async()=>{throw Error('offline');}));
 assert.ok(await s.env.AUDIO.head(first.key));await s.run();assert.equal(s.downloads(),2);
 assert.equal((await s.db.prepare('SELECT COUNT(*) n FROM operation_attempts').first<{n:number}>())!.n,0);
});
for(const action of ['cancel','expire'])test(`${action} during encoding fences publication and releases once`,async t=>{
 const s=await setup(t,true);
 for(let i=0;i<8;i++)await s.run();
 s.env.outputAudio!.encode=async input=>{
  if(action==='cancel')await cancelOperation(s.db,s.op.id,subject);
  else await s.db.prepare('UPDATE app_operations SET deadline=? WHERE id=?').bind(Date.now()-1,s.op.id).run();
  await input.checkpoint();assert.fail('Fenced encoding must not continue');
 };
 assert.equal(await s.run(),true);assert.equal(s.aborts(),1);
 assert.equal((await splitAllowance(s.db,subject)).inProgress,0);
 assert.equal((await s.env.AUDIO.list()).objects.length,0);
 assert.equal((await readOperation(s.db,s.op.id))!.state,action==='cancel'?'cancelled':'failed');
});
test('a crashed output lease expires independently of provider cooldown and never replaces the prediction',async t=>{
 const s=await setup(t);await s.run();
 await s.db.prepare("UPDATE app_operations SET lease_owner='dead-worker',lease_until=?,not_before=? WHERE id=?").bind(Date.now()-1,Date.now()+900000,s.op.id).run();
 await s.db.prepare("INSERT INTO provider_cooldowns VALUES('replicate',?)").bind(Date.now()+900000).run();
 t.mock.method(globalThis,'fetch',async()=>assert.fail('No provider access during output recovery'));
 await s.run();assert.equal(s.downloads(),2);assert.equal(await s.run(),true);assert.equal((await readOperation(s.db,s.op.id))!.provider_id,'paid-once');
 assert.ok(OUTPUT_LEASE_MS<300000);
});
test('invalid source audio fails without a charge or perpetual retries',async t=>{
 const s=await setup(t);s.env.validateStemAudio=async()=>false;
 assert.equal(await s.run(),true);assert.equal((await readOperation(s.db,s.op.id))!.state,'failed');
 assert.equal((await splitAllowance(s.db,subject)).completed,0);
});
test('adaptive output survives encoding failure and publishes only validated tracks',async t=>{
 const s=await setup(t,true);for(let i=0;i<10;i++)await s.run();
 const first=outputProgress((await readOperation(s.db,s.op.id))!)!.outputs[0];assert.equal(first.validated,true);
 const encode=s.env.outputAudio!.encode;s.env.outputAudio!.encode=async()=>{throw Error('interrupted encoder');};
 await assert.rejects(s.run());assert.ok(await s.env.AUDIO.head(first.key));assert.equal(s.aborts(),1);
 s.env.outputAudio!.encode=encode;let done=false;for(let i=0;i<12&&!done;i++)done=await s.run();assert.equal(done,true);
 const row=await s.db.prepare('SELECT status,stems FROM jobs WHERE id=?').bind(s.op.id).first<{status:string;stems:string}>();
 assert.equal(row!.status,'done');assert.equal(JSON.parse(row!.stems).length,4);assert.equal((await s.env.AUDIO.list()).objects.length,4);
});
for(const publication of [false,true])test(`lost ${publication?'publication':'checkpoint'} acknowledgement preserves committed audio`,async t=>{
 const s=await setup(t);if(publication){await s.run();await s.run();}
 const base=s.env.DB;let lost=false;
 s.env.DB=new Proxy(base,{get(target,key){if(key==='prepare')return (sql:string)=>{
  const statement=target.prepare(sql);if(!sql.startsWith(publication?"UPDATE jobs SET status='done'":"UPDATE app_operations SET result_json=?"))return statement;
  return new Proxy(statement,{get(stmt,method){if(method==='bind')return (...args:any[])=>{const bound=stmt.bind(...args);return new Proxy(bound,{get(b,k){if(k==='run')return async()=>{const result=await b.run();if(!lost){lost=true;throw Error('lost write acknowledgement');}return result;};const v=Reflect.get(b,k);return typeof v==='function'?v.bind(b):v;}});};const value=Reflect.get(stmt,method);return typeof value==='function'?value.bind(stmt):value;}});
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 if(publication)assert.equal(await s.run(),true);else await assert.rejects(s.run());
 const progress=outputProgress((await readOperation(base,s.op.id))!)!;
 for(const source of progress.sources)assert.ok(await s.env.AUDIO.head(source.key));
 if(!publication){s.env.DB=base;await s.run();assert.equal(s.downloads(),2);assert.equal(await s.run(),true);}
 assert.equal((await splitAllowance(base,subject)).completed,1);
});
test('multipart buffering preserves bytes across part boundaries and uploads bounded parts',async()=>{
 const chunks:Uint8Array[]=[];let complete=false;
 const bucket={createMultipartUpload:async()=>({uploadPart:async(n:number,data:Uint8Array)=>{chunks.push(new Uint8Array(data));return {partNumber:n,etag:String(n)};},complete:async()=>{complete=true;},abort:async()=>{}})} as unknown as R2Bucket;
 const sink=await multipartSink(bucket,'fixture');const source=Uint8Array.from({length:11*1024*1024+13},(_,i)=>i%251);
 for(let at=0;at<source.length;at+=713)await sink.append(source.subarray(at,at+713));await sink.finish();
 assert.equal(complete,true);assert.deepEqual(chunks.map(c=>c.length),[5*1024*1024,5*1024*1024,1024*1024+13]);assert.deepEqual(Buffer.concat(chunks),Buffer.from(source));
});
test('two provider slots preserve per-subject fairness and reject a third concurrent claim',async t=>{
 const s=await setup(t);const people=['a','b','c'].map(c=>'cail-'+c.repeat(32));
 for(const who of people)await s.reserve(crypto.randomUUID(),who);
 const claimed=await Promise.all(Array.from({length:6},()=>claimNext(s.db,'split',Date.now(),2)));
 assert.equal(claimed.filter(Boolean).length,2);assert.equal(new Set(claimed.filter(Boolean).map(o=>o!.subject)).size,2);
});
test('a stale encoder cannot overwrite the output saved by its replacement',async t=>{
 const s=await setup(t,true);for(let i=0;i<8;i++)await s.run();
 let release!:()=>void,entered!:()=>void,encodes=0;
 const blocked=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);
 s.env.outputAudio!.encode=async input=>{if(++encodes===1){entered();await blocked;}await input.append(bytes);await input.checkpoint();};
 const stale=s.run();await ready;
 await s.db.prepare('UPDATE app_operations SET lease_until=? WHERE id=?').bind(Date.now()-1,s.op.id).run();
 assert.equal(await s.run(),false);release();await assert.rejects(stale);
 const current=outputProgress((await readOperation(s.db,s.op.id))!)!;
 assert.equal(current.outputs.length,1);assert.ok(await s.env.AUDIO.head(current.outputs[0].key));
 assert.equal((await s.env.AUDIO.list()).objects.length,7);
});
test('expiry immediately before the final publication CAS cannot produce a charge',async t=>{
 const s=await setup(t);await s.run();await s.run();const base=s.env.DB;
 s.env.DB=new Proxy(base,{get(target,key){if(key==='prepare')return(sql:string)=>{
  const statement=target.prepare(sql);if(!sql.startsWith("UPDATE jobs SET status='done'"))return statement;
  return new Proxy(statement,{get(stmt,k){if(k==='bind')return(...args:any[])=>{const bound=stmt.bind(...args);return new Proxy(bound,{get(b,method){if(method==='run')return async()=>{await base.prepare('UPDATE app_operations SET deadline=? WHERE id=?').bind(Date.now()-1,s.op.id).run();return b.run();};const v=Reflect.get(b,method);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(stmt,k);return typeof v==='function'?v.bind(stmt):v;}});
 };const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 assert.equal(await s.run(),true);assert.equal((await readOperation(base,s.op.id))!.state,'failed');
 assert.equal((await splitAllowance(base,subject)).completed,0);assert.equal((await s.env.AUDIO.list()).objects.length,0);
});
