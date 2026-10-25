import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('durable fallback preserves report, deduplicates replay, isolates uncertain Redmine, and minimizes contacts', {timeout:60000}, async()=>{
 let posts=0,mailCalls=0,sends=0,mode='saved',mailMode='accepted'; const emails=new Map<string,string>();
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./test-report-delivery-worker.ts',import.meta.url))],bundle:true,format:'esm',write:false,platform:'browser',target:'es2022'});
 const server=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-06',script:bundle.outputFiles[0].text,d1Databases:['DB'],
 serviceBindings:{MAIL:async(request:Request)=>{mailCalls++;const r=await request.json<any>();assert.ok(r.description.length<=4000);assert.deepEqual(Object.keys(r).sort(),['description','origin','path','rateDay','rateKey','release','reportId'].sort());
 if(emails.has(r.reportId)){assert.equal(emails.get(r.reportId),r.description);return Response.json({ok:true,status:'accepted',reportId:r.reportId});}
 sends++;emails.set(r.reportId,r.description);if(mailMode==='lost')throw new Error('lost acknowledgment');return Response.json({ok:true,status:'accepted',reportId:r.reportId});}},
 outboundService:async(request:Request)=>{if(request.method==='GET')return Response.json({issues:[],total_count:0});posts++;if(mode==='lost')throw new Error('uncertain');if(mode==='reject')return new Response('',{status:403});return Response.json({issue:{id:42}},{status:201});}}));
 const fetch=(path:string,body?:unknown)=>server.dispatchFetch('https://fixture.test'+path,{method:'POST',body:JSON.stringify(body)});
 let n=0;const fresh=()=>({reportId:`77000000-0000-4000-8000-${String(++n).padStart(12,'0')}`,subject:'cail-'+n.toString(16).padStart(32,'0'),description:'Synthetic fallback report.',origin:'https://fixture.test',path:'/',release:'fixture'});
 const send=async(report:any,key?:string,mail=true)=>await(await fetch('/submit',{report,key,mail})).json() as any;
 const receipts=async()=>await(await fetch('/receipts')).json() as any[];
 try{
 for(const file of ['redmine-reports.sql','../migrations/0032-bug-report-deliveries.sql'])await fetch('/schema',schemaStatements(await readFile(new URL(file,import.meta.url),'utf8')));
 const actor=(value:string)=>createHash('sha256').update(`cail-bug-report-actor:v1\n${value}`).digest('hex');
 for(const state of ['pending','saved','rejected','retryable']) {
   const old=fresh(),owner=actor(old.subject),fingerprint=createHash('sha256').update(`${old.reportId}\n${old.path}\n${old.description}`).digest('hex');
   await fetch('/schema',[`INSERT INTO bug_report_receipts VALUES ('${owner}','${old.reportId}','${fingerprint}','2026-10-25T00:00:00.000Z','${state}',NULL)`]);
   const before=sends,result=await send(old);
   if(state==='saved'){assert.equal(result.delivery,'redmine');assert.equal(sends,before);}
   else if(state==='rejected'){assert.equal(result.delivery,'email');assert.equal(sends,before+1);}
   else{assert.equal(result.ok,false);assert.equal(sends,before);}
   assert.equal((await send({...old,description:'Changed legacy description.'})).code,'idempotency_conflict');assert.equal(sends,before+(state==='rejected'?1:0));
 }
 sends=0;posts=0;mailCalls=0;
 const r=fresh();assert.equal((await send(r)).delivery,'email');assert.equal(sends,1);assert.equal((await send(r)).delivery,'email');assert.equal(sends,1);
 assert.equal((await send({...r,description:'Changed synthetic text.'})).code,'idempotency_conflict');assert.equal(sends,1);
 let row=(await receipts()).find(row=>row.report_id===r.reportId);assert.equal(row.state,'accepted');assert.equal(row.description,r.description);assert.equal(row.delivery,'email');assert.equal(row.report_id,r.reportId);
 const signed=fresh();assert.equal((await send(signed,'synthetic')).delivery,'redmine');assert.equal(posts,1);assert.equal(sends,1);
 mode='lost';const uncertain=fresh();assert.equal((await send(uncertain,'synthetic')).ok,false);assert.equal((await send(uncertain,'synthetic')).ok,false);assert.equal((await send(uncertain)).ok,false);assert.equal(sends,1);assert.equal(posts,2);
 mode='reject';const rejected=fresh();assert.equal((await send(rejected,'synthetic')).delivery,'email');assert.equal(sends,2);assert.equal((await send(rejected,'synthetic')).delivery,'email');assert.equal(posts,3);
 mailMode='lost';const lost=fresh();assert.equal((await send(lost)).ok,false);const before=sends;assert.equal((await send(lost)).delivery,'email');assert.equal(sends,before);mailMode='accepted';
 const guest={...fresh(),contact:{firstName:'Synthetic',lastName:'Guest',email:'synthetic@example.edu'},rateKey:'a'.repeat(64)};delete (guest as any).subject;assert.equal((await send(guest)).delivery,'email');row=(await receipts()).at(-1);assert.doesNotMatch(JSON.stringify(row),/example.edu|Synthetic Guest/);
 const max={...fresh(),description:'x'.repeat(4000)};assert.equal((await send(max)).delivery,'email');
 const absent=fresh();assert.equal((await send(absent,undefined,false)).ok,false);row=(await receipts()).at(-1);assert.equal(row.state,'pending');assert.equal(row.description,absent.description);
 const race=fresh();await Promise.all([send(race),send(race)]);assert.equal((await receipts()).filter(r=>r.report_id===race.reportId).length,1);
 const limitedSubject='cail-'+'e'.repeat(32);
 for(let i=0;i<10;i++)assert.equal((await send({...fresh(),subject:limitedSubject})).ok,true);
 const mailBefore=sends;assert.equal((await send({...fresh(),subject:limitedSubject})).code,'rate_limited');assert.equal(sends,mailBefore);
 const sharedRate='f'.repeat(64);
 for(let i=0;i<20;i++)assert.equal((await send({...fresh(),contact:{firstName:'Test',lastName:'Guest',email:`guest${i}@example.edu`},rateKey:sharedRate})).ok,true);
 const rateBefore=sends;assert.equal((await send({...fresh(),contact:{firstName:'Test',lastName:'Guest',email:'over@example.edu'},rateKey:sharedRate})).code,'rate_limited');assert.equal(sends,rateBefore);
 assert.ok(mailCalls>=sends);
 }finally{await server.dispose();}
});
