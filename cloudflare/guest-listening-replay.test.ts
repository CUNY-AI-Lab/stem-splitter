import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from '../server/d1.ts';
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { assistantReceipt, reserveAssistant, replayAssistant } from '../src/reliability/assistant.ts';
import { purgeOperationContent } from '../src/reliability/retention.ts';
import { readOperation } from '../src/reliability/ledger.ts';

const guest='guest-'+'a'.repeat(64), alice='cail-'+'b'.repeat(32), bob='cail-'+'c'.repeat(32);
async function fixture() {
  const local=new SqliteD1(':memory:');local.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db=local as unknown as D1Database, now=Date.now(), expiresAt=now+3600000, verifiedDay=new Date(now).toISOString().slice(0,10);
  await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(guest,now,expiresAt,verifiedDay).run();
  for(const subject of [alice,bob])await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('recording','Audio','uploads/source.mp3','done','htdemucs_ft','[]')").run();
  await db.prepare("INSERT INTO guest_job_owners(job_id,subject) VALUES('recording',?)").bind(guest).run();
  let calls=0;
  const env={DB:db,AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',ASSISTANT_MODEL:'fixture',guestRuntimeReady:true,guestChatReady:true,
    guestSession:{subject:guest,expiresAt,verifiedDay},guestClaimSession:{subject:guest,expiresAt,verifiedDay},
    verifyCailIdentity:async(token:string)=>[alice,bob].includes(token)?{subject:token,name:'Fixture'}:null,
    ADMISSION_RESOLVER:{resolveMembership:async()=>({ok:true,accessRole:'member',budgetScope:'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()})},
    assistantTransport:async(_env:Env,_input:unknown,delta:(text:string)=>Promise<void>)=>{
      calls++;await delta('Saved guest reply.');return {content:'Saved guest reply.',model:'fixture',toolCalls:[],finishReason:'stop'};
    },
  } as unknown as Env;
  const request=(path:string,method='GET',body?:unknown,subject?:string)=>app.fetch(new Request(`https://split.test${path}`,{
    method,headers:{Origin:'https://split.test','Content-Type':'application/json',...(subject?{'x-cail-identity-jwt':subject,'X-Stem-Claim-Actor':subject}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}),subject?{...env,guestSession:undefined}:env);
  const events=async(response:Response)=>(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  const body=(key:string)=>({messageId:key,messages:[{role:'user',content:'What should I listen for?'}]});
  return {db,env,request,events,body,expiresAt,calls:()=>calls};
}

test('guest retries recover a completed fifth reply without a model call or an extra turn',async()=>{
  const f=await fixture();
  for(let i=0;i<5;i++)assert.equal((await f.events(await f.request('/api/jobs/recording/chat','POST',f.body(`guest-replay-message-${i}`)))).at(-1).type,'done');
  const replay=await f.events(await f.request('/api/jobs/recording/chat','POST',f.body('guest-replay-message-4')));
  assert.equal(replay.at(-1).replayed,true);assert.equal(replay.at(-1).text,'Saved guest reply.');
  assert.equal(replay.at(-1).usage.successfulTurns,5);assert.equal(f.calls(),5);
  const receipt=await f.db.prepare('SELECT * FROM guest_listening_reply_receipts LIMIT 1').first<any>();
  assert.ok(receipt.expires_at<=f.expiresAt);
  assert.doesNotMatch(JSON.stringify((await f.db.prepare('SELECT * FROM app_operations').all()).results),/Saved guest reply/);
  const op=await readOperation(f.db,receipt.operation_id);
  await f.db.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(),guest).run();
  assert.equal(await replayAssistant(f.env,op!),null);
  await purgeOperationContent(f.db);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM guest_listening_reply_receipts').first<any>()).n,0);
});

test('a lost guest reply survives sign-in and retries under the current member without regenerating or recharging',async()=>{
  const f=await fixture(),body=f.body('guest-replay-after-claim');
  await f.events(await f.request('/api/jobs/recording/chat','POST',body));
  assert.equal((await f.request('/api/account/claim-guest','POST',{},alice)).status,200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM guest_listening_reply_receipts').first<any>()).n,0);
  assert.ok((await f.db.prepare('SELECT expires_at FROM listening_reply_receipts').first<any>()).expires_at>f.expiresAt,'member receipt uses its own 24-hour lifetime after claim');
  const replay=await f.events(await f.request('/api/jobs/recording/chat','POST',body,alice));
  assert.equal(replay.at(-1).replayed,true);assert.equal(replay.at(-1).text,'Saved guest reply.');assert.equal(f.calls(),1);
  assert.equal(replay.at(-1).usage.successfulTurns,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM app_operations').first<any>()).n,1);
  assert.equal((await f.request('/api/jobs/recording/chat','POST',body,bob)).status,404);
  assert.equal((await f.request('/api/jobs/recording/chat','POST',{...body,messages:[{role:'user',content:'Changed input'}]},alice)).status,409);
  assert.equal((await f.request('/api/jobs/recording/chat','POST',body)).status,403,'retired guest cookie loses access');
  assert.equal((await f.request('/api/jobs/recording/listening-conversation','DELETE',undefined,alice)).status,200);
  await f.request('/api/account/claim-guest','POST',{},alice);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM listening_reply_receipts').first<any>()).n,0,'repeated claim cannot restore reset receipts');
  assert.equal((await f.request('/api/jobs/recording/chat','POST',body,alice)).status,409);assert.equal(f.calls(),1);
});

test('guest reset fences live output; a request finishing during claim writes only the member receipt',async()=>{
  const f=await fixture();
  const first=await reserveAssistant(f.env,guest,null,'chat','guest-reset-inflight','recording',{},'guest');
  assert.equal((await f.request('/api/jobs/recording/listening-conversation','DELETE')).status,200);
  await assert.rejects(assistantReceipt(f.env,first.operation).complete('Late reply',{text:'Late reply'}),/ended/);
  const next=await reserveAssistant(f.env,guest,null,'chat','guest-claim-inflight','recording',{},'guest');
  assert.equal((await f.request('/api/account/claim-guest','POST',{},alice)).status,200);
  await assistantReceipt(f.env,next.operation).complete('Claimed reply',{text:'Claimed reply'});
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM guest_listening_reply_receipts').first<any>()).n,0);
  assert.equal((await replayAssistant(f.env,(await readOperation(f.db,next.operation.id))!,alice))?.text,'Claimed reply');
  await f.db.prepare("DELETE FROM jobs WHERE id='recording'").run();
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM listening_reply_receipts').first<any>()).n,0);
});
