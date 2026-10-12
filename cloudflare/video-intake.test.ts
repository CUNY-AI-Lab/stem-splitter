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
import { drainSplitQueue, resumeOwnedSourceImport, resumeOwnedVimeoImport, submitSplit } from '../src/reliability/splits.ts';
import { beginAttempt, finishAttempt, fingerprint, OperationError, readOperation } from '../src/reliability/ledger.ts';
import { cancelOperation, claimNext, claimNativeImport, claimVimeoImport, recoverExpired, WORK_LEASE_MS } from '../src/reliability/queue.ts';
import { YouTubeError } from '../src/youtube.ts';
import { mp3FrameInfo } from '../src/reliability/media.ts';
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
const browserAudio=()=>{
  const bytes=new Uint8Array(2048);bytes.set([0x1a,0x45,0xdf,0xa3]);
  return {data:bytes.buffer,title:'Browser audio fixture',durationSec:19,fileName:'source.webm',contentType:'audio/webm' as const};
};

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
    {audiusId:'4zxjE',videoUrl:youtube},{audiusId:'4zxjE',archiveId:'fixture'},
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
  for(const [source,url] of [['vimeo',vimeo],['youtube',youtube],['browser-youtube',youtube]]) {
    env.fetchYouTubeBrowserAudio=source==='browser-youtube'?async()=>assert.fail('Cancelled browser work must not resume'):undefined;
    const operation=(await submitSplit(env,principal,{videoUrl:url},`cancelled-abandoned-${source}`)).operation;
    const claimed=(source!=='youtube'?await claimNativeImport(db,operation.id,subject):await claimNext(db,'fetch'))!;
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

test('retired Vimeo submissions stop before quota, source fetches or provider starts',async t=>{
  const {db,env,api}=await setup(t),guest=await guestRequests(db,env,'a');
  let outbound=0;
  t.mock.method(globalThis,'fetch',async()=>{outbound++;throw new Error('retired source reached the network');});
  for(const source of [vimeo,vimeoPlayer,'https://vimeo.com/1084537'])for(const field of ['videoUrl','youtubeUrl']) {
    const payload={[field]:source};
    const responses=[await api(payload),await guest.request('/api/jobs',{method:'POST',headers:{'Idempotency-Key':`retired-${field}-source`},body:JSON.stringify(payload)})];
    for(const response of responses) {
      assert.equal(response.status,400);
      assert.deepEqual(await response.json(),{error:'Choose a supported video link or upload an audio file.',code:'unsupported_source',retryable:false});
    }
  }
  await guest.flush();assert.equal(outbound,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{n:number}>())!.n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM app_operations').first<{n:number}>())!.n,0);
  assert.equal((await splitAllowance(db,guest.principal.subject,new Date(),'guest')).inProgress,0);
});

test('previously queued Vimeo work resumes only through its owner GET, including an expired download lease',async t=>{
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
  // Seed an operation reserved by the previous release; new HTTP submissions are retired.
  const existing=await submitSplit(owner.env,owner.principal,{videoUrl:'https://vimeo.com/1084537'},'native-http-cap-busy');
  const body={id:existing.operation.job_id};assert.equal(existing.operation.state,'queued');assert.equal(reads,0);
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

test('trusted browser routing keeps the original fingerprint and preserves old YouTube replays',async t=>{
  const {db,env}=await setup(t);
  const old=(await submitSplit(env,principal,{videoUrl:youtube,browserAudio:true},'youtube-pre-browser')).operation;
  assert.equal(JSON.parse(old.request_json).browserAudio,undefined);
  env.fetchYouTubeBrowserAudio=async()=>assert.fail('Old work must retain its provider route');
  const replay=await submitSplit(env,principal,{youtubeUrl:youtube,browserAudio:false},'youtube-pre-browser');
  assert.equal(replay.created,false);assert.equal(replay.operation.id,old.id);
  assert.equal(replay.operation.request_json,old.request_json);
  const fresh=(await submitSplit(env,principal,{videoUrl:youtube,browserAudio:false},'youtube-browser-new')).operation;
  assert.equal(JSON.parse(fresh.request_json).browserAudio,true);
  assert.equal(fresh.fingerprint,old.fingerprint);
  const posts:Array<{version:string;input:{url:string}}>=[];
  t.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(init?.method,'POST');posts.push(JSON.parse(String(init.body)));
    return Response.json({id:'old-import-retained',status:'starting'});
  });
  await resumeOwnedSourceImport(env,principal,replay.operation);
  assert.equal(posts.length,0);
  await drainSplitQueue(env,async()=>{});
  assert.equal(posts.length,1);assert.equal(posts[0].version,importVersion);assert.equal(posts[0].input.url,youtube);
  const processing=(await readOperation(db,old.id))!;
  assert.equal(processing.provider_id,'old-import-retained');assert.equal(processing.phase,'fetch');assert.equal(processing.state,'processing');
  assert.equal((await readOperation(db,fresh.id))!.state,'queued');
  const again=await submitSplit(env,principal,{videoUrl:youtube},'youtube-pre-browser');
  assert.equal(again.operation.provider_id,processing.provider_id);assert.equal(again.operation.request_json,old.request_json);
});

test('browser YouTube intake needs the selected GPU configuration and ignores forged loader input',async t=>{
  const {db,env}=await setup(t);
  env.REPLICATE_YT_MODEL=undefined;env.REPLICATE_YT_MODEL_VERSION=undefined;
  await assert.rejects(submitSplit(env,principal,{videoUrl:youtube,browserAudio:true,fetchYouTubeBrowserAudio:'forged'},'youtube-forged-route'),
    (error:unknown)=>error instanceof OperationError&&error.code==='youtube_unconfigured');
  env.fetchYouTubeBrowserAudio=async()=>browserAudio();
  env.REPLICATE_MODEL_VERSION=undefined;
  await assert.rejects(submitSplit(env,principal,{videoUrl:youtube},'youtube-missing-gpu'),
    (error:unknown)=>error instanceof OperationError&&error.code==='provider_configuration');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM app_operations').first<{n:number}>())!.n,0);
  env.REPLICATE_MODEL_VERSION=splitVersion;
  const {operation}=await submitSplit(env,principal,{videoUrl:youtube},'youtube-browser-no-pin');
  assert.equal(JSON.parse(operation.request_json).browserAudio,true);
  assert.equal(await claimNext(db,'fetch'),null);
  assert.equal((await claimNativeImport(db,operation.id,subject))!.id,operation.id);
});

test('an old uncertain provider start stays in reconciliation after browser routing is available',async t=>{
  const {db,env}=await setup(t);
  const original=(await submitSplit(env,principal,{videoUrl:youtube},'youtube-old-uncertain')).operation;
  const claimed=(await claimNext(db,'fetch'))!;
  const attempt=await beginAttempt(db,claimed,'replicate',importVersion);
  await finishAttempt(db,attempt,'uncertain');
  await db.prepare("UPDATE app_operations SET state='starting',lease_until=? WHERE id=?").bind(Date.now()-1,original.id).run();
  env.fetchYouTubeBrowserAudio=async()=>assert.fail('An ambiguous provider start must retain its existing route');
  t.mock.method(globalThis,'fetch',async()=>assert.fail('An ambiguous start must not submit another prediction'));
  const replay=await submitSplit(env,principal,{youtubeUrl:youtube},'youtube-old-uncertain');
  assert.equal(replay.created,false);assert.equal(replay.operation.request_json,original.request_json);
  await resumeOwnedSourceImport(env,principal,replay.operation);
  await drainSplitQueue(env,async()=>{});
  const current=(await readOperation(db,original.id))!;
  assert.equal(current.state,'reconciling');assert.equal(current.provider_id,null);
  assert.equal(JSON.parse(current.request_json).browserAudio,undefined);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts WHERE operation_id=?').bind(original.id).first<{n:number}>())!.n,1);
  assert.equal((await splitAllowance(db,subject)).inProgress,1);
});

test('YouTube POST awaits its trusted browser loader, preserves WebM metadata, and replays once',async t=>{
  const {db,env}=await setup(t);
  let release!:()=>void,started!:()=>void,loads=0,posts=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),sourceStarted=new Promise<void>(resolve=>{started=resolve;});
  env.fetchYouTubeBrowserAudio=async(url,options)=>{
    loads++;assert.equal(url,youtube);assert.ok(options.deadline>Date.now());started();await gate;return browserAudio();
  };
  const guest=await guestRequests(db,env,'d');
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.ok(String(input).startsWith('https://api.replicate.com/'));
    if(init?.method==='POST'){
      posts++;const body=JSON.parse(String(init.body));assert.equal(body.version,splitVersion);assert.match(body.input.audio,/\.webm$/);
    }
    return Response.json({id:'browser-youtube-split',status:'processing'});
  });
  const submit=()=>guest.request('/api/jobs',{method:'POST',headers:{'Idempotency-Key':'youtube-browser-owned'},body:JSON.stringify({videoUrl:youtube,browserAudio:false})});
  let resolved=false;
  const pending=submit().then(response=>{resolved=true;return response;});await sourceStarted;
  const replay=await submit(),replayed=await replay.json() as {id:string;replay:boolean};
  assert.equal(resolved,false);assert.equal(replay.status,200);assert.equal(replayed.replay,true);assert.equal(loads,1);assert.equal(posts,0);
  release();const response=await pending,body=await response.json() as {id:string;savedToAccount:boolean};await guest.flush();
  assert.equal(response.status,202);assert.equal(body.id,replayed.id);assert.equal(body.savedToAccount,false);assert.equal(posts,1);assert.equal(loads,1);
  const job=await db.prepare('SELECT source_key,source_hash,source_type FROM jobs WHERE id=?').bind(body.id).first<{source_key:string;source_hash:string;source_type:string}>();
  assert.equal(job!.source_type,'youtube');assert.match(job!.source_key,/\.webm$/);
  const stored=(await env.AUDIO.get(job!.source_key))!;
  assert.equal(stored.httpMetadata!.contentType,'audio/webm');
  assert.deepEqual(new Uint8Array(await new Response(stored.body).arrayBuffer()),new Uint8Array(browserAudio().data));
  assert.equal(job!.source_hash,Buffer.from(await crypto.subtle.digest('SHA-256',browserAudio().data)).toString('hex'));
  const attempts=await db.prepare('SELECT phase,model FROM operation_attempts WHERE operation_id=?').bind(body.id).all<{phase:string;model:string}>();
  assert.deepEqual(attempts.results.map(({phase,model})=>({phase,model})),[{phase:'split',model:splitVersion}]);
  await submit();await guest.flush();assert.equal(loads,1);assert.equal(posts,1);
});

