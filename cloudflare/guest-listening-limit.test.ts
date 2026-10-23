import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from '../server/d1.ts';
import { reserveAssistant, assistantReceipt } from '../src/reliability/assistant.ts';
import { guestListeningUsage, recoverListeningOperations } from '../src/reliability/listening.ts';
import { settleOperation } from '../src/reliability/ledger.ts';
import type { Env } from '../src/env.ts';
import app from '../src/index.ts';

const subject='guest-'+'a'.repeat(64);
async function fixture() {
  const db=new SqliteD1(':memory:'); db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const now=Date.now(), expiresAt=now+7*86400000, verifiedDay=new Date(now).toISOString().slice(0,10);
  await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(subject,now,expiresAt,verifiedDay).run();
  for(const id of ['recording-a','recording-b']) {
    await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES(?,'Audio','uploads/source.wav','done')").bind(id).run();
    await db.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind(id,subject).run();
  }
  const env={DB:db,AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',guestRuntimeReady:true,guestChatReady:true,
    guestSession:{subject,expiresAt,verifiedDay}} as unknown as Env;
  const reserve=(id:string,index:number,kind:'chat'|'guide'='chat')=>reserveAssistant(env,subject,null,kind,`guest-listening-${id}-${index}`,id,{index},'guest');
  return {db,env,reserve};
}

test('five guest replies belong to one recording across refresh and days; another recording has its own allowance',async t=>{
  const f=await fixture(); let now=Date.now(); t.mock.method(Date,'now',()=>now);
  for(let i=0;i<5;i++) {
    const r=await f.reserve('recording-a',i,i===0?'guide':'chat');
    await assistantReceipt(f.env,r.operation).complete('Usable reply');
  }
  const used=await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a');
  assert.equal(used.remainingTurns,0);assert.equal(used.signInRequired,true);assert.equal(used.successfulTurns,5);
  await assert.rejects(f.reserve('recording-a',5),(e:any)=>e.code==='guest_listening_signin_required'&&e.status===403&&e.details.usage.jobId==='recording-a');
  assert.equal((await f.reserve('recording-a',1)).replay,true,'same receipt stays free');
  now+=86400000;
  await assert.rejects(f.reserve('recording-a',6),{code:'guest_listening_signin_required'});
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-b')).remainingTurns,5);
  await f.reserve('recording-b',0);
  const read=await app.fetch(new Request('https://split.test/api/jobs/recording-a/listening-usage'),f.env);
  assert.equal(read.status,200);assert.equal((await read.json() as any).signInRequired,true);
  assert.equal((await app.fetch(new Request('https://split.test/api/jobs/somebody-else/listening-usage'),f.env)).status,404);
});

test('parallel guest requests reserve five places and failures release them while partial output counts once',async()=>{
  const f=await fixture();
  const attempts=await Promise.allSettled(Array.from({length:12},(_,i)=>f.reserve('recording-a',i)));
  const accepted=attempts.flatMap(r=>r.status==='fulfilled'?[r.value.operation]:[]);
  assert.equal(accepted.length,5);
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a')).inProgress,5);
  for(const result of attempts)if(result.status==='rejected')assert.equal(result.reason.code,'listening_in_progress');
  await assistantReceipt(f.env,accepted[0]).failed();
  const partial=assistantReceipt(f.env,accepted[1]);await partial.delta('Useful opening');await partial.failed();
  for(const operation of accepted.slice(2))await assistantReceipt(f.env,operation).complete('Complete');
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a')).remainingTurns,1);
  const replacement=await f.reserve('recording-a',99);await assistantReceipt(f.env,replacement.operation).complete('Complete');
  await settleOperation(f.db as unknown as D1Database,accepted[1].id,'failed');
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a')).successfulTurns,5);
  await assert.rejects(f.reserve('recording-a',100),{code:'guest_listening_signin_required'});
});

test('abandoned guest reservations release empty attempts and retain delivered partials',async()=>{
  const f=await fixture();
  const empty=await f.reserve('recording-a',0), partial=await f.reserve('recording-a',1);
  await assistantReceipt(f.env,partial.operation).delta('Received opening');
  await recoverListeningOperations(f.db as unknown as D1Database,subject,Date.now()+90001);
  const usage=await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a');
  assert.equal(usage.successfulTurns,1);assert.equal(usage.remainingTurns,4);assert.equal(usage.inProgress,0);
  await assert.rejects(assistantReceipt(f.env,empty.operation).complete('Late output'),/ended/);
});
