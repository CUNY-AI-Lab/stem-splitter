import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SqliteD1} from '../server/d1.ts';
import app from '../src/index.ts';
import type {Env} from '../src/env.ts';
import {courseFixture} from './course-fixture.ts';
import {defaultSampleSettings,parseSampleSettings,readSampleResource,saveSampleResource,publicSampleResource,SampleResourceError} from '../src/song-sample-resource.ts';
const teacher='cail-'+ '1'.repeat(32),student='cail-'+ '2'.repeat(32),admin='cail-'+ '3'.repeat(32);
async function setup(){
  const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  for(const subject of [teacher,student,admin])await db.prepare('INSERT INTO app_users(subject,role) VALUES(?,?)').bind(subject,subject===teacher?'instructor':'student').run();
  const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',CAIL_CLASSROOM_ENABLED:'false',DB:db,
    verifyCailIdentity:async(token:string)=>[teacher,student,admin].includes(token)?{subject:token,name:'Instructor fixture'}:null,
    ADMISSION_RESOLVER:{resolveMembership:async({subject}:{subject:string})=>({ok:true,accessRole:subject===admin?'admin':'member',budgetScope:subject===admin?'admin':'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),resolveCourseAccess:async({subject,classId}:{subject:string;classId:string})=>courseFixture(subject,classId,false)}} as unknown as Env;
  const request=(path:string,who=teacher,method='GET',body?:unknown)=>app.fetch(new Request('https://split.test'+path,{method,headers:{'x-cail-identity-jwt':who,Origin:'https://split.test','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env);
  return {db:db as unknown as D1Database,request};
}
test('song settings enforce complete-name timing, bounded unique recordings and ordering',()=>{
  const base=defaultSampleSettings();assert.equal(base.tracks.length,6);assert.deepEqual(base.tracks.map(t=>t.archiveId),['riversidejazz','1979-yellow-magic-orchestra-solid-state-survivor','willie-nelson-ride-me-back-home','1976-jorge-ben-africa-brasil','HUG055CD','simon-garfunkel-sounds-of-silence-1966-2014_24-192']);assert.ok(base.tracks.every(t=>!('genre' in t)));
  // A retired category on stored or submitted songs is accepted and dropped.
  assert.ok(parseSampleSettings({...base,tracks:base.tracks.map(t=>({...t,genre:'country'}))}).tracks.every(t=>!('genre' in t)));assert.ok(base.tracks.every(t=>t.durationSec!>0&&t.durationSec!<=300&&t.importTestedAt));
  for(const change of [{holdMs:2999},{cadenceMs:3500},{tracks:[base.tracks[0],base.tracks[0]]},{tracks:[]},{tracks:[{...base.tracks[0],archiveFile:'not-audio.html'}]}])assert.throws(()=>parseSampleSettings({...base,...change}),SampleResourceError);
  assert.deepEqual(parseSampleSettings({...base,tracks:[...base.tracks].reverse()}).tracks.map(t=>t.title),[...base.tracks].reverse().map(t=>t.title));
  assert.equal(parseSampleSettings({...base,enabled:false,tracks:[]}).enabled,false);
});
test('song settings persist atomically, reject stale concurrent editors, and retain immutable history',async()=>{
  const empty=new SqliteD1(':memory:');await assert.rejects(readSampleResource(empty as unknown as D1Database),/no such table/);
  const {db}=await setup(),initial=await readSampleResource(db);
  const outcomes=await Promise.allSettled([saveSampleResource(db,{...initial.settings,holdMs:4000},0,teacher),saveSampleResource(db,{...initial.settings,cadenceMs:7000},0,admin)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.status,409);
  const saved=await readSampleResource(db);assert.equal(saved.revision,1);
  const history=await db.prepare('SELECT * FROM song_sample_revisions').all();assert.equal(history.results.length,1);
  await assert.rejects(db.prepare('DELETE FROM song_sample_revisions').run(),/immutable/);
  await assert.rejects(db.prepare("UPDATE song_sample_revisions SET updated_by='other'").run(),/immutable/);
  await assert.rejects(db.prepare('INSERT OR REPLACE INTO song_sample_revisions SELECT * FROM song_sample_revisions').run(),/immutable/);
  assert.equal((await readSampleResource(db)).revision,1);
  const response=await publicSampleResource(db,new Request('https://split.test/api/song-samples'));
  const body=await response.json() as any;assert.equal(body.revision,1);assert.equal(body.tracks.length,6);assert.equal('updatedBy'in body,false);
  const legacy=await publicSampleResource(db,new Request('https://split.test/search-samples.json'));assert.equal(Array.isArray(await legacy.json()),true);
  assert.equal((await publicSampleResource(db,new Request('https://split.test/api/song-samples',{headers:{'if-none-match':response.headers.get('etag')!}}))).status,304);
});
test('only instructor-console roles configure songs; public readers see fresh settings without private run data',async()=>{
  const {db,request}=await setup();
  for(const method of ['GET','PUT'])assert.equal((await request('/api/teacher/song-samples',student,method,method==='PUT'?{expectedRevision:0,settings:defaultSampleSettings()}:undefined)).status,403);
  assert.equal((await request('/api/teacher/song-samples','')).status,401);
  const first=await request('/api/teacher/song-samples');assert.equal(first.status,200);assert.match(first.headers.get('cache-control')!,/no-store/);
  const track=defaultSampleSettings().tracks[0];
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('private-success','Private original','uploads/private.mp3','done'),('private-failure','Failed original','uploads/failed.mp3','failed')").run();
  for(const id of ['private-success','private-failure'])await db.prepare('INSERT INTO job_attributions(job_id,attribution) VALUES(?,?)').bind(id,JSON.stringify({sourceUrl:'https://archive.org/details/'+encodeURIComponent(track.archiveId),fileName:track.archiveFile})).run();
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('malformed','Legacy metadata','uploads/legacy.mp3','done')").run();
  await db.prepare("INSERT INTO job_attributions(job_id,attribution) VALUES('malformed','not-json')").run();
  const enriched=await(await request('/api/teacher/song-samples')).json() as any;
  assert.equal(enriched.catalog.find((t:any)=>t.archiveId===track.archiveId&&t.archiveFile===track.archiveFile).successfulRuns,1);
  assert.doesNotMatch(JSON.stringify(enriched),/private-success|private-failure|Private original/);
  const edited={...defaultSampleSettings(),enabled:false,holdMs:4500,cadenceMs:7000};
  assert.equal((await request('/api/teacher/song-samples',admin,'PUT',{expectedRevision:0,settings:edited})).status,200);
  const publicView=await(await request('/api/song-samples','')).json() as any;assert.equal(publicView.enabled,false);assert.deepEqual(publicView.tracks,[]);assert.equal(publicView.holdMs,4500);assert.equal(publicView.cadenceMs,7000);assert.equal('catalog'in publicView,false);
  assert.equal((await request('/api/teacher/song-samples',teacher,'PUT',{expectedRevision:0,settings:edited})).status,409);
});
