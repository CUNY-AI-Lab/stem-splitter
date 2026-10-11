import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { STEM_COURSE_ID } from '../src/classroom/contract.ts';

test('two actual Workerd Workers sharing D1 admit fifteen simultaneous requests across courses and keep each student independent',async()=>{
 const issuer=await createTestIdentityIssuer();const people=[TEST_SUBJECTS.alice,TEST_SUBJECTS.bob];
 const tokens=await Promise.all(people.map(subject=>issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject})));
 const config=JSON.parse(await readFile(new URL('./test-wrangler.jsonc',import.meta.url),'utf8'));
 config.main=fileURLToPath(new URL('./test-worker.ts',import.meta.url));config.assets.directory=fileURLToPath(new URL('../public',import.meta.url));
 config.vars={...config.vars,TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol,CAIL_COURSE_IDS:`${STEM_COURSE_ID},second-fixture-course`,
  REPLICATE_API_TOKEN:'fixture-only',REPLICATE_MODEL_VERSION:'fixture-pin',WEBHOOK_SECRET:'fixture-secret'};
 delete config.$schema;
 let starts=0;
 const network=setupServer(http.post('https://api.replicate.com/v1/predictions',()=>{starts++;return HttpResponse.json({id:'shared-prediction'});}),
  http.get('https://api.replicate.com/v1/predictions/shared-prediction',()=>HttpResponse.json({id:'shared-prediction',status:'processing'})));
 network.listen({onUnhandledRequest:'error'});
 const harness=createTestHarness({workers:[{config:{...config,name:'queue-worker-one'}},{config:{...config,name:'queue-worker-two'}}]});
 try {
  await harness.listen();const workers=[harness.getWorker('queue-worker-one'),harness.getWorker('queue-worker-two')];
  const schema=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  assert.equal((await workers[0].fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(schema)})).status,200);
  const call=(worker:number,who:number,path:string,init:RequestInit={})=>workers[worker].fetch(path,{...init,headers:{origin:'https://split.test','content-type':'application/json','x-fixture-identity':tokens[who],...init.headers}});
  const wav=await readFile(new URL('../tests/fixtures/audio/source.wav',import.meta.url));const keys:string[]=[];
  for(let i=0;i<2;i++){
   const grant=await(await call(i,i,'/api/uploads',{method:'POST',body:'{"filename":"fixture.wav"}'})).json();keys.push(grant.key);
   assert.equal((await call(i,i,new URL(grant.uploadUrl,'https://split.test').pathname,{method:'PUT',headers:{'content-length':String(wav.length)},body:wav})).status,204);
  }
  const submit=(who:number,i:number)=>call(i%2,who,'/api/jobs',{method:'POST',headers:{'Idempotency-Key':`person-${who}-operation-${String(i).padStart(4,'0')}`,'X-Stem-Course':i%2?STEM_COURSE_ID:'second-fixture-course'},body:JSON.stringify({key:keys[who],filename:'fixture.wav',model:'htdemucs_ft',coursePolicy:'course-work-v1'})});
  const responses=await Promise.all(Array.from({length:30},(_,i)=>submit(0,i)));
  assert.equal(responses.filter(r=>r.status===202).length,15);assert.equal(responses.filter(r=>r.status===429).length,15);
  await Promise.all(responses.map(r=>r.arrayBuffer()));
  const bob=await Promise.all(Array.from({length:15},(_,i)=>submit(1,i)));assert.ok(bob.every(r=>r.status===202));await Promise.all(bob.map(r=>r.arrayBuffer()));
  for(let who=0;who<2;who++){
   const account=await(await call((who+1)%2,who,'/api/account')).json();assert.equal(account.splitAllowance.inProgress,15);assert.equal(account.splitAllowance.completed,0);assert.equal(account.splitAllowance.remaining,0);
  }
  const rows=await(await workers[1].fetch('/__fixture/operations',{headers:{'x-fixture':'local-only'}})).json();assert.equal(rows.length,30);assert.equal(starts,1);
 } finally {await harness.close();network.close();}
});