test('marked YouTube queue recovery remains owner-only and independent of provider cooldown',async t=>{
  const {db,env}=await setup(t);let loads=0,posts=0;
  env.fetchYouTubeBrowserAudio=async()=>{loads++;return browserAudio();};
  const owner=await guestRequests(db,env,'e'),other=await guestRequests(db,env,'f');
  const blocker=(await submitSplit(env,principal,{videoUrl:vimeo},'browser-capacity-block')).operation;
  assert.ok(await claimNativeImport(db,blocker.id,subject));
  t.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.method==='POST'){posts++;assert.equal(JSON.parse(String(init.body)).version,splitVersion);}
    return Response.json({id:'resumed-browser-split',status:'processing'});
  });
  const response=await owner.request('/api/jobs',{method:'POST',headers:{'Idempotency-Key':'browser-youtube-busy'},body:JSON.stringify({videoUrl:youtube})});
  const body=await response.json() as {id:string};await owner.flush();assert.equal(response.status,202);assert.equal(loads,0);
  assert.equal((await other.request(`/api/jobs/${body.id}`)).status,404);
  await resumeOwnedSourceImport(other.env,other.principal,(await readOperation(db,body.id))!);assert.equal(loads,0);
  await db.prepare("UPDATE jobs SET status='failed' WHERE id=?").bind(blocker.id).run();
  await setCooldown(db,'replicate',Date.now()+60_000);
  const claimed=(await claimNativeImport(db,body.id,owner.principal.subject))!;assert.ok(claimed);
  await db.prepare('UPDATE app_operations SET lease_until=? WHERE id=?').bind(Date.now()-1,body.id).run();
  await drainSplitQueue(owner.env,async()=>{});assert.equal(loads,0);
  const queued=(await readOperation(db,body.id))!;assert.equal(queued.state,'queued');assert.ok(queued.fence>claimed.fence);
  const poll=await owner.request(`/api/jobs/${body.id}`);await owner.flush();assert.equal(poll.status,200);assert.equal(loads,1);assert.equal(posts,0);
  assert.equal((await readOperation(db,body.id))!.phase,'split');
  await db.prepare("UPDATE provider_cooldowns SET until_ms=0 WHERE provider='replicate'").run();
  await drainSplitQueue(owner.env,async()=>{});assert.equal(posts,1);assert.equal(loads,1);
});

