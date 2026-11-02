import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal, AppRole } from '../src/identity.ts';
import { authorizeStoredCourseWork } from '../src/classroom/access.ts';
import { submitSplit, drainSplitQueue } from '../src/reliability/splits.ts';
import { readOperation } from '../src/reliability/ledger.ts';
import { claimGuestWork } from '../src/guest/claim.ts';
import app from '../src/index.ts';
import { courseFixture, membershipFixture } from './course-fixture.ts';

const member = `cail-${'a'.repeat(32)}`, guest = `guest-${'b'.repeat(64)}`;
const courseId = 'another-reviewed-course';
async function setup(t: { after: (run: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-personal-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = new SqliteD1(join(directory, 'db'));
  local.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = local as unknown as D1Database;
  await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(member).run();
  const expiresAt = Date.now() + 86400000;
  await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
    .bind(guest, Date.now(), expiresAt, '1970-01-01').run();
  let membership: unknown = membershipFixture(), courseActive = true, courseReads = 0, membershipReads = 0;
  const env = {
    DB: db, AUDIO: new FsR2Bucket(join(directory, 'audio')), AUTH_MODE: 'cail',
    PUBLIC_BASE_URL: 'https://split.test', LOCAL_HOSTING: 'true', SEPARATION_BACKEND: 'replicate',
    REPLICATE_API_TOKEN: 'fixture-only', REPLICATE_MODEL_VERSION: 'fixture-model', WEBHOOK_SECRET: 'fixture-only',
    CAIL_COURSE_IDS: courseId, guestRuntimeReady: true,
    ADMISSION_RESOLVER: {
      resolveMembership: async () => { membershipReads++; if (membership instanceof Error) throw membership; return membership; },
      resolveCourseAccessV2: async ({ subject, classId }: { subject: string; classId: string }) => {
        courseReads++;
        return courseActive && classId === courseId ? courseFixture(subject, classId) : { ok: false, code: 'not_enrolled', retryable: false };
      },
    },
  } as unknown as Env;
  const principal = (role: AppRole = 'member'): AppPrincipal => ({ subject: member, role, quotaClass: 'member', displayName: 'Fixture member', course: null, courseId: null });
  async function reserve(p: AppPrincipal) {
    const key = `uploads/${crypto.randomUUID()}/source.wav`;
    await env.AUDIO.put(key, readFileSync(new URL('../tests/fixtures/audio/source.wav', import.meta.url)));
    const table = p.quotaClass === 'guest' ? 'guest_upload_owners' : 'upload_owners';
    await db.prepare(`INSERT INTO ${table}(object_key,subject,expires_at,state) VALUES(?,?,?,'ready')`)
      .bind(key, p.subject, new Date(expiresAt).toISOString()).run();
    return (await submitSplit(env, p, { key, filename: 'Synthetic fixture audio', model: 'htdemucs_ft', ...(p.courseId ? { coursePolicy: 'course-work-v1' } : {}) }, crypto.randomUUID())).operation;
  }
  return { db, env, principal, reserve, expiresAt, courseReads: () => courseReads, membershipReads: () => membershipReads,
    membership: (value: unknown) => { membership = value; }, revokeCourse: () => { courseActive = false; } };
}

for (const role of ['member', 'instructor', 'student'] as const) test(`${role} personal split reaches the provider with no course enrollment`, async t => {
  const f = await setup(t), op = await f.reserve(f.principal(role));
  let starts = 0;
  t.mock.method(globalThis, 'fetch', async () => { starts++; return Response.json({ id: 'fixture-start', status: 'starting' }); });
  await drainSplitQueue(f.env, async () => assert.fail('Provider completion is separate'));
  assert.equal((await readOperation(f.db, op.id))?.state, 'processing');
  assert.equal(starts, 1);
  assert.equal(f.membershipReads(), 1);
  assert.equal(f.courseReads(), 0);
});

for (const claimed of [false, true]) test(`${claimed ? 'claimed guest' : 'guest'} queued work retains its correct authority`, async t => {
  const f = await setup(t);
  const p: AppPrincipal = { subject: guest, role: 'guest', quotaClass: 'guest', displayName: 'Guest', course: null, courseId: null };
  const op = await f.reserve(p);
  if (claimed) {
    f.env.guestClaimSession = { subject: guest, expiresAt: f.expiresAt, verifiedDay: '1970-01-01' };
    assert.deepEqual((await claimGuestWork(f.env, f.principal())).claimedJobIds, [op.job_id]);
  }
  let starts = 0;
  t.mock.method(globalThis, 'fetch', async () => { starts++; return Response.json({ id: 'fixture-start', status: 'starting' }); });
  await drainSplitQueue(f.env, async () => assert.fail('Provider completion is separate'));
  const after = (await readOperation(f.db, op.id))!;
  assert.equal(after.state, 'processing');
  assert.equal(after.quota_class, 'guest');
  assert.equal(starts, 1);
  assert.equal(f.membershipReads(), claimed ? 1 : 0);
  assert.equal(f.courseReads(), 0);
});

test('queued course work checks its selected class and current Lab membership', async t => {
  const f = await setup(t), principal = f.principal('student');
  principal.courseId = courseId; principal.course = await courseFixture(member, courseId);
  const op = await f.reserve(principal);
  let starts = 0;
  t.mock.method(globalThis, 'fetch', async () => { starts++; return Response.json({ id: 'fixture-start', status: 'starting' }); });
  await drainSplitQueue(f.env, async () => assert.fail('Provider completion is separate'));
  assert.equal((await readOperation(f.db, op.id))?.state, 'processing');
  assert.equal(starts, 1); assert.equal(f.courseReads(), 1); assert.equal(f.membershipReads(), 1);
  f.revokeCourse();
  await assert.rejects(authorizeStoredCourseWork(f.env, member, courseId), { code: 'not_enrolled' });
  await assert.rejects(authorizeStoredCourseWork(f.env, member, 'unconfigured-course'), { code: 'course_not_available' });
});

for (const denied of ['revoked', 'expired', 'malformed', 'unavailable', 'disabled'] as const) test(`${denied} Lab access stops personal queued work before provider dispatch`, async t => {
  const f = await setup(t), op = await f.reserve(f.principal());
  if (denied === 'disabled') await f.db.prepare('UPDATE app_users SET disabled=1,updated_by=?,revision=revision+1 WHERE subject=?').bind(member,member).run();
  else f.membership(denied === 'revoked' ? { ok: false, code: 'not_admitted' }
    : denied === 'expired' ? { ...membershipFixture(), expiresAt: new Date(Date.now() - 1000).toISOString() }
    : denied === 'malformed' ? { ...membershipFixture(), budgetScope: 'admin' } : new Error('fixture outage'));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unconfirmed access cannot dispatch a provider'));
  await drainSplitQueue(f.env, async () => assert.fail('Unconfirmed access cannot complete'));
  assert.equal((await readOperation(f.db, op.id))?.error_code, 'access_unavailable');
  assert.match((await f.db.prepare('SELECT error FROM jobs WHERE id=?').bind(op.job_id).first<{ error: string }>())!.error, /^Account access/);
  assert.equal(f.courseReads(), 0);
});

test('a Lab member with zero course enrollment receives complete personal Guide and chat replies under member allowance', async t => {
  const f = await setup(t);
  f.env.verifyCailIdentity = async token => token === 'fixture-member' ? { subject: member, name: 'Fixture member' } : null;
  f.env.ASSISTANT_MODEL = 'fixture';
  let replies = 0;
  f.env.assistantTransport = async (_env, _input, delta) => {
    replies++; await delta('Listen for the fixture bass.');
    return { content: 'Listen for the fixture bass.', model: 'fixture', toolCalls: [], finishReason: 'stop' };
  };
  await f.db.prepare("INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('personal-guide','Synthetic fixture','uploads/fixture/source.wav','done','htdemucs_ft','[]')").run();
  await f.db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind('personal-guide',member).run();
  for (const kind of ['guide','chat']) {
    const response = await app.fetch(new Request(`https://split.test/api/jobs/personal-guide/${kind}`, { method:'POST',
      headers:{origin:'https://split.test','content-type':'application/json','x-cail-identity-jwt':'fixture-member'},
      body:JSON.stringify({messageId:`personal-no-course-${kind}-0001`,...(kind==='chat'?{messages:[{role:'user',content:'What should I listen for?'}]}:{})}),
    }),f.env);
    assert.equal(response.status,200);
    const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    const done=events.at(-1);assert.equal(done.type,'done');assert.equal(done.usage.limit,50);
    if(kind==='guide')assert.equal(done.cached,false);
  }
  assert.equal(replies,2);assert.equal(f.courseReads(),0);
});
