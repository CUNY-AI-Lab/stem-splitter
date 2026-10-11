import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';
import app from '../src/index.ts';
import { drainSplitQueue, resumeOwnedVimeoImport, submitSplit } from '../src/reliability/splits.ts';
import { fingerprint, OperationError, readOperation } from '../src/reliability/ledger.ts';
import { cancelOperation, claimNext, claimVimeoImport, recoverExpired, WORK_LEASE_MS } from '../src/reliability/queue.ts';
import { setCooldown } from '../src/reliability/retry.ts';
import { splitAllowance } from '../src/daily-allowance.ts';
import { courseFixture } from './course-fixture.ts';
import { joinBytes, vimeoFixture } from '../tests/fixtures/vimeo.ts';

const subject='cail-'+ 'e'.repeat(32);
const principal:AppPrincipal={subject,role:'student',displayName:'Fixture',course:null,courseId:null};
const vimeo='https://vimeo.com/160743502/abd0e13fb4';
const vimeoPlayer='https://player.vimeo.com/video/160743502?h=abd0e13fb4';
const youtube='https://www.youtube.com/watch?v=jNQXAC9IVRw';
const importVersion='a'.repeat(64), splitVersion='b'.repeat(64);

async function setup(t:{after:(f:()=>void)=>void}) {
  const directory=mkdtempSync(join(tmpdir(),'stem-video-intake-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const local=new SqliteD1(join(directory,'db'));
  local.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db=local as unknown as D1Database;
  await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const env={DB:db,AUDIO:new FsR2Bucket(join(directory,'audio')),AUTH_MODE:'cail',SEPARATION_BACKEND:'replicate',LOCAL_HOSTING:'true',
    CLASS_CODE:'intake-fixture',PUBLIC_BASE_URL:'https://split.test',WEBHOOK_SECRET:'fixture-only',
    REPLICATE_API_TOKEN:'fixture-replicate-token',REPLICATE_YT_MODEL:'test/video-audio',
    REPLICATE_YT_MODEL_VERSION:importVersion,REPLICATE_MODEL_VERSION:splitVersion,
    ADMISSION_RESOLVER:{resolveCourseAccess:({subject,classId}:{subject:string;classId:string})=>courseFixture(subject,classId)},
  } as unknown as Env;
  const api=(body:unknown)=>app.fetch(new Request('https://split.test/api/jobs',{
    method:'POST',headers:{'x-class-code':'intake-fixture','Content-Type':'application/json'},body:JSON.stringify(body),
  }),{...env,AUTH_MODE:undefined});
  return {db,env,api};
}

async function guestRequests(db:D1Database,env:Env,hex:string) {
  const now=Date.now(),guestSubject=`guest-${hex.repeat(64)}`,expiresAt=now+86400000;
  await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
    .bind(guestSubject,now,expiresAt,'1970-01-01').run();
  const guestEnv={...env,guestRuntimeReady:true,guestSession:{subject:guestSubject,expiresAt,verifiedDay:'1970-01-01'}};
  const pending:Promise<unknown>[]=[];
  const request=(path:string,init:RequestInit={})=>app.fetch(new Request('https://split.test'+path,{...init,
    headers:{Origin:'https://split.test','Content-Type':'application/json',...init.headers}}),guestEnv,
    {waitUntil:(promise:Promise<unknown>)=>pending.push(promise),passThroughOnException:()=>{}} as ExecutionContext);
  const principal:AppPrincipal={subject:guestSubject,role:'guest',quotaClass:'guest',displayName:'Guest',course:null,courseId:null};
  return {env:guestEnv,principal,request,flush:async()=>{while(pending.length)await Promise.all(pending.splice(0));}};
}

test('both video aliases preserve source provenance and replay one durable reservation',async t=>{
  const {db,env}=await setup(t);
  for (const [sourceType,url,expectedField] of [['youtube',youtube,'youtubeUrl'],['vimeo',vimeo,'videoUrl']]) {
    const key=`video-alias-${sourceType}`;
    const first=await submitSplit(env,principal,{youtubeUrl:url},key);
    const replay=await submitSplit(env,principal,{videoUrl:url},key);
    assert.equal(first.created,true);assert.equal(replay.created,false);assert.equal(first.operation.id,replay.operation.id);
    const request=JSON.parse(first.operation.request_json);
    assert.equal(request.sourceType,sourceType);assert.equal(request[expectedField],url);
    assert.equal((await db.prepare('SELECT source_type FROM jobs WHERE id=?').bind(first.operation.job_id).first<{source_type:string}>())!.source_type,sourceType);
    if(sourceType==='youtube')assert.equal(first.operation.fingerprint,await fingerprint({
      sourceType:'youtube',filename:'YouTube audio',model:'htdemucs_ft',auto:false,youtubeUrl:youtube,
    }));
  }
  assert.equal((await splitAllowance(db,subject)).inProgress,2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
});

test('durable and legacy intake reject multiple sources and invalid URLs before provider or quota work',async t=>{
  const {db,env,api}=await setup(t);
  t.mock.method(globalThis,'fetch',async()=>assert.fail('Invalid input must not reach a provider'));
  for(const body of [
    {videoUrl:vimeo,youtubeUrl:youtube},{videoUrl:vimeo,youtubeUrl:vimeo},
    {videoUrl:vimeo,key:'uploads/fixture/source.wav',filename:'Fixture'},
    {youtubeUrl:youtube,archiveId:'fixture'},{archiveId:'fixture',key:'uploads/fixture/source.wav'},
    {videoUrl:'',youtubeUrl:youtube},{},null,[],
  ]) {
    await assert.rejects(()=>submitSplit(env,principal,body,'invalid-source-fixture'),
      (error:unknown)=>error instanceof OperationError&&error.code==='invalid_input');
    const response=await api(body);assert.equal(response.status,400);
    assert.equal((await response.json() as {code:string}).code,'invalid_input');
  }
  for(const videoUrl of [null,7,'https://vimeo.com.evil/76979871','https://vimeo.com/76979871?h=wrong']) {
    await assert.rejects(()=>submitSplit(env,principal,{videoUrl},'invalid-video-fixture'),
      (error:unknown)=>error instanceof OperationError&&error.code==='invalid_youtube_url');
    const response=await api({videoUrl});assert.equal(response.status,400);
    assert.equal((await response.json() as {code:string}).code,'invalid_youtube_url');
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{n:number}>())!.n,0);
  assert.equal((await splitAllowance(db,subject)).inProgress,0);
});

test('native Vimeo intake needs no extractor pin, and background drains leave its lease for its owner',async t=>{
  const {db,env}=await setup(t);
  env.REPLICATE_YT_MODEL=undefined;env.REPLICATE_YT_MODEL_VERSION=undefined;
  t.mock.method(globalThis,'fetch',async()=>assert.fail('Background drains must leave native Vimeo for its owner'));
  const {operation}=await submitSplit(env,principal,{videoUrl:vimeo},'vimeo-native-scheduled');
  await assert.rejects(()=>submitSplit(env,principal,{videoUrl:youtube},'youtube-needs-extractor'),
    (error:unknown)=>error instanceof OperationError&&error.code==='youtube_unconfigured');
  await drainSplitQueue(env,async()=>{});
  const queued=(await readOperation(db,operation.id))!;
  assert.equal(queued.state,'queued');assert.equal(queued.fence,0);assert.equal(queued.lease_owner,null);
  await setCooldown(db,'replicate',Date.now()+60_000);
  const now=Date.now(),claimed=(await claimVimeoImport(db,operation.id,subject,now))!;
  assert.equal(claimed.id,operation.id);assert.equal(claimed.lease_until,now+WORK_LEASE_MS);
  assert.equal(await claimVimeoImport(db,operation.id,subject,now),null);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
  await recoverExpired(db,claimed.lease_until+1);
  const recovered=(await readOperation(db,operation.id))!;
  assert.equal(recovered.state,'queued');assert.equal(recovered.provider_id,null);assert.ok(recovered.fence>claimed.fence);
  assert.equal(await claimNext(db,'fetch',claimed.lease_until+2),null);
  const restarted=(await claimVimeoImport(db,operation.id,subject,claimed.lease_until+2))!;
  assert.equal(restarted.id,operation.id);assert.ok(restarted.fence>recovered.fence);
});

test('queued Vimeo does not block an HTTP YouTube claim and cancelled or expired Vimeo releases its place',async t=>{
  const {db,env}=await setup(t);
  const native=(await submitSplit(env,principal,{videoUrl:vimeo},'vimeo-waits-for-cron')).operation;
  const remote=(await submitSplit(env,principal,{videoUrl:youtube},'youtube-http-starts')).operation;
  assert.equal((await claimNext(db,'fetch'))!.id,remote.id);
  await cancelOperation(db,native.id,subject);
  assert.equal((await readOperation(db,native.id))!.state,'cancelled');
  assert.equal((await splitAllowance(db,subject)).inProgress,1);
  const expired=(await submitSplit(env,principal,{videoUrl:vimeo},'vimeo-expired-fixture')).operation;
  await db.prepare('UPDATE app_operations SET deadline=? WHERE id=?').bind(Date.now()-1,expired.id).run();
  await recoverExpired(db);
  assert.equal((await readOperation(db,expired.id))!.state,'failed');
  assert.equal((await splitAllowance(db,subject)).inProgress,1);
});

test('cancelled abandoned native and YouTube imports refund without another source request',async t=>{
  const {db,env}=await setup(t);
  t.mock.method(globalThis,'fetch',async()=>assert.fail('Cancelled recovery must not fetch a source'));
  for(const [source,url] of [['vimeo',vimeo],['youtube',youtube]]) {
    const operation=(await submitSplit(env,principal,{videoUrl:url},`cancelled-abandoned-${source}`)).operation;
    const claimed=(source==='vimeo'?await claimVimeoImport(db,operation.id,subject):await claimNext(db,'fetch'))!;
    await cancelOperation(db,operation.id,subject);
    await recoverExpired(db,claimed.lease_until+1);
    await drainSplitQueue(env,async()=>{});
    assert.equal((await readOperation(db,operation.id))!.state,'cancelled');
    assert.equal((await splitAllowance(db,subject)).inProgress,0);
  }
});

test('native Vimeo failures release a guest place once and preserve only fixed error codes',async t=>{
  for(const [status,code] of [[403,'youtube_source_denied'],[429,'youtube_fetch_busy'],[0,'youtube_fetch_unavailable']] as const) {
    const {db,env}=await setup(t),now=Date.now(),guestSubject=`guest-${'f'.repeat(64)}`;
    await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
      .bind(guestSubject,now,now+86400000,'1970-01-01').run();
    env.guestRuntimeReady=true;
    const guest:AppPrincipal={subject:guestSubject,role:'guest',quotaClass:'guest',displayName:'Guest',course:null,courseId:null};
    let reads=0;
    const mock=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
      assert.equal(String(input),vimeoPlayer);assert.notEqual(init?.method,'POST');reads++;
      if(!status)throw new Error('private transport detail https://private.invalid/?credential=fixture');
      return new Response('private upstream failure',{status});
    });
    const first=await submitSplit(env,guest,{videoUrl:vimeo},`vimeo-guest-failure-${status}`);
    await resumeOwnedVimeoImport(env,guest,first.operation);
    const failed=(await readOperation(db,first.operation.id))!;
    assert.equal(failed.state,'failed');assert.equal(failed.error_code,code);assert.equal(failed.provider_id,null);
    assert.equal((await splitAllowance(db,guestSubject,new Date(),'guest')).remaining,5);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
    const job=await db.prepare('SELECT source_type,error FROM jobs WHERE id=?').bind(first.operation.id).first<{source_type:string;error:string}>();
    assert.equal(job!.source_type,'vimeo');assert.doesNotMatch(job!.error,/private|credential|https:/);
    assert.equal((await submitSplit(env,guest,{videoUrl:vimeo},`vimeo-guest-failure-${status}`)).created,false);
    await resumeOwnedVimeoImport(env,guest,failed);await drainSplitQueue(env,async()=>{});assert.equal(reads,1);
    mock.mock.restore();
  }
});

