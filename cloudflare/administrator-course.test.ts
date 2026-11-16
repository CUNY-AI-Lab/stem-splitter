import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from '../src/index.ts';
import { SqliteD1 } from '../server/d1.ts';
import type { Env } from '../src/env.ts';
import { currentMembership } from '../src/membership.ts';
import { STEM_COURSE_ID as COURSE, validAssignmentV2 } from '../src/classroom/contract.ts';
import { courseFixture } from './course-fixture.ts';

const admin = `cail-${'a'.repeat(32)}`, student = `cail-${'b'.repeat(32)}`;
const caps = { instructorPanel: true, rosterRead: true, promptRead: true, promptWrite: true };
async function setup() {
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  let revoked = false, budgetScope = 'person-plus';
  const receipt = async (subject: string, classId: string) => {
    const base = await courseFixture(subject, classId);
    return subject === admin ? { ...base, participant: false, owner: false, administrator: true as const, capabilities: caps } : base;
  };
  const env = { AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://split.test', CAIL_COURSE_IDS: COURSE, DB: db,
    verifyCailIdentity: async (token: string) => [admin, student].includes(token) ? { subject: token } : null,
    REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    ADMISSION_RESOLVER: {
      resolveMembership: async ({ subject }: { subject: string }) => ({ ok: true,
        accessRole: subject === admin && !revoked ? 'admin' : 'member', budgetScope,
        revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }),
      resolveCourseAccessV2: async (input: { subject: string; classId: string; includeAdministrator?: true }) => {
        assert.equal(input.includeAdministrator, true);
        if (input.subject === admin && revoked) return { ok: false, code: 'not_enrolled', retryable: false };
        return receipt(input.subject, input.classId);
      },
      listCourseAssignmentsV2: async (input: { subject: string; includeAdministrator?: true }) => {
        assert.equal(input.includeAdministrator, true);
        const { ok, ...course } = await receipt(input.subject, COURSE);
        return { ok, checkedAt: course.checkedAt, expiresAt: course.expiresAt, revision: 1,
          assignments: input.subject === admin && revoked ? [] : [course], nextCursor: null };
      },
      listCourseRosterV2: async (input: { subject: string; classId: string; includeAdministrator?: true }) => {
        assert.equal(input.includeAdministrator, true); assert.equal(input.subject, admin);
        const course = await receipt(student, input.classId);
        const { memberId, displayName, displayNameSource, startsAt, expiresAt } = course;
        return { ok: true, classId: input.classId, checkedAt: course.checkedAt, expiresAt, revision: 1,
          participants: [{ memberId, displayName, displayNameSource, startsAt, expiresAt }], nextCursor: null };
      },
    },
  } as unknown as Env;
  for (const subject of [admin, student]) await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const memberId = (await courseFixture(student, COURSE)).memberId;
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status,stems) VALUES('admin-review','Synthetic tone','uploads/tone.wav','done','[]')").run();
  await db.prepare("INSERT INTO job_owners(job_id,subject) VALUES('admin-review',?)").bind(student).run();
  await db.prepare("INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('admin-review',?,?,?,'course-work-v1')").bind(COURSE, memberId, student).run();
  const request = (path: string, who = admin, method = 'GET', body?: unknown) => app.fetch(new Request(`https://split.test${path}`, {
    method, headers: { 'x-cail-identity-jwt': who, origin: 'https://split.test', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { db, env, request, receipt, memberId, revoke: () => { revoked = true; }, budget: (scope: string) => { budgetScope = scope; } };
}

test('administrator course capabilities preserve identity and support instructor management without enrollment', async () => {
  const f = await setup(), path = `/api/classroom/courses/${COURSE}`;
  const discovery = await f.request('/api/classroom/courses'); assert.equal(discovery.status, 200);
  const [course] = (await discovery.json() as any).courses;
  assert.equal(course.administrator, true); assert.equal(course.owner, false); assert.equal(course.participant, false);
  assert.equal(course.memberId, (await f.receipt(admin, COURSE)).memberId);
  const roster = await f.request(`${path}/roster`); assert.equal(roster.status, 200);
  assert.deepEqual((await roster.json() as any).participants.map((p: any) => p.memberId), [f.memberId]);
  assert.equal((await f.request(`${path}/prompt`)).status, 200);
  const saved = await f.request(`${path}/prompt`, admin, 'PUT', { amendment: 'Fictional class guidance', expectedRevision: 0, changeNote: 'Administrator acceptance' });
  assert.equal(saved.status, 200);
  assert.equal((await f.db.prepare('SELECT actor FROM course_prompt_revisions WHERE course_id=?').bind(COURSE).first<any>()).actor, admin);
  assert.equal((await f.request(`${path}/participants/${f.memberId}/jobs`)).status, 200);
  const made = await f.request(`${path}/folders`, student, 'POST', { name: 'Student folder' }); assert.equal(made.status, 200);
  const folder = (await made.json() as any).folder;
  const changed = await f.request(`${path}/folders/${folder.id}`, admin, 'PUT', { name: 'Renamed by administrator', revision: folder.revision });
  assert.equal(changed.status, 200);
  assert.equal((await f.request(`${path}/folders/${folder.id}`, admin, 'DELETE')).status, 200);
  assert.equal((await f.request('/api/classroom/courses/not-configured/prompt')).status, 403);
  f.revoke();
  assert.equal((await f.request(`${path}/roster`)).status, 403);
  assert.equal((await f.request(`${path}/prompt`)).status, 403);
  assert.equal((await f.request('/api/admin/users')).status, 403);
});

test('administrator live sessions remain visible with an independent budget and end after role loss', async () => {
  const f = await setup(), path = `/api/classroom/courses/${COURSE}/jobs/admin-review/live`;
  const started = await f.request(path, admin, 'PUT', { action: 'start', expectedRevision: 0,
    playing: false, position: 0, playbackRate: 1, focusStem: null, focusMode: null, selection: null });
  assert.equal(started.status, 200);
  const own = await started.json() as any; assert.equal(own.canControl, true); assert.equal(own.isHost, true);
  const peer = await f.request(path, student); assert.equal(peer.status, 200);
  const state = await peer.json() as any; assert.equal(state.session.active, true); assert.equal(state.canControl, false);
  f.revoke();
  const ended = await f.request(path, student); assert.equal(ended.status, 200);
  assert.equal((await ended.json() as any).session.active, false);
});

test('administrator receipts require literal authority and matching capabilities', async () => {
  const f = await setup(), { ok, ...course } = await f.receipt(admin, COURSE);
  assert.equal(validAssignmentV2(course), true);
  for (const administrator of [false, 'true', 1, null]) assert.equal(validAssignmentV2({ ...course, administrator }), false);
  assert.equal(validAssignmentV2({ ...course, administrator: undefined }), false);
  assert.equal(validAssignmentV2({ ...course, capabilities: { ...caps, promptWrite: false } }), false);
  assert.equal(validAssignmentV2({ ...course, expiresAt: new Date(Date.now() - 1).toISOString() }), false);
});

test('membership role and budget are independent; budget never grants administrator access', async () => {
  const now = Date.now();
  for (const accessRole of ['member', 'admin'] as const) for (const budgetScope of ['person', 'person-plus', 'admin'] as const) {
    const receipt = { ok: true as const, accessRole, budgetScope, revision: 1, expiresAt: new Date(now + 60000).toISOString() };
    assert.deepEqual(currentMembership(receipt, now), receipt);
    assert.equal(currentMembership({ ...receipt, budgetScope: 'unknown' }, now), null);
    assert.equal(currentMembership({ ...receipt, accessRole: 'unknown' }, now), null);
    assert.equal(currentMembership({ ...receipt, expiresAt: new Date(now).toISOString() }, now), 'denied');
  }
  const f = await setup(); f.budget('admin');
  assert.equal((await f.request('/api/admin/users', student)).status, 403);
});
