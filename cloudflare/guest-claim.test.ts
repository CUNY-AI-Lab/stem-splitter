import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SqliteD1 } from '../server/d1.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';
import app from '../src/index.ts';
import { claimGuestWork } from '../src/guest/claim.ts';
import { authorizeGuestRequest } from '../src/guest/access.ts';
import { reserveOperation, readOperation } from '../src/reliability/ledger.ts';
import { resumeOwnedSourceImport } from '../src/reliability/splits.ts';
import { splitAllowance } from '../src/daily-allowance.ts';
import { courseFixture } from './course-fixture.ts';
import { startGuestSession, readGuestSession } from './guest.ts';

const alice='cail-'+'a'.repeat(32),bob='cail-'+'b'.repeat(32),guest='guest-'+'c'.repeat(64),other='guest-'+'d'.repeat(64);
const member=(subject=alice):AppPrincipal=>({subject,role:'student',quotaClass:'member',displayName:'Student',course:null,courseId:null});
async function fixture(expiresIn=86400000){
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 for(const id of [alice,bob])await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(id).run();
 const expiresAt=Date.now()+expiresIn;
 for(const id of [guest,other])await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
  .bind(id,Date.now()-1000,expiresAt,new Date().toISOString().slice(0,10)).run();
 const flags={membership:true,course:true};
 const env={DB:db,AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',guestRuntimeReady:true,
  guestClaimSession:{subject:guest,expiresAt,verifiedDay:new Date().toISOString().slice(0,10)},
  verifyCailIdentity:async(token:string)=>[alice,bob].includes(token)?{subject:token,name:'Student'}:null,
  ADMISSION_RESOLVER:{resolveMembership:async()=>flags.membership?{ok:true,accessRole:'member',budgetScope:'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}:{ok:false,code:'not_admitted'},
   resolveCourseAccessV2:async({subject,classId}:any)=>flags.course?courseFixture(subject,classId):{ok:false,code:'not_enrolled',retryable:false}},
 } as unknown as Env;
 const seed=async(id:string,who=guest,done=true)=>{
  const {operation}=await reserveOperation(env.DB,{subject:who,quotaClass:'guest',courseId:null,kind:'split',key:`guest-claim-job-${id}`,fingerprint:id,phase:'fetch',jobId:id,
   request:{sourceType:'youtube',youtubeUrl:'https://www.youtube.com/watch?v=jNQXAC9IVRw',browserAudio:true,filename:'Guest audio',model:'htdemucs_ft',auto:false},
   statements:op=>[db.prepare("INSERT INTO jobs(id,filename,source_key,status,model) VALUES(?,'Guest audio',?,'queued','htdemucs_ft')").bind(op,`uploads/${op}/source.webm`),
    db.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind(op,who)] as any});
  if(done)await db.prepare("UPDATE jobs SET status='done' WHERE id=?").bind(id).run();return operation;
 };
 const post=(who=alice,body:unknown={})=>app.fetch(new Request('https://split.test/api/account/claim-guest',{method:'POST',headers:{Origin:'https://split.test','x-cail-identity-jwt':who,'X-Stem-Claim-Actor':who,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
 return {db,env,flags,seed,post};
}

test('same-browser claim transfers saved jobs and notes once, preserving history and original quota',async()=>{
 const {db,env,seed,post}=await fixture();await seed('saved');await seed('foreign',other);
 await db.prepare("INSERT INTO annotations(id,job_id,at_seconds,text,author_subject) VALUES('note','saved',1,'Saved note',?)").bind(guest).run();
 await db.prepare("INSERT INTO guest_listening_conversations(job_id,subject,entries,revision,expires_at) VALUES('saved',?,'[{\"kind\":\"you\",\"text\":\"Saved thought\"}]',2,datetime('now','+1 day'))").bind(guest).run();
 const usage=await db.prepare('SELECT * FROM app_operations ORDER BY id').all();
 const response=await post(alice,{jobIds:['foreign'],subject:other});assert.equal(response.status,200);
 assert.deepEqual((await response.json()).claimedJobIds,['saved']);
 assert.equal((await db.prepare("SELECT subject FROM job_owners WHERE job_id='saved'").first<any>())?.subject,alice);
 assert.equal((await db.prepare("SELECT subject FROM guest_job_owners WHERE job_id='foreign'").first<any>())?.subject,other);
 assert.equal((await db.prepare("SELECT author_subject FROM annotations WHERE id='note'").first<any>())?.author_subject,alice);
 assert.match((await db.prepare("SELECT entries FROM listening_conversations WHERE job_id='saved' AND subject=?").bind(alice).first<any>())?.entries,/Saved thought/);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_listening_conversations').first<any>())?.n,1);
 await db.prepare("UPDATE listening_conversations SET entries='[]',revision=3 WHERE job_id='saved' AND subject=?").bind(alice).run();
 assert.equal((await post()).status,200);
 assert.equal((await db.prepare("SELECT revision FROM listening_conversations WHERE job_id='saved' AND subject=?").bind(alice).first<any>())?.revision,3);
 assert.deepEqual(await db.prepare('SELECT * FROM app_operations ORDER BY id').all(),usage);
 assert.equal((await splitAllowance(env.DB,alice)).remaining,15);
 assert.equal((await splitAllowance(env.DB,guest,new Date(),'guest')).remaining,4);
 const guestResponse=await authorizeGuestRequest(new Request('https://split.test/api/account'),{...env,guestSession:env.guestClaimSession},()=>assert.fail('Claimed guest cannot regain anonymous access'));
 assert.equal(guestResponse?.status,403);
});

test('concurrent and repeated claims cannot transfer to a second member or overwrite existing member work',async()=>{
 const {db,seed,post}=await fixture();await seed('saved');
 await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('existing','Member work','uploads/x/source','done')").run();
 await db.prepare("INSERT INTO job_owners(job_id,subject) VALUES('existing',?)").bind(bob).run();
 const responses=await Promise.all([post(alice),post(bob)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 const winner=(await db.prepare("SELECT subject FROM job_owners WHERE job_id='saved'").first<any>())!.subject;
 assert.equal((await post(winner)).status,200);assert.equal((await post(winner===alice?bob:alice)).status,409);
 assert.equal((await db.prepare("SELECT subject FROM job_owners WHERE job_id='existing'").first<any>())?.subject,bob);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_job_claims').first<any>())?.n,1);
});

test('a claim atomically closes new guest reservations even after request authorization raced sign-in',async()=>{
 const {db,env,seed,post}=await fixture();await seed('saved');assert.equal((await post()).status,200);
 await assert.rejects(reserveOperation(env.DB,{subject:guest,quotaClass:'guest',courseId:null,kind:'split',key:'racing-guest-new-split',fingerprint:'race',phase:'fetch',jobId:'racing'}),{code:'guest_session_claimed'});
 assert.equal(await db.prepare("SELECT 1 FROM app_operations WHERE id='racing'").first(),null);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_job_claims').first<any>())?.n,1);
});

test('interrupted transaction rolls back ownership and notes; a later claim recovers',async t=>{
 const {db,env,seed,post}=await fixture();await seed('saved');
 const batch=db.batch.bind(db);
 const mock=t.mock.method(db,'batch',statements=>batch([...statements,db.prepare("INSERT INTO job_owners(job_id,subject) VALUES('missing',?)").bind(alice)]));
 await assert.rejects(claimGuestWork(env,member()));mock.mock.restore();
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_account_claims').first<any>())?.n,0);
 assert.equal((await db.prepare("SELECT subject FROM guest_job_owners WHERE job_id='saved'").first<any>())?.subject,guest);
 assert.equal((await post()).status,200);
});

test('failed membership, course eligibility, cross-origin requests and expired guest proof preserve originals',async()=>{
 const {db,env,flags,seed,post}=await fixture();await seed('saved');
 flags.membership=false;assert.equal((await post()).status,403);flags.membership=true;
 flags.course=false;
 const personal=await app.fetch(new Request('https://split.test/api/account',{headers:{Origin:'https://split.test','x-cail-identity-jwt':alice}}),env);
 assert.equal(personal.status,200,'Lab membership grants personal access without STEM enrollment');flags.course=true;
 const cross=await app.fetch(new Request('https://split.test/api/account/claim-guest',{method:'POST',headers:{Origin:'https://attacker.test','x-cail-identity-jwt':alice}}),env);
 assert.equal(cross.status,403);
 env.guestClaimSession={...env.guestClaimSession!,expiresAt:Date.now()-1};assert.equal((await post()).status,403);
 env.guestClaimSession=undefined;assert.deepEqual(await(await post(alice,{jobIds:['saved'],guestSubject:guest})).json(),{claimedJobIds:[],guestStorageKey:null});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_account_claims').first<any>())?.n,0);
 assert.equal((await db.prepare("SELECT subject FROM guest_job_owners WHERE job_id='saved'").first<any>())?.subject,guest);
});

test('claimed pending import can resume once with its original guest accounting and without a second reservation',async t=>{
 const {db,env,seed,post}=await fixture();const operation=await seed('pending',guest,false);let loads=0;
 env.AUDIO={put:async()=>{},delete:async()=>{}} as any;
 env.fetchYouTubeBrowserAudio=async()=>{loads++;return {data:new Uint8Array([1,2,3]).buffer,title:'Fixture',durationSec:19,fileName:'source.webm',contentType:'audio/webm'};};
 t.mock.method(globalThis,'fetch',async()=>assert.fail('Claim must not start a new paid request'));
 assert.equal((await post()).status,200);
 await resumeOwnedSourceImport(env,member(bob),operation);assert.equal(loads,0);
 await resumeOwnedSourceImport(env,member(),operation);assert.equal(loads,1);
 const current=(await readOperation(env.DB,operation.id))!;assert.equal(current.phase,'split');assert.equal(current.subject,guest);assert.equal(current.quota_class,'guest');
 await resumeOwnedSourceImport(env,member(),current);assert.equal(loads,1);
 assert.equal((await splitAllowance(env.DB,alice)).inProgress,0);
 assert.equal((await splitAllowance(env.DB,guest,new Date(),'guest')).inProgress,1);
 await db.prepare("UPDATE jobs SET status='done' WHERE id='pending'").run();
 assert.equal((await splitAllowance(env.DB,guest,new Date(),'guest')).completed,1);
 assert.equal((await splitAllowance(env.DB,alice)).completed,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>())?.n,0);
});

test('guest proof remains origin-bound and rejects modified or expired cookies',async t=>{
 const {env}=await fixture();Object.assign(env,{GUEST_ENABLED:'true',GUEST_COOKIE_SECRET:'x'.repeat(48),GUEST_TURNSTILE_SITE_KEY:'a'.repeat(30),GUEST_TURNSTILE_SECRET:'b'.repeat(40),REQUEST_LIMIT:{limit:async()=>({success:true})}});
 const start=await startGuestSession(new Request('https://split.test/auth/guest',{method:'POST',headers:{Origin:'https://split.test','Content-Type':'application/json'},body:'{}'}),env);
 assert.equal(start.status,200);const cookie=start.headers.get('set-cookie')!.split(';')[0];
 assert.ok(await readGuestSession(new Request('https://split.test/',{headers:{Cookie:cookie}}),env));
 assert.equal(await readGuestSession(new Request('https://other.test/',{headers:{Cookie:cookie}}),env),null);
 assert.equal(await readGuestSession(new Request('https://split.test/',{headers:{Cookie:cookie+'x'}}),env),null);
 const future=Date.now()+8*86400000;t.mock.method(Date,'now',()=>future);
 assert.equal(await readGuestSession(new Request('https://split.test/',{headers:{Cookie:cookie}}),env),null);
});

test('only the claiming member can cancel a pending guest split and the original allowance is refunded',async()=>{
 const {env,seed,post}=await fixture();await seed('pending-cancel',guest,false);assert.equal((await post()).status,200);
 const cancel=(subject:string)=>app.fetch(new Request('https://split.test/api/jobs/pending-cancel/cancel',{method:'POST',headers:{Origin:'https://split.test','x-cail-identity-jwt':subject}}),env);
 assert.equal((await cancel(bob)).status,404);assert.equal((await cancel(alice)).status,200);assert.equal((await cancel(alice)).status,200);
 const operation=(await readOperation(env.DB,'pending-cancel'))!;
 assert.equal(operation.subject,guest);assert.equal(operation.quota_class,'guest');assert.equal(operation.state,'cancelled');
 assert.equal((await splitAllowance(env.DB,guest,new Date(),'guest')).remaining,5);
 assert.equal((await splitAllowance(env.DB,alice)).remaining,15);
});

test('browser claim uses no client IDs, preserves cache on failure and merges only confirmed layout',async()=>{
 const source=readFileSync(new URL('../public/guest-claim.js',import.meta.url),'utf8');
 const guestKey=`jobs:${guest}`,memberKey=`jobs:${alice}`,data=new Map([[guestKey,JSON.stringify([{id:'saved',collapsed:true},{id:'foreign',collapsed:true}])],[memberKey,JSON.stringify([{id:'existing',collapsed:false}])]]);
 let fail=true,calls=0;
 const context={window:{} as any,AbortSignal,localStorage:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)},fetch:async(path:string,options:any)=>{
  calls++;assert.equal(path,'/api/account/claim-guest');assert.equal(options.body,undefined);
  return {ok:!fail,headers:new Headers({'X-Stem-Account':alice}),json:async()=>({claimedJobIds:['saved'],guestStorageKey:guestKey})};
 }};
 vm.runInNewContext(source,context);const before=data.get(guestKey);
 await assert.rejects(context.window.StemGuestClaim.run(member()));assert.equal(data.get(guestKey),before);
 fail=false;await context.window.StemGuestClaim.run(member());assert.equal(calls,2);
 assert.deepEqual(JSON.parse(data.get(memberKey)!),[{id:'saved',collapsed:true},{id:'existing',collapsed:false}]);
 assert.equal(data.get(guestKey),before);
});

test('claim actor expectation refuses a switched or missing browser account before transferring work',async()=>{
 const {db,env,seed,post}=await fixture();await seed('actor-fence');
 for(const actor of [bob,'']) {
  const response=await app.fetch(new Request('https://split.test/api/account/claim-guest',{method:'POST',headers:{Origin:'https://split.test','x-cail-identity-jwt':alice,'X-Stem-Claim-Actor':actor}}),env);
  assert.equal(response.status,409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_account_claims').first<any>())?.n,0);
 }
 assert.equal((await post()).status,200);
});

test('lost acknowledgement after committed claim retries without duplicate ownership or usage',async t=>{
 const {db,env,seed,post}=await fixture();await seed('lost-ack');
 const original=db.batch.bind(db);
 const mock=t.mock.method(db,'batch',async statements=>{await original(statements);throw Error('Fixture lost response after commit');});
 await assert.rejects(claimGuestWork(env,member()),/lost response/);mock.mock.restore();
 assert.equal((await db.prepare("SELECT subject FROM job_owners WHERE job_id='lost-ack'").first<any>())?.subject,alice);
 const response=await post();assert.equal(response.status,200);assert.deepEqual((await response.json()).claimedJobIds,['lost-ack']);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_account_claims').first<any>())?.n,1);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_job_claims').first<any>())?.n,1);
 assert.equal((await splitAllowance(db,guest,new Date(),'guest')).completed,1);
 assert.equal((await splitAllowance(db,alice)).remaining,15);
});

test('claimed five-place guest allowance preserves successful work and refunds a later source failure',async t=>{
 const {db,env,seed,post}=await fixture();
 for(let i=0;i<4;i++)await seed(`done-${i}`);
 const operation=await seed('fetch-failure',guest,false);
 assert.equal((await splitAllowance(db,guest,new Date(),'guest')).remaining,0);
 await assert.rejects(seed('over-limit',guest,false));
 assert.equal((await post()).status,200);
 env.AUDIO={put:async()=>{},delete:async()=>{}} as any;
 env.fetchYouTubeBrowserAudio=async()=>{throw Error('Fixture unavailable source');};
 t.mock.method(globalThis,'fetch',async()=>assert.fail('No paid provider request is allowed'));
 await resumeOwnedSourceImport(env,member(),operation);
 const current=(await readOperation(db,operation.id))!;
 assert.equal(current.state,'failed');assert.equal(current.subject,guest);assert.equal(current.quota_class,'guest');
 const guestAllowance=await splitAllowance(db,guest,new Date(),'guest');
 assert.equal(guestAllowance.limit,5);assert.equal(guestAllowance.completed,4);assert.equal(guestAllowance.inProgress,0);assert.equal(guestAllowance.remaining,1);
 assert.equal((await splitAllowance(db,alice)).remaining,15);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>())?.n,0);
});

