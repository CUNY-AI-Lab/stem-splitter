import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { GUEST_COOKIE, guestConfigured, startGuestSession } from './guest.ts';
import { readGuestSession } from './guest.ts';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { reserveOperation,settleOperation } from '../src/reliability/ledger.ts';
import { dailyWindow,splitAllowance,operationAllowance } from '../src/daily-allowance.ts';
import type { Env } from '../src/env.ts';

const origin='https://split.test';
const settings={GUEST_ENABLED:'true',GUEST_COOKIE_SECRET:'fixture-cookie-secret-'.repeat(3),GUEST_TURNSTILE_SITE_KEY:'fixture-site-key',
  GUEST_TURNSTILE_SECRET:'fixture-turnstile-secret-only',GUEST_GATEWAY_API_KEY:'sk-cail-fixture-sponsor-key-only-000000'};

test('guest activation requires every reviewed capability; legacy provider keys never enable it',()=>{
  const env={...settings,GATEWAY:{},GATEWAY_MODEL:'glm-5.2',GATEWAY_FALLBACK_MODEL:'deepseek-v4-flash-0731',REQUEST_LIMIT:{}} as never;
  assert.equal(guestConfigured(env),true);
  for(const field of Object.keys(settings))assert.equal(guestConfigured({...env,[field]:undefined,OPENROUTER_API_KEY:'old-provider-key'}),false,field);
  assert.equal(guestConfigured({...env,GUEST_ENABLED:'false'}),false);
  assert.equal(guestConfigured({...env,GATEWAY:undefined}),false);
});

