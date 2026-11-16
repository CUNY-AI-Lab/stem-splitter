import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SqliteD1} from '../server/d1.ts';
import app from '../src/index.ts';
import type {Env} from '../src/env.ts';
import {courseFixture} from './course-fixture.ts';
import {claimedGuestPreferenceScope,claimedPreferenceStatements,guestPreferenceScope,normalizePreference,readAccountPreferences,seedAccountPreferences,writeAccountPreference,validatePreferenceSeed} from '../src/account-preferences.ts';
import {purgeExpiredAccountPreferences} from './retention.ts';

const alice=`cail-${'a'.repeat(32)}`,bob=`cail-${'b'.repeat(32)}`,guest=`guest-${'c'.repeat(64)}`;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(){
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 for(const subject of [alice,bob])await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
 return db;
}
const list=(db:SqliteD1,subject:string)=>db.prepare('SELECT kind,revision,payload_json,digest FROM account_preferences WHERE subject=? ORDER BY kind').bind(subject).all<any>();

test('five preference slots accept only their fixed bounded shapes',()=>{
 assert.deepEqual(normalizePreference('classChoice','msh-245'), 'msh-245');
 assert.deepEqual(normalizePreference('modelChoice','auto'),'auto');
 assert.deepEqual(normalizePreference('benchTab','splitter'),'splitter');
 assert.deepEqual(normalizePreference('sampleRotation',{revision:1,seen:['a/a.mp3'],last:'a/a.mp3',pass:0,order:['a/a.mp3']}),{revision:1,seen:['a/a.mp3'],last:'a/a.mp3',pass:0,order:['a/a.mp3']});
 assert.deepEqual(normalizePreference('rackLayout',{entries:[{jobId:'job-1',collapsed:true,rank:0}],suppressedJobIds:[]}),{entries:[{jobId:'job-1',collapsed:true,rank:0}],suppressedJobIds:[]});
 assert.throws(()=>normalizePreference('classChoice','x'.repeat(129)));
 assert.throws(()=>normalizePreference('benchTab','admin'));
 assert.throws(()=>normalizePreference('sampleRotation',{revision:1,seen:['a/a.mp3','a/a.mp3'],last:'',pass:0,order:[]}));
 assert.throws(()=>normalizePreference('rackLayout',{entries:[{jobId:'job-1',collapsed:false,rank:0},{jobId:'job-2',collapsed:false,rank:0}],suppressedJobIds:[]}));
 assert.throws(()=>validatePreferenceSeed({requestId:id(1),records:[{kind:'arbitraryKey',value:'x'}]}));
});

test('preference reads and writes are actor-private, CAS revisions and request receipts are exact',async()=>{
 const db=await fixture();
 const first={kind:'modelChoice' as const,requestId:id(1),baseRevision:0,value:'htdemucs_ft'};
 assert.deepEqual(await writeAccountPreference(db,alice,first),{kind:'modelChoice',outcome:'applied',revision:1});
 assert.deepEqual(await writeAccountPreference(db,alice,first),{kind:'modelChoice',outcome:'applied',revision:1},'lost acknowledgements return the same receipt');
 await assert.rejects(writeAccountPreference(db,alice,{...first,value:'other'}),(error:any)=>error.status===409);
 assert.deepEqual((await readAccountPreferences(db,alice)).preferences.modelChoice,{value:'htdemucs_ft',revision:1});
 assert.deepEqual((await readAccountPreferences(db,bob)).preferences,{});
 const stale=await writeAccountPreference(db,alice,{...first,requestId:id(2),value:'different'});
 assert.deepEqual(stale,{kind:'modelChoice',outcome:'conflict',revision:1});
 assert.equal((await readAccountPreferences(db,alice)).preferences.modelChoice?.value,'htdemucs_ft');
 assert.equal((await db.prepare('SELECT payload_json FROM account_preference_versions WHERE subject=? AND kind=?').bind(alice,'modelChoice').first<any>()).payload_json,'"different"');
 assert.equal((await readAccountPreferences(db,bob)).preferences.modelChoice,undefined);
});

