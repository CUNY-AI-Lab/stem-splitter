import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteD1} from '../server/d1.ts';
import {FsR2Bucket} from '../server/r2.ts';
import {deleteOwnedRun,recordFailedRunSession,runWasDeleted,purgeDeletedRuns} from '../src/run-deletion.ts';
import type {Env} from '../src/env.ts';
import type {AppPrincipal} from '../src/identity.ts';
async function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'run-delete-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const db=new SqliteD1(join(dir,'db'));db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const env={DB:db,AUDIO:new FsR2Bucket(join(dir,'audio')),AUTH_MODE:'cail',RUN_DELETION_ENABLED:'true'} as unknown as Env;
 const owner={subject:'cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',role:'student',displayName:'Owner',course:null,courseId:null} as AppPrincipal;
 await env.DB.prepare("INSERT INTO app_users(subject) VALUES('cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),('cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')").run();
 await env.DB.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('run','fixture','uploads/run/audio.wav','failed')").run();
 await env.DB.prepare("INSERT INTO job_owners VALUES('run','cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')").run();return {env,owner};
}
test('failures survive second session; reloads and alternating tabs count once',async t=>{
 const {env,owner}=await fixture(t);
 for(const session of ['session-0000000001','session-0000000001','session-0000000002','session-0000000001','session-0000000002']){
  await recordFailedRunSession(env,owner,session);assert.equal(await runWasDeleted(env,'run'),false);
 }
 await recordFailedRunSession(env,{...owner,subject:'cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},'session-0000000003');assert.equal(await runWasDeleted(env,'run'),false);
 await recordFailedRunSession(env,owner,'session-0000000003');assert.equal(await runWasDeleted(env,'run'),true);
 await purgeDeletedRuns(env);assert.equal(await env.DB.prepare("SELECT 1 FROM jobs WHERE id='run'").first(),null);
});
test('owner deletion is durable and purges only that run audio',async t=>{
 const {env,owner}=await fixture(t);
 await env.AUDIO.put('uploads/run/audio.wav',new Uint8Array([1,2]));
 await env.AUDIO.put('stems/run/vocals.mp3',new Uint8Array([3]));
 await env.AUDIO.put('stems/other/vocals.mp3',new Uint8Array([4]));
 assert.equal(await deleteOwnedRun(env,{...owner,subject:'cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},'run'),false);
 assert.equal(await deleteOwnedRun(env,owner,'run'),true);await purgeDeletedRuns(env);
 assert.equal(await env.AUDIO.get('uploads/run/audio.wav'),null);assert.equal(await env.AUDIO.get('stems/run/vocals.mp3'),null);
 assert.ok(await env.AUDIO.get('stems/other/vocals.mp3'));assert.equal(await deleteOwnedRun(env,owner,'run'),true);
 assert.equal(await deleteOwnedRun(env,{...owner,subject:'cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},'run'),false);
});
test('shared source survives deletion',async t=>{
 const {env,owner}=await fixture(t);
 await env.DB.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('another','fixture','uploads/run/audio.wav','done')").run();
 await env.AUDIO.put('uploads/run/audio.wav',new Uint8Array([1]));
 await deleteOwnedRun(env,owner,'run');await purgeDeletedRuns(env);assert.ok(await env.AUDIO.get('uploads/run/audio.wav'));
});
