import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const names=['vocals','drums','bass','other','guitar','piano'];
function tone(frequency:number,volume:number) {
 const r=spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=44100:duration=2`,'-af',`volume=${volume}`,'-ac','2','-c:a','libmp3lame','-b:a','192k','-f','mp3','pipe:1'],{maxBuffer:1024*1024});
 assert.equal(r.status,0,String(r.stderr));return r.stdout;
}
test('workerd: adaptive four publishes guitar and a real remainder with ownership and model guards',{timeout:90000},async()=>{
 const issuer=await createTestIdentityIssuer(),subjects=[TEST_SUBJECTS.alice,TEST_SUBJECTS.bob];
 const tokens=await Promise.all(subjects.map(subject=>issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject})));
 const audio=Object.fromEntries(names.map((n,i)=>[n,tone([500,1500,80,250,900,650][i],[.8,.8,.0008,.8,4,.0008][i])]));let starts=0;
 const network=setupServer(
  http.post('https://api.replicate.com/v1/predictions',async({request})=>{const body=await request.json() as {input:{model:string}};assert.equal(body.input.model,'htdemucs_6s');return HttpResponse.json({id:`adaptive-fixture-${++starts}`,status:'starting'});}),
  http.get('https://api.replicate.com/v1/predictions/:id',({params})=>HttpResponse.json({id:params.id,status:'succeeded',output:Object.fromEntries(names.map(n=>[n,`https://adaptive.replicate.delivery/${n}.mp3`]))})),
  http.get('https://adaptive.replicate.delivery/:name.mp3',({params})=>new HttpResponse(audio[String(params.name)],{headers:{'content-type':'audio/mpeg'}})),
 );network.listen({onUnhandledRequest:'error'});
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol,ADAPTIVE_FOUR_ENABLED:'true',TEST_QUEUE:'true',TEST_QUEUE_FAIL:'true'},secrets:{REPLICATE_API_TOKEN:'fixture-only',REPLICATE_MODEL_VERSION:'fixture-pin',WEBHOOK_SECRET:'fixture-webhook'}}]});
 try {
  await server.listen();const worker=server.getWorker('stem-preview-contract-test');
  const schema=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  assert.equal((await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(schema)})).status,200);
  const call=(path:string,who=0,init:RequestInit={})=>worker.fetch(path,{...init,headers:{'x-fixture-identity':tokens[who],Origin:'https://split.test','Content-Type':'application/json',...(init.method==='POST'?{'Idempotency-Key':crypto.randomUUID()}:{}),...init.headers}});
  const opts=await(await worker.fetch('/api/separation-options')).json() as {defaultModel:string;routing:{auto:string};models:{stems:string[]}[]};
  assert.equal(opts.defaultModel,'adaptive_four');assert.equal(opts.routing.auto,'adaptive');assert.deepEqual(opts.models.map(m=>m.stems.length),[2,4,6]);
  const wav=await readFile(new URL('../tests/fixtures/audio/source.wav',import.meta.url));
  const grantResponse=await call('/api/uploads',0,{method:'POST',body:'{"filename":"fixture.wav"}'});assert.equal(grantResponse.status,200,await grantResponse.clone().text());
  const grant=await grantResponse.json() as {key:string;uploadUrl:string};
  assert.equal((await call(new URL(grant.uploadUrl,'https://split.test').pathname,0,{method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':String(wav.length)},body:wav})).status,204);
  const start={key:grant.key,filename:'fixture.wav',model:'adaptive_four'};
  assert.equal((await call('/api/jobs',0,{method:'POST',body:JSON.stringify({...start,model:'adaptive_4__vocals_drums_guitar'})})).status,400);assert.equal(starts,0);
  const response=await call('/api/jobs',0,{method:'POST',body:JSON.stringify(start)});assert.equal(response.status,202,await response.clone().text());
  const created=await response.json() as {id:string;adaptiveOutput:number;expectedStems:string[]};assert.equal(created.adaptiveOutput,4);assert.deepEqual(created.expectedStems,[]);
  const queued=await(await call(`/api/jobs/${created.id}`)).json() as {status:string};
  assert.notEqual(queued.status,'done','HTTP polls hand off expensive work instead of encoding in waitUntil');
  let drained={delivered:0,acked:0,retried:0};
  for(let i=0;i<40&&!drained.delivered;i++){
    await call(`/api/jobs/${created.id}`);
    await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify([`UPDATE jobs SET status='ingesting',error='ingesting:1:expired-fixture' WHERE id='${created.id}' AND status='processing'`])});
    drained=await(await worker.fetch('/__fixture/adaptive-queue',{headers:{'x-fixture':'local-only'}})).json() as typeof drained;
    if(!drained.delivered)await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(drained.delivered>=1);assert.ok(drained.retried>=1,'transient storage failures retry without spending another allowance');
  assert.equal((await (await call(`/api/jobs/${created.id}`)).json() as any).operation.phase,'output');
  const recovered=await(await worker.fetch('/__fixture/adaptive-queue',{headers:{'x-fixture':'local-only'}})).json() as typeof drained;
  assert.ok(recovered.delivered>=1);assert.equal(recovered.retried,0);assert.equal(recovered.acked,recovered.delivered);
  let job:{status:string;model:string;expectedStems:string[];stems:{name:string;url:string}[]}|undefined;
  for(let i=0;i<50;i++){await worker.fetch('/__fixture/adaptive-queue',{headers:{'x-fixture':'local-only'}});job=await(await call(`/api/jobs/${created.id}`)).json() as typeof job;if(job?.status==='done'||job?.status==='failed')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(job?.status,'done',JSON.stringify(job));assert.equal(starts,1);assert.equal(job!.model,'adaptive_4__vocals_drums_guitar');
  assert.deepEqual(job!.expectedStems,['vocals','drums','guitar','other']);assert.deepEqual(job!.stems.map(s=>s.name),['vocals','drums','guitar','other']);
  assert.equal((await call(`/api/jobs/${created.id}`,1)).status,404);const hashes=[];
  for(const stem of job!.stems){const r=await call(stem.url);assert.equal(r.status,200);assert.match(r.headers.get('content-type')||'',/^audio\/mpeg/);const bytes=Buffer.from(await r.arrayBuffer());assert.ok(bytes.length>1000);hashes.push(createHash('sha256').update(bytes).digest('hex'));assert.equal((await call(stem.url,1)).status,404);}
  assert.equal(new Set(hashes).size,4);assert.equal((await worker.fetch(`/api/jobs/${created.id}`)).status,401);
 } finally {await server.close();network.close();}
});
