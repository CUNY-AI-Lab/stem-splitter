import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import { beginAttempt, finishAttempt, readOperation, reserveOperation } from '../src/reliability/ledger.ts';
import { cancelOperation, claimNext, recoverExpired, transition } from '../src/reliability/queue.ts';
import { hasAutoQualityFallback, operationWebhook, recoverCallback, reconcileSplit } from '../src/reliability/splits.ts';
import { splitAllowance } from '../src/daily-allowance.ts';
import { runReliableJobs, resumeAdaptiveOutput } from '../src/index.ts';
import { AutoOutputQualityError } from '../src/separation/quality.ts';
import { membershipFixture, courseFixture } from './course-fixture.ts';
import { STEM_COURSE_ID } from '../src/classroom/contract.ts';

const quality = new AutoOutputQualityError({ durationSeconds: 174, windowStartSeconds: 173.6,
  windowSeconds: .15, qualifyingSources: 5, minimumEnergyFraction: .75 });
const names = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
async function setup(t: { after(f: () => void): void }, guest = false, courseId: string | null = null) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-auto-retry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = new SqliteD1(':memory:');
  local.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = local as unknown as D1Database;
  const subject = guest ? 'guest-' + 'a'.repeat(64) : 'cail-' + 'd'.repeat(32);
  const now = Date.now(), id = crypto.randomUUID(), key = `uploads/${id}/source.mp3`;
  if (guest) await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
    .bind(subject, now, now + 86400000, new Date(now).toISOString().slice(0, 10)).run();
  else await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const env = { DB: db, AUDIO: new FsR2Bucket(join(directory, 'audio')), AUTH_MODE: 'cail', LOCAL_HOSTING: 'true',
    SEPARATION_BACKEND: 'replicate', PUBLIC_BASE_URL: 'https://split.test', WEBHOOK_SECRET: 'fixture-only',
    REPLICATE_API_TOKEN: 'fixture-only', REPLICATE_MODEL_VERSION: 'same-provider-pin', guestRuntimeReady: true,
    validateStemAudio: async () => true,
    ADMISSION_RESOLVER: { resolveMembership: async () => membershipFixture(),
      resolveCourseAccessV2: ({ subject, classId }: { subject: string; classId: string }) => courseFixture(subject, classId) },
  } as unknown as Env;
  const bytes = readFileSync(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  await env.AUDIO.put(key, bytes);
  const course = courseId ? await courseFixture(subject, courseId) : null;
  const reserved = await reserveOperation(db, { subject, quotaClass: guest ? 'guest' : 'member', courseId,
    kind: 'split', key: crypto.randomUUID(), fingerprint: 'original-auto-input', phase: 'split', jobId: id,
    request: { sourceType: 'upload', key, filename: 'Synthetic Auto recording', model: 'htdemucs_6s', auto: false, adaptive: 'auto' },
    statements: operation => [
      db.prepare(`INSERT INTO jobs(id,filename,source_key,source_hash,status,model,routing_request)
        SELECT id,'Synthetic Auto recording',?,?,'queued','htdemucs_6s','adaptive:auto' FROM app_operations WHERE id=?`)
        .bind(key, 'a'.repeat(64), operation),
      db.prepare(`INSERT INTO ${guest ? 'guest_job_owners' : 'job_owners'}(job_id,subject)
        SELECT id,subject FROM app_operations WHERE id=?`).bind(operation),
      ...(course ? [db.prepare(`INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version)
        SELECT id,?,?,?,'course-work-v1' FROM app_operations WHERE id=?`)
        .bind(courseId, course.memberId, subject, operation)] : []),
    ],
  });
  const claimed = (await claimNext(db, 'split'))!;
  await transition(db, claimed, 'starting');
  const attempt = await beginAttempt(db, claimed, 'replicate', 'same-provider-pin');
  await finishAttempt(db, attempt, 'accepted', { externalId: 'six-prediction', usage: { cost_usd: .25 } });
  await transition(db, claimed, 'processing', { providerId: 'six-prediction' });
  const lease = `ingesting:${now}:first-output`;
  await db.prepare("UPDATE jobs SET status='ingesting',error=?,external_id='six-prediction' WHERE id=?").bind(lease, id).run();
  return { db, env, subject, id, key, bytes, attempt, lease, original: reserved.operation,
    operation: (await readOperation(db, id))!, allowance: () => splitAllowance(db, subject, new Date(), guest ? 'guest' : 'member') };
}