test('Vimeo browser import stores audio and its provenance before starting the selected separator',async t=>{
  const {db,env}=await setup(t);
  const {operation}=await submitSplit(env,principal,{videoUrl:'https://player.vimeo.com/video/160743502?h=abd0e13fb4'},'vimeo-pipeline-fixture');
  const fixture=vimeoFixture(),bytes=joinBytes(fixture.init,fixture.segment,fixture.segment);
  const config={...fixture.config,video:{...fixture.config.video,id:160743502,privacy:'unlisted',unlisted_hash:'abd0e13fb4'}};
  const posts:Array<{version:string;input:{url?:string;audio?:string}}>=[];
  let reads=0,browserReads=0;
  env.BROWSER={async quickAction(action,options){
    browserReads++;assert.equal(action,'content');assert.equal(options.url,vimeoPlayer);
    assert.equal(options.gotoOptions.waitUntil,'domcontentloaded');
    return Response.json({success:true,result:`<script>const playerConfig=${JSON.stringify(config)};</script>`,meta:{status:200,finalUrl:vimeoPlayer}});
  }};
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.method==='POST') {
      assert.equal(String(input),'https://api.replicate.com/v1/predictions');
      const body=JSON.parse(String(init.body));posts.push(body);
      assert.equal(body.version,splitVersion);
      return Response.json({id:'vimeo-split-fixture',status:'starting'});
    }
    reads++;assert.equal(init?.method,'GET');
    assert.notEqual(String(input),vimeoPlayer);
    return fixture.fetchImpl(input,init);
  });
  const complete=async()=>assert.fail('Import does not complete separation');
  await setCooldown(db,'replicate',Date.now()+60_000);
  await resumeOwnedVimeoImport(env,principal,operation);
  assert.equal(posts.length,0);assert.equal(reads,3);assert.equal(browserReads,1);
  let current=(await readOperation(db,operation.id))!;
  assert.equal(current.phase,'split');assert.equal(current.state,'queued');
  assert.equal(JSON.parse(current.request_json).sourceType,'vimeo');
  assert.equal(JSON.parse(current.request_json).videoUrl,vimeo);
  const job=await db.prepare('SELECT source_type,source_key,source_hash FROM jobs WHERE id=?').bind(operation.job_id)
    .first<{source_type:string;source_key:string;source_hash:string}>();
  assert.equal(job!.source_type,'vimeo');
  assert.equal(job!.source_hash,Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'));
  assert.deepEqual(new Uint8Array(await new Response((await env.AUDIO.get(job!.source_key))!.body).arrayBuffer()),bytes);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
  await db.prepare("UPDATE provider_cooldowns SET until_ms=0 WHERE provider='replicate'").run();
  await drainSplitQueue(env,complete);current=(await readOperation(db,operation.id))!;
  assert.equal(current.phase,'split');assert.equal(current.state,'processing');
  assert.equal(posts.length,1);assert.equal(posts[0].version,splitVersion);assert.equal(reads,3);assert.equal(browserReads,1);
  const sourceUrl=new URL(posts[0].input.audio!);
  assert.equal(sourceUrl.origin,'https://split.test');
  assert.equal(sourceUrl.pathname,`/api/local-sources/${job!.source_key}`);
  assert.equal((await splitAllowance(db,subject)).inProgress,1);
});