test('browser claims are scoped per account and reject a mismatched confirmation without touching caches',async()=>{
 const source=readFileSync(new URL('../public/guest-claim.js',import.meta.url),'utf8');
 const guestKey=`jobs:${guest}`,aKey=`jobs:${alice}`,bKey=`jobs:${bob}`;
 const data=new Map([[guestKey,JSON.stringify([{id:'saved',collapsed:true}])],[aKey,'[{"id":"alice-existing"}]']]);
 const replies=new Map<string,(value:unknown)=>void>();
 const context={window:{} as any,AbortSignal,localStorage:{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)},
  fetch:async(_path:string,options:any)=>new Promise(resolve=>{assert.equal(options.body,undefined);replies.set(options.headers['X-Stem-Claim-Actor'],resolve);})};
 vm.runInNewContext(source,context);
 const a=context.window.StemGuestClaim.run(member()),repeat=context.window.StemGuestClaim.run(member()),b=context.window.StemGuestClaim.run(member(bob));
 assert.equal(a,repeat);assert.notEqual(a,b);assert.equal(replies.size,2);
 replies.get(alice)!({ok:true,headers:new Headers({'X-Stem-Account':bob}),json:async()=>({claimedJobIds:['saved'],guestStorageKey:guestKey})});
 await assert.rejects(a,/account changed/);
 assert.equal(data.get(aKey),'[{"id":"alice-existing"}]');assert.equal(data.has(bKey),false);
 replies.get(bob)!({ok:true,headers:new Headers({'X-Stem-Account':bob}),json:async()=>({claimedJobIds:['saved'],guestStorageKey:guestKey})});
 await b;assert.deepEqual(JSON.parse(data.get(bKey)!),[{id:'saved',collapsed:true}]);
 assert.deepEqual(JSON.parse(data.get(guestKey)!),[{id:'saved',collapsed:true}]);
});

