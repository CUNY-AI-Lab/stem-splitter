import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteD1} from '../server/d1.ts';
import {FsR2Bucket} from '../server/r2.ts';
import type {Env} from '../src/env.ts';
import type {AppPrincipal} from '../src/identity.ts';
import app from '../src/index.ts';
import {submitSplit} from '../src/reliability/splits.ts';
import {defaultSplitChoice,getSeparationOptions} from '../src/separation/options.ts';

test('Auto default is a request choice, preserving concrete provider fallbacks and unavailable routes',()=>{
 const options=getSeparationOptions('replicate',true);
 assert.equal(options.defaultModel,'adaptive_four');
 assert.equal(defaultSplitChoice(options.defaultModel,true),'auto');
 assert.equal(defaultSplitChoice(options.defaultModel,false),'adaptive_four');
 assert.equal(defaultSplitChoice('htdemucs_ft',false),'htdemucs_ft');
});

test('omitted new requests choose enabled Auto while explicit choices and queued work remain unchanged',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'stem-auto-default-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const db=new SqliteD1(join(directory,'db'));db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const subject='cail-'+ 'e'.repeat(32),key='uploads/fixture/source.wav';
 await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
 const audio=new FsR2Bucket(join(directory,'audio'));await audio.put(key,readFileSync(new URL('../tests/fixtures/audio/source.wav',import.meta.url)));
 await db.prepare("INSERT INTO upload_owners(object_key,subject,state,expires_at) VALUES(?,?,'ready',?)").bind(key,subject,new Date(Date.now()+60000).toISOString()).run();
 const env={DB:db,AUDIO:audio,AUTH_MODE:'cail',SEPARATION_BACKEND:'replicate',ADAPTIVE_FOUR_ENABLED:'true',composeStemAudio:()=>{throw new Error('No processing is permitted by this reservation fixture');}} as unknown as Env;
 const principal={subject,role:'student',quotaClass:'member',courseId:null} as AppPrincipal;
 const reserve=async(model?:string)=>submitSplit(env,principal,{key,filename:'Fixture recording',...(model===undefined?{}:{model})},crypto.randomUUID());
 const automatic=await reserve();const autoInput=JSON.parse(automatic.operation.request_json);
 assert.equal(autoInput.adaptive,'auto');assert.equal(autoInput.model,'htdemucs_6s');
 const explicit=await reserve('adaptive_four');assert.equal(JSON.parse(explicit.operation.request_json).adaptive,4);
 const two=await reserve('vocals_instrumental');assert.equal(JSON.parse(two.operation.request_json).model,'vocals_instrumental');assert.equal(JSON.parse(two.operation.request_json).adaptive,undefined);
 assert.equal((await db.prepare('SELECT routing_request FROM jobs WHERE id=?').bind(automatic.operation.job_id).first<any>())!.routing_request,'adaptive:auto');
 assert.equal((await db.prepare('SELECT routing_request FROM jobs WHERE id=?').bind(explicit.operation.job_id).first<any>())!.routing_request,'adaptive:4');
 await assert.rejects(reserve('unsupported'),(error:any)=>error.code==='invalid_model');
 env.ADAPTIVE_FOUR_ENABLED='false';const fallback=await reserve();assert.equal(JSON.parse(fallback.operation.request_json).model,'htdemucs_ft');
 // The API and omitted request agree for existing authoritative, shadow and off routes.
 for(const mode of ['authoritative','shadow','off']){
  env.SERVER_AUTO_ENABLED=mode==='off'?'false':'true';env.SERVER_AUTO_MODE=mode;
  const response=await app.request('/api/separation-options',{},env);
  assert.equal(response.status,200);const body=await response.json() as any;
  assert.equal(body.defaultChoice,mode==='authoritative'?'auto':mode==='shadow'?'htdemucs_ft':undefined);
  const operation=await reserve();const input=JSON.parse(operation.operation.request_json);
  assert.equal(input.auto,mode==='authoritative');assert.equal(input.model,'htdemucs_ft');
 }
 assert.equal((await db.prepare('SELECT request_json FROM app_operations WHERE id=?').bind(explicit.operation.id).first<any>())!.request_json,explicit.operation.request_json);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>())!.n,0,'default selection never starts a provider');
});
