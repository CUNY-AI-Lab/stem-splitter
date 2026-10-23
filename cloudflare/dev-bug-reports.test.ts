import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBugReport, handleGuestBugReport, bugReportActor } from './dev-bug-reports.ts';

const origin = 'https://dev.test';
const report = { reportId: '77000000-0000-4000-8000-000000000001', description: 'Playback stopped after changing the selected stem.', path: '/classroom.html' };
const request = (path: string, data: unknown, source = origin) => new Request(origin + path, { method: 'POST', headers: { origin: source, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.5' }, body: JSON.stringify(data) });
const saved = (id: string) => ({ ok: true as const, status: 'saved' as const, reportId: id, createdAt: '2026-10-22T12:00:00.000Z' });

test('preserved dev reporting uses verified account names and requires the same actor', async () => {
  const calls: unknown[] = [];
  const options = { origin, subject: 'cail-' + 'a'.repeat(32), preferredName: 'Fixture Teacher', release: 'dev-test', limiter: { limit: async () => ({ success: true }) }, service: { submitAuthenticated: async (data: any) => { calls.push(data); return saved(data.reportId); } } };
  const actor = await bugReportActor(options.subject);
  const session = await handleBugReport(new Request(origin + '/api/bug-reports/session', { headers: { 'cf-connecting-ip': '192.0.2.5' } }), options);
  assert.equal(session.status, 200);
  assert.equal((await session.json() as any).preferredName, 'Fixture Teacher');
  assert.equal((await handleBugReport(request('/api/bug-reports', { ...report, expectedActor: '0'.repeat(64) }), options)).status, 409);
  assert.equal(calls.length, 0);
  assert.equal((await handleBugReport(request('/api/bug-reports', { ...report, expectedActor: actor }), options)).status, 200);
  assert.equal((calls[0] as any).preferredName, 'Fixture Teacher');
});

test('dev guest reports validate contact and origin before delivery', async () => {
  const calls: any[] = [];
  const options = { origin, release: 'dev-test', rateKey: 'a'.repeat(64), limiter: { limit: async () => ({ success: true }) }, service: { submitAuthenticated: async () => saved(report.reportId), submitGuest: async (data: any) => { calls.push(data); return saved(data.reportId); } } };
  const data = { ...report, firstName: 'Sample', lastName: 'Student', email: 'sample@example.edu' };
  assert.equal((await handleGuestBugReport(request('/api/bug-reports/guest', data, 'https://other.test'), options)).status, 403);
  assert.equal((await handleGuestBugReport(request('/api/bug-reports/guest', { ...data, email: 'bad' }), options)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await handleGuestBugReport(request('/api/bug-reports/guest', data), options)).status, 200);
  assert.deepEqual(calls[0].contact, { firstName: 'Sample', lastName: 'Student', email: 'sample@example.edu' });
  assert.doesNotMatch(JSON.stringify(calls), /192\.0\.2\.5/);
});
