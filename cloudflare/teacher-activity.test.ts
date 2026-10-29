import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestIdentityIssuer, TEST_SUBJECTS} from '@cuny-ai-lab/cail-identity/testing';
import {SqliteD1} from '../server/d1.ts';
import app from '../src/index.ts';
import type {Env} from '../src/env.ts';
import type {AppPrincipal} from '../src/identity.ts';
import {verifyCailIdentity} from './verify.ts';
import {courseFixture} from './course-fixture.ts';
import {recordClientUses} from '../src/reliability/observability.ts';
import {namedUsers,guestActivity} from '../src/teacher-activity.ts';
const issuer=await createTestIdentityIssuer();
const [alice,bob,teacher,admin]=[TEST_SUBJECTS.alice,TEST_SUBJECTS.bob,TEST_SUBJECTS.carol,'cail-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
const tokens=new Map(await Promise.all([alice,bob,teacher,admin].map(async subject=>[subject,await issuer.mintIdentityJwt({subject,audience:'cail:stem-splitter'})] as const)));

test('student review uses names, counts visits and runs, and confines audio to the current instructor relationship',async()=>{
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 for(const subject of [alice,bob,teacher,admin])await db.prepare('INSERT INTO app_users(subject,role) VALUES(?,?)').bind(subject,subject===teacher?'instructor':'student').run();
 let ownsCourse=true;
 const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',CAIL_CLASSROOM_ENABLED:'false',DB:db,CAIL_IDENTITY_JWKS:issuer.jwksJson,verifyCailIdentity,
  ADMISSION_RESOLVER:{resolveMembership:async({subject}:any)=>({ok:true,accessRole:subject===admin?'admin':'member',budgetScope:subject===admin?'admin':'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),
   resolveCourseAccessV2:async({subject,classId}:any)=> subject===bob?{ok:false,code:'not_enrolled',retryable:false}:
    {...await courseFixture(subject,classId,subject===teacher&&ownsCourse),displayName:subject===alice?'Alice Rivera':subject===teacher?'Michele Teacher':'Lab Administrator'}},
  AUDIO:{head:async()=>({size:4,uploaded:new Date(),httpEtag:'"test"',writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type','audio/mpeg')}),get:async()=>({body:new Uint8Array([1,2,3,4]),size:4,httpEtag:'"test"',writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type','audio/mpeg')})}
 } as unknown as Env;
 const call=(path:string,subject=teacher)=>app.fetch(new Request('https://split.test'+path,{headers:{'x-cail-identity-jwt':tokens.get(subject)!}}),env);
 await db.prepare(`INSERT INTO jobs(id,filename,source_key,status,stems) VALUES('one','Alice recording','uploads/one.wav','done','[{"name":"vocals","key":"stems/one/vocals.mp3"}]'),('two','Failed recording','uploads/two.wav','failed',NULL),('other','Bob private','uploads/bob.wav','done','[]')`).run();
 for(const id of ['one','two','other'])await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id,id==='other'?bob:alice).run();
 await db.prepare("INSERT INTO annotations(id,job_id,at_seconds,text) VALUES('private-note','one',1,'Private listening note')").run();
 await recordClientUses(db,{subject:alice,role:'student',quotaClass:'member'} as AppPrincipal,[{id:'recorded-visit-0001',type:'session_start'},{id:'recorded-visit-0002',type:'session_start'}]);
 assert.equal((await call('/api/account',bob)).status,200);
 const adminActivity=(await (await call('/api/teacher/students',admin)).json() as any).students.find((row:any)=>row.subject===bob);
 assert.equal(adminActivity.recordedVisits,0);assert.equal(adminActivity.recordedPlays,0);
 assert.ok(Date.now()-Date.parse(adminActivity.lastActiveAt)<60000,'verified access is recorded even without client observations');
 const list=await call('/api/teacher/students');assert.equal(list.status,200);
 const students=(await list.json() as any).students;
 assert.equal(students.find((r:any)=>r.subject===alice).displayName,'Alice Rivera');
 const activity=students.find((r:any)=>r.subject===alice);
 assert.deepEqual({...activity,subject:undefined,firstSeenAt:undefined,lastActiveAt:undefined},{subject:undefined,firstSeenAt:undefined,displayName:'Alice Rivera',runs:2,completed:1,guideTurns:0,recordedVisits:2,recordedPlays:0,lastActiveAt:undefined});
 assert.equal(typeof activity.firstSeenAt,'string');
 assert.ok(students.some((row:any)=>row.subject===teacher),'the viewing instructor is included');
 assert.equal((await call(`/api/teacher/students/${teacher}/jobs`)).status,200);
 assert.ok(Date.now()-Date.parse(activity.lastActiveAt)<60000);
 assert.equal(students.some((r:any)=>r.subject===bob),false);
 const jobs=await call(`/api/teacher/students/${alice}/jobs`);assert.equal(jobs.status,200);assert.equal((await jobs.json() as any).jobs.length,2);
 const review=await call(`/api/teacher/students/${alice}/jobs/one`);assert.equal(review.status,200);
 const body=await review.json() as any;assert.equal(body.instructorReview,true);assert.deepEqual(body.annotations,[]);assert.equal(body.guide,null);
 assert.equal((await call(body.stems[0].url)).status,200);
 assert.equal((await call(`/api/teacher/students/${alice}/jobs/other`)).status,404);
 assert.equal((await call(`/api/teacher/students/${bob}/jobs`)).status,404);
 assert.equal((await call('/api/jobs/one')).status,404);
 assert.equal((await call('/api/teacher/students',alice)).status,403);
 assert.equal((await call(body.stems[0].url,alice)).status,403);
 ownsCourse=false;
 assert.equal((await call(body.stems[0].url)).status,404);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM public_split_links').first<any>())!.n,0);
 const accounts=await call('/api/admin/users',admin);assert.equal(accounts.status,200);
 assert.ok((await accounts.json() as any).users.some((user:any)=>user.displayName==='Alice Rivera'));
});

