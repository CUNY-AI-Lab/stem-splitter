import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from '../src/index.ts';
import { SqliteD1 } from '../server/d1.ts';
import type { Env } from '../src/env.ts';
import { STEM_COURSE_ID as COURSE } from '../src/classroom/contract.ts';
import { courseFixture } from './course-fixture.ts';

const OTHER = 'other-reviewed-course';
const ids = { student: `cail-${'1'.repeat(32)}`, peer: `cail-${'2'.repeat(32)}`, instructor: `cail-${'3'.repeat(32)}`, second: `cail-${'4'.repeat(32)}`, outsider: `cail-${'5'.repeat(32)}`, admin: `cail-${'6'.repeat(32)}` };
type Person = keyof typeof ids;
const state = { playing: false, position: 0, playbackRate: 1, focusStem: null, focusMode: null, selection: null };
const endpoint = (job = 'course-song', course = COURSE) => `/api/classroom/courses/${course}/jobs/${job}/live`;
async function setup() {
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const revoked = new Set<string>();
  let limited = false;
  const keys: string[] = [];
  const env = {
    AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://split.test', CAIL_COURSE_IDS: `${COURSE},${OTHER}`, DB: db,
    verifyCailIdentity: async (token: string) => Object.values(ids).includes(token as never) ? { subject: token } : null,
    REQUEST_LIMIT: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !limited }; } },
    ADMISSION_RESOLVER: {
      resolveMembership: async ({ subject }: { subject: string }) => ({ ok: true, accessRole: subject === ids.admin ? 'admin' : 'member', budgetScope: subject === ids.admin ? 'admin' : 'person', revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }),
      resolveCourseAccessV2: async ({ subject, classId }: { subject: string; classId: string }) => {
        if (revoked.has(subject) || subject === ids.outsider || subject === ids.admin) return { ok: false, code: 'not_enrolled', retryable: false };
        return courseFixture(subject, classId, [ids.instructor, ids.second].includes(subject as never));
      },
    },
  } as unknown as Env;
  for (const subject of Object.values(ids)) await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const job = async (id: string, course: string | null = COURSE, shared = true) => {
    await db.prepare(`INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES(?,?,?,'done','htdemucs_ft',?)`)
      .bind(id, 'Synthetic tone', `uploads/${id}/source.wav`, JSON.stringify([{ name: 'vocals', key: `stems/${id}/vocals.mp3` }, { name: 'drums', key: `stems/${id}/drums.mp3` }])).run();
    await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id, ids.student).run();
    if (course) {
      await db.prepare("INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES(?,?,?,?,'course-work-v1')")
        .bind(id, course, (await courseFixture(ids.student, course)).memberId, ids.student).run();
      if (shared) {
        await db.prepare("INSERT INTO course_folders(id,course_id,name,created_by,permission) VALUES(?,?,'Fixture class',?,'read')").bind(`folder-${id}`, course, ids.instructor).run();
        await db.prepare("INSERT INTO course_folder_items(folder_id,job_id,filename,model) VALUES(?,?,'Synthetic tone','htdemucs_ft')").bind(`folder-${id}`, id).run();
      }
    }
  };
  const request = (who: Person, method = 'GET', body?: unknown, path = endpoint(), headers: Record<string, string> = {}) => app.fetch(new Request(`https://split.test${path}`, {
    method, headers: { 'x-cail-identity-jwt': ids[who], origin: 'https://split.test', 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const send = (action: string, expectedRevision: number, extra: Record<string, unknown> = {}, who: Person = 'instructor', path = endpoint()) =>
    request(who, 'PUT', action === 'end' ? { action, expectedRevision, ...extra } : { action, expectedRevision, ...state, ...extra }, path);
  await job('course-song');
  return { db, env, job, request, send, revoked, keys, limit: () => { limited = true; } };
}

test('live mode is opt-in, instructor-led, course-scoped and separate from annotation grants', async () => {
  const f = await setup();
  const before = await f.request('peer'); assert.equal(before.status, 200);
  const initial = await before.json() as any;
  assert.ok(Math.abs(Date.now() - initial.serverTime) < 1000);
  assert.deepEqual({ ...initial, serverTime: 0 }, { session: null, revision: 0, canControl: false, isHost: false, serverTime: 0, pollAfterMs: 2500 });
  assert.equal((await f.send('start', 0, {}, 'student')).status, 403);
  const started = await f.send('start', 0, { playing: true, position: 12.5, focusStem: 'drums', focusMode: 'behind', selection: { start: 12, end: 18 } });
  assert.equal(started.status, 200);
  const host = await started.json() as any;
  assert.equal(host.isHost, true); assert.equal(host.revision, 1); assert.equal(host.session.active, true);
  const peer = await (await f.request('peer')).json() as any;
  assert.equal(peer.canControl, false); assert.equal(peer.isHost, false);
  assert.deepEqual(peer.session, host.session);
  assert.equal(peer.session.expiresAt - peer.session.updatedAt, 90000);
  assert.doesNotMatch(JSON.stringify(peer), /cail-|host_subject|Synthetic tone/);
  assert.equal((await f.send('update', 1, {}, 'peer')).status, 403);
  assert.equal((await f.send('end', 1, {}, 'second')).status, 409);
  assert.equal((await f.send('start', 1, {}, 'second')).status, 409);
  const changed = await f.send('update', 1, { position: 35, playbackRate: .75 }); assert.equal(changed.status, 200);
  assert.equal((await changed.json() as any).revision, 2);
  assert.equal((await f.send('update', 1)).status, 409);
  const ended = await f.send('end', 2); assert.equal(ended.status, 200);
  assert.equal((await ended.json() as any).session.active, false);
  assert.equal((await f.send('start', 3, {}, 'second')).status, 200);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM annotations').first<any>()).n, 0);
});

test('live room never grants personal, other-course, private-folder, anonymous or expired access', async () => {
  const f = await setup(); await f.job('personal', null); await f.job('other', OTHER); await f.job('private', COURSE, false);
  for (const who of ['student', 'instructor'] as Person[]) assert.equal((await f.request(who, 'GET', undefined, endpoint('personal'))).status, 404);
  assert.equal((await f.request('instructor', 'GET', undefined, endpoint('other'))).status, 404);
  assert.equal((await f.request('peer', 'GET', undefined, endpoint('private'))).status, 404);
  assert.equal((await f.request('peer', 'GET', undefined, endpoint(), { 'x-cail-identity-jwt': '' })).status, 401);
  assert.equal((await f.request('admin')).status, 403);
  assert.equal((await f.request('outsider')).status, 403);
  await f.db.prepare("UPDATE jobs SET created_at=datetime('now','-91 days') WHERE id='course-song'").run();
  assert.equal((await f.request('instructor')).status, 404);
  assert.equal((await f.send('start', 0)).status, 404);
});

test('live access and transport fail closed on participant, folder, host and workspace revocation', async () => {
  const f = await setup(); await f.send('start', 0, { playing: true });
  f.revoked.add(ids.peer); assert.equal((await f.request('peer')).status, 403); f.revoked.delete(ids.peer);
  await f.db.prepare("UPDATE course_folders SET permission='private',revision=revision+1 WHERE id='folder-course-song'").run();
  assert.equal((await f.request('peer')).status, 404);
  await f.db.prepare("UPDATE course_folders SET permission='read',revision=revision+1 WHERE id='folder-course-song'").run();
  f.revoked.add(ids.instructor);
  assert.equal((await (await f.request('peer')).json() as any).session.active, false);
  assert.equal((await f.send('update', 1)).status, 403);
  assert.equal((await f.send('start', 1, {}, 'second')).status, 200);
  await f.db.prepare('UPDATE app_users SET disabled=1,updated_by=? WHERE subject=?').bind(ids.admin, ids.second).run();
  assert.equal((await (await f.request('peer')).json() as any).session.active, false);
  f.env.CAIL_CLASSROOM_ENABLED = 'false'; assert.equal((await f.request('student')).status, 503);
});

test('expired leases, malformed cues, stale concurrent writes and polling limits are bounded', async () => {
  const f = await setup();
  for (const bad of [{ position: -1 }, { position: 901 }, { playbackRate: 4 }, { playing: 'yes' }, { focusStem: 'unknown', focusMode: 'only' },
    { focusStem: 'vocals', focusMode: null }, { focusMode: 'only' }, { selection: { start: 5, end: 4 } }, { selection: { start: 0, end: 901 } }, { selection: { start: 0, end: 2, note: 'do not store' } }, { extra: 'not supported' }]) {
    assert.equal((await f.send('start', 0, bad)).status, 400, JSON.stringify(bad));
  }
  const raced = await Promise.all([f.send('start', 0), f.send('start', 0)]);
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 409]);
  await f.db.prepare('UPDATE course_live_sessions SET expires_at=? WHERE job_id=?').bind(Date.now() - 1, 'course-song').run();
  assert.equal((await (await f.request('peer')).json() as any).session.active, false);
  assert.equal((await f.send('update', 1)).status, 409);
  assert.equal((await f.send('start', 1, {}, 'second')).status, 200);
  f.limit(); const limited = await f.request('peer'); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.ok(f.keys.some(key => key.includes(ids.peer))); assert.ok(f.keys.every(key => !key.includes('Synthetic tone')));
  f.env.REQUEST_LIMIT = undefined; assert.equal((await f.request('peer')).status, 503);
});

test('host membership loss stops cues and authority outages never disclose a playable state', async () => {
  const f = await setup(); await f.send('start', 0, { playing: true });
  const membership = f.env.ADMISSION_RESOLVER!.resolveMembership;
  f.env.ADMISSION_RESOLVER!.resolveMembership = async input => input.subject === ids.instructor ? { ok: false, code: 'not_admitted' } : membership(input);
  const denied = await (await f.request('peer')).json() as any;
  assert.equal(denied.session.active, false); assert.equal(denied.session.playing, false);
  f.env.ADMISSION_RESOLVER!.resolveMembership = async input => { if (input.subject === ids.instructor) throw new Error('fixture unavailable'); return membership(input); };
  const unavailable = await f.request('peer'); assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /"playing":true/);
});

test('live migration is additive and idempotent and preserves private history', async () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/0027-classroom-live.sql', import.meta.url), 'utf8');
  const db = new SqliteD1(':memory:'); db.applySchema(schema.slice(0, schema.lastIndexOf(migration)));
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('old','Private split','uploads/old/source.wav','done')").run();
  await db.prepare("INSERT INTO annotations(id,job_id,at_seconds,text) VALUES('old-note','old',1,'Private note')").run();
  db.applySchema(migration); db.applySchema(migration);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM course_live_sessions').first<any>()).n, 0);
  assert.equal((await db.prepare('SELECT text FROM annotations WHERE id=?').bind('old-note').first<any>()).text, 'Private note');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM job_courses').first<any>()).n, 0);
});
