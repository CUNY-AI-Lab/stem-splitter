import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from '../src/index.ts';
import { SqliteD1 } from '../server/d1.ts';
import type { Env } from '../src/env.ts';
import { claimedUiStateStatements, readJobUiState, seedJobUiState, UiStateError, writeGuestJobUiState } from '../src/ui-state.ts';
import { purgeExpiredUiState } from './retention.ts';
import { courseFixture } from './course-fixture.ts';

const alice = `cail-${'1'.repeat(32)}`;
const bob = `cail-${'2'.repeat(32)}`;
const course = 'msh-245-private-state-fixture';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const env = {
    AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://split.test', CAIL_COURSE_IDS: course, DB: db,
    verifyCailIdentity: async (token: string) => token === alice || token === bob ? { subject: token, name: 'Student' } : null,
    ADMISSION_RESOLVER: {
      resolveMembership: async () => ({ ok: true, accessRole: 'member', budgetScope: 'person', revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }),
      resolveCourseAccessV2: async ({ subject, classId }: { subject: string; classId: string }) => courseFixture(subject,classId,subject===alice),
    },
    REQUEST_LIMIT: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  for (const subject of [alice, bob]) await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  async function job(id: string, subject = alice, courseId?: string) {
    await db.prepare(`INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES(?,?,'uploads/test/source.wav','done','htdemucs_ft',?)`)
      .bind(id, id, JSON.stringify([{ name: 'vocals' }, { name: 'drums' }])).run();
    await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id, subject).run();
    if (courseId) {
      const assignment = await courseFixture(subject,courseId,subject===alice);
      await db.prepare("INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES(?,?,?,?,'course-work-v1')")
        .bind(id,courseId,assignment.memberId,subject).run();
    }
  }
  const request = (path: string, subject = alice, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.fetch(new Request(`https://split.test${path}`, {
    method, headers: { 'x-cail-identity-jwt': subject, 'x-stem-account': subject, origin: 'https://split.test', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { db, env, job, request };
}

test('private listening state uses actor/job isolation, CAS, idempotent retries, conflict copies and revisioned clears', async () => {
  const { db, job, request } = await fixture(); await job('song');
  const url = '/api/jobs/song/ui-state';
  assert.deepEqual((await (await request(url)).json() as any).records, { listeningDraft: null, listeningPlayer: null });
  const first = { requestId: uuid(1), kind: 'listeningDraft', baseRevision: 0, value: 'Initial draft' };
  const applied = await request(url, alice, 'PUT', first);
  assert.equal(applied.status, 200); assert.equal((await applied.json() as any).revision, 1);
  assert.equal((await request(url, alice, 'PUT', first)).status, 200, 'lost acknowledgment retry returns the same receipt');
  assert.equal((await request(url, alice, 'PUT', { ...first, value: 'different bytes' })).status, 409, 'request IDs cannot be rebound');
  const newer = await request(url, alice, 'PUT', { requestId: uuid(2), kind: 'listeningDraft', baseRevision: 1, value: 'Newer draft' });
  assert.equal(newer.status, 200); assert.equal((await newer.json() as any).revision, 2);
  const stale = await request(url, alice, 'PUT', { requestId: uuid(3), kind: 'listeningDraft', baseRevision: 1, value: 'Losing draft' });
  assert.equal(stale.status, 409); assert.equal((await stale.json() as any).revision, 2);
  const snapshot = await(await request(url)).json() as any;
  assert.equal(snapshot.actor, alice); assert.equal(snapshot.records.listeningDraft.value, 'Newer draft');
  assert.equal(snapshot.versions.length, 1); assert.equal(snapshot.versions[0].reason, 'conflict'); assert.equal(snapshot.versions[0].value, 'Losing draft');
  const cleared = await request(url, alice, 'PUT', { requestId: uuid(4), kind: 'listeningDraft', baseRevision: 2, value: null });
  assert.equal(cleared.status, 200); assert.equal((await cleared.json() as any).revision, 3);
  const afterClear = await(await request(url)).json() as any;
  assert.equal(afterClear.records.listeningDraft.value, null); assert.equal(afterClear.records.listeningDraft.revision, 3);
  assert.equal((await request(url, bob)).status, 404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM job_ui_state_records WHERE subject=?').bind(bob).first<any>()).n, 0);
});

test('player state is typed against current stems, mismatched actor/origin writes are fenced', async () => {
  const { job, request, db } = await fixture(); await job('song');
  const url = '/api/jobs/song/ui-state';
  const record = { requestId: uuid(5), kind: 'listeningPlayer', baseRevision: 0, value: { position: 9.5, rate: 1.25, muted: ['vocals'], solo: { stem: 'drums', stage: 'only' }, loop: { start: 1, end: 4 }, guideOpen: true } };
  const valid = await request(url, alice, 'PUT', record);
  assert.equal(valid.status, 200); assert.equal((await valid.json() as any).revision, 1);
  const invalid = await request(url, alice, 'PUT', { ...record, requestId: uuid(6), baseRevision: 1, value: { ...record.value, muted: ['other'] } });
  assert.equal(invalid.status, 422);
  const mismatch = await request(url, alice, 'PUT', { ...record, requestId: uuid(7) }, { 'x-stem-account': bob });
  assert.equal(mismatch.status, 409);
  const crossOrigin = await request(url, alice, 'PUT', { ...record, requestId: uuid(8) }, { origin: 'https://other.test' });
  assert.equal(crossOrigin.status, 403);
  const state = await(await request(url)).json() as any;
  assert.deepEqual(state.records.listeningPlayer.value, record.value);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM job_ui_state_receipts WHERE subject=?').bind(alice).first<any>()).n, 1);
});

test('UI-state calls use their dedicated limiter and fail closed when no limiter is configured', async () => {
  const { env, job, request } = await fixture(); await job('rate-limited');
  const keys: string[] = [];
  env.UI_STATE_LIMIT = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false }; } };
  assert.equal((await request('/api/jobs/rate-limited/ui-state')).status,429);
  assert.deepEqual(keys,[`stem-ui-state:${alice}`]);
  env.UI_STATE_LIMIT = undefined;
  env.REQUEST_LIMIT = undefined;
  assert.equal((await request('/api/jobs/rate-limited/ui-state')).status,503);
});

test('a currently shared reader writes only their own private state and loses access on grant withdrawal', async () => {
  const { job, request, db } = await fixture(); await job('shared',alice,course);
  await db.prepare(`INSERT INTO course_folders(id,course_id,name,created_by,creator_subject,permission,revision) VALUES('shared-state',?,?,?,?,'read',0)`)
    .bind(course,'Shared state',alice,alice).run();
  await db.prepare(`INSERT INTO course_folder_items(folder_id,job_id,filename,model,added_by) VALUES('shared-state','shared','shared','htdemucs_ft',?)`).bind(alice).run();
  const url = '/api/jobs/shared/ui-state';
  assert.equal((await request(url,bob)).status,200);
  assert.equal((await request(url,bob,'PUT',{requestId:uuid(29),kind:'listeningDraft',baseRevision:0,value:'Bob’s private listening note'})).status,200);
  assert.equal((await(await request(url,bob)).json() as any).records.listeningDraft.value,'Bob’s private listening note');
  assert.equal((await(await request(url,alice)).json() as any).records.listeningDraft,null,'course owner cannot read the peer private record');
  await db.prepare("UPDATE course_folders SET permission='private',revision=revision+1 WHERE id='shared-state'").run();
  assert.equal((await request(url,bob)).status,404);
});

test('instructors can manage course access but UI-state reads remain private to their own actor', async () => {
  const { db, env, job, request } = await fixture();
  const instructor = bob;
  await db.prepare("UPDATE app_users SET role='instructor',updated_by=? WHERE subject=?").bind(alice,instructor).run();
  env.ADMISSION_RESOLVER!.resolveCourseAccessV2 = async ({subject,classId}: {subject:string;classId:string}) => courseFixture(subject,classId,subject===alice||subject===instructor);
  await job('instructor-private-state',alice,course);
  const url='/api/jobs/instructor-private-state/ui-state';
  const studentWrite=await request(url,alice,'PUT',{requestId:uuid(90),kind:'listeningDraft',baseRevision:0,value:'student-only note'});
  assert.equal(studentWrite.status,200);
  const instructorWrite=await request(url,instructor,'PUT',{requestId:uuid(91),kind:'listeningDraft',baseRevision:0,value:'instructor-only note'});
  assert.equal(instructorWrite.status,200);
  assert.equal((await(await request(url,instructor)).json() as any).records.listeningDraft.value,'instructor-only note');
  assert.equal((await(await request(url,alice)).json() as any).records.listeningDraft.value,'student-only note');
});

test('bounded seed preserves existing drafts as conflict versions and stores pending work only as inert', async () => {
  const { job, request } = await fixture(); await job('song');
  const url = '/api/account/ui-state/seed';
  const original = { requestId: uuid(9), records: [{ jobId: 'song', kind: 'listeningDraft', value: 'source draft' },
    { jobId: 'song', kind: 'pendingGuide', value: { messageId: 'a'.repeat(20) } }] };
  let response = await request(url, alice, 'POST', original);
  assert.equal(response.status, 200); assert.equal((await response.json() as any).accepted.length, 2);
  response = await request(url, alice, 'POST', original);
  assert.equal(response.status, 200); assert.equal((await response.json() as any).accepted[0].outcome, 'applied');
  response = await request(url, alice, 'POST', { requestId: uuid(10), records: [{ jobId: 'song', kind: 'listeningDraft', value: 'local competing draft' }] });
  assert.equal(response.status, 200); assert.equal((await response.json() as any).accepted[0].outcome, 'conflict');
  const state = await(await request('/api/jobs/song/ui-state')).json() as any;
  assert.equal(state.records.listeningDraft.value, 'source draft');
  assert.deepEqual(state.versions.map((row: any) => [row.recordKind,row.reason]), [['listeningDraft','conflict'],['pendingGuide','pending']]);
  assert.equal(state.versions.find((row: any) => row.reason === 'pending').value.messageId, 'a'.repeat(20));
  assert.equal((await request(url, alice, 'POST', { requestId: uuid(11), records: Array.from({ length: 65 }, (_, i) => ({ jobId: `j${i}`, kind: 'listeningDraft', value: '' })) })).status, 400);
});

test('one semantically invalid legacy playback value does not block later valid seed records', async () => {
  const { db, job } = await fixture(); await job('legacy-player'); await job('valid-draft');
  const result = await seedJobUiState(db,alice,{requestId:uuid(13),records:[
    {jobId:'legacy-player',kind:'listeningPlayer',value:{position:12,rate:1,muted:['removed-stem'],solo:null,loop:null,guideOpen:false}},
    {jobId:'valid-draft',kind:'listeningDraft',value:'continue this draft'},
  ]});
  assert.deepEqual(result.denied,['legacy-player']);
  assert.deepEqual(result.accepted.map(item=>item.jobId),['valid-draft']);
  assert.equal((await readJobUiState(db,alice,'valid-draft')).records.listeningDraft?.value,'continue this draft');
});

test('optional inert chat fields, Unicode draft bounds, and expired jobs retain their limits', async () => {
  const { db, job, request } = await fixture(); await job('song'); await job('expired');
  const seed = await seedJobUiState(db, alice, { requestId: uuid(12), records: [
    { jobId: 'song', kind: 'pendingChat', value: { messageId: 'b'.repeat(20), messages: [{ role: 'user', content: 'unfinished' }] } },
    { jobId: 'song', kind: 'pendingGuide', value: { messageId: 'c'.repeat(20) } },
    { jobId: 'song', kind: 'listeningDraft', value: '🎵'.repeat(1000) },
  ] });
  assert.equal(seed.accepted.length, 3);
  assert.equal((await (await request('/api/jobs/song/ui-state')).json() as any).records.listeningDraft.value, '🎵'.repeat(1000));
  await db.prepare("UPDATE jobs SET created_at=datetime('now','-91 days') WHERE id='expired'").run();
  assert.equal((await request('/api/jobs/expired/ui-state')).status, 404);
  await assert.rejects(() => readJobUiState(db, alice, 'expired'), (error: unknown) => error instanceof UiStateError && error.status === 404);
});

test('simultaneous same-revision writes have one winner and preserve the losing draft', async () => {
  const { job, request, db } = await fixture(); await job('race');
  const url = '/api/jobs/race/ui-state';
  const [left, right] = await Promise.all([
    request(url, alice, 'PUT', { requestId: uuid(30), kind: 'listeningDraft', baseRevision: 0, value: 'First tab' }),
    request(url, alice, 'PUT', { requestId: uuid(31), kind: 'listeningDraft', baseRevision: 0, value: 'Second tab' }),
  ]);
  assert.deepEqual([left.status,right.status].sort(), [200,409]);
  const state = await(await request(url)).json() as any;
  assert.equal(state.records.listeningDraft.revision, 1); assert.equal(state.versions.length, 1);
  assert.notEqual(state.records.listeningDraft.value, state.versions[0].value);
});

test('guest UI state uses private actor CAS and rechecks active guest ownership atomically', async () => {
  const { db, job } = await fixture();
  const guest = `guest-${'a'.repeat(64)}`;
  const now = Date.now(), expiresAt = now + 60_000;
  await db.prepare(`INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,'2026-11-16')`)
    .bind(guest,now-1,expiresAt).run();
  await job('guest-song');
  await db.prepare('DELETE FROM job_owners WHERE job_id=?').bind('guest-song').run();
  await db.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind('guest-song',guest).run();
  const write = (requestId: string, baseRevision: number, value: string | null) => writeGuestJobUiState(db,guest,'guest-song',{
    requestId,kind:'listeningDraft',baseRevision,value,
  },{guestExpiresAt:expiresAt,now:Date.now()});
  assert.equal((await write(uuid(70),0,'guest draft')).revision,1);
  assert.equal((await write(uuid(71),0,'stale guest draft')).outcome,'conflict');
  const beforeRevoke = await readJobUiState(db,guest,'guest-song');
  assert.equal(beforeRevoke.records.listeningDraft?.value,'guest draft');
  assert.equal(beforeRevoke.versions[0]?.value,'stale guest draft');
  await db.prepare('DELETE FROM guest_job_owners WHERE job_id=?').bind('guest-song').run();
  await assert.rejects(() => write(uuid(70),0,'guest draft'), (error: unknown) => error instanceof UiStateError && error.status === 404,
    'an idempotent retry cannot bypass current ownership');
  await assert.rejects(() => write(uuid(72),1,'after ownership loss'), (error: unknown) => error instanceof UiStateError && error.status === 404);
  assert.equal((await readJobUiState(db,guest,'guest-song')).records.listeningDraft?.value,'guest draft');
});

test('successive late guest edits are each retained after claim without replacing member state', async () => {
  const { db, job } = await fixture();
  const guest = `guest-${'b'.repeat(64)}`;
  const now = Date.now(), expiresAt = now + 60_000;
  await db.prepare(`INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,'2026-11-16')`)
    .bind(guest,now-1,expiresAt).run();
  await job('claimed-ui');
  await db.prepare('DELETE FROM job_owners WHERE job_id=?').bind('claimed-ui').run();
  await db.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind('claimed-ui',guest).run();
  const guestWrite = (requestId: string, baseRevision: number, value: string) => writeGuestJobUiState(db,guest,'claimed-ui',{
    requestId,kind:'listeningDraft',baseRevision,value,
  },{guestExpiresAt:expiresAt,now:Date.now()});
  await guestWrite(uuid(73),0,'before claim');
  await db.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest,alice).run();
  await db.prepare('INSERT INTO guest_job_claims(job_id,guest_subject,member_subject) VALUES(?,?,?)').bind('claimed-ui',guest,alice).run();
  await db.prepare('DELETE FROM guest_job_owners WHERE job_id=?').bind('claimed-ui').run();
  await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind('claimed-ui',alice).run();
  await db.batch(claimedUiStateStatements(db,guest,alice,{now:Date.now(),expiresAt}));
  await guestWrite(uuid(74),1,'late guest edit one');
  await db.batch(claimedUiStateStatements(db,guest,alice,{now:Date.now(),expiresAt}));
  await guestWrite(uuid(75),2,'late guest edit two');
  await db.batch(claimedUiStateStatements(db,guest,alice,{now:Date.now(),expiresAt}));
  const memberState = await readJobUiState(db,alice,'claimed-ui');
  assert.equal(memberState.records.listeningDraft?.value,'before claim');
  assert.deepEqual(memberState.versions.map(version=>version.value).sort(),['late guest edit one','late guest edit two']);
});

test('per-actor byte quota is enforced, duplicate inert payloads dedupe, clears free capacity and expiry cleanup prunes records', async () => {
  const { job, request, db } = await fixture(); await job('quota');
  const seeded = await seedJobUiState(db, alice, { requestId: uuid(40), records: [{ jobId: 'quota', kind: 'listeningDraft', value: '\u0800'.repeat(2000) }] });
  assert.equal(seeded.accepted[0].outcome, 'applied');
  const pending = (revision: number, chars = 180000) => {
    const entries = [] as Array<{ kind: string; text: string }>;
    while (chars > 0 && entries.length < 60) { const length = Math.min(3000, chars); entries.push({ kind: 'you', text: 'x'.repeat(length) }); chars -= length; }
    return { revision, entries };
  };
  for (let i = 0; i < 11; i++) {
    const result = await seedJobUiState(db, alice, { requestId: uuid(41 + i), records: [{ jobId: 'quota', kind: 'pendingConversation', value: pending(i) }] });
    assert.equal(result.accepted.length, 1);
  }
  const usedBytes = async () => (await db.prepare(`SELECT
    COALESCE((SELECT SUM(length(CAST(payload_json AS BLOB))) FROM job_ui_state_records WHERE subject=?),0)
    + COALESCE((SELECT SUM(length(CAST(payload_json AS BLOB))) FROM job_ui_state_versions WHERE subject=?),0) AS bytes`).bind(alice,alice).first<any>()).bytes as number;
  const capacity = 2 * 1024 * 1024;
  const remaining = capacity - await usedBytes();
  let low = 1, high = 180000, best = 0, bestValue: unknown;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), value = pending(90, mid);
    const valueBytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (valueBytes <= remaining) { best = mid; bestValue = value; low = mid + 1; } else high = mid - 1;
  }
  assert.ok(best > 0);
  const filled = await seedJobUiState(db, alice, { requestId: uuid(60), records: [{ jobId: 'quota', kind: 'pendingConversation', value: bestValue }] });
  assert.equal(filled.accepted.length, 1);
  const fullBytes = await usedBytes(); assert.ok(fullBytes <= capacity); assert.ok(capacity - fullBytes < 4000);
  const over = await seedJobUiState(db, alice, { requestId: uuid(59), records: [{ jobId: 'quota', kind: 'pendingConversation', value: pending(91, 100) }] });
  assert.deepEqual(over.deferred, ['quota']); assert.equal(await usedBytes(), fullBytes, 'quota rejection preserves the prior full state');
  const duplicate = await seedJobUiState(db, alice, { requestId: uuid(61), records: [{ jobId: 'quota', kind: 'pendingConversation', value: bestValue }] });
  assert.equal(duplicate.accepted.length, 1); assert.equal(await usedBytes(), fullBytes, 'byte-identical inert versions are retained once');
  const clear = await request('/api/jobs/quota/ui-state', alice, 'PUT', { requestId: uuid(62), kind: 'listeningDraft', baseRevision: 1, value: null });
  assert.equal(clear.status, 200, 'a clear can replace a large row at full quota');
  assert.ok(await usedBytes() < fullBytes);
  const cleanup = await fixture(); await cleanup.job('expire-state');
  const expiredAt = Date.now()-1, digest = 'a'.repeat(64);
  await cleanup.db.batch([
    cleanup.db.prepare(`INSERT INTO job_ui_state_records(subject,job_id,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest) VALUES(?,?,'listeningDraft',1,'"old"',?,?,?,'expired',?)`).bind(alice,'expire-state',digest,expiredAt,expiredAt,digest),
    cleanup.db.prepare(`INSERT INTO job_ui_state_receipts(subject,job_id,kind,request_id,request_digest,outcome,revision,received_at,expires_at) VALUES(?,?,'listeningDraft','expired',?,'applied',1,?,?)`).bind(alice,'expire-state',digest,expiredAt,expiredAt),
    cleanup.db.prepare(`INSERT INTO job_ui_state_versions(subject,job_id,kind,reason,payload_json,digest,request_id,received_at,expires_at) VALUES(?,?,'pendingGuide','pending','{}',?,'expired',?,?)`).bind(alice,'expire-state',digest,expiredAt,expiredAt),
  ]);
  assert.equal(await purgeExpiredUiState(cleanup.db),3);
  for (const table of ['job_ui_state_records','job_ui_state_receipts','job_ui_state_versions']) {
    assert.equal((await cleanup.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE subject=?`).bind(alice).first<any>()).n,0);
  }
});