test('verified names from another current course fill historical accounts without changing instructor scope',async()=>{
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 await db.prepare('INSERT INTO app_users(subject,role) VALUES(?,?)').bind(bob,'student').run();
 const {ok,...assignment}=await courseFixture(bob,'another-current-course');
 let invalid=false;
 const env={DB:db,ADMISSION_RESOLVER:{resolveCourseAccessV2:async()=>({ok:false,code:'not_enrolled',retryable:false}),
  listCourseAssignmentsV2:async()=>({ok:true,checkedAt:assignment.checkedAt,expiresAt:assignment.expiresAt,revision:assignment.revision,nextCursor:null,
   assignments:[{...assignment,displayName:'Bob Morgan',...(invalid?{expiresAt:'2020-01-01T00:00:00.000Z'}:{})}]})}} as unknown as Env;
 const actor={subject:admin,role:'admin'} as AppPrincipal;
 invalid=true;assert.equal((await namedUsers(env,actor)).users[0].displayName,'Name unavailable');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_display_names').first<any>())!.n,0);
 invalid=false;assert.equal((await namedUsers(env,actor)).users[0].displayName,'Bob Morgan');
 assert.equal((await namedUsers(env,{subject:teacher,role:'instructor'} as AppPrincipal)).users.length,0);
});

test('claimed guest work contributes to account activity once while retaining its original quota owner',async()=>{
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const guest=`guest-${'a'.repeat(64)}`,now=Date.now();
 await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(alice).run();
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now,now+86400000,'2026-10-22').run();
 await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('saved-guest','Private guest recording','uploads/source.wav','done')").run();
 await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind('saved-guest',alice).run();
 await db.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest,alice).run();
 await db.prepare('INSERT INTO guest_job_claims(job_id,guest_subject,member_subject) VALUES(?,?,?)').bind('saved-guest',guest,alice).run();
 for(const kind of ['split','chat']) await db.prepare(`INSERT INTO app_operations(id,subject,quota_class,kind,idempotency_key,fingerprint,day,state,phase,job_id,deadline,created_at,updated_at)
  VALUES(?,?,'guest',?,?,?,'2026-10-22','succeeded',?,'saved-guest',?,?,?)`).bind(`guest-${kind}`,guest,kind,`guest-${kind}-key`,'a'.repeat(64),kind,now+60000,now-1000,now).run();
 const {usageBySubject}=await import('../src/classroom/activity.ts');
 const usage=(await usageBySubject({DB:db} as Env,[alice],now)).get(alice)!;
 assert.equal(usage.runs,1);assert.equal(usage.completed,1);assert.equal(usage.guideTurns,1);
 assert.equal(usage.lastActiveAt,new Date(now-1000).toISOString());
 const guests=await guestActivity({DB:db} as Env,{subject:admin,role:'admin'} as AppPrincipal);
 assert.deepEqual(guests,{days:30,browserSessions:1,splitAttempts:1,completedSplits:1,sessionsWithSplits:1,splitsSavedToAccounts:1});
 assert.doesNotMatch(JSON.stringify(guests),/Private guest|guest-[a-f0-9]{64}|cail-/);
 await assert.rejects(guestActivity({DB:db} as Env,{subject:alice,role:'student'} as AppPrincipal),(error:any)=>error.status===403);
 assert.equal((await db.prepare("SELECT subject FROM app_operations WHERE id='guest-split'").first<any>()).subject,guest);
});

