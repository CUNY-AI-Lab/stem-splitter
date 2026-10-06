import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SqliteD1} from '../server/d1.ts';
import {parseClientUses,recordClientUses,recordServerUse,usageSummary} from '../src/reliability/observability.ts';
import {reserveOperation,beginAttempt,finishAttempt,settleOperation} from '../src/reliability/ledger.ts';
import {purgeOperationContent} from '../src/reliability/retention.ts';
import type {AppPrincipal} from '../src/identity.ts';
import type {Env} from '../src/env.ts';
function setup(){const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));return db;}
const principal={subject:'cail-'+ 'e'.repeat(32),role:'student',displayName:'Do not store me',course:null,courseId:null} as AppPrincipal;
test('content-free usage validation, deduplication, bounded volume and retention',async()=>{
 const db=setup();const event={id:'client-event-0000001',type:'seek' as const,jobId:'fixture-job',positionBucket:7};
 assert.deepEqual(parseClientUses({events:[event]}),[event]);
 for(const value of [{events:[{...event,text:'private'}]},{events:[{...event,positionBucket:91}]},{events:[{...event,jobId:'https://private.test'}]},{events:Array(11).fill(event)},{events:[{...event,type:'unknown'}]}])assert.equal(parseClientUses(value),null);
 await Promise.all([recordClientUses(db,principal,[event]),recordClientUses(db,principal,[event])]);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_events').first<any>())!.n,1);
 for(let i=1;i<510;i++)await recordClientUses(db,principal,[{...event,id:`bounded-event-${String(i).padStart(8,'0')}`}]);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_events').first<any>())!.n,500);
 const rows=JSON.stringify((await db.prepare('SELECT * FROM usage_events').all()).results);
 for(const secret of [principal.subject,principal.displayName,'https://'])assert.equal(rows.includes(secret),false);
 await db.prepare('UPDATE usage_events SET at=?').bind(Date.now()-31*86400000).run();
 await purgeOperationContent(db);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM usage_events').first<any>())!.n,0);
});
test('operation attempts, fallback and settlement emit one durable receipt without arbitrary usage strings',async()=>{
 const db=setup();await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(principal.subject).run();
 const {operation}=await reserveOperation(db,{subject:principal.subject,courseId:null,kind:'chat',phase:'chat',key:'durable-observed-001',fingerprint:'hash'});
 const first=await beginAttempt(db,operation,'cail-gateway','glm-5.2');
 await finishAttempt(db,first,'rejected',{status:503,code:'upstream_unavailable',usage:{total_tokens:4,private_text:'never retain'}});
 const backup=await beginAttempt(db,operation,'cail-gateway','deepseek-v4-flash-0731');
 await finishAttempt(db,backup,'succeeded',{usage:{total_tokens:12,private_text:'never retain'}});
 await settleOperation(db,operation.id,'partial','partial_response');
 await settleOperation(db,operation.id,'succeeded');
 await finishAttempt(db,backup,'succeeded',{usage:{total_tokens:12}});
 const {results}=await db.prepare('SELECT * FROM operation_events ORDER BY id').all<any>();
 assert.equal(results!.filter(r=>r.quota_effect==='reserved').length,1);
 assert.equal(results!.filter(r=>r.quota_effect==='charged').length,1);
 assert.equal(results!.filter(r=>r.attempt_id===backup&&r.event_type==='attempt_end').length,1);
 assert.ok(results!.some(r=>r.model==='deepseek-v4-flash-0731'&&r.fallback===1));
 assert.equal(JSON.stringify((await db.prepare('SELECT usage_json FROM operation_attempts').all()).results).includes('private_text'),false);
 const summary=await usageSummary(db,7);assert.equal(JSON.stringify(summary).includes(principal.subject),false);
 assert.ok(summary.operations.length>0);assert.ok(summary.operations.every(row=>(row as any).actor_class==='member'));
 await db.prepare('UPDATE operation_events SET at=?').bind(Date.now()-31*86400000).run();
 await purgeOperationContent(db);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_events').first<any>())!.n,0);
 assert.ok(await db.prepare('SELECT 1 FROM app_operations').first());
});
test('guest and member usage summaries keep immutable accounting classes separate without exposing identities',async()=>{
 const db=setup(),now=Date.now(),guest={...principal,subject:'guest-'+ 'a'.repeat(64),role:'guest' as const,quotaClass:'guest' as const};
 await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
   .bind(guest.subject,now,now+86400000,new Date(now).toISOString().slice(0,10)).run();
 const {operation}=await reserveOperation(db,{subject:guest.subject,quotaClass:'guest',courseId:null,kind:'chat',phase:'chat',key:'guest-observed-input-01',fingerprint:'hash'});
 await settleOperation(db,operation.id,'partial','partial_response');
 for(let i=0;i<260;i++)await recordClientUses(db,guest,[{id:`guest-usage-${String(i).padStart(12,'0')}`,type:'page_view'}]);
 const summary=await usageSummary(db,7);
 assert.ok(summary.operations.some(row=>(row as any).actor_class==='guest'&&(row as any).quota_effect==='charged'));
 assert.equal(summary.uses.reduce((count,row)=>count+Number((row as any).count),0),250);
 assert.ok(summary.uses.every(row=>(row as any).actor_class==='guest'));
 assert.equal(JSON.stringify(summary).includes(guest.subject),false);
});
test('server request rejection retries coalesce and never retain request contents',async()=>{
 const db=setup(),env={AUTH_MODE:'cail',DB:db} as Env;
 const request=new Request('https://app.test/api/jobs?source=private',{method:'POST',headers:{'Idempotency-Key':'rejection-request-00001'},body:'private source name'});
 for(let i=0;i<2;i++)await recordServerUse(env,request,Response.json({error:'Do not store',code:'split_daily_limit'},{status:429}),principal,Date.now()-5);
 const rows=(await db.prepare('SELECT * FROM usage_events').all<any>()).results!;assert.equal(rows.length,1);assert.equal(rows[0].code,'split_daily_limit');
 assert.equal(JSON.stringify(rows).includes('private'),false);
});
