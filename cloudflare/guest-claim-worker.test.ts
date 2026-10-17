import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('workerd claims require both verified browser cookie and Lab membership, not STEM course enrollment',async()=>{
 const issuer=await createTestIdentityIssuer(),member=TEST_SUBJECTS.alice;
 const jwt=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:member});
 const harness=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),
  vars:{TEST_JWKS:issuer.jwksJson,GUEST_ENABLED:'true',GUEST_COOKIE_SECRET:'fixture-cookie-secret-'.repeat(3),
   GUEST_TURNSTILE_SITE_KEY:'fixture-site-key',GUEST_TURNSTILE_SECRET:'fixture-turnstile-secret-only'}}]});
 try {
  await harness.listen();const worker=harness.getWorker('stem-preview-contract-test'),origin='https://split.test';
  const sql=async(statements:string[])=>assert.equal((await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(statements)})).status,200);
  await sql(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')));
  const call=(path:string,headers:Record<string,string>={},body?:string)=>worker.fetch(origin+path,{redirect:'manual',method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(path==='/api/account/claim-guest'?{'X-Stem-Claim-Actor':member}:{}),...headers},body});
  assert.equal(((await(await call('/api/runtime')).json() as any).guest).splitLimit,3);
  const started=await call('/auth/guest',{},'{}');assert.equal(started.status,200);assert.equal((await started.clone().json() as any).splitLimit,3);
  const cookie=started.headers.get('set-cookie')!.split(';')[0];
  const guestAccount=await(await call('/api/account',{Cookie:cookie})).json() as any;
  const guest=guestAccount.account.subject;assert.match(guest,/^guest-[0-9a-f]{64}$/);
  await sql([`INSERT INTO jobs(id,filename,source_key,status) VALUES('claim-worker','Saved fixture','uploads/claim-worker/source','done')`,
   `INSERT INTO guest_job_owners(job_id,subject) VALUES('claim-worker','${guest}')`]);
  const route='/api/account/claim-guest';
  assert.equal((await call(route,{Cookie:cookie},'{}')).status,403,'a guest cookie cannot claim alone');
  const noProof=await call(route,{'x-fixture-identity':jwt},JSON.stringify({guestSubject:guest,jobIds:['claim-worker']}));
  assert.equal(noProof.status,200);assert.deepEqual(await noProof.json(),{claimedJobIds:[],guestStorageKey:null});
  const tampered=await call(route,{'x-fixture-identity':jwt,Cookie:cookie+'x'},'{}');
  assert.equal(tampered.status,200);assert.deepEqual(await tampered.json(),{claimedJobIds:[],guestStorageKey:null});
  const courseUnavailableClaim=await call(route,{'x-fixture-identity':jwt,Cookie:cookie,'x-fixture-course-state':'revoked'},'{}');
  assert.equal(courseUnavailableClaim.status,200);assert.deepEqual((await courseUnavailableClaim.json() as any).claimedJobIds,['claim-worker']);
  assert.equal((await call('/api/jobs/claim-worker',{Cookie:cookie})).status,403,'a Lab member claim removes anonymous guest authority');
  const headers={'x-fixture-identity':jwt,Cookie:cookie};
  const claimed=await call(route,headers,'{}');assert.equal(claimed.status,200,await claimed.clone().text());
  assert.deepEqual(await claimed.json(),{claimedJobIds:['claim-worker'],guestStorageKey:`jobs:${guest}`});
  assert.equal((await call('/api/jobs/claim-worker',headers)).status,200);
  assert.equal((await call('/api/jobs/claim-worker',{Cookie:cookie})).status,403,'claimed cookie has no anonymous authority');
  const repeated=await call(route,headers,'{}');assert.equal(repeated.status,200);
  assert.deepEqual((await repeated.json() as any).claimedJobIds,['claim-worker']);
  assert.equal((await(await call('/api/account',headers)).json() as any).splitAllowance.remaining,15);
 } finally {await harness.close();}
});
