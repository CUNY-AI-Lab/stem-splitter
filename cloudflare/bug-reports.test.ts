import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleBugReport, type BugReportService } from './bug-reports.ts';
const origin = 'https://stem-splitter.ailab-452.workers.dev';
const contract = JSON.parse(readFileSync(new URL('./bug-report-v1.json', import.meta.url), 'utf8'));
const { reportId, name, email, description } = contract.input;
const report = { reportId, name, email, description };
const request = (data: unknown = report, headers: Record<string, string> = {}) => new Request(`${origin}/api/bug-reports`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.5', ...headers }, body: JSON.stringify(data),
});
function fixture() {
  const submissions: Parameters<BugReportService['submit']>[0][] = [];
  const options = { app: 'stem-splitter' as const, origin, limiter: { limit: async () => ({ success: true }) },
    service: { submit: async (input: Parameters<BugReportService['submit']>[0]) => { submissions.push(input); return { ok: true as const, status: 'accepted' as const, reportId: input.reportId }; } } };
  return { options, submissions };
}
test('anonymous form forwards only bounded fields plus server-owned origin/rate metadata', async () => {
  const { options, submissions } = fixture();
  const response = await handleBugReport(request(report, { cookie: 'private-session=never-forward', authorization: 'never-forward', 'x-cail-subject': 'never-forward' }), options);
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.deepEqual(await response.json(), contract.accepted);
  assert.deepEqual(Object.keys(submissions[0]).sort(), ['description', 'email', 'name', 'origin', 'rateDay', 'rateKey', 'reportId']);
  assert.match(submissions[0].rateKey, /^[0-9a-f]{64}$/); assert.equal(submissions[0].rateDay, new Date().toISOString().slice(0, 10));
  assert.equal(submissions[0].origin, origin); assert.equal(JSON.stringify(submissions).includes('192.0.2.5'), false);
  await handleBugReport(request(report, { 'x-forwarded-for': 'spoofed' }), options);
  assert.equal(submissions[0].rateKey, submissions[1].rateKey);
});
test('foreign, missing, null and cross-site origins cannot dispatch', async () => {
  const { options, submissions } = fixture();
  for (const headers of [{ origin: 'https://foreign.example' }, { origin: 'null' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await handleBugReport(request(report, headers), options)).status, 403);
  }
  assert.equal((await handleBugReport(new Request('https://foreign.example/api/bug-reports', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(report) }), options)).status, 403);
  assert.equal(submissions.length, 0);
});
test('only JSON POST is accepted and unavailable configuration fails closed', async () => {
  const { options, submissions } = fixture();
  const method = await handleBugReport(new Request(`${origin}/api/bug-reports`), options);
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await handleBugReport(request(report, { 'content-type': 'text/plain' }), options)).status, 400);
  assert.equal((await handleBugReport(request(), { ...options, service: undefined })).status, 503);
  assert.equal((await handleBugReport(request(), { ...options, limiter: undefined })).status, 503);
  assert.equal((await handleBugReport(request(report, { 'cf-connecting-ip': '' }), options)).status, 503);
  assert.equal(submissions.length, 0);
});
test('header injection, control characters, extra metadata and oversized inputs are rejected before RPC', async () => {
  const { options, submissions } = fixture();
  for (const data of [null, [], { ...report, recipient: 'wrong@example.edu' }, { ...report, rateKey: 'a'.repeat(64) },
    { ...report, name: 'A\r\nBcc: wrong@example.edu' }, { ...report, email: 'a@example.edu\r\nBcc: x@example.edu' },
    { ...report, reportId: 'not-a-uuid' }, { ...report, description: 'short' }, { ...report, description: 'a'.repeat(4001) },
    { ...report, name: 'a'.repeat(121) }, { ...report, description: 'null\u0000byte in report' }]) {
    assert.equal((await handleBugReport(request(data), options)).status, 400);
  }
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(17000))); controller.close(); } });
  assert.equal((await handleBugReport(new Request(`${origin}/api/bug-reports`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.5' }, body: stream, duplex: 'half' } as RequestInit), options)).status, 400);
  assert.equal(submissions.length, 0);
});
test('plain-text markup stays data and ingress rate limits prevent dispatch', async () => {
  const { options, submissions } = fixture();
  const description = '<img src=x onerror=alert(1)> does not open.';
  assert.equal((await handleBugReport(request({ ...report, description }), options)).status, 200);
  assert.equal(submissions[0].description, description);
  const limited = await handleBugReport(request(), { ...options, limiter: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60'); assert.equal(submissions.length, 1);
  assert.equal((await handleBugReport(request(), { ...options, limiter: { limit: async () => { throw new Error('private details'); } } })).status, 503);
});
test('lost RPC acknowledgement and malformed acceptance preserve an uncertain receipt', async () => {
  const { options } = fixture();
  for (const service of [
    { submit: async () => { throw new Error('private delivery details'); } },
    { submit: async () => ({ ok: true, status: 'accepted', reportId: crypto.randomUUID() }) },
    { submit: async () => ({ ok: true, status: 'unrecognized' }) },
  ]) {
    const response = await handleBugReport(request(), { ...options, service: service as BugReportService });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, code: 'delivery_unknown', retryable: false, reportId: report.reportId });
  }
});
test('receiver status and safe retry delay survive without leaking private response fields', async () => {
  const { options } = fixture();
  for (const [code, status] of [['rate_limited', 429], ['unavailable', 503], ['idempotency_conflict', 409]] as const) {
    const response = await handleBugReport(request(), { ...options, service: { submit: async () => ({ ok: false, code, retryable: true, retryAfterSeconds: 60, private: 'must disappear' }) } });
    assert.equal(response.status, status); assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { ok: false, code, retryable: true, retryAfterSeconds: 60, reportId: report.reportId });
  }
});
