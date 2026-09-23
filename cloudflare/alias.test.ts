import { test } from 'node:test';
import assert from 'node:assert/strict';
import alias from './alias.ts';
import worker from './worker.ts';

test('alias preserves URL, identity, origin, body and streaming responses', async () => {
  const request = new Request('https://stem-splitter.ailab-452.workers.dev/api/jobs/song/chat', {
    method: 'POST', headers: { Origin: 'https://stem-splitter.ailab-452.workers.dev', 'x-cail-identity-jwt': 'fixture-only' },
    body: '{"messages":[]}',
  });
  const response = new Response('data: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  const result = await alias.fetch(request, { STEM_APP: { fetch: async (forwarded) => {
    assert.equal(forwarded, request);
    assert.equal(await forwarded.text(), '{"messages":[]}');
    return response;
  } } });
  assert.equal(result, response);
  assert.match(await result.text(), /"done"/);
});

test('alias preserves denied responses and fails closed without exposing exceptions', async () => {
  const request = new Request('https://stem-splitter.ailab-452.workers.dev/api/account');
  assert.equal((await alias.fetch(request, { STEM_APP: { fetch: async () => new Response('Denied', { status: 401 }) } })).status, 401);
  const failure = await alias.fetch(request, { STEM_APP: { fetch: async () => { throw new Error('private provider detail'); } } });
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('Cache-Control'), 'no-store');
  assert.doesNotMatch(await failure.text(), /private provider detail/);
});

test('health identifies guide configuration without exposing credentials', async () => {
  const env = { DB: { prepare: () => ({ first: async () => ({ ready: 1 }) }) },
    GATEWAY: { fetch: async () => new Response() }, GATEWAY_MODEL: 'glm-5.2', OPENROUTER_API_KEY: 'fixture-only' };
  const health = await worker.fetch(new Request('https://preview.test/healthz'), env, {});
  const body = await health.json();
  assert.deepEqual(body.listeningGuide, { configured: true, fallbackConfigured: false, transport: 'cail-gateway' });
  assert.doesNotMatch(JSON.stringify(body), /fixture-only|fixture\/model/);
  const unset = await worker.fetch(new Request('https://preview.test/healthz'), { ...env, GATEWAY: undefined }, {});
  assert.equal((await unset.json()).listeningGuide.configured, false);
});