test('additive claim schema is repeatable and leaves every preexisting row unchanged',async()=>{
 const fresh=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
 const migration=readFileSync(new URL('../migrations/0023-guest-account-claims.sql',import.meta.url),'utf8');
 assert.ok(fresh.includes(migration.trim()));
 const db=new SqliteD1(':memory:');db.applySchema(fresh.replace(migration.trim(),''));
 await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(alice).run();
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,Date.now(),Date.now()+86400000,'2026-10-12').run();
 await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('existing-guest','Preserved work','uploads/existing/source','done')").run();
 await db.prepare("INSERT INTO guest_job_owners(job_id,subject) VALUES('existing-guest',?)").bind(guest).run();
 await db.prepare("INSERT INTO annotations(id,job_id,at_seconds,text,author_subject) VALUES('existing-note','existing-guest',1,'Preserve this original note',?)").bind(guest).run();
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{name:string}>()).results;
 const snapshot=async()=>Promise.all(tables.map(async({name})=>({name,rows:(await db.prepare(`SELECT * FROM "${name}"`).all()).results})));
 const before=await snapshot();
 db.applySchema(migration);db.applySchema(migration);
 assert.deepEqual(await snapshot(),before);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_account_claims').first<any>())?.n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM guest_job_claims').first<any>())?.n,0);
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});

