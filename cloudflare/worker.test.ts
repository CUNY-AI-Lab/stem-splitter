import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  const wav = await readFile(new URL('../tests/fixtures/audio/source.wav', import.meta.url));
  const mp3 = await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  let providerStarts = 0;
  let statusFetches = 0;
  const network = setupServer(
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
    const schema = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    const setup = await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only', 'Content-Type': 'application/json' }, body: JSON.stringify(schema) });
    assert.equal(setup.status, 200);
    const call = (path: string, who = 0, init: RequestInit = {}) => server.fetch(path, {
      ...init, headers: { 'x-cail-identity-jwt': tokens[who], Origin: 'https://split.test', 'Content-Type': 'application/json', ...init.headers },
    });
    const anonymous = await server.fetch('/api/account');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(anonymous.headers.get('cache-control')!, /no-store/);
    assert.equal((await call('/api/account')).status, 200);
    assert.equal((await call('/api/account', 1)).status, 200);
    assert.equal((await call('/api/admin/users')).status, 403);
    assert.equal((await call('/api/teacher/login', 0, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await call('/api/uploads', 0, { method: 'POST', headers: { Origin: 'https://attacker.test' }, body: '{"filename":"source.wav"}' })).status, 403);
    const native = server.getWorker('stem-preview-contract-test');
    const canonicalGrant = await native.fetch('https://stem-splitter.ailab-452.workers.dev/api/uploads', {
      method: 'POST', headers: { 'x-cail-identity-jwt': tokens[0], Origin: 'https://stem-splitter.ailab-452.workers.dev', 'Content-Type': 'application/json' },
      body: '{"filename":"alias.wav"}',
    });
    assert.equal(canonicalGrant.status, 200, await canonicalGrant.clone().text());
    assert.match((await canonicalGrant.json()).uploadUrl, /^\/api\/local-uploads\//);
    const spoofedOrigin = await native.fetch('https://attacker.test/api/uploads', {
      method: 'POST', headers: { 'x-cail-identity-jwt': tokens[0], Origin: 'https://attacker.test', 'Content-Type': 'application/json' },
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
    const jobRequest = { method: 'POST', body: JSON.stringify({ key: grant.key, filename: 'source.wav', model: 'htdemucs_ft' }) };
    assert.equal((await call('/api/jobs', 1, jobRequest)).status, 404);
    const createdResponse = await call('/api/jobs', 0, jobRequest);
    assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
    const created = await createdResponse.json();
    assert.equal(providerStarts, 1);
    assert.equal((await call(`/api/jobs/${created.id}`, 1)).status, 404);
    assert.equal((await call(`/api/files/%73tems/${created.id}/vocals.mp3`, 1)).status, 400);
    const callback = await server.fetch(`/api/webhooks/separation?job=${created.id}&token=contract-webhook`, { method: 'POST', body: '{"output":{"vocals":"https://attacker.test/private"}}' });
    assert.equal(callback.status, 200);
    assert.equal(statusFetches, 1);
    const job = await (await call(`/api/jobs/${created.id}`)).json();
    assert.equal(job.status, 'done');
    assert.equal(job.stems.length, 4);
    assert.equal((await call(`/api/files/stems/${created.id}/vocals.mp3`, 1)).status, 404);
    const stem = await call(`/api/files/stems/${created.id}/vocals.mp3`);
    assert.equal(stem.status, 200);
    assert.deepEqual(Buffer.from(await stem.arrayBuffer()), mp3);
    assert.match(stem.headers.get('cache-control')!, /no-store/);
    const attempts = await Promise.all(Array.from({ length: 20 }, () => call('/api/jobs', 0, { method: 'POST', body: '{}' })));
    assert.equal(attempts.filter((response) => response.status === 400).length, 4);
    assert.equal(attempts.filter((response) => response.status === 429).length, 16);
    assert.equal(providerStarts, 1); // Concurrent invalid/replayed requests cannot overspend the daily reservation.
    const users = await (await call('/api/admin/users', 2)).json();
    const alice = users.users.find((user: { subject: string }) => user.subject === subjects[0]);
    const grantRole = { method: 'PUT', body: JSON.stringify({ role: 'instructor', expiresAt: new Date(Date.now() + 60000).toISOString(), disabled: false, revision: alice.revision }) };
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, grantRole)).status, 200);
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, grantRole)).status, 409);
    assert.equal((await call('/api/teacher/prompt')).status, 200);
    assert.equal((await call(`/api/admin/users/${subjects[0]}`, 2, { method: 'PUT', body: JSON.stringify({ role: 'student', disabled: true, revision: alice.revision + 1 }) })).status, 200);
    assert.equal((await call(`/api/files/stems/${created.id}/vocals.mp3`)).status, 403);
    assert.equal(providerStarts, 1);
    const denied = await Promise.all(Array.from({ length: 40 }, () => server.fetch('/api/account')));
    assert.ok(denied.every((response) => response.status === 401));
  } finally { await server.close(); network.close(); }
});