// Reproduce an operation persisted by the retired release. Application code
// can complete these existing attempts but can no longer create this transition.
async function legacyAlternate(f: Awaited<ReturnType<typeof setup>>) {
  const input = JSON.parse(f.operation.request_json);
  const request = JSON.stringify({ ...input, model: 'vocals_instrumental', auto: false,
    qualityFallback: { version: 1, reason: quality.reason, details: quality.details } });
  await f.db.batch([
    f.db.prepare("UPDATE app_operations SET request_json=?,state='queued',provider_id=NULL,fence=fence+1,lease_owner=NULL,lease_until=0 WHERE id=?").bind(request, f.id),
    f.db.prepare("UPDATE operation_attempts SET outcome='quality_rejected' WHERE id=?").bind(f.attempt),
    f.db.prepare("UPDATE jobs SET status='queued',model='vocals_instrumental',external_id=NULL,error=NULL WHERE id=?").bind(f.id),
  ]);
}

test('a crash before the alternate POST requeues without adopting the retired prediction', async t => {
  const f = await setup(t); await legacyAlternate(f);
  const claimed = (await claimNext(f.db, 'split'))!;
  await recoverExpired(f.db, claimed.lease_until + 1);
  const recovered = (await readOperation(f.db, f.id))!;
  assert.equal(recovered.state, 'queued'); assert.equal(recovered.provider_id, null);
  assert.equal(hasAutoQualityFallback(recovered), true);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>()).n, 1);
});

test('an uncertain alternate POST is recovered once and cannot adopt an old same-version callback', async t => {
  const f = await setup(t); await legacyAlternate(f);
  let posts = 0, reads = 0;
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++; const body = JSON.parse(String(init.body));
      assert.equal(body.input.model, 'htdemucs_ft'); assert.equal(body.input.stem, 'vocals');
      throw new Error('Synthetic response loss after alternate start');
    }
    if (String(url).startsWith('https://api.replicate.com/')) {
      reads++; return Response.json({ id: 'two-prediction', version: 'same-provider-pin',
        webhook: operationWebhook(f.env, f.id, 'split'), status: 'succeeded',
        output: { vocals: 'https://fixture.replicate.delivery/vocals.mp3', no_vocals: 'https://fixture.replicate.delivery/instrumental.mp3' } });
    }
    return new Response(f.bytes);
  });
  await runReliableJobs(f.env); await runReliableJobs(f.env);
  let current = (await readOperation(f.db, f.id))!;
  assert.equal(posts, 1); assert.equal(current.state, 'reconciling'); assert.equal(current.provider_id, null);
  await recoverExpired(f.db); current = (await readOperation(f.db, f.id))!;
  await recoverCallback(f.env, current, 'six-prediction'); assert.equal(reads, 0);
  assert.equal((await readOperation(f.db, f.id))!.provider_id, null);
  await recoverCallback(f.env, current, 'two-prediction');
  await runReliableJobs(f.env); await runReliableJobs(f.env);
  const job = await f.db.prepare('SELECT status,model,stems FROM jobs WHERE id=?').bind(f.id).first<any>();
  assert.equal(job.status, 'done'); assert.equal(job.model, 'vocals_instrumental');
  assert.deepEqual(JSON.parse(job.stems).map((s: any) => s.name), ['vocals', 'instrumental']);
  assert.equal(posts, 1); assert.equal((await f.allowance()).completed, 1); assert.equal((await f.allowance()).inProgress, 0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM operation_events WHERE operation_id=? AND quota_effect='charged'").bind(f.id).first<any>()).n, 1);
});

test('cancelling the queued alternate releases the original reservation without another start', async t => {
  const f = await setup(t); await legacyAlternate(f);
  await cancelOperation(f.db, f.id, f.subject);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Cancelled alternate must not start'));
  await runReliableJobs(f.env);
  assert.equal((await readOperation(f.db, f.id))!.state, 'cancelled');
  assert.equal((await f.allowance()).completed, 0); assert.equal((await f.allowance()).inProgress, 0);
});

for (const scope of ['guest', 'personal-member', 'course-member'] as const) test(`alternate paid start rechecks current ${scope} access`, async t => {
  const f = await setup(t, scope === 'guest', scope === 'course-member' ? STEM_COURSE_ID : null);
  await legacyAlternate(f);
  if (scope === 'guest') await f.db.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(), f.subject).run();
  else if (scope === 'personal-member') t.mock.method(f.env.ADMISSION_RESOLVER!, 'resolveMembership', async () => ({ ok: false, code: 'not_admitted' }));
  else t.mock.method(f.env.ADMISSION_RESOLVER!, 'resolveCourseAccessV2', async () => ({ ok: false, code: 'revoked', retryable: false }));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Access must be current before the alternate paid start'));
  await runReliableJobs(f.env);
  const operation = (await readOperation(f.db, f.id))!;
  assert.equal(operation.state, 'failed'); assert.equal(operation.error_code, 'access_unavailable');
  assert.equal(operation.course_id, f.operation.course_id);
  assert.equal((await f.allowance()).completed, 0); assert.equal((await f.allowance()).inProgress, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM operation_attempts WHERE operation_id=?').bind(f.id).first<any>()).n, 1);
});