test('failed or unavailable browser loaders refund marked YouTube work without provider fallback',async t=>{
  for(const mode of ['denied','missing'] as const){
    const {db,env}=await setup(t);let loads=0;
    env.fetchYouTubeBrowserAudio=async()=>{loads++;throw new YouTubeError('Fixed refusal','youtube_source_denied');};
    const guest=await guestRequests(db,env,mode==='denied'?'a':'b');
    const {operation}=await submitSplit(guest.env,guest.principal,{videoUrl:youtube},`browser-failed-${mode}`);
    if(mode==='missing')guest.env.fetchYouTubeBrowserAudio=undefined;
    t.mock.method(globalThis,'fetch',async()=>assert.fail('Marked browser failure must not start a provider request'));
    await resumeOwnedSourceImport(guest.env,guest.principal,operation);
    const failed=(await readOperation(db,operation.id))!;
    assert.equal(failed.state,'failed');assert.equal(failed.error_code,mode==='denied'?'youtube_source_denied':'youtube_fetch_unavailable');
    assert.equal((await splitAllowance(db,guest.principal.subject,new Date(),'guest')).remaining,5);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
    await resumeOwnedSourceImport(guest.env,guest.principal,failed);await drainSplitQueue(guest.env,async()=>{});
    assert.equal(loads,mode==='denied'?1:0);t.mock.restoreAll();
  }
});

