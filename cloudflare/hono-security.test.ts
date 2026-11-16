import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono-cloudflare';
import { authorizeCailRequest } from '../src/identity.ts';
import type { Env } from '../src/env.ts';

test('encoded line terminators cannot bypass API identity middleware for private routes', async () => {
  const env = {
    AUTH_MODE: 'cail',
    PUBLIC_BASE_URL: 'https://split.test',
    verifyCailIdentity: async () => null,
    ADMISSION_RESOLVER: {},
  } as unknown as Env;
  const worker = new Hono();
  worker.use('/api/*', async (c, next) => {
    const denied = await authorizeCailRequest(c.req.raw, env);
    if (denied) return denied;
    await next();
  });
  // Match the production wildcard route shape. Reaching it without the API
  // identity middleware would expose this synthetic private audio marker.
  worker.get('/api/files/*', c => c.text('PRIVATE-SPLIT-SECRET'));
  worker.notFound(c => c.json({ error: 'Not found' }, 404));

  const request = (path: string) => worker.fetch(new Request(`https://split.test${path}`), env);
  const ordinaryPrivateRequest = await request('/api/files/stems/private/vocals.mp3');
  assert.equal(ordinaryPrivateRequest.status, 401);
  assert.doesNotMatch(await ordinaryPrivateRequest.text(), /PRIVATE-SPLIT-SECRET/);

  // The path guard rejects encoded bytes before Hono route matching. These
  // include CR/LF and both Unicode line separators covered by RegExpRouter.
  for (const path of [
    '/api/files/stems/private%0A/vocals.mp3',
    '/api/files/stems/private%0D/vocals.mp3',
    '/api/files/stems/private%E2%80%A8/vocals.mp3',
    '/api/files/stems/private%E2%80%A9/vocals.mp3',
  ]) {
    const response = await request(path);
    assert.equal(response.status, 400, `${path} should reach the identity path guard`);
    assert.doesNotMatch(await response.text(), /PRIVATE-SPLIT-SECRET|private/);
  }
});