test('guest-start rate rejection performs no database, verification or provider work',async t=>{
  let databaseCalls=0,externalCalls=0;const ingressKeys:string[]=[];
  t.mock.method(globalThis,'fetch',async()=>{externalCalls++;throw new Error('No external call expected');});
  const env={...settings,GATEWAY:{},GATEWAY_MODEL:'glm-5.2',GATEWAY_FALLBACK_MODEL:'deepseek-v4-flash-0731',PUBLIC_BASE_URL:origin,
    REQUEST_LIMIT:{limit:async({key}:{key:string})=>{ingressKeys.push(key);return {success:false};}},
    DB:{prepare:()=>{databaseCalls++;throw new Error('No database call expected');}},
  } as unknown as Parameters<typeof startGuestSession>[1];
  const response=await startGuestSession(new Request(origin+'/auth/guest',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','cf-connecting-ip':'192.0.2.1'},body:'{"token":"unused-fixture-proof"}'}),env);
  assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');
  assert.equal(response.headers.get('Set-Cookie'),null);assert.equal((await response.json() as any).error.code,'guest_rate_limited');
  assert.deepEqual(ingressKeys,['stem-guest-start:192.0.2.1']);assert.equal(databaseCalls,0);assert.equal(externalCalls,0);
});

test('workerd guests: verified cookie, split/chat settlement, replay, isolation, proof refresh and logout',async()=>{
  const issuer=await createTestIdentityIssuer();
  const member=TEST_SUBJECTS.alice;
  const jwt=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:member});
  const mp3=await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  const wav=await readFile(new URL('../tests/fixtures/audio/source.wav',import.meta.url));
  let challengeMode='ok',predictionMode='success',starts=0,verifications=0;
  const predictions=new Map<string,string>();
  const network=setupServer(
    http.post('https://challenges.cloudflare.com/turnstile/v0/siteverify',async({request})=>{
      const body=await request.json() as {secret:string;response:string};
      assert.equal(body.secret,settings.GUEST_TURNSTILE_SECRET);verifications++;
      return HttpResponse.json({success:challengeMode!=='failed',hostname:challengeMode==='wrong-host'?'other.test':'split.test',
        action:challengeMode==='wrong-action'?'other':'stem_guest',challenge_ts:new Date(Date.now()-(challengeMode==='expired'?400000:0)).toISOString()});
    }),
    http.post('https://api.replicate.com/v1/predictions',async({request})=>{
      const input=await request.json() as {version:string};assert.equal(input.version,'guest-fixture-pin');
      const id=`guest-prediction-${++starts}`;predictions.set(id,predictionMode);return HttpResponse.json({id,status:'starting'});
    }),
    http.get('https://api.replicate.com/v1/predictions/:id',({params})=>HttpResponse.json({id:params.id,
      status:predictions.get(String(params.id))==='failed'?'failed':'succeeded',output:Object.fromEntries(['vocals','drums','bass','other'].map(name=>[name,`https://fixtures.replicate.delivery/${name}.mp3`]))})),
    http.get('https://fixtures.replicate.delivery/:name.mp3',()=>new HttpResponse(mp3,{headers:{'Content-Type':'audio/mpeg'}})),
  );
  network.listen({onUnhandledRequest:'error'});
  const harness=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),
    vars:{TEST_JWKS:issuer.jwksJson,...settings},secrets:{REPLICATE_API_TOKEN:'guest-fixture-token',REPLICATE_MODEL_VERSION:'guest-fixture-pin',WEBHOOK_SECRET:'guest-fixture-webhook'}}]});
  try {
    await harness.listen();const worker=harness.getWorker('stem-preview-contract-test');
    async function sql(statements:string[]){assert.equal((await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(statements)})).status,200);}
    await sql(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')));
    const call=(path:string,cookie='',init:RequestInit={})=>worker.fetch(origin+path,{redirect:'manual',...init,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...init.headers}});
    const begin=(token:string,cookie='',headers={})=>call('/auth/guest',cookie,{method:'POST',body:JSON.stringify({token}),headers});
    assert.equal((await call('/api/account')).status,401);
    assert.equal((await begin('cross-site','',{Origin:'https://attacker.test'})).status,403);
    assert.equal(verifications,0);
    for(challengeMode of ['failed','wrong-host','wrong-action','expired']){const check=await begin(challengeMode);assert.equal(check.status,403,`${challengeMode}: ${await check.text()}`);}
    challengeMode='ok';
    const first=await begin('unique-guest-token-a');assert.equal(first.status,200,await first.clone().text());
    assert.match(first.headers.get('set-cookie')!,/Secure; HttpOnly; SameSite=Lax/);
    const cookieA=first.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await begin('unique-guest-token-a')).status,403,'challenge replay');
    const cookieB=(await begin('unique-guest-token-b')).headers.get('set-cookie')!.split(';')[0];
    const account=await(await call('/api/account',cookieA)).json() as any;
    assert.equal(account.account.role,'guest');assert.equal(account.account.quotaClass,'guest');assert.equal(account.account.course,null);
    assert.equal(account.splitAllowance.limit,5);assert.equal(account.chatAllowance.limit,25);
    assert.equal((await(await call('/api/account',cookieA)).json() as any).account.subject,account.account.subject,'resumed guest');
    const macOffset=cookieA.lastIndexOf('.')+1;
    assert.equal((await call('/api/account',cookieA.slice(0,macOffset)+(cookieA[macOffset]==='a'?'b':'a')+cookieA.slice(macOffset+1))).status,401,'tampered MAC');
    assert.equal((await call('/api/account',cookieA+'; '+cookieB)).status,401,'duplicate cookie');
    const memberCookie='__Host-stem-session=invalid';
    assert.equal((await call('/api/account',cookieA+'; '+memberCookie)).status,401,'invalid member cannot become guest');
    assert.equal((await begin('member-downgrade',cookieA+'; '+memberCookie)).status,403);
    for(const path of ['/api/classroom/courses','/api/teacher/prompt','/api/teacher/folders','/api/admin/users','/api/model-quota'])assert.equal((await call(path,cookieA)).status,403,path);
    assert.equal((await call('/api/account',cookieA,{headers:{'x-stem-course':'msh-245-the-american-musical-experience-fall-2026-01'}})).status,403);
    assert.deepEqual(await(await call('/api/teacher/me',cookieA)).json(),{teacher:null});

    await sql([`INSERT INTO app_users(subject) VALUES('${member}')`,
      `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('member-private','Private member lesson','uploads/private.wav','done','htdemucs_ft','[{"name":"vocals","key":"stems/member-private/vocals.mp3"}]')`,
      `INSERT INTO job_owners(job_id,subject) VALUES('member-private','${member}')`,
      `INSERT INTO listening_conversations(job_id,subject,entries,revision,expires_at) VALUES('member-private','${member}','[{"kind":"you","text":"Private member transcript"}]',1,datetime('now','+1 day'))`]);
    for(const path of ['/api/jobs/member-private','/api/jobs/member-private/listening-conversation','/api/files/stems/member-private/vocals.mp3']){
      const response=await call(path,cookieA);assert.equal(response.status,404,path);assert.doesNotMatch(await response.text(),/Private member/);
    }
    assert.doesNotMatch(await(await call('/api/jobs',cookieA)).text(),/Private member/);

    const grant=await(await call('/api/uploads',cookieA,{method:'POST',body:'{"filename":"guest.wav"}'})).json() as any;
    assert.equal((await call(grant.uploadUrl,cookieB,{method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':String(wav.length)},body:wav})).status,404);
    assert.equal((await call(grant.uploadUrl,cookieA,{method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':String(wav.length)},body:wav})).status,204);
    const body=JSON.stringify({key:grant.key,filename:'Guest owned fixture',model:'htdemucs_ft'});
    const submit=(key:string)=>call('/api/jobs',cookieA,{method:'POST',headers:{'Idempotency-Key':key},body});
    async function finish(id:string){for(let i=0;i<50;i++){const response=await call(`/api/jobs/${id}`,cookieA);assert.equal(response.status,200,await response.clone().text());const job=await response.json() as any;if(['done','failed'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('fixture job did not settle');}
    predictionMode='failed';let response=await submit('guest-split-failed-0001');assert.equal(response.status,202,await response.clone().text());
    const failed=await response.json() as any;assert.equal((await finish(failed.id)).status,'failed');
    assert.equal((await(await call('/api/account',cookieA)).json() as any).splitAllowance.remaining,5);
    predictionMode='success';let job:any;
    for(let i=0;i<5;i++){
      const key=`guest-split-success-${String(i).padStart(4,'0')}`;response=await submit(key);assert.equal(response.status,202,await response.clone().text());
      const created=await response.json() as any;const repeated=await submit(key);assert.equal(repeated.status,200);assert.equal((await repeated.json() as any).id,created.id);
      job=await finish(created.id);assert.equal(job.status,'done');
    }
    assert.equal(starts,6,'failed plus five successful predictions, no replay start');
    assert.equal((await submit('guest-split-sixth-0006')).status,429);
    const count=await(await call('/api/account',cookieA)).json() as any;assert.equal(count.splitAllowance.completed,5);assert.equal(count.splitAllowance.inProgress,0);
    for(const path of [`/api/jobs/${job.id}`,`/api/jobs/${job.id}/listening-conversation`,new URL(job.stems[0].url,origin).pathname])assert.equal((await call(path,cookieB)).status,404,path);
    assert.equal((await call(`/api/jobs/${job.id}`,cookieA,{headers:{'x-fixture-identity':jwt}})).status,404,'member does not inherit guest work');
    assert.equal((await call(`/api/jobs/${job.id}/share`,cookieA,{method:'POST',body:'{}'})).status,403);
    const usage=JSON.stringify({events:[{id:'guest-playback-event-0001',type:'playback_start',jobId:job.id}]});
    const accountB=await(await call('/api/account',cookieB)).json() as any;
    assert.equal((await call('/api/usage-events',cookieA,{method:'POST',headers:{'X-Stem-Usage-Actor':account.account.subject},body:usage})).status,200,'own playback telemetry');
    assert.equal((await call('/api/usage-events',cookieB,{method:'POST',headers:{'X-Stem-Usage-Actor':accountB.account.subject},body:usage})).status,404,'other guest cannot attach a job to telemetry');
    assert.equal((await call('/api/usage-events',cookieB,{method:'POST',headers:{'X-Stem-Usage-Actor':account.account.subject},body:JSON.stringify({events:[{id:'old-guest-page-event-001',type:'page_view'}]})})).status,409,'guest switch rejects old queued observations');
    assert.equal((await call('/api/admin/usage-events',cookieA)).status,403);
    const note=await call(`/api/jobs/${job.id}/annotations`,cookieA,{method:'POST',body:JSON.stringify({atSeconds:1,text:'Guest listening note'})});
    assert.equal(note.status,200);const noteId=(await note.json() as any).id;
    assert.equal((await call(`/api/jobs/${job.id}/annotations/${noteId}`,cookieB,{method:'DELETE'})).status,404);
    assert.equal((await call(`/api/jobs/${job.id}/annotations/${noteId}`,cookieA,{method:'DELETE'})).status,200);
    assert.equal((await call(`/api/jobs/${job.id}/listening-conversation`,cookieA,{method:'PUT',body:JSON.stringify({revision:0,entries:[{kind:'you',text:'Only guest A'}]})})).status,200);
    assert.match(await(await call(`/api/jobs/${job.id}/listening-conversation`,cookieA)).text(),/Only guest A/);
    const chat=(key:string,mode='ok')=>call(`/api/jobs/${job.id}/chat`,cookieA,{method:'POST',headers:{'x-fixture-gateway-mode':mode},body:JSON.stringify({messageId:key,messages:[{role:'user',content:'What should I listen for?'}]})});
    response=await chat('guest-chat-empty-0001','empty');await response.text();
    assert.equal((await(await call('/api/account',cookieA)).json() as any).chatAllowance.completed,0);
    assert.equal((await(await call('/api/account',cookieA)).json() as any).chatAllowance.inProgress,0);
    for(let i=0;i<25;i++){response=await chat(`guest-chat-human-${String(i).padStart(4,'0')}`);assert.equal(response.status,200);assert.match(await response.text(),/Listen for the bass/);}
    assert.equal((await chat('guest-chat-human-0000')).status,409,'human replay has no extra inference');
    assert.equal((await chat('guest-chat-human-0026')).status,429);
    assert.equal((await(await call('/api/account',cookieA)).json() as any).chatAllowance.completed,25);
    const stats=await worker.fetch('/__fixture/gateway-stats',{headers:{'x-fixture':'local-only'}});assert.equal((await stats.json() as any).gatewayCalls,26);
    await sql([`UPDATE guest_sessions SET verified_day='2000-01-01' WHERE subject='${account.account.subject}'`]);
    assert.equal((await call('/api/jobs',cookieA)).status,200,'old proof preserves own reads');
    assert.equal((await submit('guest-needs-proof-0001')).status,403);
    assert.equal((await begin('guest-proof-refresh',cookieA)).status,200);
    assert.equal((await(await call('/api/account',cookieA)).json() as any).splitAllowance.completed,5,'proof refresh does not reset budget');
    assert.equal((await call('/auth/logout',cookieA,{method:'POST'})).status,303);
    assert.equal((await call(`/api/jobs/${job.id}`,cookieA)).status,401,'logout revokes copied cookie');
    assert.equal((await call('/api/jobs',cookieB)).status,200,'other guest remains isolated and active');
  } finally {await harness.close();network.close();}
});

test('guest expiry, signing scope, immutable quota class, atomic reservations and midnight reset',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'stem-guest-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const local=new SqliteD1(join(directory,'db'));local.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db=local as unknown as D1Database,now=Date.now(),id='a'.repeat(64),subject=`guest-${id}`,expires=now+60000;
  await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(subject,now,expires,dailyWindow().day).run();
  const env={...settings,DB:db} as Env;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(settings.GUEST_COOKIE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sign=async(exp:number,scope=origin)=>Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`stem-splitter-guest-v1\n${scope}\n${id}.${exp}`))).toString('base64url');
  const cookie=`${GUEST_COOKIE}=${id}.${expires}.${await sign(expires)}`;
  assert.equal((await readGuestSession(new Request(origin,{headers:{Cookie:cookie}}),env))?.subject,subject);
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',signature=await sign(expires);
  const noncanonical=signature.slice(0,-1)+alphabet[alphabet.indexOf(signature.at(-1)!)+1];
  assert.deepEqual(Buffer.from(noncanonical,'base64url'),Buffer.from(signature,'base64url'),'only ignored padding bits changed');
  assert.equal(await readGuestSession(new Request(origin,{headers:{Cookie:`${GUEST_COOKIE}=${id}.${expires}.${noncanonical}`}}),env),null,'noncanonical MAC encoding');
  await assert.rejects(readGuestSession(new Request(origin,{headers:{Cookie:cookie}}),{...env,DB:{prepare(){throw new Error('fixture database unavailable');}} as unknown as D1Database}),/fixture database unavailable/,'storage outage preserves the distinction from an invalid cookie');
  assert.equal(await readGuestSession(new Request('https://other.test',{headers:{Cookie:cookie}}),env),null);
  const past=now-1000;assert.equal(await readGuestSession(new Request(origin,{headers:{Cookie:`${GUEST_COOKIE}=${id}.${past}.${await sign(past)}`}}),env),null,'correctly signed expired cookie');
  assert.equal(await readGuestSession(new Request(origin,{headers:{Cookie:`${GUEST_COOKIE}=${id}.${expires+1000}.${await sign(expires+1000)}`}}),env),null,'database expiry must match');
  const reserve=(n:number,at=now)=>reserveOperation(db,{subject,quotaClass:'guest',courseId:null,kind:'split',key:`guest-parallel-${String(n).padStart(4,'0')}`,fingerprint:`${n}`,phase:'split',now:at});
  const first=await reserve(0);await settleOperation(db,first.operation.id,'failed');
  for(let i=1;i<=3;i++){const value=await reserve(i);await settleOperation(db,value.operation.id,'succeeded');}
  const concurrent=await Promise.allSettled([4,5,6,7].map(n=>reserve(n)));
  assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,2);
  assert.equal((await splitAllowance(db,subject,new Date(now),'guest')).remaining,0);
  await assert.rejects(db.prepare("UPDATE app_operations SET quota_class='member' WHERE id=?").bind(first.operation.id).run(),/immutable/);
  await assert.rejects(db.prepare("INSERT INTO app_users(subject) VALUES(?)").bind(subject).run(),/CHECK/);
  await assert.rejects(reserveOperation(db,{subject,quotaClass:'member',courseId:null,kind:'chat',key:'guest-member-forgery',fingerprint:'x',phase:'chat'}),/FOREIGN KEY/);
  await assert.rejects(reserveOperation(db,{subject,quotaClass:'guest',courseId:'course-a',kind:'chat',key:'guest-course-forgery',fingerprint:'x',phase:'chat'}),/course/);
  const tomorrow=now+86400000;
  assert.equal((await splitAllowance(db,subject,new Date(tomorrow),'guest')).remaining,5,'UTC-day allowance is separate');
  const chats=await Promise.allSettled(Array.from({length:30},(_,i)=>reserveOperation(db,{subject,quotaClass:'guest',courseId:null,
    kind:'chat',phase:'chat',key:`guest-parallel-chat-${String(i).padStart(4,'0')}`,fingerprint:String(i),now})));
  const admitted=chats.flatMap(result=>result.status==='fulfilled'?[result.value.operation]:[]);
  assert.equal(admitted.length,25,'parallel 25th/26th input cannot oversubscribe');
  for(const [index,operation] of admitted.entries())await settleOperation(db,operation.id,index===0?'failed':index===1?'partial':'succeeded');
  assert.equal((await operationAllowance(db,subject,'chat',new Date(now),'guest')).completed,24);
  assert.equal((await operationAllowance(db,subject,'chat',new Date(tomorrow),'guest')).completed,0,'late settlement remains on submission day');
  const replacement=await reserveOperation(db,{subject,quotaClass:'guest',courseId:null,kind:'chat',phase:'chat',key:'guest-chat-replacement-01',fingerprint:'replacement',now});
  await settleOperation(db,replacement.operation.id,'succeeded');
  await settleOperation(db,admitted[1].id,'failed');
  assert.equal((await operationAllowance(db,subject,'chat',new Date(now),'guest')).completed,25,'partial replay cannot refund a charged input');
  await db.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(now,subject).run();
  assert.equal(await readGuestSession(new Request(origin,{headers:{Cookie:cookie}}),env),null,'revoked copied cookie');
  await assert.rejects(db.prepare('UPDATE guest_sessions SET revoked_at=NULL WHERE subject=?').bind(subject).run(),/immutable/);
});