test('missing-only seed never replaces an active value and retains a differing local version',async()=>{
 const db=await fixture();
 const seeded=await seedAccountPreferences(db,alice,{requestId:id(3),records:[{kind:'benchTab',value:'splitter'},{kind:'classChoice',value:'msh-245'}]});
 assert.equal(seeded.accepted.length,2);assert.ok(seeded.accepted.every(row=>row.outcome==='applied'));
 const repeated=await seedAccountPreferences(db,alice,{requestId:id(3),records:[{kind:'benchTab',value:'splitter'},{kind:'classChoice',value:'msh-245'}]});
 assert.ok(repeated.accepted.every(row=>row.outcome==='applied'));
 const conflict=await seedAccountPreferences(db,alice,{requestId:id(4),records:[{kind:'benchTab',value:'remixer'}]});
 assert.deepEqual(conflict.accepted,[{kind:'benchTab',outcome:'conflict',revision:1}]);
 assert.equal((await readAccountPreferences(db,alice)).preferences.benchTab?.value,'splitter');
 assert.equal((await db.prepare('SELECT payload_json FROM account_preference_versions WHERE subject=? AND kind=?').bind(alice,'benchTab').first<any>()).payload_json,'"remixer"');
});

test('explicit null clear advances revision and a stale legacy seed cannot resurrect the prior value',async()=>{
 const db=await fixture();
 await writeAccountPreference(db,alice,{kind:'benchTab',requestId:id(40),baseRevision:0,value:'splitter'});
 const cleared=await writeAccountPreference(db,alice,{kind:'benchTab',requestId:id(41),baseRevision:1,value:null});
 assert.deepEqual(cleared,{kind:'benchTab',outcome:'applied',revision:2});
 assert.deepEqual((await readAccountPreferences(db,alice)).preferences.benchTab,{value:null,revision:2});
 const stale=await seedAccountPreferences(db,alice,{requestId:id(42),records:[{kind:'benchTab',value:'splitter'}]});
 assert.deepEqual(stale.accepted,[{kind:'benchTab',outcome:'conflict',revision:2}]);
 assert.deepEqual((await readAccountPreferences(db,alice)).preferences.benchTab,{value:null,revision:2});
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM account_preference_versions WHERE subject=? AND kind='benchTab'").bind(alice).first<any>()).n,1);
});

test('concurrent writes at one base revision have one winner and retain the losing version',async()=>{
 const db=await fixture();
 const results=await Promise.all([
  writeAccountPreference(db,alice,{kind:'modelChoice',requestId:id(43),baseRevision:0,value:'auto'}),
  writeAccountPreference(db,alice,{kind:'modelChoice',requestId:id(44),baseRevision:0,value:'htdemucs_ft'}),
 ]);
 assert.equal(results.filter(result=>result.outcome==='applied').length,1);
 assert.equal(results.filter(result=>result.outcome==='conflict').length,1);
 assert.equal((await readAccountPreferences(db,alice)).preferences.modelChoice?.revision,1);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM account_preference_versions WHERE subject=? AND kind='modelChoice' AND reason='conflict'").bind(alice).first<any>()).n,1);
});

test('malformed multi-slot seeds validate completely before any preference or receipt write',async()=>{
 const db=await fixture();
 await assert.rejects(seedAccountPreferences(db,alice,{requestId:id(45),records:[
  {kind:'benchTab',value:'splitter'},
  {kind:'classChoice',value:'course with spaces'},
 ]}));
 await assert.rejects(seedAccountPreferences(db,alice,{requestId:id(46),records:[{kind:'benchTab',value:'splitter'},{kind:'benchTab',value:'remixer'}]}));
 assert.deepEqual((await readAccountPreferences(db,alice)).preferences,{});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_preference_receipts WHERE subject=?').bind(alice).first<any>()).n,0);
});

