import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeEnvironment, intakePauseResponse } from './intake-pause.ts';
import worker from './worker.ts';
import alias from './alias.ts';
import { createTestHarness } from 'wrangler';
import { fileURLToPath } from 'node:url';

const paused = { INTAKE_PAUSED: 'true' };
const origins = ['https://stem-splitter.ailab-452.workers.dev', 'https://cail-stem-splitter-preview.ailab-452.workers.dev'];

test('Workerd maintenance blocks starts before an application schema exists and preserves health and static assets', async () => {
  const server = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { INTAKE_PAUSED: 'true' },
  }] });
  try {
    await server.listen();
    const runtime = server.getWorker('stem-preview-contract-test');
    for (const [method, path] of [
      ['POST', '/api/jobs'], ['POST', '/api/uploads'], ['PUT', '/api/local-uploads/pending.wav'],
      ['POST', '/api/jobs/existing/chat'], ['POST', '/api/jobs/existing/guide'],
    ]) {
      const response = await runtime.fetch(path, { method, body: '{}' });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { code: string }).code, 'intake_paused');
    }
    const health = await runtime.fetch('/healthz');
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { intakePaused: boolean; courseAccess: unknown };
    assert.equal(healthBody.intakePaused, true);
    assert.equal(healthBody.courseAccess, null);
    assert.equal((await runtime.fetch('/app.js')).status, 200);
  } finally {
    await server.close();
  }
});

test('maintenance rejects new compute and uploads through both entry paths before identity or storage', async () => {
  let downstreamCalls = 0;
  const forbidden = new Proxy({}, { get() { downstreamCalls++; throw new Error('must not touch existing data'); } });
  const env = { ...paused, DB: forbidden, AUDIO: forbidden, IDENTITY: forbidden, PREVIEW_IDENTITY: forbidden };
  const starts = [
    ['POST', '/api/jobs'], ['POST', '/api/jobs/'], ['POST', '/api/uploads'],
    ['PUT', '/api/local-uploads/new.wav'], ['POST', '/api/remix/archive-audio'],
    ['POST', '/api/jobs/owned-song/chat'], ['POST', '/api/jobs/owned-song/guide'],
    ['POST', '/api/jobs/encoded%2Fname/chat'], ['POST', '/api/teacher/jobs/owned-song/isolations'],
  ];
  for (const origin of origins) for (const [method, path] of starts) {
    const request = new Request(origin + path, { method, headers: { Origin: origin }, body: '{}' });
    const response = origin === origins[0]
      ? await alias.fetch(request, { STEM_APP: { fetch: (forwarded: Request) => worker.fetch(forwarded, env as never, {} as never) } } as never)
      : await worker.fetch(request, env as never, {} as never);
    assert.equal(response.status, 503, `${method} ${origin}${path}`);
    assert.equal((await response.json() as any).code, 'intake_paused');
    assert.equal(response.headers.get('Retry-After'), '120');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  assert.equal(downstreamCalls, 0);
});

test('maintenance preserves reads, session transitions, notes, cancellation and signed provider callbacks', () => {
  for (const [method, path] of [
    ['GET', '/'], ['GET', '/healthz'], ['GET', '/api/jobs'],
    ['GET', '/api/jobs/owned-song'], ['GET', '/api/shared-jobs/song/stems/0'],
    ['GET', '/api/files/stems/song/vocals.mp3'], ['GET', '/auth/login'],
    ['GET', '/auth/callback'], ['POST', '/auth/logout'],
    ['POST', '/api/jobs/song/cancel'], ['POST', '/api/webhooks/separation'],
    ['POST', '/api/jobs/song/annotations'], ['PUT', '/api/jobs/song/annotations/note'],
    ['POST', '/api/bug-reports'], ['GET', '/api/jobs/song/listening-conversation'],
    ['OPTIONS', '/api/jobs'],
  ]) assert.equal(intakePauseResponse(new Request(origins[0] + path, { method }), paused), null, `${method} ${path}`);
});

test('pause flag propagates to queued-start control without mutating bindings or disabling recovery', () => {
  const DB = {}, AUDIO = {};
  const env = { ...paused, DB, AUDIO, SPLIT_STARTS_DISABLED: 'false' };
  const requestEnv = intakeEnvironment(env);
  assert.equal(requestEnv.SPLIT_STARTS_DISABLED, 'true');
  assert.equal(requestEnv.DB, DB); assert.equal(requestEnv.AUDIO, AUDIO);
  assert.equal(env.SPLIT_STARTS_DISABLED, 'false');
  assert.equal(intakeEnvironment(requestEnv).SPLIT_STARTS_DISABLED, 'true');
  for (const unpaused of [{}, { INTAKE_PAUSED: 'false' }, { SPLIT_STARTS_DISABLED: 'true' }]) {
    assert.equal(intakeEnvironment(unpaused), unpaused);
    assert.equal(intakePauseResponse(new Request(origins[0] + '/api/jobs', { method: 'POST' }), unpaused), null);
  }
});

test('health exposes the pause state while static playback assets remain available', async () => {
  const env = { ...paused, DB: { prepare: () => ({ first: async () => ({ ready: 1 }) }) },
    AUTH_MODE: 'cail', ASSETS: { fetch: async () => new Response('existing playback UI') } };
  const ctx = { waitUntil: (promise: Promise<unknown>) => promise.catch(() => undefined) };
  const health = await worker.fetch(new Request(origins[0] + '/healthz'), env as never, ctx as never);
  assert.equal(health.status, 200); assert.equal((await health.json() as any).intakePaused, true);
  const script = await worker.fetch(new Request(origins[0] + '/app.js'), env as never, ctx as never);
  assert.equal(script.status, 200); assert.equal(await script.text(), 'existing playback UI');
});

test('Doorway course readiness follows the classroom pause independently of the intake pause', async () => {
  const DB = { prepare: (sql: string) => ({ first: async () => sql.includes('sqlite_master') ? { present: 2 } : { ready: 1 } }) };
  for (const classroom of [undefined, 'true', 'false']) {
    const response = await worker.fetch(new Request(origins[0] + '/healthz'), {
      DB, AUTH_MODE: 'cail', CAIL_CLASSROOM_ENABLED: classroom,
    } as never, {} as never);
    const body = await response.json() as { courseAccess: unknown; intakePaused: boolean };
    assert.equal(body.intakePaused, false);
    assert.deepEqual(body.courseAccess, classroom === 'false' ? null : { contract: 'stem-course-v1' });
  }
});
