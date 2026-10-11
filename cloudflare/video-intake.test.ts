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
import { drainSplitQueue, reconcileSplit, submitSplit } from '../src/reliability/splits.ts';
import { fingerprint, OperationError, readOperation } from '../src/reliability/ledger.ts';
import { splitAllowance } from '../src/daily-allowance.ts';
import { courseFixture } from './course-fixture.ts';

const subject='cail-'+ 'e'.repeat(32);
const principal:AppPrincipal={subject,role:'student',displayName:'Fixture',course:null,courseId:null};
const vimeo='https://vimeo.com/160743502/abd0e13fb4';
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

test('durable Vimeo import stores audio and its provenance before starting the selected separator',async t=>{
  const {db,env}=await setup(t);
  const {operation}=await submitSplit(env,principal,{videoUrl:'https://player.vimeo.com/video/160743502?h=abd0e13fb4'},'vimeo-pipeline-fixture');
  const bytes=new Uint8Array(2048);bytes.set([0,0,0,24,102,116,121,112]);
  const posts:Array<{version:string;input:{url?:string;audio?:string}}>=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.method==='POST') {
      assert.equal(String(input),'https://api.replicate.com/v1/predictions');
      const body=JSON.parse(String(init.body));posts.push(body);
      return Response.json({id:body.version===importVersion?'vimeo-import-fixture':'vimeo-split-fixture',status:'starting'});
    }
    assert.equal(String(input),'https://api.replicate.com/v1/predictions/vimeo-import-fixture');
    return Response.json({id:'vimeo-import-fixture',status:'succeeded',output:{
      title:'Vimeo fixture',duration:19,audio:`data:audio/mp4;base64,${Buffer.from(bytes).toString('base64')}`,
    }});
  });
  const complete=async()=>assert.fail('Import does not complete separation');
  await drainSplitQueue(env,complete);
  assert.equal(posts.length,1);assert.equal(posts[0].version,importVersion);assert.equal(posts[0].input.url,vimeo);
  await reconcileSplit(env,(await readOperation(db,operation.id))!,complete);
  let current=(await readOperation(db,operation.id))!;
  assert.equal(current.phase,'split');assert.equal(current.state,'queued');
  assert.equal(JSON.parse(current.request_json).sourceType,'vimeo');
  const job=await db.prepare('SELECT source_type,source_key,source_hash FROM jobs WHERE id=?').bind(operation.job_id)
    .first<{source_type:string;source_key:string;source_hash:string}>();
  assert.equal(job!.source_type,'vimeo');
  assert.equal(job!.source_hash,Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'));
  assert.deepEqual(new Uint8Array(await new Response((await env.AUDIO.get(job!.source_key))!.body).arrayBuffer()),bytes);
  const nextPoll=current.not_before+1;t.mock.method(Date,'now',()=>nextPoll);
  await drainSplitQueue(env,complete);current=(await readOperation(db,operation.id))!;
  assert.equal(current.phase,'split');assert.equal(current.state,'processing');
  assert.equal(posts.length,2);assert.equal(posts[1].version,splitVersion);
  const sourceUrl=new URL(posts[1].input.audio!);
  assert.equal(sourceUrl.origin,'https://split.test');
  assert.equal(sourceUrl.pathname,`/api/local-sources/${job!.source_key}`);
  assert.equal((await splitAllowance(db,subject)).inProgress,1);
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