test('oversized valid-shaped seed is rejected before earlier slots can commit',async()=>{
 const db=await fixture();
 const keys=Array.from({length:64},(_,index)=>`archive/${'x'.repeat(490)}-${index}.mp3`);
 const oversized={requestId:id(56),records:[{kind:'benchTab' as const,value:'splitter'},{kind:'sampleRotation' as const,value:{revision:1,seen:keys,last:keys[0],pass:0,order:keys}}]};
 await assert.rejects(seedAccountPreferences(db,alice,oversized),(error:any)=>error.status===413);
 assert.deepEqual((await readAccountPreferences(db,alice)).preferences,{});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_preference_receipts WHERE subject=?').bind(alice).first<any>()).n,0);
});

test('preference payload quota failure atomically rolls back its receipt and conflict version',async()=>{
 const db=await fixture();
 const rack=(batch:number)=>({entries:Array.from({length:200},(_,rank)=>({jobId:`j${batch.toString().padStart(2,'0')}-${rank.toString().padStart(3,'0')}-${'x'.repeat(40)}`,collapsed:rank%2===0,rank})),suppressedJobIds:[]});
 await writeAccountPreference(db,alice,{kind:'rackLayout',requestId:id(47),baseRevision:0,value:rack(0)});
 let failureRequest=id(48),acceptedConflicts=0,failureMessage='';
 for(let batch=1;batch<40;batch++){
  failureRequest=id(47+batch);
  try{
   const receipt=await writeAccountPreference(db,alice,{kind:'rackLayout',requestId:failureRequest,baseRevision:0,value:rack(batch)});
   assert.equal(receipt.outcome,'conflict');acceptedConflicts++;
  }catch(error){failureMessage=String(error);break;}
 }
 const versions=await db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS bytes FROM account_preference_versions WHERE subject=? AND kind='rackLayout'").bind(alice).first<any>();
 assert.ok(acceptedConflicts>0,failureMessage);assert.ok(versions.bytes<=262144);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_preference_receipts WHERE subject=? AND kind=\'rackLayout\' AND request_id=?').bind(alice,failureRequest).first<any>()).n,0,'failed quota write leaves no receipt');
 assert.equal(versions.n,acceptedConflicts,'failed quota write leaves no archived version');
 assert.equal((await readAccountPreferences(db,alice)).preferences.rackLayout?.revision,1,'quota failure never replaces active preference');
});

