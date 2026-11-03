import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../src/env.ts';
import { replicateRequest } from '../src/replicate-http.ts';
import { replicateBackend, cancelReplicatePrediction } from '../src/separation/replicate.ts';
import { startVideoImport, pollYouTubeImport } from '../src/youtube.ts';

const env = { REPLICATE_API_TOKEN: 'fixture-primary-token-1234', REPLICATE_FALLBACK_API_TOKEN: 'fixture-secondary-token-1234',
  REPLICATE_MODEL_VERSION: 'a'.repeat(64), REPLICATE_YT_MODEL: 'fixture/importer', REPLICATE_YT_MODEL_VERSION: 'b'.repeat(64) } as Env;
const request = { jobId: 'same-job', audioUrl: 'https://source.test/recording.mp3', webhookUrl: 'https://split.test/callback', model: 'htdemucs_6s' };
const key = (init?: RequestInit) => new Headers(init?.headers).get('Authorization');

for (const status of [401, 402, 403, 429]) test(`separation uses a second credential after definitive HTTP ${status} while preserving the selected model`, async t => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: any, init?: RequestInit) => {
    calls.push(init!);
    return calls.length === 1 ? new Response('', { status }) : Response.json({ id: 'fallback-prediction' });
  });
  assert.deepEqual(await replicateBackend(env).start(request), { externalId: 'fallback-prediction' });
  assert.equal(calls.length, 2);
  assert.equal(key(calls[0]), `Bearer ${env.REPLICATE_API_TOKEN}`);
  assert.equal(key(calls[1]), `Bearer ${env.REPLICATE_FALLBACK_API_TOKEN}`);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(String(calls[1].body)).input, { audio: request.audioUrl, model: 'htdemucs_6s', output_format: 'mp3', mp3_bitrate: 192 });
});

for (const failure of ['timeout', '500', '503', '400', '422', 'redirect', 'invalid-success']) test(`separation ${failure} preserves one paid create`, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    if (failure === 'invalid-success') return Response.json({ unexpected: true });
    return new Response('', { status: failure === 'redirect' ? 302 : Number(failure) });
  });
  await assert.rejects(replicateBackend(env).start(request));
  assert.equal(calls, 1);
});

test('a rejected alternate ends the credential sequence and preserves cooldown', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: ++calls === 1 ? 402 : 429, headers: { 'Retry-After': '90' } }));
  await assert.rejects(replicateBackend(env).start(request), (error: any) => error.code === 'provider_capacity' && error.notBefore >= Date.now() + 89000);
  assert.equal(calls, 2);
});

test('poll, callback confirmation and cancellation find the same prediction under its fallback credential', async t => {
  let cancelled = false, creates = 0, cancels = 0;
  t.mock.method(globalThis, 'fetch', async (url: any, init?: RequestInit) => {
    if (String(url).endsWith('/predictions')) creates++;
    if (key(init) === `Bearer ${env.REPLICATE_API_TOKEN}`) return new Response('', { status: 404 });
    if (init?.method === 'POST') { cancels++; cancelled = true; }
    return Response.json({ id: 'fallback-prediction', status: cancelled ? 'canceled' : 'processing', version: env.REPLICATE_MODEL_VERSION, webhook: request.webhookUrl });
  });
  const backend = replicateBackend(env);
  assert.deepEqual(await backend.fetchStatus('fallback-prediction'), { status: 'processing' });
  assert.equal(await backend.confirmStart!('fallback-prediction', request.webhookUrl, env.REPLICATE_MODEL_VERSION), true);
  assert.equal(await cancelReplicatePrediction(env, 'fallback-prediction'), true);
  assert.equal(creates, 0); assert.equal(cancels, 1);
});

test('duplicate credentials are tried once and credentials stay on provider origins', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: any, init?: RequestInit) => { calls++; assert.equal(init?.redirect, 'manual'); return new Response('', { status: 401 }); });
  await assert.rejects(replicateBackend({ ...env, REPLICATE_FALLBACK_API_TOKEN: env.REPLICATE_API_TOKEN }).start(request));
  assert.equal(calls, 1);
  await assert.rejects(replicateRequest(env, 'https://untrusted.test/v1/predictions', { method: 'POST' }));
  assert.equal(calls, 1);
});

test('an aborted deadline prevents the second credential request', async t => {
  const controller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; controller.abort(); return new Response('', { status: 429 }); });
  await assert.rejects(replicateRequest(env, 'https://api.replicate.com/v1/predictions', { method: 'POST', signal: controller.signal }));
  assert.equal(calls, 1);
});

test('durable video import shares credential fallback and preserves its input and webhook', async t => {
  const bodies: string[] = []; let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url: any, init?: RequestInit) => {
    if (init?.method === 'POST') {
      bodies.push(String(init.body));
      return key(init) === `Bearer ${env.REPLICATE_API_TOKEN}` ? new Response('', { status: 402 }) : Response.json({ id: 'fallback-import', status: 'starting' });
    }
    reads++;
    return key(init) === `Bearer ${env.REPLICATE_API_TOKEN}` ? new Response('', { status: 404 }) : Response.json({ id: 'fallback-import', status: 'processing' });
  });
  assert.equal(await startVideoImport('https://vimeo.com/1234567', env, request.webhookUrl), 'fallback-import');
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(await pollYouTubeImport('fallback-import', env), null); assert.equal(reads, 2);
});
