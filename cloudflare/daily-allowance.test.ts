import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { dailyWindow, operationAllowance, splitAllowance } from '../src/daily-allowance.ts';
import { OperationError, readOperation, reserveOperation, settleOperation } from '../src/reliability/ledger.ts';
import { claimNext, recoverExpired, transition, QUEUE_CAPS } from '../src/reliability/queue.ts';
import { retryAt } from '../src/reliability/retry.ts';
const alice='cail-'+'a'.repeat(32),bob='cail-'+'b'.repeat(32);
const now=Date.parse('2026-12-31T23:59:59.999Z');
function setup(t:{after:(f:()=>void)=>void}) {
 const dir=mkdtempSync(join(tmpdir(),'stem-ledger-')),left=new SqliteD1(join(dir,'db.sqlite'));
 left.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const right=new SqliteD1(join(dir,'db.sqlite'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return [left,right] as unknown as D1Database[];
}
async function user(db:D1Database,subject:string){await db.prepare('INSERT OR IGNORE INTO app_users(subject) VALUES(?)').bind(subject).run();}
const reserve=(db:D1Database,i:number,subject=alice,kind:'split'|'chat'='split',at=now)=>reserveOperation(db,{subject,courseId:i%2?'course-a':'course-b',kind,key:`request-number-${String(i).padStart(4,'0')}`,fingerprint:`fingerprint-${i}`,phase:kind==='split'?'split':'chat',now:at});

test('two connections atomically admit fifteen across courses; failures release exactly once',async t=>{
 const db=setup(t);for(const u of [alice,bob])await user(db[0],u);
 const results=await Promise.allSettled(Array.from({length:30},(_,i)=>reserve(db[i%2],i)));
 const admitted=results.flatMap(r=>r.status==='fulfilled'?[r.value.operation]:[]);assert.equal(admitted.length,15);
 await Promise.all(admitted.map((op,i)=>settleOperation(db[i%2],op.id,i<7?'succeeded':'failed')));
 await Promise.all(admitted.slice(7).map(op=>settleOperation(db[1],op.id,'failed')));
 assert.deepEqual(await splitAllowance(db[0],alice,new Date(now)),{limit:15,completed:7,inProgress:0,remaining:8,resetsAt:'2027-01-01T00:00:00.000Z'});
 const replacements=await Promise.allSettled(Array.from({length:20},(_,i)=>reserve(db[i%2],100+i)));assert.equal(replacements.filter(r=>r.status==='fulfilled').length,8);
 await reserve(db[1],400,bob);assert.equal((await splitAllowance(db[1],bob,new Date(now))).remaining,14);
 assert.equal(await settleOperation(db[0],admitted[8].id,'succeeded'),false);
});
test('sixty human messages admit fifty; one replay/partial/failure uses one reservation',async t=>{
 const db=setup(t);await user(db[0],alice);
 const results=await Promise.allSettled(Array.from({length:60},(_,i)=>reserve(db[i%2],i,alice,'chat')));assert.equal(results.filter(r=>r.status==='fulfilled').length,50);
 const first=await reserve(db[1],0,alice,'chat');assert.equal(first.created,false);
 await assert.rejects(reserveOperation(db[1],{subject:alice,courseId:'course-b',kind:'chat',key:'request-number-0000',fingerprint:'different',phase:'chat',now}),OperationError);
 await settleOperation(db[0],first.operation.id,'partial',null,{text:'Partial answer'});
 const second=await reserve(db[0],1,alice,'chat');await settleOperation(db[0],second.operation.id,'failed');
 const count=await operationAllowance(db[0],alice,'chat',new Date(now));assert.equal(count.completed,1);assert.equal(count.inProgress,48);assert.equal(count.remaining,1);
 await reserve(db[1],70,alice,'chat');await assert.rejects(reserve(db[0],71,alice,'chat'),OperationError);
});
test('submission-day accounting survives UTC midnight/year rollover and DST',async t=>{
 const db=setup(t);await user(db[0],alice);
 assert.deepEqual(dailyWindow(new Date(now)),{day:'2026-12-31',resetsAt:'2027-01-01T00:00:00.000Z',retryAfter:1});assert.equal(dailyWindow(new Date('2026-11-01T00:00:00Z')).retryAfter,86400);
 const op=await reserve(db[0],0);await settleOperation(db[1],op.operation.id,'succeeded');
 assert.equal((await splitAllowance(db[0],alice,new Date(now))).completed,1);assert.equal((await splitAllowance(db[0],alice,new Date(now+1))).remaining,15);
 await assert.rejects(db[0].prepare("UPDATE app_operations SET day='2027-01-01' WHERE id=?").bind(op.operation.id).run());
});
test('twenty students with two coordinators make fair progress within global/per-user caps',async t=>{
 const db=setup(t),seen=new Set<string>();
 for(let i=0;i<20;i++){const subject='cail-'+String(i).padStart(32,'0');await user(db[0],subject);await reserve(db[i%2],i,subject);await reserve(db[(i+1)%2],i+30,subject);}
 for(let i=0;i<20;i++){
  const claims=(await Promise.all([claimNext(db[0],'split',now+1),claimNext(db[1],'split',now+1)])).filter(Boolean);assert.equal(claims.length,QUEUE_CAPS.split);
  const op=claims[0]!;assert.equal(seen.has(op.subject),false);seen.add(op.subject);await settleOperation(db[i%2],op.id,'succeeded');
 }
 assert.equal(seen.size,20);
});
test('lost starts retain capacity; expiry fences old Worker completions without another POST',async t=>{
 const db=setup(t);await user(db[0],alice);await reserve(db[0],1);
 const op=(await claimNext(db[0],'split',now+1))!;await transition(db[0],op,'starting');
 await db[0].prepare("INSERT INTO operation_attempts(id,operation_id,phase,provider,outcome,created_at,updated_at) VALUES('attempt',?,'split','replicate','starting',?,?)").bind(op.id,now,now).run();
 await recoverExpired(db[1],now+600001);assert.equal((await readOperation(db[1],op.id))?.state,'reconciling');assert.equal(await transition(db[0],op,'succeeded'),false);
 assert.equal(await claimNext(db[0],'split',now+600002),null);assert.equal((await splitAllowance(db[0],alice,new Date(now))).inProgress,1);
});
test('Retry-After 90/date never shortens server floor; malformed headers use bounded jitter',()=>{
 assert.equal(retryAt('90',now),now+90000);const date=new Date(now+120001).toUTCString();assert.equal(retryAt(date,now),Date.parse(date));
 assert.equal(retryAt(null,now,1,()=>0),now+2000);assert.equal(retryAt('garbage',now,1,()=>0.5),now+3000);assert.equal(retryAt('-1',now,0,()=>0),now+1000);
});
test('quota rejection/duplicate key create no orphan jobs; late success cannot revive failure',async t=>{
 const db=setup(t);await user(db[0],alice);
 const submit=(id:string,key:string)=>reserveOperation(db[0],{subject:alice,courseId:null,kind:'split',key,fingerprint:key,phase:'split',jobId:id,now,statements:operationId=>[db[0].prepare("INSERT INTO jobs(id,filename,source_key) SELECT id,'fixture','uploads/fixture/a.mp3' FROM app_operations WHERE id=?").bind(operationId)]});
 await submit('job-a','request-duplicate-0001');await submit('job-b','request-duplicate-0001');for(let i=0;i<14;i++)await reserve(db[i%2],i+100);
 await assert.rejects(submit('job-full','request-quota-full-01'),OperationError);assert.equal((await db[0].prepare('SELECT COUNT(*) AS n FROM jobs').first<{n:number}>())?.n,1);
 await db[0].prepare("UPDATE jobs SET status='failed' WHERE id='job-a'").run();await assert.rejects(db[0].prepare("UPDATE jobs SET status='done' WHERE id='job-a'").run());
});
test('migration keeps old attempt evidence separate and never invents successful charges',async t=>{
 const db=setup(t);await user(db[0],alice);await db[0].prepare("INSERT INTO app_request_reservations(id,subject,scope,day) VALUES('old',?,'split','2026-12-31')").bind(alice).run();
 (db[0] as unknown as SqliteD1).applySchema(readFileSync(new URL('../migrations/0022-reliable-operations.sql',import.meta.url),'utf8'));
 assert.equal((await splitAllowance(db[0],alice,new Date(now))).completed,0);assert.equal((await db[0].prepare('SELECT COUNT(*) AS n FROM app_request_reservations').first<{n:number}>())?.n,1);
});