test('native Vimeo late storage is fenced after cancellation or expired lease, and storage failure refunds',async t=>{
  for(const mode of ['cancel','expire','storage'] as const) {
    const {db,env}=await setup(t),fixture=vimeoFixture();
    const {operation}=await submitSplit(env,principal,{videoUrl:'https://vimeo.com/1084537'},`vimeo-storage-${mode}`);
    t.mock.method(globalThis,'fetch',fixture.fetchImpl);
    const put=env.AUDIO.put.bind(env.AUDIO);let writtenKey='';
    t.mock.method(env.AUDIO,'put',async(...args:Parameters<R2Bucket['put']>)=>{
      if(mode==='storage')throw new Error('private storage configuration detail');
      const result=await put(...args);writtenKey=args[0];
      if(mode==='cancel')await cancelOperation(db,operation.id,subject);
      else await recoverExpired(db,(await readOperation(db,operation.id))!.lease_until+1);
      return result;
    });
    await resumeOwnedVimeoImport(env,principal,operation);
    const current=(await readOperation(db,operation.id))!;
    assert.equal(current.phase,'fetch');assert.equal(current.state,mode==='expire'?'queued':mode==='cancel'?'cancelled':'failed');
    assert.equal(current.provider_id,null);
    if(writtenKey)assert.equal(await env.AUDIO.head(writtenKey),null);
    const job=await db.prepare('SELECT source_hash FROM jobs WHERE id=?').bind(operation.id).first<{source_hash:string|null}>();
    assert.equal(job!.source_hash,null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
    assert.equal((await splitAllowance(db,subject)).inProgress,mode==='expire'?1:0);
    t.mock.restoreAll();
  }
});

test('Vimeo POST awaits its own source while simultaneous replay preserves one download and GPU start',async t=>{
  const {db,env}=await setup(t),guest=await guestRequests(db,env,'a'),fixture=vimeoFixture();
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),sourceStarted=new Promise<void>(resolve=>{started=resolve;});
  let reads=0,posts=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).startsWith('https://api.replicate.com/')) {
      if(init?.method==='POST'){posts++;assert.equal(JSON.parse(String(init.body)).version,splitVersion);}
      return Response.json({id:'owned-http-split',status:'processing'});
    }
    reads++;
    if(String(input)==='https://player.vimeo.com/video/1084537'){started();await gate;}
    return fixture.fetchImpl(input,init);
  });
  const submit=()=>guest.request('/api/jobs',{method:'POST',headers:{'Idempotency-Key':'native-http-same-key'},body:JSON.stringify({videoUrl:'https://vimeo.com/1084537'})});
  let resolved=false;
  const first=submit().then(response=>{resolved=true;return response;});await sourceStarted;
  const replay=await submit(),replayed=await replay.json() as {id:string;replay:boolean;model:string};
  assert.equal(resolved,false);assert.equal(replay.status,200);assert.equal(replayed.replay,true);assert.equal(replayed.model,'htdemucs_ft');
  assert.equal(reads,1);assert.equal(posts,0);
  release();const response=await first,created=await response.json() as {id:string;savedToAccount:boolean;replay:boolean};await guest.flush();
  assert.equal(response.status,202);assert.equal(created.id,replayed.id);assert.equal(created.replay,false);assert.equal(created.savedToAccount,false);
  assert.equal(reads,4);assert.equal(posts,1);
  const current=(await readOperation(db,created.id))!;assert.equal(current.phase,'split');assert.equal(current.state,'processing');
  await submit();await guest.flush();assert.equal(reads,4);assert.equal(posts,1);
});