test('saved Vimeo jobs remain readable with their stored source type',async t=>{
  const {db,env}=await setup(t),owner=await guestRequests(db,env,'d');
  const existing=await submitSplit(owner.env,owner.principal,{videoUrl:vimeo},'saved-vimeo-existing');
  await db.prepare("UPDATE jobs SET status='done' WHERE id=?").bind(existing.operation.job_id).run();
  const response=await owner.request(`/api/jobs/${existing.operation.job_id}`);await owner.flush();
  assert.equal(response.status,200);
  const job=await response.json() as {id:string;status:string};
  assert.equal(job.id,existing.operation.job_id);assert.equal(job.status,'done');
  assert.equal((await db.prepare('SELECT source_type FROM jobs WHERE id=?').bind(job.id).first<{source_type:string}>())!.source_type,'vimeo');
});


test('Archive search and import keep guest ownership, full audio, attribution and a single GPU start',async t=>{
  const {db,env}=await setup(t),guest=await guestRequests(db,env,'c');
  const audio=new Uint8Array(readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url)));
  const duration=mp3FrameInfo(audio.buffer)!.seconds;
  let sourceReads=0,posts=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.includes('/advancedsearch.php?'))return Response.json({response:{docs:[{identifier:'song-fixture'}]}});
    if(url==='https://archive.org/metadata/song-fixture')return Response.json({metadata:{title:'Song fixture',creator:'Artist'},files:[{name:'song.mp3',title:'Song fixture',size:String(audio.length),length:String(duration)}]});
    if(url==='https://archive.org/download/song-fixture/song.mp3'){
      if(new Headers(init?.headers).has('range'))return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
      sourceReads++;return new Response(audio,{headers:{'content-type':'audio/mpeg'}});
    }
    assert.ok(url.startsWith('https://api.replicate.com/'));
    if(init?.method==='POST'){posts++;const body=JSON.parse(String(init.body));assert.equal(body.version,splitVersion);assert.match(body.input.audio,/\.mp3$/);}
    return Response.json({id:'archive-split-fixture',status:'processing'});
  });
  const search=await guest.request('/api/music/search?q=Song');assert.equal(search.status,200);
  assert.equal(((await search.json()) as {results:{archiveId:string}[]}).results[0].archiveId,'song-fixture');
  const submit=()=>guest.request('/api/jobs',{method:'POST',headers:{'Idempotency-Key':'archive-guest-fixture'},body:JSON.stringify({archiveId:'song-fixture',archiveFile:'song.mp3',archiveSearch:true})});
  const response=await submit();const body=await response.json() as {id:string;savedToAccount:boolean};await guest.flush();
  assert.equal(response.status,202);assert.equal(body.savedToAccount,false);assert.equal(posts,1);assert.equal(sourceReads,1);
  const job=(await db.prepare('SELECT source_type,source_key,filename,source_hash FROM jobs WHERE id=?').bind(body.id).first<{source_type:string;source_key:string;filename:string;source_hash:string}>())!;
  assert.equal(job.source_type,'archive');assert.equal(job.filename,'Song fixture');assert.match(job.source_key,/\.mp3$/);
  const stored=(await env.AUDIO.get(job.source_key))!;assert.equal(stored.httpMetadata!.contentType,'audio/mpeg');
  assert.deepEqual(new Uint8Array(await new Response(stored.body).arrayBuffer()),audio);
  assert.equal(job.source_hash,Buffer.from(await crypto.subtle.digest('SHA-256',audio)).toString('hex'));
  const provenance=(await db.prepare('SELECT attribution FROM job_attributions WHERE job_id=?').bind(body.id).first<{attribution:string}>())!;
  assert.equal(JSON.parse(provenance.attribution).creator,'');
  assert.equal(JSON.parse(provenance.attribution).itemCreator,'Artist');
  assert.equal(JSON.parse(provenance.attribution).fileName,'song.mp3');
  await submit();await guest.flush();assert.equal(posts,1);assert.equal(sourceReads,1);
  // Release the fixture's processing slot before selecting the same source again.
  await db.prepare("UPDATE app_operations SET state='succeeded',lease_until=0 WHERE job_id=?").bind(body.id).run();
  await db.prepare('UPDATE import_cache SET metadata_json=?').bind(JSON.stringify({title:'Artist - Song fixture',fileName:'song.mp3',attribution:{creator:'Artist'}})).run();
  const cachedResponse=await guest.request('/api/jobs',{method:'POST',headers:{'Idempotency-Key':'archive-cache-fixture'},body:JSON.stringify({archiveId:'song-fixture',archiveFile:'song.mp3',archiveSearch:true})});
  const cachedJob=await cachedResponse.json() as {id:string};await guest.flush();
  assert.equal(cachedResponse.status,202);assert.equal(sourceReads,1);
  assert.equal((await db.prepare('SELECT filename FROM jobs WHERE id=?').bind(cachedJob.id).first<{filename:string}>())!.filename,'Song fixture');
  const refreshed=JSON.parse((await db.prepare('SELECT attribution FROM job_attributions WHERE job_id=?').bind(cachedJob.id).first<{attribution:string}>())!.attribution);
  assert.equal(refreshed.creator,'');assert.equal(refreshed.itemCreator,'Artist');assert.equal(refreshed.fileName,'song.mp3');
  const other=await guestRequests(db,env,'d');assert.equal((await other.request('/api/jobs/'+body.id)).status,404);
});

