import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedRequest, handleAuth, LOGIN_COOKIE, SESSION_COOKIE, safeNext, type WorkerIdentity, type SsoEnv } from './sso.ts';

const origin = 'https://stem-splitter.ailab-452.workers.dev';
const preview = 'https://cail-stem-splitter-preview.ailab-452.workers.dev';
const code = 'a0000000-0000-4000-8000-000000000001';
const token = code + '.' + 's'.repeat(43);
function fixture() {
  let challenge = '', state = '', used = false, revoked = false, calls = 0;
  const client: WorkerIdentity = {
    async begin(c, s) { challenge = c; state = s; return { url: 'https://tools.ailab.gc.cuny.edu/worker-login?request=' + code }; },
    async redeem(c, verifier) {
      const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
      if (c !== code || expected !== challenge || used) throw new Error('Rejected');
      used = true;
      return { ok: true, token, expiresAt: Date.now() + 60000 };
    },
    async identities(t) { calls++; return t === token && used && !revoked ? { ok: true, appJwt: 'server-app-jwt', gatewayJwt: 'never-forward', workspaceJwt: null } : { ok: false, status: 401 }; },
    async revoke() { revoked = true; return {}; },
  };
  const env: SsoEnv = { PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin, IDENTITY: client, REQUEST_LIMIT: { limit: async () => ({ success: true }) } };
  const request = (path: string, init?: RequestInit) => new Request(origin + path, init);
  return { env, client, request, state: () => state, calls: () => calls };
}
const pair = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(name + '='))!.split(';')[0];

test('CUNY handoff: S256 proof, host-only cookies, clean return, private JWT forwarding and logout', async () => {
  const f = fixture();
  const start = await handleAuth(f.request('/auth/login?next=/teacher.html'), f.env);
  assert.equal(start.status, 303);
  assert.match(start.headers.get('location')!, /^https:\/\/tools\.ailab\.gc\.cuny\.edu\/worker-login/);
  const pending = pair(start, LOGIN_COOKIE);
  assert.match(start.headers.get('set-cookie')!, /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600/);
  const callback = await handleAuth(f.request(`/auth/callback?code=${code}&state=${f.state()}`, { headers: { Cookie: pending } }), f.env);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/teacher.html');
  assert.match(callback.headers.get('cache-control')!, /no-store/);
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  const session = pair(callback, SESSION_COOKIE);
  const internal = await authenticatedRequest(f.request('/api/account', { headers: { Cookie: session + '; unrelated=secret', Authorization: 'Bearer untrusted', 'x-cail-identity-jwt': 'forged', 'x-cail-gateway-identity-jwt': 'forged' } }), f.env);
  assert.ok(internal instanceof Request);
  assert.equal(internal.headers.get('x-cail-identity-jwt'), 'server-app-jwt');
  for (const header of ['cookie', 'authorization', 'x-cail-gateway-identity-jwt']) assert.equal(internal.headers.get(header), null);
  assert.equal((await handleAuth(f.request('/auth/logout', { method: 'POST', headers: { Cookie: session, Origin: origin } }), f.env)).status, 303);
  assert.equal((await authenticatedRequest(f.request('/api/account', { headers: { Cookie: session } }), f.env) as Response).status, 401);
});

