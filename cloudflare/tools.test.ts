import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { TOOLS_ORIGIN, toolsLoginPath, toolsRequest, serveTools } from './tools.ts';
import { SqliteD1 } from '../server/d1.ts';
import type { WorkerEnv } from './worker.ts';

const issuer = await createTestIdentityIssuer();
const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
const gatewayJwt = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.alice });
const headers = { 'x-cail-identity-jwt': appJwt, 'x-cail-gateway-identity-jwt': gatewayJwt };
function env(resolve = async () => ({ ok: true, accessRole: 'member', budgetScope: 'person', revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString() })): WorkerEnv {
  return { CAIL_IDENTITY_JWKS: issuer.jwksJson, ADMISSION_RESOLVER: { resolveMembership: resolve } } as WorkerEnv;
}
const request = (path: string, init?: RequestInit) => new Request(TOOLS_ORIGIN + path, { ...init, headers: { ...headers, ...init?.headers } });

test('private Tools ingress preserves the request body and query while dropping browser credentials', async () => {
  const result = await toolsRequest(request('/stem-splitter/api/uploads?course=demo', {
    method: 'POST', headers: { origin: TOOLS_ORIGIN, cookie: 'private-cookie=never-forward', authorization: 'Bearer never-forward', 'x-cail-subject': 'forged', 'cf-connecting-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.12' }, body: '{"filename":"source.wav"}',
  }), env());
  assert.ok(result instanceof Request);
  assert.equal(result.url, TOOLS_ORIGIN + '/api/uploads?course=demo');
  assert.equal(await result.text(), '{"filename":"source.wav"}');
  assert.equal(result.headers.get('cookie'), null);
  assert.equal(result.headers.get('authorization'), null);
  assert.equal(result.headers.get('x-cail-subject'), null);
  assert.equal(result.headers.get('cf-connecting-ip'), '192.0.2.12');
  assert.equal(result.headers.get('x-forwarded-for'), null);
  assert.equal(result.headers.get('x-cail-identity-jwt'), appJwt);
  assert.equal(result.headers.get('x-cail-gateway-identity-jwt'), gatewayJwt);
});

for (const target of ['https://attacker.test/stem-splitter/', TOOLS_ORIGIN + '/stem-splitter-other/', TOOLS_ORIGIN + '/api/account']) {
  test(`private Tools ingress refuses an unregistered target: ${target}`, async () => {
    const result = await toolsRequest(new Request(target, { headers }), env());
    assert.ok(result instanceof Response); assert.equal(result.status, 404);
  });
}

for (const origin of ['https://attacker.test', 'https://stem-splitter.ailab-452.workers.dev', '']) {
  test(`private Tools ingress refuses a write without the exact Tools origin: ${origin}`, async () => {
    const result = await toolsRequest(request('/stem-splitter/api/uploads', { method: 'POST', headers: { origin }, body: '{}' }), env());
    assert.ok(result instanceof Response); assert.equal(result.status, 403);
  });
}

test('private Tools ingress refuses a mismatched Gateway subject before Admission', async () => {
  const other = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.bob });
  let called = false;
  const result = await toolsRequest(request('/stem-splitter/api/account', { headers: { 'x-cail-gateway-identity-jwt': other } }), env(async () => { called = true; throw new Error('must not resolve'); }));
  assert.ok(result instanceof Response); assert.equal(result.status, 401); assert.equal(called, false);
});

for (const [label, supplied] of [
  ['missing app identity', { ...headers, 'x-cail-identity-jwt': '' }],
  ['missing Gateway identity', { ...headers, 'x-cail-gateway-identity-jwt': '' }],
  ['invalid app signature', { ...headers, 'x-cail-identity-jwt': appJwt.slice(0, -10) + 'AAAAAAAAAA' }],
  ['wrong app audience', { ...headers, 'x-cail-identity-jwt': gatewayJwt }],
  ['wrong Gateway audience', { ...headers, 'x-cail-gateway-identity-jwt': appJwt }],
] as const) {
  test(`private Tools ingress rejects ${label} before Admission`, async () => {
    let called = false;
    const result = await toolsRequest(request('/stem-splitter/api/account', { headers: supplied }), env(async () => { called = true; throw new Error('must not resolve'); }));
    assert.ok(result instanceof Response); assert.equal(result.status, 401); assert.equal(called, false);
  });
}