test('cancellation after an accepted alternate verifies that prediction and skips publishing audio', async t => {
  const f = await setup(t); await legacyAlternate(f);
  let posts = 0, downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return Response.json({ id: 'two-prediction', status: 'starting' }); }
    if (String(url).includes('/predictions/')) return Response.json({ id: 'two-prediction', status: 'succeeded' });
    downloads++; return new Response(f.bytes);
  });
  await runReliableJobs(f.env); await cancelOperation(f.db, f.id, f.subject); await runReliableJobs(f.env);
  assert.equal(posts, 1); assert.equal(downloads, 0);
  assert.equal((await readOperation(f.db, f.id))!.state, 'cancelled'); assert.equal((await f.allowance()).completed, 0);
});

test('delayed original callback and create acknowledgement cannot revive the retired attempt', async t => {
  const f = await setup(t);
  await f.db.prepare("UPDATE operation_attempts SET outcome='uncertain',external_id=NULL WHERE id=?").bind(f.attempt).run();
  await f.db.prepare("UPDATE app_operations SET state='reconciling',provider_id=NULL,lease_owner=NULL,lease_until=0 WHERE id=?").bind(f.id).run();
  await f.db.prepare("UPDATE jobs SET status='processing',error=NULL WHERE id=?").bind(f.id).run();
  const unknown = (await readOperation(f.db, f.id))!;
  let release!: () => void, entered!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    if (++reads === 1) { entered(); await gate; }
    return Response.json({ id: 'six-prediction', version: 'same-provider-pin', webhook: operationWebhook(f.env, f.id, 'split'), status: 'succeeded', output: {} });
  });
  const delayed = recoverCallback(f.env, unknown, 'six-prediction'); await began;
  await recoverCallback(f.env, unknown, 'six-prediction');
  await reconcileSplit(f.env, (await readOperation(f.db, f.id))!, async (_env, _id, _result, current) => {
    await f.db.prepare("UPDATE jobs SET status='ingesting',error=? WHERE id=?").bind(f.lease, f.id).run();
    await legacyAlternate(f);
  });
  const claimed = (await claimNext(f.db, 'split'))!;
  await transition(f.db, claimed, 'starting'); const second = await beginAttempt(f.db, claimed, 'replicate', 'same-provider-pin');
  await finishAttempt(f.db, second, 'uncertain'); await recoverExpired(f.db, claimed.lease_until + 1);
  release(); await delayed;
  await finishAttempt(f.db, f.attempt, 'accepted', { externalId: 'six-prediction' });
  await recoverExpired(f.db, claimed.lease_until + 2);
  const current = (await readOperation(f.db, f.id))!;
  assert.equal(current.provider_id, null); assert.equal(current.state, 'reconciling');
  assert.equal((await f.db.prepare('SELECT outcome FROM operation_attempts WHERE id=?').bind(f.attempt).first<any>()).outcome, 'quality_rejected');
  assert.equal((await f.db.prepare('SELECT outcome FROM operation_attempts WHERE id=?').bind(second).first<any>()).outcome, 'uncertain');
});

test('failed quality check releases allowance and staged audio without another provider start', async t => {
  const f = await setup(t);
  await f.db.prepare("UPDATE jobs SET status='processing',error=NULL WHERE id=?").bind(f.id).run();
  await f.db.prepare('UPDATE app_operations SET lease_owner=NULL,lease_until=0 WHERE id=?').bind(f.id).run();
  f.env.composeStemAudio = async () => { throw quality; };
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => String(url).startsWith('https://api.replicate.com/')
    ? Response.json({ id: 'six-prediction', status: 'succeeded', output: Object.fromEntries(names.map(name => [name, `https://fixture.replicate.delivery/${name}.mp3`])) })
    : new Response(f.bytes));
  assert.equal(await resumeAdaptiveOutput(f.env, f.id), true);
  assert.equal((await readOperation(f.db, f.id))!.state, 'failed');
  assert.equal((await f.db.prepare('SELECT model FROM jobs WHERE id=?').bind(f.id).first<any>()).model, 'htdemucs_6s');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>()).n, 1);
  assert.deepEqual((await f.env.AUDIO.list()).objects.map(object => object.key), [f.key]);
  assert.equal((await f.allowance()).completed, 0);
});