test('disabled members cannot read or write typed preferences',async()=>{
 const db=await fixture(),origin='https://split.test';
 await db.prepare('UPDATE app_users SET disabled=1,updated_by=? WHERE subject=?').bind(alice,alice).run();
 const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:origin,CAIL_COURSE_IDS:'',DB:db,
  verifyCailIdentity:async(token:string)=>token===alice?{subject:alice,name:'Student'}:null,
  ADMISSION_RESOLVER:{resolveMembership:async()=>({ok:true,accessRole:'member',budgetScope:'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),
    resolveCourseAccessV2:async()=>courseFixture(alice,'msh-245',true)},
  REQUEST_LIMIT:{limit:async()=>({success:true})},UI_STATE_LIMIT:{limit:async()=>({success:true})}} as unknown as Env;
 const call=(method:string,body?:unknown)=>app.fetch(new Request(origin+'/api/account/preferences',{method,headers:{origin,'content-type':'application/json','x-cail-identity-jwt':alice,'X-Stem-Account':alice},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 assert.equal((await call('GET')).status,403);
 assert.equal((await call('PUT',{kind:'benchTab',requestId:id(57),baseRevision:0,value:'splitter'})).status,403);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_preferences WHERE subject=?').bind(alice).first<any>()).n,0);
});

test('guest preference scope binds exact live cookie expiry and does not extend session retention',async()=>{
 const db=await fixture(),now=Date.now(),expires=now+60000;
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now-1000,expires,'2026-11-16').run();
 const scope=guestPreferenceScope(guest,expires,now);
 const saved=await writeAccountPreference(db,guest,{kind:'benchTab',requestId:id(5),baseRevision:0,value:'splitter'},scope);
 assert.equal(saved.outcome,'applied');
 assert.equal((await db.prepare('SELECT expires_at FROM account_preferences WHERE subject=?').bind(guest).first<any>()).expires_at,expires);
 const forged=guestPreferenceScope(guest,expires+1,now);
 await assert.rejects(writeAccountPreference(db,guest,{kind:'modelChoice',requestId:id(6),baseRevision:0,value:'auto'},forged),(error:any)=>error.status===403);
 await db.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(now,guest).run();
 await assert.rejects(writeAccountPreference(db,guest,{kind:'modelChoice',requestId:id(7),baseRevision:0,value:'auto'},scope),(error:any)=>error.status===403);
});

test('guest claim copies only through the exact active mapping, member values win and conflicts are retained',async()=>{
 const db=await fixture(),now=Date.now(),expires=now+60000;
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now-1000,expires,'2026-11-16').run();
 await db.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest,alice).run();
 const gs=guestPreferenceScope(guest,expires,now);
 await writeAccountPreference(db,guest,{kind:'benchTab',requestId:id(8),baseRevision:0,value:'remixer'},gs);
 await writeAccountPreference(db,guest,{kind:'modelChoice',requestId:id(9),baseRevision:0,value:'htdemucs_ft'},gs);
 await writeAccountPreference(db,alice,{kind:'benchTab',requestId:id(10),baseRevision:0,value:'splitter'});
 await db.batch(claimedPreferenceStatements(db,guest,alice,{now,expiresAt:expires}));
 const prefs=(await readAccountPreferences(db,alice)).preferences;
 assert.equal(prefs.benchTab?.value,'splitter');assert.equal(prefs.modelChoice?.value,'htdemucs_ft');
 assert.equal((await db.prepare("SELECT payload_json FROM account_preference_versions WHERE subject=? AND kind='benchTab' AND reason='claim-conflict'").bind(alice).first<any>()).payload_json,'"remixer"');
 assert.equal((await readAccountPreferences(db,guest,gs)).preferences.modelChoice?.value,'htdemucs_ft','guest originals remain');
 await db.prepare('DELETE FROM guest_account_claims WHERE guest_subject=?').bind(guest).run();
 await db.prepare("DELETE FROM account_preferences WHERE subject=?").bind(alice).run();
 await db.batch(claimedPreferenceStatements(db,guest,bob,{now,expiresAt:expires}));
 assert.deepEqual((await readAccountPreferences(db,bob)).preferences,{});
});

test('late claimed guest CAS advances only unchanged claim-derived member slots',async()=>{
 const now=Date.now(),expires=now+60000;
 const make=async(memberValue?:string)=>{
  const db=await fixture();
  await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now-1000,expires,'2026-11-16').run();
  await db.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest,alice).run();
  await writeAccountPreference(db,guest,{kind:'benchTab',requestId:id(70),baseRevision:0,value:'splitter'},guestPreferenceScope(guest,expires,now));
  if(memberValue)await writeAccountPreference(db,alice,{kind:'benchTab',requestId:id(71),baseRevision:0,value:memberValue});
  await db.batch(claimedPreferenceStatements(db,guest,alice,{now,expiresAt:expires}));
  return db;
 };
 const late=await make();
 assert.deepEqual((await readAccountPreferences(late,alice)).preferences.benchTab,{value:'splitter',revision:1});
 const cleared=await writeAccountPreference(late,guest,{kind:'benchTab',requestId:id(72),baseRevision:1,value:null},claimedGuestPreferenceScope(guest,alice,expires,now));
 assert.equal(cleared.outcome,'applied');
 await late.batch(claimedPreferenceStatements(late,guest,alice,{now:now+1,expiresAt:expires}));
 assert.deepEqual((await readAccountPreferences(late,alice)).preferences.benchTab,{value:null,revision:2});
 assert.ok((await late.prepare("SELECT expires_at AS expiresAt FROM account_preferences WHERE subject=? AND kind='benchTab'").bind(alice).first<any>()).expiresAt>expires,'late claim copy retains member-side preference retention after the source guest expires');
 assert.throws(()=>claimedGuestPreferenceScope(guest,alice,expires,expires+1),(error:any)=>error.status===403,'expired guest cannot obtain scope for another late write');
 assert.equal((await late.prepare("SELECT COUNT(*) AS n FROM account_preference_versions WHERE subject=? AND kind='benchTab' AND reason='claim-conflict'").bind(alice).first<any>()).n,0,'claim-derived value is advanced rather than misfiled as a conflict');

 const preexisting=await make('remixer');
 await writeAccountPreference(preexisting,guest,{kind:'benchTab',requestId:id(73),baseRevision:1,value:null},claimedGuestPreferenceScope(guest,alice,expires,now));
 await preexisting.batch(claimedPreferenceStatements(preexisting,guest,alice,{now:now+1,expiresAt:expires}));
 assert.deepEqual((await readAccountPreferences(preexisting,alice)).preferences.benchTab,{value:'remixer',revision:1});

 const concurrentlyEdited=await make();
 await writeAccountPreference(concurrentlyEdited,alice,{kind:'benchTab',requestId:id(74),baseRevision:1,value:'remixer'});
 await writeAccountPreference(concurrentlyEdited,guest,{kind:'benchTab',requestId:id(75),baseRevision:1,value:null},claimedGuestPreferenceScope(guest,alice,expires,now));
 await concurrentlyEdited.batch(claimedPreferenceStatements(concurrentlyEdited,guest,alice,{now:now+1,expiresAt:expires}));
 assert.deepEqual((await readAccountPreferences(concurrentlyEdited,alice)).preferences.benchTab,{value:'remixer',revision:2});
 assert.equal((await concurrentlyEdited.prepare("SELECT COUNT(*) AS n FROM account_preference_versions WHERE subject=? AND kind='benchTab' AND reason='claim-conflict'").bind(alice).first<any>()).n,1,'a member edit changes provenance and is never overwritten');
});

