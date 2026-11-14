import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { TOOLS_ORIGIN, toolsLoginPath, toolsRequest } from './tools.ts';
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
  const result = await toolsRequest(request('/stem-splitter/', { headers: { 'x-cail-gateway-identity-jwt': other } }), env(async () => { called = true; throw new Error('must not resolve'); }));
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
    const result = await toolsRequest(request('/stem-splitter/', { headers: supplied }), env(async () => { called = true; throw new Error('must not resolve'); }));
    assert.ok(result instanceof Response); assert.equal(result.status, 401); assert.equal(called, false);
  });
}

for (const membership of [
  { ok: false, code: 'not_admitted' },
  { ok: true, accessRole: 'member', budgetScope: 'person', revision: 1, expiresAt: new Date(Date.now() - 60000).toISOString() },
]) {
  test(`private Tools ingress refuses ${membership.ok ? 'expired' : 'revoked'} Admission even for static pages`, async () => {
    const result = await toolsRequest(request('/stem-splitter/'), env(async () => membership as never));
    assert.ok(result instanceof Response); assert.equal(result.status, 403);
  });
}

test('private Tools ingress does not turn service failure into anonymous access', async () => {
  const result = await toolsRequest(request('/stem-splitter/'), env(async () => { throw new Error('private service details'); }));
  assert.ok(result instanceof Response); assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /private service details/);
});

test('browser mount paths preserve external destinations and the shared logout route', async () => {
  const source = await readFile(new URL('../public/app-path.js', import.meta.url), 'utf8');
  for (const base of ['', '/stem-splitter']) {
    const sent: unknown[] = [];
    const window: Record<string, any> = { fetch: (...args: unknown[]) => { sent.push(args); } };
    runInNewContext(source, { window, URL, document: { currentScript: { src: TOOLS_ORIGIN + base + '/app-path.js' } } });
    assert.equal(window.StemPath('/api/account'), base + '/api/account');
    assert.equal(window.StemPath(base + '/api/account'), base + '/api/account');
    assert.equal(window.StemPath('/auth/logout'), '/auth/logout');
    assert.equal(window.StemPath('https://archive.org/source.mp3'), 'https://archive.org/source.mp3');
    assert.equal(window.StemPath('blob:local-audio'), 'blob:local-audio');
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