test('Archive search imports stay owner-only and a newly restricted file refunds a guest place',async t=>{
  const {db,env}=await setup(t),guest=await guestRequests(db,env,'e');let reads=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    reads++;assert.equal(String(input),'https://archive.org/metadata/song-fixture');
    return Response.json({metadata:{title:'Song fixture','access-restricted-item':'true'},files:[]});
  });
  const {operation}=await submitSplit(guest.env,guest.principal,{archiveId:'song-fixture',archiveFile:'song.mp3',archiveSearch:true},'archive-refund-fixture');
  assert.equal(await claimNext(db,'fetch'),null);await drainSplitQueue(guest.env,async()=>{});assert.equal(reads,0);
  await resumeOwnedSourceImport(guest.env,guest.principal,operation);
  const failed=(await readOperation(db,operation.id))!;assert.equal(failed.state,'failed');assert.equal(failed.provider_id,null);
  assert.equal(failed.error_code,'archive_download_restricted');
  assert.equal((await splitAllowance(db,guest.principal.subject,new Date(),'guest')).remaining,5);
  await resumeOwnedSourceImport(guest.env,guest.principal,failed);assert.equal(reads,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<{n:number}>())!.n,0);
});

test('retired Audius submissions stop before source access or quota reservation',async t=>{
  const {db,env}=await setup(t),guest=await guestRequests(db,env,'f');
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Retired provider was called');});
  const response=await guest.request('/api/jobs',{method:'POST',body:JSON.stringify({audiusId:'4zxjE'})});
  assert.equal(response.status,400);assert.equal((await response.json() as {code:string}).code,'unsupported_source');
  await assert.rejects(()=>submitSplit(guest.env,guest.principal,{audiusId:'4zxjE'},'retired-audius'),/Internet Archive/);
  assert.equal((await splitAllowance(db,guest.principal.subject,new Date(),'guest')).remaining,5);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM app_operations').first<{n:number}>())!.n,0);
});