test('bounded retention removes expired and revoked guest preference data',async()=>{
 const db=await fixture(),now=Date.now(),expired=now-1;
 await db.prepare('INSERT INTO account_preferences(subject,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind(alice,'benchTab',1,'"splitter"','a'.repeat(64),expired,expired,'expired','b'.repeat(64)).run();
 assert.equal(await purgeExpiredAccountPreferences(db,now),1);
 assert.equal((await list(db,alice)).results.length,0);
});

test('account preference HTTP routes preserve matched identity, origin and current guest session checks',async()=>{
 const db=await fixture(),origin='https://split.test';
 const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:origin,CAIL_COURSE_IDS:'',DB:db,
  verifyCailIdentity:async(token:string)=>[alice,bob].includes(token)?{subject:token,name:'Student'}:null,
  ADMISSION_RESOLVER:{resolveMembership:async()=>({ok:true,accessRole:'member',budgetScope:'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),
    resolveCourseAccessV2:async({subject,classId}:{subject:string;classId:string})=>courseFixture(subject,classId,subject===alice)},
  REQUEST_LIMIT:{limit:async()=>({success:true})},UI_STATE_LIMIT:{limit:async()=>({success:true})}} as unknown as Env;
 const request=(path:string,method:string,subject:string|null,body?:unknown,requestOrigin=origin)=>app.fetch(new Request(origin+path,{method,
  headers:{...(subject?{'x-cail-identity-jwt':subject,'X-Stem-Account':subject}:{}),origin:requestOrigin,'content-type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 assert.equal((await request('/api/account/preferences','GET',null)).status,401);
 const mismatch=await request('/api/account/preferences','GET',alice);
 assert.equal(mismatch.status,200);assert.equal((await mismatch.json() as any).actor,alice);
 assert.equal((await request('/api/account/preferences','PUT',alice,{kind:'benchTab',requestId:id(39),baseRevision:0,value:'splitter'}, 'https://foreign.invalid')).status,403);
 assert.equal((await request('/api/account/preferences','GET',alice,undefined,origin)).headers.get('X-Stem-Account'),alice);
 const seeded=await request('/api/account/preferences/seed','POST',alice,{requestId:id(30),records:[{kind:'benchTab',value:'splitter'}]});
 assert.equal(seeded.status,200);assert.equal((await seeded.json() as any).accepted[0].outcome,'applied');
 assert.equal((await request('/api/account/preferences','GET',bob)).status,200);
 assert.deepEqual((await (await request('/api/account/preferences','GET',bob)).json() as any).preferences,{});
 assert.equal((await request('/api/account/preferences','PUT',alice,{kind:'unknown',requestId:id(31),baseRevision:0,value:'x'})).status,400);
 const expires=Date.now()+60000;
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,Date.now()-1000,expires,'2026-11-16').run();
 const guestEnv={...env,guestRuntimeReady:true,guestSession:{subject:guest,expiresAt:expires,verifiedDay:'2026-11-16'}} as unknown as Env;
 const guestRequest=(method:string,body?:unknown,who=guest)=>app.fetch(new Request(origin+'/api/account/preferences'+(method==='POST'?'/seed':''),{method,
   headers:{origin,'content-type':'application/json','X-Stem-Account':who},...(body===undefined?{}:{body:JSON.stringify(body)})}),guestEnv);
 const guestWrite=await guestRequest('PUT',{kind:'modelChoice',requestId:id(32),baseRevision:0,value:'auto'});
 assert.equal(guestWrite.status,200);
 assert.equal((await guestRequest('GET')).status,200);
 assert.equal((await guestRequest('PUT',{kind:'modelChoice',requestId:id(33),baseRevision:1,value:'htdemucs_ft'},bob)).status,409);
 await db.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(),guest).run();
 assert.equal((await guestRequest('GET')).status,401);
});

test('late guest preference route requires exact member, claimed guest cookie and current membership',async()=>{
 const db=await fixture(),origin='https://split.test',now=Date.now(),expires=now+60000;
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now-1000,expires,'2026-11-16').run();
 await db.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest,alice).run();
 await writeAccountPreference(db,guest,{kind:'benchTab',requestId:id(80),baseRevision:0,value:'splitter'},guestPreferenceScope(guest,expires,now));
 await db.batch(claimedPreferenceStatements(db,guest,alice,{now,expiresAt:expires}));
 let membershipDenied=false;
 const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:origin,CAIL_COURSE_IDS:'',DB:db,guestClaimSession:{subject:guest,expiresAt:expires,verifiedDay:'2026-11-16'},
  verifyCailIdentity:async(token:string)=>[alice,bob].includes(token)?{subject:token,name:'Student'}:null,
  ADMISSION_RESOLVER:{resolveMembership:async()=>membershipDenied?{ok:false,code:'not_admitted'}:({ok:true,accessRole:'member',budgetScope:'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),
    resolveCourseAccessV2:async({subject,classId}:{subject:string;classId:string})=>courseFixture(subject,classId,subject===alice)},
  REQUEST_LIMIT:{limit:async()=>({success:true})},UI_STATE_LIMIT:{limit:async()=>({success:true})}} as unknown as Env;
 const call=(guestActor=guest,claimActor=alice,subject=alice,requestId=id(81))=>app.fetch(new Request(origin+'/api/account/claim-guest/preferences/write',{method:'POST',headers:{origin,'content-type':'application/json','x-cail-identity-jwt':subject,'X-Stem-Account':guestActor,'X-Stem-Claim-Actor':claimActor},body:JSON.stringify({kind:'benchTab',requestId,baseRevision:1,value:null})}),env);
 assert.equal((await call('guest-'+'d'.repeat(64))).status,409,'request cannot select a different guest namespace');
 assert.equal((await call(guest,bob)).status,409,'request cannot select a different member');
 await db.prepare('DELETE FROM guest_account_claims WHERE guest_subject=?').bind(guest).run();
 await db.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest,bob).run();
 assert.equal((await call()).status,403,'signed-in member must match the immutable guest claim mapping');
 await db.prepare('DELETE FROM guest_account_claims WHERE guest_subject=?').bind(guest).run();
 await db.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest,alice).run();
 membershipDenied=true;
 assert.equal((await call()).status,403,'current membership is rechecked before a late write');
 membershipDenied=false;
 const response=await call(guest,alice,alice,id(82));
 assert.equal(response.status,200);assert.equal(response.headers.get('X-Stem-Account'),alice);assert.equal(response.headers.get('X-Stem-Guest-Account'),guest);
 assert.deepEqual((await readAccountPreferences(db,alice)).preferences.benchTab,{value:null,revision:2});
});