for (const lifecycle of ['logout','expiry','member-disabled','access-revoked'] as const) {
 test(`claimed pending import follows member authorization after ${lifecycle}`,async t=>{
  const {db,env,seed,post,flags}=await fixture(1000);const operation=await seed('pending-lifecycle',guest,false);let loads=0;
  env.AUDIO={put:async()=>{},delete:async()=>{}} as any;
  env.fetchYouTubeBrowserAudio=async()=>{loads++;return {data:new Uint8Array([1,2,3]).buffer,title:'Fixture',durationSec:19,fileName:'source.webm',contentType:'audio/webm'};};
  t.mock.method(globalThis,'fetch',async()=>assert.fail('No paid provider request is allowed'));
  assert.equal((await post()).status,200);
  if(lifecycle==='expiry'){const expiredNow=env.guestClaimSession!.expiresAt+1;t.mock.method(Date,'now',()=>expiredNow);}
  else await db.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(),guest).run();
  if(lifecycle==='member-disabled')await db.prepare('UPDATE app_users SET disabled=1,updated_by=?,revision=revision+1 WHERE subject=?').bind(alice,alice).run();
  if(lifecycle==='access-revoked')flags.course=false;
  await resumeOwnedSourceImport(env,member(bob),operation);assert.equal(loads,0);
  await resumeOwnedSourceImport(env,member(),operation);
  const current=(await readOperation(db,operation.id))!;
  const denied=lifecycle==='member-disabled'||lifecycle==='access-revoked';
  assert.equal(loads,denied?0:1);assert.equal(current.subject,guest);assert.equal(current.quota_class,'guest');
  if(denied){assert.equal(current.state,'failed');assert.equal(current.error_code,'access_unavailable');}
  else assert.equal(current.phase,'split');
  assert.equal((await splitAllowance(db,alice)).remaining,15);
  assert.equal((await splitAllowance(db,guest,new Date(),'guest')).inProgress,denied?0:1);
  assert.equal((await authorizeGuestRequest(new Request('https://split.test/api/account'),{...env,guestSession:env.guestClaimSession},()=>assert.fail('Retired guest must not regain access')))?.status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>())?.n,0);
 });
}