for (const membership of [
  { ok: false, code: 'not_admitted' },
  { ok: true, accessRole: 'member', budgetScope: 'person', revision: 1, expiresAt: new Date(Date.now() - 60000).toISOString() },
]) {
  test(`private Tools ingress refuses ${membership.ok ? 'expired' : 'revoked'} Admission on protected APIs`, async () => {
    const result = await toolsRequest(request('/stem-splitter/api/account'), env(async () => membership as never));
    assert.ok(result instanceof Response); assert.equal(result.status, 403);
  });
}

test('private Tools ingress does not turn service failure into anonymous access', async () => {
  const result = await toolsRequest(request('/stem-splitter/api/account'), env(async () => { throw new Error('private service details'); }));
  assert.ok(result instanceof Response); assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /private service details/);
});

test('anonymous static reads strip all identity and browser credentials without contacting Admission', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/app.js', '/teacher.html?course=demo', '/docs/getting-started.html']) {
      const result = await toolsRequest(new Request(TOOLS_ORIGIN + '/stem-splitter' + path, {
        method, headers: { cookie: 'never-forward', authorization: 'Bearer never-forward', 'x-cail-identity-jwt': 'forged', 'x-cail-gateway-identity-jwt': 'forged', 'x-cail-subject': 'forged', 'cf-connecting-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.12' },
      }), {} as WorkerEnv);
      assert.ok(result instanceof Request);
      assert.equal(result.url, TOOLS_ORIGIN + path);
      assert.equal(result.method, method);
      for (const header of ['cookie', 'authorization', 'x-cail-identity-jwt', 'x-cail-gateway-identity-jwt', 'x-cail-subject', 'cf-connecting-ip', 'x-forwarded-for']) assert.equal(result.headers.get(header), null);
    }
  }
});

test('non-page writes cannot enter the public static dispatch', async () => {
  for (const path of ['/', '/app.js', '/healthz', '/auth/login']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const result = await toolsRequest(request('/stem-splitter' + path, { method, headers: { origin: TOOLS_ORIGIN } }), env());
      assert.ok(result instanceof Response); assert.equal(result.status, 405);
    }
  }
});

test('anonymous APIs reach the app guest boundary with only scoped cookies and no caller identity', async () => {
  for (const path of ['/api', '/api/runtime', '/api/account', '/api/shared-jobs/fixture', '/api/files/stems/fixture/vocals.mp3']) {
    const result = await toolsRequest(new Request(TOOLS_ORIGIN + '/stem-splitter' + path, { headers: {
      cookie: '__Host-stem-guest=fixture; __Host-stem-transfer=nonce; __Host-cail-session=private; unrelated=private',
      authorization: 'Bearer forged', 'x-cail-subject': 'forged', 'x-forwarded-for': '192.0.2.10',
    } }), env(async () => { throw new Error('anonymous guests must not resolve Admission'); }));
    assert.ok(result instanceof Request);
    assert.equal(result.headers.get('cookie'), '__Host-stem-guest=fixture; __Host-stem-transfer=nonce');
    for (const header of ['authorization', 'x-cail-subject', 'x-cail-identity-jwt', 'x-cail-gateway-identity-jwt']) assert.equal(result.headers.get(header), null);
    assert.equal(result.headers.get('cf-connecting-ip'), '192.0.2.10');
  }
});

test('login requires signed identities and only exact guest auth routes are accepted', async () => {
  for (const path of ['/auth/login?returnTo=%2Fstem-splitter%2F']) {
    const result = await toolsRequest(new Request(TOOLS_ORIGIN + '/stem-splitter' + path), env());
    assert.ok(result instanceof Response); assert.equal(result.status, 401);
  }
  for (const path of ['/auth', '/auth/logout', '/auth/callback', '/auth/guest', '/auth/login/']) {
    const result = await toolsRequest(request('/stem-splitter' + path), env());
    assert.ok(result instanceof Response); assert.equal(result.status, 404);
  }
  for (const [path, method] of [['/auth/guest', 'POST'], ['/auth/guest-transfer/start', 'GET'], ['/auth/guest-transfer/finish', 'POST']]) {
    const result = await toolsRequest(new Request(TOOLS_ORIGIN + '/stem-splitter' + path, { method, headers: { origin: TOOLS_ORIGIN } }), env());
    assert.ok(result instanceof Request);
  }
});

