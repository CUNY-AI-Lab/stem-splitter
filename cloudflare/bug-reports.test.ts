import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import worker, { type WorkerEnv } from './worker.ts';
import { bugReportActor, type BugReportService } from './bug-reports.ts';
import { SqliteD1 } from '../server/d1.ts';
import { SESSION_COOKIE } from './sso.ts';

// Node requires duplex for the streamed Request copies accepted by Workerd.
// Browser acceptance also runs this entrypoint in Workerd without this shim.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } as RequestInit : init);
  }
};
test.after(() => { globalThis.Request = NativeRequest; });

const origin = 'https://stem-splitter.ailab-452.workers.dev';
const issuer = await createTestIdentityIssuer();
const token = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice, name: 'Verified Reporter' });
const session = '11111111-1111-4111-8111-111111111111.' + 's'.repeat(43);
const report = { reportId: '77000000-0000-4000-8000-000000000001', description: 'The split button stayed unavailable after my upload.',
  path: '/classroom.html', expectedActor: await bugReportActor(TEST_SUBJECTS.alice) };
const createdAt = '2026-10-20T12:00:00.000Z';
type Submission = Parameters<BugReportService['submitAuthenticated']>[0];
function fixture() {
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const submissions: Submission[] = [];
  const saved = new Map<string, { input: Submission; createdAt: string }>();
  const state = { jwt: token, identityStatus: 200, admitted: true, loseAcknowledgement: false };
  const env = { AUTH_MODE: 'cail', PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin, RELEASE: 'report-test-20261020',
    DB: db, CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_COURSE_IDS: '',
    IDENTITY: { identities: async (value: string) => value === session && state.identityStatus === 200
      ? { ok: true, appJwt: state.jwt, gatewayJwt: 'unused', workspaceJwt: null }
      : { ok: false, status: state.identityStatus === 200 ? 401 : state.identityStatus } },
    ADMISSION_RESOLVER: { resolveMembership: async () => state.admitted
      ? { ok: true, expiresAt: new Date(Date.now() + 60000).toISOString(), revision: 1, accessRole: 'member', budgetScope: 'person' }
      : { ok: false, code: 'not_admitted', retryable: false } },
    REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    BUG_REPORTS: { submitAuthenticated: async (input: Submission) => {
      submissions.push(input);
      const key = `${input.subject}:${input.reportId}`, previous = saved.get(key);
      if (previous && previous.input.description !== input.description) return { ok: false, code: 'idempotency_conflict', retryable: false };
      if (!previous) saved.set(key, { input, createdAt });
      if (state.loseAcknowledgement) { state.loseAcknowledgement = false; throw new Error('injected lost storage acknowledgement'); }
      return { ok: true, status: 'saved', reportId: input.reportId, createdAt };
    } },
  } as unknown as WorkerEnv;
  const send = (body: unknown = report, headers: Record<string, string> = {}, path = '/api/bug-reports', method = 'POST') =>
    worker.fetch(new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE}=${session}`, 'cf-connecting-ip': '192.0.2.5', ...headers },
      ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: () => {} } as unknown as ExecutionContext);
  return { env, db, state, send, submissions, saved };
}

test('actual Worker verifies the session and forwards only server identity and bounded report context', async () => {
  const f = fixture();
  const response = await f.send(report, { Authorization: 'Bearer never-forward', 'x-cail-identity-jwt': 'forged', 'x-cail-subject': 'forged', 'x-stem-course': 'untrusted-course' });
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /private, no-store/);
  assert.deepEqual(await response.json(), { ok: true, status: 'saved', reportId: report.reportId, createdAt });
  assert.deepEqual(f.submissions, [{ reportId: report.reportId, description: report.description, subject: TEST_SUBJECTS.alice,
    origin, path: '/classroom.html', release: 'report-test-20261020' }]);
  assert.doesNotMatch(JSON.stringify(f.submissions), /never-forward|192\.0\.2\.5|expectedActor|Verified Reporter/);
});

test('report session reveals only an opaque account comparison marker after full authorization', async () => {
  const f = fixture();
  const response = await f.send(undefined, {}, '/api/bug-reports/session', 'GET');
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.deepEqual(await response.json(), { ok: true, expectedActor: report.expectedActor });
  assert.deepEqual(f.submissions, []);
  f.state.admitted = false;
  assert.equal((await f.send(undefined, {}, '/api/bug-reports/session', 'GET')).status, 403);
});

test('missing, ambiguous, expired, revoked and guest-only sessions cannot write reports', async () => {
  const f = fixture();
  for (const cookie of ['', '__Host-stem-guest=unsigned', `${SESSION_COOKIE}=${session}; ${SESSION_COOKIE}=${session}`]) {
    for (const [path, method] of [['/api/bug-reports', 'POST'], ['/api/bug-reports/session', 'GET']]) {
      assert.equal((await f.send(report, { Cookie: cookie, 'x-cail-identity-jwt': token }, path, method)).status, 401);
    }
  }
  for (const status of [401, 403, 503]) {
    f.state.identityStatus = status;
    assert.equal((await f.send()).status, status);
  }
  assert.equal(f.submissions.length, 0);
});

test('a Doorway response still requires cryptographic app JWT verification and current local access', async () => {
  const f = fixture();
  for (const jwt of ['forged', await issuer.mintIdentityJwt({ audience: 'cail:gateway' }),
    await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', expiresInSeconds: -120 }),
    await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', issuer: 'https://foreign.example' })]) {
    f.state.jwt = jwt; assert.equal((await f.send()).status, 401);
  }
  f.state.jwt = token; f.state.admitted = false;
  assert.equal((await f.send()).status, 403);
  f.state.admitted = true;
  await f.db.prepare('INSERT OR REPLACE INTO app_users (subject,role,disabled) VALUES (?, ?, ?)').bind(TEST_SUBJECTS.alice, 'student', 1).run();
  assert.equal((await f.send()).status, 403);
  assert.equal(f.submissions.length, 0);
});

test('account changes reject the old draft before calling Admission', async () => {
  const f = fixture();
  f.state.jwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.bob });
  const response = await f.send();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, code: 'account_changed', retryable: false });
  assert.equal(f.submissions.length, 0);
});

test('exact origins, methods, content type, body size and allowed fields are enforced before RPC', async () => {
  const f = fixture();
  for (const headers of [{ Origin: '' }, { Origin: 'null' }, { Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.send(report, headers)).status, 403);
  }
  assert.equal((await f.send(report, {}, '/api/bug-reports', 'GET')).status, 405);
  assert.equal((await f.send(report, {}, '/api/bug-reports/session', 'POST')).status, 405);
  assert.equal((await f.send(report, {}, '/api/bug-reports/session?private=discard', 'GET')).status, 400);
  assert.equal((await f.send(report, { Origin: 'https://foreign.example' }, '/api/bug-reports/session', 'GET')).status, 403);
  assert.equal((await f.send(report, {}, '/api/bug-reports?private=discard')).status, 400);
  assert.equal((await f.send(report, { 'Content-Type': 'text/plain' })).status, 400);
  for (const data of [null, [], { ...report, email: 'untrusted@example.edu' }, { ...report, subject: TEST_SUBJECTS.bob },
    { ...report, release: 'spoof' }, { ...report, createdAt }, { ...report, attachment: 'private' },
    { ...report, reportId: 'bad' }, { ...report, expectedActor: 'bad' }, { ...report, description: 'short' },
    { ...report, description: 'a'.repeat(4001) }, { ...report, description: 'null\u0000byte in report' },
    { ...report, description: '𝄞'.repeat(8500) }]) assert.equal((await f.send(data)).status, 400);
  for (const path of ['/classroom.html?course=private', '/?job=private', '/account.html#private', '/api/jobs/private', 'https://foreign.example', '/%2fprivate']) {
    assert.equal((await f.send({ ...report, path })).status, 400);
  }
  assert.equal(f.submissions.length, 0);
});

test('description normalization is shared with Admission and markup remains plain text', async () => {
  const f = fixture();
  const description = '  The button\r\n<img src=x onerror=alert(1)>\tdid not open.\r  ';
  assert.equal((await f.send({ ...report, description })).status, 200);
  assert.equal(f.submissions[0].description, 'The button\n<img src=x onerror=alert(1)> did not open.');
});

test('missing configuration, malformed release, missing trusted IP and ingress limits fail closed', async () => {
  for (const change of [{ BUG_REPORTS: undefined }, { REQUEST_LIMIT: undefined }, { RELEASE: undefined }, { RELEASE: 'bad release' },
    { CAIL_IDENTITY_JWKS: '{}' }, { AUTH_MODE: 'class-code' }]) {
    const f = fixture(); Object.assign(f.env, change);
    assert.equal((await f.send()).status, 503); assert.equal(f.submissions.length, 0);
  }
  const f = fixture();
  assert.equal((await f.send(report, { 'cf-connecting-ip': '' })).status, 503);
  f.env.REQUEST_LIMIT = { limit: async () => ({ success: false }) };
  const limited = await f.send(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await f.send(undefined, {}, '/api/bug-reports/session', 'GET')).status, 429);
  assert.equal(f.submissions.length, 0);
});

test('lost acknowledgement recovers the same durable report and original context with no second record', async () => {
  const f = fixture(); f.state.loseAcknowledgement = true;
  assert.deepEqual(await (await f.send()).json(), { ok: false, code: 'unavailable', retryable: true });
  assert.equal(f.saved.size, 1);
  f.env.RELEASE = 'new-release';
  assert.deepEqual(await (await f.send()).json(), { ok: true, status: 'saved', reportId: report.reportId, createdAt });
  assert.equal(f.saved.size, 1);
  assert.equal([...f.saved.values()][0].input.release, 'report-test-20261020');
  assert.equal((await f.send({ ...report, description: 'Changed content cannot reuse the report reference.' })).status, 409);
});

test('malformed RPC replies remain retryable using the same report and do not expose private fields', async () => {
  const f = fixture();
  for (const result of [{ ok: true, status: 'saved', reportId: crypto.randomUUID(), createdAt },
    { ok: true, status: 'saved', reportId: report.reportId, createdAt: 'not-a-time' }, { ok: true, status: 'accepted' }]) {
    f.env.BUG_REPORTS = { submitAuthenticated: async () => result } as BugReportService;
    assert.deepEqual(await (await f.send()).json(), { ok: false, code: 'unavailable', retryable: true });
  }
  f.env.BUG_REPORTS = { submitAuthenticated: async () => ({ ok: false, code: 'rate_limited', retryable: true, retryAfterSeconds: 60, private: 'never-return' }) };
  const response = await f.send(); assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: 'rate_limited', retryable: true, retryAfterSeconds: 60 });
});