test('busy Vimeo work resumes only through its owner GET, including an expired download lease',async t=>{
  const {db,env}=await setup(t),owner=await guestRequests(db,env,'b'),other=await guestRequests(db,env,'c'),fixture=vimeoFixture();
  const blocker=(await submitSplit(env,principal,{videoUrl:'https://vimeo.com/1084537'},'native-capacity-blocker')).operation;
  assert.ok(await claimVimeoImport(db,blocker.id,principal.subject));
  let reads=0,posts=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(String(input).startsWith('https://api.replicate.com/')) {
      if(init?.method==='POST')posts++;
      return Response.json({id:'resumed-http-split',status:'processing'});
    }
    reads++;return fixture.fetchImpl(input,init);
  });
  const response=await owner.request('/api/jobs',{method:'POST',headers:{'Idempotency-Key':'native-http-cap-busy'},body:JSON.stringify({videoUrl:'https://vimeo.com/1084537'})});
  const body=await response.json() as {id:string;status:string};await owner.flush();
  assert.equal(response.status,202);assert.equal(body.status,'queued');assert.equal(reads,0);
  assert.equal((await other.request(`/api/jobs/${body.id}`)).status,404);assert.equal(reads,0);
  await resumeOwnedVimeoImport(other.env,other.principal,(await readOperation(db,body.id))!);assert.equal(reads,0);
  await db.prepare("UPDATE jobs SET status='failed' WHERE id=?").bind(blocker.id).run();
  const abandoned=(await claimVimeoImport(db,body.id,owner.principal.subject))!;
  await db.prepare('UPDATE app_operations SET lease_until=? WHERE id=?').bind(Date.now()-1,body.id).run();
  await drainSplitQueue(owner.env,async()=>{});assert.equal(reads,0);
  const recovered=(await readOperation(db,body.id))!;assert.equal(recovered.state,'queued');assert.ok(recovered.fence>abandoned.fence);
  const polled=await owner.request(`/api/jobs/${body.id}`);assert.equal(polled.status,200);await owner.flush();
  assert.equal(reads,4);assert.equal(posts,1);
  const current=(await readOperation(db,body.id))!;assert.equal(current.phase,'split');assert.equal(current.state,'processing');
});

