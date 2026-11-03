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

function encode(expression: string) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    `aevalsrc=${expression}:s=44100:d=8`, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'],
  { maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

test('workerd: failed experimental Auto quality ends the operation without selecting another model', { timeout: 90000 }, async () => {
  const issuer = await createTestIdentityIssuer();
  const tokens = await Promise.all([TEST_SUBJECTS.alice, TEST_SUBJECTS.bob].map(subject =>
    issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject })));
  const names = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
  const suspect = Object.fromEntries(names.map((name, i) => [name,
    encode(`0.001*sin(2*PI*${200 + i * 100}*t)+0.7*sin(2*PI*1000*t)*between(t\\,6.8\\,6.85)`)]));
  const healthy = { vocals: encode('0.12*sin(2*PI*440*t)'), instrumental: encode('0.18*sin(2*PI*220*t)') };
  const starts: Array<{ model: string; stem?: string }> = [];
  const network = setupServer(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const body = await request.json() as { input: { model: string; stem?: string } };
      starts.push(body.input);
      assert.equal(starts.length, 1, 'a quality failure must never start another model');
      return HttpResponse.json({ id: `auto-quality-${starts.length}`, status: 'starting' });
    }),
    http.get('https://api.replicate.com/v1/predictions/:id', ({ params }) => {
      const fallback = params.id === 'auto-quality-2';
      return HttpResponse.json({ id: params.id, status: 'succeeded', output: Object.fromEntries(
        (fallback ? ['vocals', 'instrumental'] : names).map(name => [name,
          `https://quality.replicate.delivery/${fallback ? 'healthy' : 'suspect'}/${name}.mp3`])) });
    }),
    http.get('https://quality.replicate.delivery/:kind/:name.mp3', ({ params }) => new HttpResponse(
      params.kind === 'healthy' ? healthy[params.name as keyof typeof healthy] : suspect[String(params.name)],
      { headers: { 'content-type': 'audio/mpeg' } })),
  );
  network.listen({ onUnhandledRequest: 'error' });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, ADAPTIVE_FOUR_ENABLED: 'true',
      CAIL_COURSE_IDS: 'unconfigured-quality-fixture', TEST_QUEUE: 'true' },
    secrets: { REPLICATE_API_TOKEN: 'fixture-only', REPLICATE_MODEL_VERSION: 'fixture-pin', WEBHOOK_SECRET: 'fixture-webhook' } }] });
  try {
    await server.listen();
    const worker = server.getWorker('stem-preview-contract-test');
    const fixture = { 'x-fixture': 'local-only' };
    const sql = async (statements: string[]) => {
      const response = await worker.fetch('/__fixture/schema', { method: 'POST', headers: fixture, body: JSON.stringify(statements) });
      assert.equal(response.status, 200, await response.clone().text());
    };
    await sql(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
    const call = (path: string, who = 0, init: RequestInit = {}) => worker.fetch(path, { ...init, headers: {
      'x-fixture-identity': tokens[who], 'x-stem-course': 'personal', Origin: 'https://split.test',
      'Content-Type': 'application/json', ...(init.method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}), ...init.headers } });
    const grant = await (await call('/api/uploads', 0, { method: 'POST', body: '{"filename":"quality-check.mp3"}' })).json() as { key: string; uploadUrl: string };
    assert.equal((await call(new URL(grant.uploadUrl, 'https://split.test').pathname, 0, {
      method: 'PUT', headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(healthy.instrumental.length) }, body: healthy.instrumental })).status, 204);
    const response = await call('/api/jobs', 0, { method: 'POST', body: JSON.stringify({ key: grant.key, filename: 'quality-check.mp3', model: 'auto' }) });
    assert.equal(response.status, 202, await response.clone().text());
    const created = await response.json() as { id: string };
    let job: { id: string; status: string; model: string; adaptiveOutput: string; stems: Array<{ name: string; url: string }> } | undefined;
    for (let i = 0; i < 50; i++) {
      await sql([`UPDATE app_operations SET not_before=0 WHERE id='${created.id}'`]);
      job = await (await call(`/api/jobs/${created.id}`)).json() as typeof job;
      await worker.fetch('/__fixture/adaptive-queue', { headers: fixture });
      if (job?.status === 'done' || job?.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(job?.status, 'failed', JSON.stringify(job));
    assert.equal(job!.model, 'htdemucs_6s');
    assert.deepEqual(starts.map(input => ({ model: input.model, stem: input.stem })), [
      { model: 'htdemucs_6s', stem: undefined },
    ]);
    assert.deepEqual(job!.stems, []);
    assert.equal((await call(`/api/jobs/${created.id}`, 1)).status, 404);
    const operations = await (await worker.fetch('/__fixture/operations', { headers: fixture })).json() as Array<{ id: string; state: string }>;
    assert.equal(operations.length, 1);
    assert.equal(operations[0].id, created.id);
    assert.equal(operations[0].state, 'failed');
  } finally {
    await server.close();
    network.close();
  }
});