test('state/cookie/proof expiry, duplicate parameters, replay and redirect injection fail closed', async () => {
  const f = fixture();
  const start = await handleAuth(f.request('/auth/login?next=//attacker.test'), f.env);
  const pending = pair(start, LOGIN_COOKIE);
  const callback = `/auth/callback?code=${code}&state=${f.state()}`;
  for (const [path, cookie] of [[callback, ''], [callback + '&state=duplicate', pending], [callback.replace(f.state(), 'b'.repeat(43)), pending], [callback, pending + '; ' + pending]]) {
    assert.equal((await handleAuth(f.request(path, { headers: { Cookie: cookie } }), f.env)).status, 401);
  }
  const expired = JSON.parse(decodeURIComponent(pending.slice(pending.indexOf('=') + 1)));
  expired.expiresAt = Date.now() - 1;
  assert.equal((await handleAuth(f.request(callback, { headers: { Cookie: LOGIN_COOKIE + '=' + encodeURIComponent(JSON.stringify(expired)) } }), f.env)).status, 401);
  const result = await handleAuth(f.request(callback, { headers: { Cookie: pending } }), f.env);
  assert.equal(result.headers.get('location'), '/');
  assert.equal((await handleAuth(f.request(callback, { headers: { Cookie: pending } }), f.env)).status, 503);
  for (const value of ['//attacker.test', '/auth/logout', '/%2f%2fattacker.test', '/\\attacker.test', '/api/account', '/?next=//attacker.test']) assert.equal(safeNext(value), '/');
});

test('browser JWTs cannot authenticate; writes and logout reject missing/cross origins before RPC', async () => {
  const f = fixture();
  assert.equal((await authenticatedRequest(f.request('/api/account', { headers: { 'x-cail-identity-jwt': 'even-a-valid-jwt' } }), f.env) as Response).status, 401);
  for (const headers of [{}, { Origin: 'https://attacker.test' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://tools.ailab.gc.cuny.edu' }]) {
    const init = { method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=${token}`, ...headers } };
    assert.equal((await authenticatedRequest(f.request('/api/jobs', init), f.env) as Response).status, 403);
    assert.equal((await handleAuth(f.request('/auth/logout', init), f.env)).status, 403);
  }
  assert.equal(f.calls(), 0);
  assert.equal((await handleAuth(f.request('/auth/logout'), f.env)).status, 405);
  const webhook = await authenticatedRequest(f.request('/api/webhooks/separation?token=capability', { method: 'POST', headers: { Cookie: 'secret', 'x-cail-identity-jwt': 'untrusted' } }), f.env);
  assert.ok(webhook instanceof Request);
  assert.equal(webhook.headers.get('cookie'), null);
  assert.equal(webhook.headers.get('x-cail-identity-jwt'), null);
});

test('preview and canonical origins use separate deployment-pinned capabilities; unknown origins cannot start login', async () => {
  const canonical = fixture(), candidate = fixture();
  const env = { ...canonical.env, PUBLIC_BASE_URL: preview, PREVIEW_IDENTITY: candidate.client };
  await handleAuth(new Request(preview + '/auth/login'), env);
  assert.notEqual(candidate.state(), '');
  assert.equal(canonical.state(), '');
  await handleAuth(new Request(origin + '/auth/login'), env);
  assert.notEqual(canonical.state(), '');
  assert.equal((await handleAuth(new Request('https://attacker.test/auth/login'), env)).status, 403);
  assert.equal((await handleAuth(new Request(preview + '/auth/login'), { ...env, PREVIEW_IDENTITY: undefined })).status, 503);
});

test('revoked membership, receiver errors, missing bindings and malformed grants fail closed', async () => {
  const f = fixture();
  const request = f.request('/api/account', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
  for (const status of [401, 403, 503, 500]) {
    const client = { ...f.client, identities: async () => ({ ok: false as const, status }) };
    assert.equal((await authenticatedRequest(request, { ...f.env, IDENTITY: client }) as Response).status, status === 500 ? 503 : status);
  }
  assert.equal((await authenticatedRequest(request, { ...f.env, IDENTITY: undefined }) as Response).status, 503);
  assert.equal((await authenticatedRequest(request, { ...f.env, IDENTITY: { ...f.client, identities: async () => { throw new Error('private'); } } }) as Response).status, 503);
  const badStart = await handleAuth(f.request('/auth/login'), { ...f.env, IDENTITY: { ...f.client, begin: async () => ({ url: 'https://attacker.test/worker-login' }) } });
  assert.equal(badStart.status, 503);
  assert.equal(badStart.headers.has('set-cookie'), false);
});