test('legacy job endpoint imports Vimeo through either request alias',async t=>{
  const {db,api}=await setup(t);
  const bytes=new Uint8Array(2048);bytes.set([0,0,0,24,102,116,121,112]);
  let imports=0,splits=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(String(input),'https://api.replicate.com/v1/predictions');assert.equal(init?.method,'POST');
    const body=JSON.parse(String(init?.body));
    if(body.version===importVersion) {
      imports++;assert.equal(body.input.url,vimeo);
      return Response.json({id:'legacy-vimeo-import',status:'succeeded',output:{title:'Vimeo fixture',duration:19,
        audio:`data:audio/mp4;base64,${Buffer.from(bytes).toString('base64')}`}});
    }
    splits++;assert.equal(body.version,splitVersion);
    return Response.json({id:`legacy-vimeo-split-${splits}`,status:'starting'});
  });
  for(const field of ['videoUrl','youtubeUrl']) {
    const response=await api({[field]:vimeo});assert.equal(response.status,200);
    const body=await response.json() as {id:string;status:string};assert.equal(body.status,'processing');
    assert.equal((await db.prepare('SELECT source_type FROM jobs WHERE id=?').bind(body.id).first<{source_type:string}>())!.source_type,'vimeo');
  }
  assert.equal(imports,2);assert.equal(splits,2);
});
