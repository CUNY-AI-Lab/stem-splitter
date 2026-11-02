import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import { STEM_COURSE_ID } from '../src/classroom/contract.ts';
import { courseFixture, membershipFixture } from './course-fixture.ts';
import { verifyCailIdentity } from './verify.ts';

const issuer = await createTestIdentityIssuer();
const owner = TEST_SUBJECTS.alice, other = TEST_SUBJECTS.bob;
const tokens = new Map(await Promise.all([owner, other].map(async subject =>
  [subject, await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject })] as const)));

async function fixture(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-member-audio-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const bucket = new FsR2Bucket(join(directory, 'audio'));
  const bytes = readFileSync(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  let courseReads = 0, membershipActive = true, enrolled = false, courseAvailable = false;
  const env = {
    AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://split.test', ROUTED_AUDIO: 'true',
    CAIL_COURSE_IDS: STEM_COURSE_ID, CAIL_IDENTITY_JWKS: issuer.jwksJson, verifyCailIdentity, DB: db,
    ADMISSION_RESOLVER: {
      resolveMembership: async () => membershipActive ? membershipFixture() : { ok: false, code: 'not_admitted', retryable: false },
      resolveCourseAccessV2: async ({ subject, classId }: { subject: string; classId: string }) => {
        courseReads++;
        if (!courseAvailable) return new Promise(() => {});
        return enrolled ? courseFixture(subject, classId) : { ok: false, code: 'not_enrolled', retryable: false };
      },
    },
    AUDIO: {
      head: (key: string) => bucket.head(key), delete: (key: string) => bucket.delete(key),
      get: async (...args: Parameters<FsR2Bucket['get']>) => {
        const object = await bucket.get(...args);
        if (!object) return null;
        const body = object.body.pipeThrough(new TransformStream({ async transform(chunk, controller) {
          await delay(2); controller.enqueue(chunk);
        } }));
        return { ...object, body, writeHttpMetadata: object.writeHttpMetadata.bind(object) };
      },
    },
  } as unknown as Env;
  for (const subject of [owner, other]) await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  async function job(id: string, course = false) {
    const key = `stems/${id}/attempt/vocals.mp3`;
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'audio/mpeg' } });
    await db.prepare("INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES(?, 'Synthetic audio', 'uploads/fixture.mp3', 'done', 'htdemucs_ft', ?)")
      .bind(id, JSON.stringify([{ name: 'vocals', key }])).run();
    await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id, owner).run();
    if (course) await db.prepare("INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES(?,?,?,?,'course-work-v1')")
      .bind(id, STEM_COURSE_ID, (await courseFixture(owner)).memberId, owner).run();
    return '/api/files/' + key;
  }
  const request = (path: string, method = 'GET', subject = owner, range?: string) => app.fetch(new Request('https://split.test' + path,
    { method, headers: { 'x-cail-identity-jwt': tokens.get(subject)!, ...(range ? { Range: range } : {}) } }), env);
  return { db, bytes, request, job, courseReads: () => courseReads,
    revokeMembership: () => { membershipActive = false; },
    enrollment: (active: boolean) => { courseAvailable = true; enrolled = active; } };
}

test('personal member audio streams full, HEAD and successive ranges without waiting for optional course authority', async t => {
  const f = await fixture(t), path = await f.job('personal-audio');
  const full = await f.request(path);
  assert.equal(full.status, 200);
  assert.equal(f.courseReads(), 0, 'Personal audio must not invoke an unrelated course resolver that never settles');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.bytes);
  const head = await f.request(path, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(f.bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [start, end] of [[0, 31], [32, 63], [64, f.bytes.length - 1]]) {
    const partial = await f.request(path, 'GET', owner, `bytes=${start}-${end}`);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('Content-Range'), `bytes ${start}-${end}/${f.bytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), f.bytes.subarray(start, end + 1));
  }
  assert.equal(f.courseReads(), 0);
  assert.equal((await f.request(path, 'GET', other, 'bytes=0-31')).status, 404);
  await f.db.prepare('UPDATE app_users SET disabled=1,updated_by=?,revision=revision+1 WHERE subject=?').bind(owner, owner).run();
  assert.equal((await f.request(path, 'HEAD')).status, 403);
  await f.db.prepare('UPDATE app_users SET disabled=0,updated_by=?,revision=revision+1 WHERE subject=?').bind(owner, owner).run();
  f.revokeMembership();
  assert.equal((await f.request(path, 'GET', owner, 'bytes=32-63')).status, 403);
  assert.equal(f.courseReads(), 0);
});

test('course-assigned audio rechecks enrollment for later ranges and HEAD requests', async t => {
  const f = await fixture(t), path = await f.job('course-audio', true);
  f.enrollment(true);
  const first = await f.request(path, 'GET', owner, 'bytes=0-31');
  assert.equal(first.status, 206);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), f.bytes.subarray(0, 32));
  assert.equal(f.courseReads(), 1);
  f.enrollment(false);
  assert.equal((await f.request(path, 'GET', owner, 'bytes=32-63')).status, 403);
  assert.equal((await f.request(path, 'HEAD')).status, 403);
  assert.equal(f.courseReads(), 3);
});
