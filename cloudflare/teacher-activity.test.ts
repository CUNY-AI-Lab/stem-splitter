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
import {namedUsers} from '../src/teacher-activity.ts';
const issuer=await createTestIdentityIssuer();
const [alice,bob,teacher,admin]=[TEST_SUBJECTS.alice,TEST_SUBJECTS.bob,TEST_SUBJECTS.carol,'cail-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
const tokens=new Map(await Promise.all([alice,bob,teacher,admin].map(async subject=>[subject,await issuer.mintIdentityJwt({subject,audience:'cail:stem-splitter'})] as const)));

test('student review uses names, counts visits and runs, and confines audio to the current instructor relationship',async()=>{
 const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 for(const subject of [alice,bob,teacher,admin])await db.prepare('INSERT INTO app_users(subject,role) VALUES(?,?)').bind(subject,subject===teacher?'instructor':'student').run();
 let ownsCourse=true;
 const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',CAIL_CLASSROOM_ENABLED:'false',DB:db,CAIL_IDENTITY_JWKS:issuer.jwksJson,verifyCailIdentity,
  ADMISSION_RESOLVER:{resolveMembership:async({subject}:any)=>({ok:true,accessRole:subject===admin?'admin':'member',budgetScope:subject===admin?'admin':'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}),
   resolveCourseAccess:async({subject,classId}:any)=> subject===bob?{ok:false,code:'not_enrolled',retryable:false}:
    {...await courseFixture(subject,classId,subject===teacher&&ownsCourse),displayName:subject===alice?'Alice Rivera':subject===teacher?'Michele Teacher':'Lab Administrator'}},
  AUDIO:{head:async()=>({size:4,uploaded:new Date(),httpEtag:'"test"',writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type','audio/mpeg')}),get:async()=>({body:new Uint8Array([1,2,3,4]),size:4,httpEtag:'"test"',writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type','audio/mpeg')})}
 } as unknown as Env;
 const call=(path:string,subject=teacher)=>app.fetch(new Request('https://split.test'+path,{headers:{'x-cail-identity-jwt':tokens.get(subject)!}}),env);
 await db.prepare(`INSERT INTO jobs(id,filename,source_key,status,stems) VALUES('one','Alice recording','uploads/one.wav','done','[{"name":"vocals","key":"stems/one/vocals.mp3"}]'),('two','Failed recording','uploads/two.wav','failed',NULL),('other','Bob private','uploads/bob.wav','done','[]')`).run();
 for(const id of ['one','two','other'])await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id,id==='other'?bob:alice).run();
 await db.prepare("INSERT INTO annotations(id,job_id,at_seconds,text) VALUES('private-note','one',1,'Private listening note')").run();
 await recordClientUses(db,{subject:alice,role:'student',quotaClass:'member'} as AppPrincipal,[{id:'recorded-visit-0001',type:'session_start'},{id:'recorded-visit-0002',type:'session_start'}]);
 const list=await call('/api/teacher/students');assert.equal(list.status,200);
 const students=(await list.json() as any).students;
 assert.equal(students.find((r:any)=>r.subject===alice).displayName,'Alice Rivera');
 assert.deepEqual({...students.find((r:any)=>r.subject===alice),subject:undefined},{subject:undefined,displayName:'Alice Rivera',runs:2,completed:1,recordedVisits:2});
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
 const env={DB:db,ADMISSION_RESOLVER:{resolveCourseAccess:async()=>({ok:false,code:'not_enrolled',retryable:false}),
  listCourseAssignments:async()=>({ok:true,checkedAt:assignment.checkedAt,expiresAt:assignment.expiresAt,revision:assignment.revision,nextCursor:null,
   assignments:[{...assignment,displayName:'Bob Morgan',...(invalid?{expiresAt:'2020-01-01T00:00:00.000Z'}:{})}]})}} as unknown as Env;
 const actor={subject:admin,role:'admin'} as AppPrincipal;
 invalid=true;assert.equal((await namedUsers(env,actor))[0].displayName,'Name unavailable');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_display_names').first<any>())!.n,0);
 invalid=false;assert.equal((await namedUsers(env,actor))[0].displayName,'Bob Morgan');
 assert.equal((await namedUsers(env,{subject:teacher,role:'instructor'} as AppPrincipal,true)).length,0);
});
