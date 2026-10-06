import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('workerd: signed identities, write-once audio, full split ingestion, ownership, roles, revocation and CSP', async () => {
  const issuer = await createTestIdentityIssuer();
  const subjects = [TEST_SUBJECTS.alice, TEST_SUBJECTS.bob, TEST_SUBJECTS.carol];
  const tokens = await Promise.all(subjects.map((subject) => issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject })));
  const gatewayTokens = await Promise.all(subjects.map((subject) => issuer.mintIdentityJwt({ audience: 'cail:gateway', subject })));
  const wav = await readFile(new URL('../tests/fixtures/audio/source.wav', import.meta.url));
  const mp3 = await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  let providerStarts = 0;
  let statusFetches = 0;
  const inlineAudio=Buffer.alloc(12*1024*1024);inlineAudio.set([0,0,0,24,102,116,121,112,77,52,65,32]);
  const network = setupServer(
    http.get('https://api.replicate.com/v1/predictions/inline-memory-fixture',()=>HttpResponse.json({id:'inline-memory-fixture',status:'succeeded',output:{audio:'data:audio/mp4;base64,'+inlineAudio.toString('base64'),title:'Memory fixture',duration:600}})),
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const body = await request.json();
      assert.equal(body.version, 'contract-pin');
      assert.match(body.input.audio, /^https:\/\/split\.test\/api\/local-sources\/uploads\//);
      providerStarts++;
      return HttpResponse.json({ id: 'contract-prediction', status: 'starting' });
    }),
    http.get('https://api.replicate.com/v1/predictions/contract-prediction', () => {
      statusFetches++;
      return HttpResponse.json({ id: 'contract-prediction', status: 'succeeded', output: Object.fromEntries(['vocals', 'drums', 'bass', 'other'].map((stem) => [stem, `https://fixtures.replicate.delivery/${stem}.mp3`])) });
    }),
    http.get('https://fixtures.replicate.delivery/:stem.mp3', () => new HttpResponse(mp3, { headers: { 'Content-Type': 'audio/mpeg' } })),
  );
  network.listen({ onUnhandledRequest: 'error' });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: subjects[2], CANONICAL_BASE_URL: 'https://stem-splitter.ailab-452.workers.dev' },
    secrets: { REPLICATE_API_TOKEN: 'contract-fixture', REPLICATE_MODEL_VERSION: 'contract-pin', WEBHOOK_SECRET: 'contract-webhook' },
  }] });
  try {
    await server.listen();
    // Direct Worker dispatch avoids the development reload proxy; the actual
    // production entrypoint, private bindings, D1 and R2 still run in Workerd.
    const worker = server.getWorker('stem-preview-contract-test');
    const schema = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    const setup = await worker.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only', 'Content-Type': 'application/json' }, body: JSON.stringify(schema) });
    assert.equal(setup.status, 200);
    // Real locally bundled Wasm runs in Workerd, with no inference/media service.
    for(const valid of [true,false]) {
      const audio=valid?mp3:Buffer.alloc(417*8,255);
      if(!valid)for(let i=0;i<8;i++)audio.set([255,251,144,0],417*i);
      const checked=await worker.fetch('/__fixture/validate-audio',{method:'POST',headers:{'x-fixture':'local-only'},body:audio});
      assert.deepEqual(await checked.json(),{valid});
    }

    const silence=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','2','-c:a','libmp3lame','-b:a','128k','-f','mp3','pipe:1'],{timeout:10000,maxBuffer:1024*1024});
    assert.equal(silence.status,0,String(silence.stderr));
    assert.deepEqual(await(await worker.fetch('/__fixture/validate-audio',{method:'POST',headers:{'x-fixture':'local-only'},body:silence.stdout})).json(),{valid:true});

    // A long high-bitrate stem and an ordinary-size inline import overlap in
    // the same Workerd isolate. This is a local bounded-input check, not a
    // claimed production CPU or peak-RSS measurement.
    const longAudio=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','600','-c:a','libmp3lame','-b:a','320k','-f','mp3','pipe:1'],{timeout:30000,maxBuffer:25*1024*1024});
    assert.equal(longAudio.status,0,String(longAudio.stderr));assert.ok(longAudio.stdout.length>22*1024*1024);
    const largeChecks=await Promise.all([
      worker.fetch('/__fixture/validate-audio',{method:'POST',headers:{'x-fixture':'local-only'},body:longAudio.stdout}).then(r=>r.json()),
      worker.fetch('/__fixture/inline-import',{headers:{'x-fixture':'local-only'}}).then(r=>r.json()),
    ]);
    assert.deepEqual(largeChecks,[{valid:true},{bytes:12*1024*1024}]);

    const call = async (path: string, who = 0, init: RequestInit = {}) => {
      const response = await worker.fetch(path, {
        ...init, headers: { 'x-fixture-identity': tokens[who], 'x-fixture-gateway-identity': gatewayTokens[who], Origin: 'https://split.test', 'Content-Type': 'application/json', ...(init.method==='POST'?{'Idempotency-Key':crypto.randomUUID()}:{}), ...init.headers },
      });
      const body = await response.arrayBuffer();
      assert.notEqual(response.status, 500, new TextDecoder().decode(body));
      return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
    };
    const anonymous = await worker.fetch('/api/account');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(anonymous.headers.get('cache-control')!, /no-store/);
    assert.equal((await call('/api/account')).status, 200);
    assert.equal((await call('/api/account', 1)).status, 200);
    assert.equal((await call('/api/remix/archive-audio', 0, { method: 'POST', body: '{"archiveId":"example","archiveFile":"track.mp3"}' })).status, 404);
    assert.equal((await call('/api/admin/users')).status, 403);
    assert.equal((await call('/api/teacher/login', 0, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await call('/api/uploads', 0, { method: 'POST', headers: { Origin: 'https://attacker.test' }, body: '{"filename":"source.wav"}' })).status, 403);
    const native = server.getWorker('stem-preview-contract-test');
    const canonicalGrant = await native.fetch('https://stem-splitter.ailab-452.workers.dev/api/uploads', {
      method: 'POST', headers: { 'x-fixture-identity': tokens[0], Origin: 'https://stem-splitter.ailab-452.workers.dev', 'Content-Type': 'application/json' },
      body: '{"filename":"alias.wav"}',
    });
    assert.equal(canonicalGrant.status, 200, await canonicalGrant.clone().text());
    assert.match((await canonicalGrant.json()).uploadUrl, /^\/api\/local-uploads\//);
    const spoofedOrigin = await native.fetch('https://attacker.test/api/uploads', {
      method: 'POST', headers: { 'x-fixture-identity': tokens[0], Origin: 'https://attacker.test', 'Content-Type': 'application/json' },
      body: '{"filename":"blocked.wav"}',
    });
    assert.equal(spoofedOrigin.status, 403);
    const grantResponse = await call('/api/uploads', 0, { method: 'POST', body: '{"filename":"source.wav"}' });
    assert.equal(grantResponse.status, 200, await grantResponse.clone().text());
    const grant = await grantResponse.json();
    const uploadPath = new URL(grant.uploadUrl, 'https://split.test').pathname;
    const upload = { method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) }, body: wav };
    assert.equal((await call(uploadPath, 1, upload)).status, 404);
    assert.equal((await call(uploadPath, 0, upload)).status, 204);
    assert.equal((await call(uploadPath, 0, upload)).status, 409);
    const jobRequest = { method: 'POST', headers:{'Idempotency-Key':'workerd-split-request-0001'}, body: JSON.stringify({ key: grant.key, filename: 'source.wav', model: 'htdemucs_ft' }) };
    assert.equal((await call('/api/jobs', 1, jobRequest)).status, 404);
    const createdResponse = await call('/api/jobs', 0, jobRequest);
    assert.equal(createdResponse.status, 202, await createdResponse.clone().text());
    const created = await createdResponse.json();
    assert.equal(created.savedToAccount, true);
    const listed = await (await call('/api/jobs')).json();
    assert.deepEqual(listed.jobs.map((row: { id: string }) => row.id), [created.id]);
    assert.equal(listed.nextCursor, null);
    assert.equal(JSON.stringify(listed).includes('source_key'), false);
    assert.deepEqual((await (await call(`/api/jobs?subject=${subjects[0]}`, 1)).json()).jobs, []);
    assert.deepEqual((await (await call('/api/jobs', 2)).json()).jobs, []); // Admin rack is still personal.
    assert.equal((await worker.fetch('/api/jobs')).status, 401);
    assert.equal((await call('/api/jobs?cursor=bad')).status, 400);
    for(let i=0;i<20&&providerStarts===0;i++){await call(`/api/jobs/${created.id}`);await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(providerStarts, 1,JSON.stringify(await(await worker.fetch('/__fixture/operations',{headers:{'x-fixture':'local-only'}})).json()));
    assert.equal((await call(`/api/jobs/${created.id}`, 1)).status, 404);
    assert.equal((await call(`/api/files/%73tems/${created.id}/vocals.mp3`, 1)).status, 400);
    const callback = await worker.fetch(`/api/webhooks/separation?job=${created.id}&phase=split&token=contract-webhook`, { method: 'POST', body: '{"output":{"vocals":"https://attacker.test/private"}}' });
    assert.equal(callback.status, 200);
    assert.ok(statusFetches>=1);
    const job = await (await call(`/api/jobs/${created.id}`)).json();
    assert.equal(job.status, 'done');
    assert.equal(job.stems.length, 4);
    const usageEvent={id:'workerd-usage-event-0001',type:'seek',jobId:created.id,positionBucket:4};
    assert.equal((await call('/api/usage-events',1,{method:'POST',body:JSON.stringify({events:[usageEvent]})})).status,404);
    assert.equal((await call('/api/usage-events',0,{method:'POST',body:JSON.stringify({events:[{...usageEvent,text:'must not be logged'}]})})).status,400);
    for(let n=0;n<2;n++)assert.equal((await call('/api/usage-events',0,{method:'POST',body:JSON.stringify({events:[usageEvent]})})).status,200);
    assert.equal((await call('/api/admin/usage-events')).status,403);
    const usage=await(await call('/api/admin/usage-events',2)).json();
    assert.equal(usage.uses.find((row:any)=>row.event_type==='seek').count,1);
    assert.equal(JSON.stringify(usage).includes(subjects[0]),false);

    const sharePath = `/api/jobs/${created.id}/share`;
    const publicPath = `/api/shared-jobs/${created.id}`;
    assert.equal((await worker.fetch(publicPath)).status, 404);
    assert.equal((await call(sharePath, 1, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await call(sharePath, 2, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await worker.fetch(sharePath, { method: 'POST' })).status, 403); // origin checked before session
    assert.equal((await call(sharePath, 0, { method: 'POST', body: '{}' })).status, 200);
    const shared = await (await worker.fetch(publicPath)).json();
    assert.equal(shared.readOnlyShared, true);
    assert.deepEqual(Object.keys(shared).sort(), ['annotations', 'filename', 'guide', 'id', 'labels', 'model', 'readOnlyShared', 'status', 'stems'].sort());
    assert.deepEqual(shared.annotations, []);
    assert.equal(shared.guide, null);
    const publicAudio = await worker.fetch(shared.stems[0].url);
    assert.equal(publicAudio.status, 200);
    assert.deepEqual(Buffer.from(await publicAudio.arrayBuffer()), mp3);
    const publicHead = await worker.fetch(shared.stems[0].url + '?download', { method: 'HEAD' });
    assert.equal(publicHead.status, 200);
    assert.equal(publicHead.headers.get('content-length'), String(mp3.length));
    assert.equal(publicHead.headers.get('accept-ranges'), 'bytes');
    assert.match(publicHead.headers.get('content-disposition') || '', /^attachment;/);
    assert.equal(await publicHead.text(), '');
    assert.equal((await worker.fetch(`/api/files/stems/${created.id}/vocals.mp3`, { method: 'HEAD' })).status, 401);
    assert.equal((await worker.fetch(`${publicPath}/stems/999`)).status, 404);
    assert.equal((await worker.fetch(`/api/jobs/${created.id}`)).status, 401);
    assert.equal((await worker.fetch(publicPath, { method: 'PUT', body: '{}' })).status, 403);
    assert.equal((await call(sharePath, 1, { method: 'DELETE' })).status, 404);
    assert.equal((await call(sharePath, 0, { method: 'DELETE' })).status, 200);
    assert.equal((await worker.fetch(publicPath)).status, 404);
    assert.equal((await worker.fetch(shared.stems[0].url)).status, 404);
    assert.equal((await worker.fetch(shared.stems[0].url, { method: 'HEAD' })).status, 404);
    assert.equal((await call(sharePath, 0, { method: 'POST', body: '{}' })).status, 200);
    const conversationPath = `/api/jobs/${created.id}/listening-conversation`;
    const emptyConversation = await (await call(conversationPath)).json();
    assert.deepEqual(emptyConversation.entries, []);
    assert.equal(emptyConversation.revision, 0);
    assert.match(emptyConversation.expiresAt, /^\d{4}-\d\d-\d\d /);
    const transcript = [{ kind: 'you', text: 'What does the bass do here?' }, { kind: 'coach', text: 'Listen beneath the vocal.' }];
    const savedConversation = await call(conversationPath, 0, { method: 'PUT', body: JSON.stringify({ entries: transcript, revision: 0 }) });
    assert.equal(savedConversation.status, 200, await savedConversation.clone().text());
    assert.equal((await savedConversation.json()).revision, 1);
    assert.deepEqual((await (await call(conversationPath)).json()).entries, transcript);
    assert.equal((await call(conversationPath, 1)).status, 404); // private to the owning CUNY identity
    assert.equal((await call(conversationPath, 2)).status, 404); // admin does not inherit a student's private history
    assert.equal((await worker.fetch(conversationPath)).status, 401);
    for (const who of [1, 2]) {
      assert.equal((await call(conversationPath, who, { method: 'PUT', body: JSON.stringify({ entries: transcript, revision: 1 }) })).status, 404);
    }
    const nextConversation = await call(conversationPath, 0, { method: 'PUT', body: JSON.stringify({ entries: [...transcript, { kind: 'you', text: 'And the drums?' }], revision: 1 }) });
    const updatedConversation = await nextConversation.json();
    assert.equal(updatedConversation.revision, 2);
    assert.equal(updatedConversation.expiresAt, emptyConversation.expiresAt);
    assert.equal((await call(conversationPath, 0, { method: 'PUT', body: JSON.stringify({ entries: transcript, revision: 1 }) })).status, 409);
    assert.equal((await call(conversationPath, 1, { method: 'DELETE' })).status, 404);
    assert.equal((await call(conversationPath, 0, { method: 'DELETE' })).status, 200);
    assert.equal((await (await call(conversationPath)).json()).revision, 3);
    assert.equal((await call(conversationPath, 0, { method: 'PUT', body: JSON.stringify({ entries: transcript, revision: 1 }) })).status, 409);
    assert.equal((await call(conversationPath, 0, { method: 'PUT', body: JSON.stringify({ entries: [{ kind: 'system', text: 'no' }], revision: 0 }) })).status, 400);
    assert.equal((await call(conversationPath, 0, { method: 'PUT', body: JSON.stringify({ entries: [], revision: 8 }) })).status, 409);
    assert.equal((await call(`/api/files/stems/${created.id}/vocals.mp3`, 1)).status, 404);
    const stem = await call(job.stems[0].url);
    assert.equal(stem.status, 200);
    assert.deepEqual(Buffer.from(await stem.arrayBuffer()), mp3);
    assert.match(stem.headers.get('cache-control')!, /no-store/);
    const stats = async () => (await (await worker.fetch('/__fixture/gateway-stats', { headers: { 'x-fixture': 'local-only' } })).json()).gatewayCalls;
    const guide = await call(`/api/jobs/${created.id}/guide`, 0, { method: 'POST', body: '{}' });
    assert.match(await guide.text(), /"type":"done"/); assert.equal(await stats(), 1);
    const cached = await call(`/api/jobs/${created.id}/guide`, 0, { method: 'POST', body: '{}' });
    assert.match(await cached.text(), /"cached":true/); assert.equal(await stats(), 1);
    for (const mode of ['quota', 'trailing-error']) {
      const response = await call(`/api/jobs/${created.id}/chat`, 0, { method: 'POST', headers: { 'x-fixture-gateway-mode': mode }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic listening question' }] }) });
      const text = await response.text();
      assert.match(text, /"type":"error"/); assert.doesNotMatch(text, /"type":"done"/);
      assert.match(text, /quota_exceeded/); assert.match(text, /01900000-0000-7000-8000-000000000001/); assert.doesNotMatch(text, /private fixture/);
    }
    assert.equal(await stats(), 3);
    const quota = await (await call('/api/model-quota')).json();
    assert.equal(quota.quota.remaining_percent, 90);
    assert.equal(await stats(), 3);
    const invalid = await Promise.all(Array.from({length:20},()=>call('/api/jobs',0,{method:'POST',body:'{}'})));
    assert.equal(invalid.every(response=>response.status===400),true);
    const allowance=(await(await call('/api/account')).json()).splitAllowance;
    assert.equal(allowance.limit,15);assert.equal(allowance.completed,1);assert.equal(allowance.inProgress,0);assert.equal(allowance.remaining,14);
    const chatCount=(await(await call('/api/account')).json()).chatAllowance;
    assert.equal(chatCount.limit,50);assert.equal(chatCount.completed,1);assert.equal(chatCount.inProgress,0);assert.equal(chatCount.remaining,49);
    const replay=await call('/api/jobs',0,jobRequest);assert.equal(replay.status,200);assert.equal((await replay.json()).id,created.id);
    assert.equal(providerStarts,1);
    const users = await (await call('/api/admin/users', 2)).json();
    const alice = users.users.find((user: { subject: string }) => user.subject === subjects[0]);
    const grantRole = { method: 'PUT', body: JSON.stringify({ role: 'instructor', expiresAt: new Date(Date.now() + 60000).toISOString(), disabled: false, revision: alice.revision }) };
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, grantRole)).status, 200);
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, grantRole)).status, 409);
    assert.equal((await call('/api/teacher/folders')).status, 200);
    const permanentBody = { role: 'instructor', expiresAt: null, disabled: false, revision: alice.revision + 1 };
    for (const expiresAt of [undefined, '', 'invalid', false, 0, new Date(Date.now() - 1000).toISOString()]) {
      assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, { method: 'PUT', body: JSON.stringify({ ...permanentBody, expiresAt }) })).status, 400);
    }
    const permanentGrant = { method: 'PUT', body: JSON.stringify(permanentBody) };
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 0, permanentGrant)).status, 403);
    assert.equal((await call(`/api/admin/users/${subjects[2]}`, 2, permanentGrant)).status, 400);
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, permanentGrant)).status, 200);
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, permanentGrant)).status, 409);
    const updated = (await (await call('/api/admin/users', 2)).json()).users.find((user: { subject: string }) => user.subject === subjects[0]);
    assert.equal(updated.role, 'instructor');
    assert.equal(updated.role_expires_at, null);
    assert.equal(updated.revision, alice.revision + 2);
    assert.equal((await (await call('/api/account')).json()).account.role, 'instructor');
    assert.equal((await call('/api/teacher/folders')).status, 200);
    assert.equal((await call('/api/admin/users')).status, 403);
    assert.equal((await call('/api/teacher/folders', 1)).status, 403);
    // The existing immutable trigger records the explicit permanent grant.
    const audit = await worker.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify([
      'CREATE TABLE audit_check (ok INTEGER CHECK (ok = 1))',
      `INSERT INTO audit_check SELECT COUNT(*) FROM app_user_events WHERE subject = '${subjects[0]}' AND actor = '${subjects[2]}' AND role = 'instructor' AND role_expires_at IS NULL AND revision = ${alice.revision + 2}`,
    ]) });
    assert.equal(audit.status, 200);
    const expiryFixture = await worker.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only', 'Content-Type': 'application/json' }, body: JSON.stringify([
      `UPDATE jobs SET created_at = datetime('now', '-91 days') WHERE id = '${created.id}'`,
      `UPDATE listening_conversations SET expires_at = datetime('now', '-1 day') WHERE job_id = '${created.id}' AND subject = '${subjects[0]}'`,
    ]) });
    assert.equal(expiryFixture.status, 200);
    assert.equal((await worker.fetch(publicPath)).status, 404);
    assert.equal((await worker.fetch(shared.stems[0].url)).status, 404);
    assert.equal((await call(conversationPath)).status, 404);
    assert.equal((await call(conversationPath, 0, { method: 'PUT', body: JSON.stringify({ entries: transcript, revision: 3 }) })).status, 404);
    assert.equal((await call(conversationPath, 0, { method: 'DELETE' })).status, 404);
    const purged = await worker.fetch('/__fixture/purge-conversations', { headers: { 'x-fixture': 'local-only' } });
    assert.equal((await purged.json()).deleted, 1);
    assert.equal((await call(conversationPath)).status, 404); // fixed 90-day lifetime, not extended by chat
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, { method: 'PUT', body: JSON.stringify({ role: 'student', disabled: true, revision: alice.revision + 2 }) })).status, 200);
    assert.equal((await call(`/api/files/stems/${created.id}/vocals.mp3`)).status, 403);
    assert.equal((await call('/api/jobs')).status, 403);
    assert.equal(providerStarts, 1);
    const denied = await Promise.all(Array.from({ length: 40 }, () => worker.fetch('/api/account')));
    assert.ok(denied.every((response) => response.status === 401));
  } catch (error) { server.debug(); throw error; }
  finally { await server.close(); network.close(); }
});