test('a student with zero split attempts still has recorded visits, playback and recent activity',async()=>{
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const {usageBySubject}=await import('../src/classroom/activity.ts');
 const {parseClientUses}=await import('../src/reliability/observability.ts');
 const principal={subject:alice,role:'student',quotaClass:'member'} as AppPrincipal;
 const events=[{id:'observed-visit-only-001',type:'session_start' as const},
  {id:'observed-page-only-0001',type:'page_view' as const},
  {id:'observed-play-only-0001',type:'playback_start' as const}];
 assert.deepEqual(parseClientUses({events}),events);
 await recordClientUses(db,principal,events);
 await recordClientUses(db,principal,[events[0]]);
 const usage=(await usageBySubject({DB:db} as Env,[alice,bob])).get(alice)!;
 assert.equal(usage.runs,0);assert.equal(usage.completed,0);
 assert.equal(usage.recordedVisits,1);assert.equal(usage.recordedPlays,1);
 assert.ok(Date.now()-Date.parse(usage.lastActiveAt!)<60000);
 const serialized=JSON.stringify((await db.prepare('SELECT * FROM usage_events').all()).results);
 assert.equal(serialized.includes(alice),false);
 assert.equal((await usageBySubject({DB:db} as Env,[bob])).get(bob)!.recordedVisits,0);
});

test('account pages reach eligible members beyond 200 accounts, advance through empty pages, and reject malformed cursors',async()=>{
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const people=Array.from({length:201},(_,i)=>'cail-'+i.toString(16).padStart(32,'0'));
 const target=people[0];
 for(const person of people)await db.prepare("INSERT INTO app_users(subject,created_at) VALUES(?,'2026-10-01 00:00:00')").bind(person).run();
 let active=true,calls=0;
 const env={DB:db,CAIL_COURSE_IDS:'synthetic-course',ADMISSION_RESOLVER:{resolveCourseAccessV2:async({subject,classId}:any)=>{
  calls++;return subject===teacher||subject===target&&active?{...await courseFixture(subject,classId,subject===teacher),displayName:'Older Student'}:{ok:false,code:'not_enrolled',retryable:false};
 }}} as unknown as Env;
 const actor={subject:teacher,role:'instructor'} as AppPrincipal;
 let cursor:string|undefined, pages=0;const seen:string[]=[];
 do {
  const before=calls,page=await namedUsers(env,actor,cursor);pages++;
  assert.ok(calls-before<=26,'at most 25 candidates plus the current instructor authority per page');
  seen.push(...page.users.map(user=>user.subject));
  if(pages===1){assert.equal(page.users.length,0);assert.equal(page.complete,false);assert.ok(page.nextCursor);assert.match(page.nextCursor!,/^[0-9]+$/);assert.doesNotMatch(page.nextCursor!,/cail-|Older Student|2026/);}
  assert.equal(page.complete,page.nextCursor===null);assert.notEqual(page.nextCursor,cursor);
  cursor=page.nextCursor??undefined;
 }while(cursor);
 assert.equal(pages,9);assert.deepEqual(seen,[target]);
 // Admin pagination must also expose every account exactly once when timestamps tie.
 cursor=undefined;const all:string[]=[];
 do {const page=await namedUsers(env,{subject:admin,role:'admin'} as AppPrincipal,cursor);all.push(...page.users.map(user=>user.subject));cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(all.length,201);assert.equal(new Set(all).size,201);assert.deepEqual([...all].sort(),people);
 const first=await namedUsers(env,actor);active=false;
 const next=await namedUsers(env,actor,first.nextCursor!);assert.equal(next.users.length,0);
 for(const invalid of ['', 'invalid',btoa('{}'),btoa(JSON.stringify({createdAt:'bad',subject:target})),btoa(JSON.stringify({createdAt:'2026-10-01',subject:target,extra:true}))])
  await assert.rejects(namedUsers(env,actor,invalid),(error:any)=>error.status===400&&error.code==='invalid_cursor');
});