test('browser mount paths preserve external destinations and the shared logout route', async () => {
  const source = await readFile(new URL('../public/app-path.js', import.meta.url), 'utf8');
  for (const base of ['', '/stem-splitter']) {
    const sent: unknown[] = [];
    const window: Record<string, any> = { fetch: (...args: unknown[]) => { sent.push(args); } };
    runInNewContext(source, { window, URL, location: { pathname: base + '/classroom.html', search: '?course=demo&view=students' }, document: { currentScript: { src: TOOLS_ORIGIN + base + '/app-path.js' } } });
    assert.equal(window.StemPath('/api/account'), base + '/api/account');
    assert.equal(window.StemPath(base + '/api/account'), base + '/api/account');
    assert.equal(window.StemPath('/auth/logout'), '/auth/logout');
    assert.equal(window.StemPath('https://archive.org/source.mp3'), 'https://archive.org/source.mp3');
    assert.equal(window.StemPath('blob:local-audio'), 'blob:local-audio');
    assert.equal(window.StemPath('/auth/login'), base ? '/stem-splitter/auth/login?returnTo=%2Fstem-splitter%2Fclassroom.html%3Fcourse%3Ddemo%26view%3Dstudents' : '/auth/login');
    assert.equal(window.StemPath('/auth/login?next=%2Fteacher.html%3Fcourse%3Ddemo'), base ? '/stem-splitter/auth/login?returnTo=%2Fstem-splitter%2Fteacher.html%3Fcourse%3Ddemo' : '/auth/login?next=%2Fteacher.html%3Fcourse%3Ddemo');
    window.StemFetch('/api/account', { method: 'GET' });
    assert.deepEqual(sent[0], [base + '/api/account', { method: 'GET' }]);
  }
});

test('Tools sign-in return paths preserve app pages and query strings without opening redirects or API destinations', () => {
  for (const path of ['/?job=fixture', '/teacher.html?course=demo', '/classroom.html?course=demo&view=students', '/account']) {
    assert.equal(toolsLoginPath(path), '/stem-splitter' + path);
    assert.equal(toolsLoginPath('/stem-splitter' + path), '/stem-splitter' + path);
  }
  for (const path of [null, '//attacker.test/', '/\\attacker.test/', 'https://attacker.test/', '/auth/logout', '/api/account', '/stem-splitter-other/']) {
    assert.equal(toolsLoginPath(path), '/stem-splitter/');
  }
});

test('mounted pages and verified sign-in return contribute privacy-safe server usage', async () => {
  const database = new SqliteD1(':memory:');
  database.applySchema(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (value: Promise<unknown>) => pending.push(value) } as unknown as ExecutionContext;
  const runtime = { ...env(), DB: database, AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://stem-splitter.ailab-452.workers.dev',
    ASSETS: { fetch: async () => new Response('fixture asset', { headers: { 'content-type': 'text/plain' } }) },
  } as unknown as WorkerEnv;
  assert.equal((await serveTools(new Request(TOOLS_ORIGIN + '/stem-splitter/'), runtime, ctx)).status, 200);
  assert.equal((await serveTools(new Request(TOOLS_ORIGIN + '/stem-splitter/app.js'), runtime, ctx)).status, 200);
  assert.equal((await serveTools(new Request(TOOLS_ORIGIN + '/stem-splitter/', { method: 'HEAD' }), runtime, ctx)).status, 200);
  assert.equal((await serveTools(request('/stem-splitter/auth/login?returnTo=%2Fstem-splitter%2F'), runtime, ctx)).status, 303);
  await Promise.all(pending);
  const rows = (await database.prepare('SELECT * FROM usage_events').all()).results;
  assert.deepEqual(rows.map(row => row.event_type).sort(), ['page_response', 'signin_attempt', 'signin_session_reused']);
  assert.ok(rows.every(row => row.actor_class === 'anonymous' && row.source === 'server'));
  for (const secret of [appJwt, gatewayJwt, TEST_SUBJECTS.alice, 'returnTo']) assert.equal(JSON.stringify(rows).includes(secret), false);
});
