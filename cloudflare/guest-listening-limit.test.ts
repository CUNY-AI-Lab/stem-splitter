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

test('two successful guest replies cover the entire browser session across recordings, routes and days',async t=>{
  const f=await fixture(); let now=Date.now(); t.mock.method(Date,'now',()=>now);
  for(let i=0;i<2;i++) {
    const r=await f.reserve('recording-a',i,i===0?'guide':'chat');
    await assistantReceipt(f.env,r.operation).complete('Usable reply');
    const stage=await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a');
    assert.equal(stage.showSignIn,i>=1);assert.equal(stage.signInRequired,i>=1);
  }
  const used=await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a');
  assert.equal(used.scope,'session');assert.equal(used.remainingTurns,0);assert.equal(used.signInRequired,true);assert.equal(used.successfulTurns,2);
  await assert.rejects(f.reserve('recording-a',5),(e:any)=>e.code==='guest_listening_signin_required'&&e.status===403&&e.details.usage.jobId==='recording-a');
  assert.equal((await f.reserve('recording-a',1)).replay,true,'same receipt stays free');
  now+=86400000;
  await assert.rejects(f.reserve('recording-a',6),{code:'guest_listening_signin_required'});
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-b')).remainingTurns,0);
  await assert.rejects(f.reserve('recording-b',0),{code:'guest_listening_signin_required'});
  const read=await app.fetch(new Request('https://split.test/api/jobs/recording-a/listening-usage'),f.env);
  assert.equal(read.status,200);assert.equal((await read.json() as any).signInRequired,true);
  assert.equal((await app.fetch(new Request('https://split.test/api/jobs/somebody-else/listening-usage'),f.env)).status,404);
});

test('parallel guest requests hold two demo places and failed or incomplete replies release both',async()=>{
  const f=await fixture();
  const attempts=await Promise.allSettled(Array.from({length:12},(_,i)=>f.reserve(i%2?'recording-b':'recording-a',i,i%2?'chat':'guide')));
  const accepted=attempts.flatMap(r=>r.status==='fulfilled'?[r.value.operation]:[]);
  assert.equal(accepted.length,2);
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a')).inProgress,2);
  for(const result of attempts)if(result.status==='rejected')assert.equal(result.reason.code,'listening_in_progress');
  await assistantReceipt(f.env,accepted[0]).failed();
  const partial=assistantReceipt(f.env,accepted[1]);await partial.delta('Incomplete opening');await partial.failed();
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a')).remainingTurns,2);
  for(const key of [99,100]) {const replacement=await f.reserve('recording-a',key);await assistantReceipt(f.env,replacement.operation).complete('Complete');}
  await settleOperation(f.db as unknown as D1Database,accepted[1].id,'failed');
  assert.equal((await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a')).successfulTurns,2);
  await assert.rejects(f.reserve('recording-a',101),{code:'guest_listening_signin_required'});
});

test('abandoned guest reservations release demo places and fence late replies',async()=>{
  const f=await fixture();
  const empty=await f.reserve('recording-a',0), partial=await f.reserve('recording-a',1);
  await assistantReceipt(f.env,partial.operation).delta('Received opening');
  await recoverListeningOperations(f.db as unknown as D1Database,subject,Date.now()+90001);
  const usage=await guestListeningUsage(f.db as unknown as D1Database,subject,'recording-a');
  assert.equal(usage.successfulTurns,0);assert.equal(usage.remainingTurns,2);assert.equal(usage.inProgress,0);
  await assert.rejects(assistantReceipt(f.env,empty.operation).complete('Late output'),/ended/);
});
