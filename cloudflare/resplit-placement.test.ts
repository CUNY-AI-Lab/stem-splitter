import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';
import { submitSplit } from '../src/reliability/splits.ts';
import { storedResplit, validateResplit } from '../src/resplits.ts';
import { splitAllowance } from '../src/daily-allowance.ts';
import app from '../src/index.ts';

async function fixture(t: { after: (fn: () => void) => void }, guest = false) {
  const path=mkdtempSync(join(tmpdir(),'stem-resplit-'));t.after(()=>rmSync(path,{recursive:true,force:true}));
  const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const subject=guest?'guest-'+'a'.repeat(64):'cail-'+'b'.repeat(32);
  const principal:AppPrincipal={subject,role:guest?'guest':'member',quotaClass:guest?'guest':'member',displayName:'Fixture',course:null,courseId:null};
  const now=Date.now(),expiresAt=now+3600000,verifiedDay=new Date(now).toISOString().slice(0,10);
  if(guest)await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(subject,now,expiresAt,verifiedDay).run();
  else await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const env={DB:db,AUDIO:new FsR2Bucket(join(path,'audio')),AUTH_MODE:'cail',SEPARATION_BACKEND:'replicate',PUBLIC_BASE_URL:'https://split.test',
    ...(guest?{guestRuntimeReady:true,guestSession:{subject,expiresAt,verifiedDay}}:{}),
    verifyCailIdentity:async(token:string)=>token===subject?{subject,name:'Fixture'}:null,
    ADMISSION_RESOLVER:{resolveMembership:async()=>({ok:true,accessRole:'member',budgetScope:'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()})},
  } as unknown as Env;
  const bytes=readFileSync(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  const source='stems/original/vocals.mp3',key='uploads/resplit/source.mp3';
  await env.AUDIO.put(source,bytes);await env.AUDIO.put(key,bytes);
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status,stems) VALUES('original','Original audio','uploads/original/source.mp3','done',?)")
    .bind(JSON.stringify([{name:'vocals',key:source}])).run();
  await db.prepare('INSERT INTO '+(guest?'guest_job_owners':'job_owners')+"(job_id,subject) VALUES('original',?)").bind(subject).run();
  await db.prepare('INSERT INTO '+(guest?'guest_upload_owners':'upload_owners')+"(object_key,subject,state,expires_at) VALUES(?,?,'ready',?)")
    .bind(key,subject,new Date(now+3600000).toISOString()).run();
  await db.prepare("INSERT INTO job_attributions(job_id,attribution) VALUES('original',?)")
    .bind(JSON.stringify({provider:'commons',licenseName:'CC BY 4.0',creator:'Fixture artist'})).run();
  const request=(route:string)=>app.fetch(new Request('https://split.test'+route,{headers:{Origin:'https://split.test',...(guest?{}:{'x-cail-identity-jwt':subject})}}),env);
  return {db,env,principal,key,source,bytes,request};
}
for(const guest of [false,true])for(const placement of ['with_original','separate'] as const)test((guest?'guest':'member')+' resplit '+placement+' persists exactly once with verified bytes and source credits',async t=>{
  const f=await fixture(t,guest);
  const resplit={parentJobId:'original',stem:'vocals',placement};
  const body={key:f.key,filename:'Original audio — vocals.mp3',model:'htdemucs_ft',resplit};
  const first=await submitSplit(f.env,f.principal,body,'resplit-placement-0001');
  const second=await submitSplit(f.env,f.principal,body,'resplit-placement-0001');
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(second.operation.id,first.operation.id);
  assert.deepEqual(storedResplit(second.operation.request_json),resplit);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM app_operations').first<{n:number}>())!.n,1);
  assert.equal((await splitAllowance(f.env.DB,f.principal.subject,new Date(),f.principal.quotaClass,f.principal.role)).inProgress,1);
  assert.equal((await f.db.prepare('SELECT attribution FROM job_attributions WHERE job_id=?').bind(first.operation.id).first<{attribution:string}>())?.attribution,
    (await f.db.prepare("SELECT attribution FROM job_attributions WHERE job_id='original'").first<{attribution:string}>())?.attribution);
  const response=await f.request('/api/jobs');assert.equal(response.status,200);
  const list=await response.json() as any;
  assert.deepEqual(list.jobs.find((job:any)=>job.id===first.operation.id).resplit,resplit);
  assert.ok(!JSON.stringify(list).includes('request_json'));
  assert.ok(!JSON.stringify(list).includes(f.key));
  assert.equal((await f.db.prepare("SELECT filename FROM jobs WHERE id='original'").first<{filename:string}>())?.filename,'Original audio');
  await assert.rejects(submitSplit(f.env,f.principal,{...body,resplit:{...resplit,placement:placement==='separate'?'with_original':'separate'}},'resplit-placement-0001'),
    (error:any)=>error.code==='idempotency_conflict');
});
test('resplit rejects another owner, unavailable stems, workspace mismatch and changed bytes before spending any allowance',async t=>{
  const f=await fixture(t);
  const resplit={parentJobId:'original',stem:'vocals',placement:'with_original'};
  await assert.rejects(validateResplit(f.env,{...f.principal,subject:'cail-'+'c'.repeat(32),role:'admin'},resplit,f.key),(e:any)=>e.code==='resplit_unavailable');
  await assert.rejects(validateResplit(f.env,f.principal,{...resplit,stem:'missing'},f.key),(e:any)=>e.code==='resplit_unavailable');
  await assert.rejects(validateResplit(f.env,{...f.principal,courseId:'different-class'},resplit,f.key),(e:any)=>e.code==='resplit_workspace_changed');
  await assert.rejects(validateResplit(f.env,f.principal,{...resplit,placement:'unknown'},f.key),(e:any)=>e.code==='invalid_resplit');
  const changed=new Uint8Array(f.bytes);changed[changed.length-1]^=1;await f.env.AUDIO.put(f.key,changed);
  await assert.rejects(submitSplit(f.env,f.principal,{key:f.key,filename:'audio.mp3',model:'htdemucs_ft',resplit},'resplit-mismatch-0001'),(e:any)=>e.code==='resplit_audio_changed');
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM app_operations').first<{n:number}>())!.n,0);
  assert.equal((await splitAllowance(f.env.DB,f.principal.subject)).inProgress,0);
});
test('old and purged operation records expose no invented resplit grouping',()=>{
  for(const value of [null,undefined,'{}','bad json','{"resplit":{"parentJobId":"x","stem":"vocals","placement":"bad"}}'])assert.equal(storedResplit(value),null);
});
