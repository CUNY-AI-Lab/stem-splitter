import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteD1 } from '../server/d1.ts';
import { authorizeBrowserTransferSource, consumeBrowserTransfer, createBrowserTransferProof, reauthorizeBrowserTransferJobs, stageBrowserTransfer } from '../src/browser-transfer.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';

const member = (subject: string): AppPrincipal => ({ subject, role: 'member', quotaClass: 'member', displayName: 'Synthetic', course: null, courseId: null });
const config = { PUBLIC_BASE_URL: 'https://stem-splitter.ailab-452.workers.dev', CAIL_BROWSER_ORIGIN: 'https://tools.ailab.gc.cuny.edu' };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'stem-browser-transfer-'));
  const db = new SqliteD1(join(directory, 'transfer.sqlite'));
  db.applySchema(readFileSync(new URL('../migrations/0035-browser-transfer-proofs.sql', import.meta.url), 'utf8'));
  const env = (mounted: boolean) => ({
    ...config,
    APP_BASE_PATH: mounted ? '/stem-splitter' : undefined,
    DB: db as unknown as D1Database,
    REQUEST_LIMIT: { limit: async () => ({ success: true, reset: 0 }) },
  }) as unknown as Env;
  return { db, env, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
async function json(response: Response) { return response.json() as Promise<Record<string, unknown>>; }

test('browser recovery proof binds current subject, configured origin pair, and one-use state transitions', async () => {
  const fixture = setup();
  try {
    const user = member(`cail-${'1'.repeat(32)}`), other = member(`cail-${'2'.repeat(32)}`);
    const issued = await createBrowserTransferProof(fixture.env(true), user);
    assert.equal(issued.status, 200);
    const { proof } = await json(issued) as { proof: string };
    assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await authorizeBrowserTransferSource(fixture.env(false), other, proof)).status, 403);
    assert.equal((await authorizeBrowserTransferSource({ ...fixture.env(false), PUBLIC_BASE_URL: 'https://attacker.example' } as Env, user, proof)).status, 403);
    assert.equal((await authorizeBrowserTransferSource(fixture.env(false), user, proof)).status, 200);
    assert.equal((await authorizeBrowserTransferSource(fixture.env(false), user, proof)).status, 403);
    const staged = await stageBrowserTransfer(fixture.env(true), user, proof, []);
    assert.equal(staged.status, 200);
    assert.deepEqual((await json(staged)).allowedJobIds, []);
    assert.equal((await stageBrowserTransfer(fixture.env(true), user, proof, [])).status, 403);
    assert.equal((await consumeBrowserTransfer(fixture.env(true), user, proof)).status, 200);
    assert.equal((await consumeBrowserTransfer(fixture.env(true), user, proof)).status, 403);
    assert.deepEqual({ ...await fixture.db.prepare('SELECT COUNT(*) AS count FROM browser_transfer_proofs WHERE subject=?').bind(user.subject).first() }, { count: 1 });
  } finally { fixture.dispose(); }
});

test('proof issuance fails closed when rate limiting is unavailable', async () => {
  const fixture = setup();
  try {
    const env = { ...fixture.env(true), REQUEST_LIMIT: undefined } as unknown as Env;
    assert.equal((await createBrowserTransferProof(env, member(`cail-${'3'.repeat(32)}`))).status, 503);
    assert.deepEqual({ ...await fixture.db.prepare('SELECT COUNT(*) AS count FROM browser_transfer_proofs').first() }, { count: 0 });
  } finally { fixture.dispose(); }
});

test('apply-time job checks are bounded and reject malformed caller scopes', async () => {
  const fixture = setup();
  try {
    const user = member(`cail-${'4'.repeat(32)}`);
    const empty = await reauthorizeBrowserTransferJobs(fixture.env(true), user, []);
    assert.equal(empty.status, 200);
    assert.deepEqual((await json(empty)).allowedJobIds, []);
    assert.equal((await reauthorizeBrowserTransferJobs(fixture.env(true), user, ['../other'])).status, 400);
    assert.equal((await reauthorizeBrowserTransferJobs(fixture.env(true), { ...user, quotaClass: 'guest' }, [])).status, 403);
  } finally { fixture.dispose(); }
});

test('revoked course jobs are omitted while authorized personal work remains recoverable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-browser-transfer-partial-'));
  const db = new SqliteD1(join(directory, 'transfer.sqlite'));
  try {
    db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    const user = member(`cail-${'5'.repeat(32)}`), other = member(`cail-${'6'.repeat(32)}`);
    await db.prepare('INSERT INTO app_users(subject) VALUES(?),(?)').bind(user.subject, other.subject).run();
    await db.prepare(`INSERT INTO jobs(id,filename,source_key,status) VALUES
      ('personal-ok','personal fixture','uploads/personal.wav','done'),
      ('course-revoked','old class fixture','uploads/course.wav','done')`).run();
    await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind('personal-ok', user.subject).run();
    await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind('course-revoked', other.subject).run();
    await db.prepare(`INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version)
      VALUES('course-revoked','msh-245-the-american-musical-experience-fall-2026-01','member-old','owner','course-work-v1')`).run();
    const env = {
      ...config, APP_BASE_PATH: '/stem-splitter', CAIL_COURSE_IDS: 'msh-245-the-american-musical-experience-fall-2026-01',
      AUTH_MODE: 'cail', CAIL_CLASSROOM_ENABLED: 'true', DB: db as unknown as D1Database,
      REQUEST_LIMIT: { limit: async () => ({ success: true, reset: 0 }) },
      ADMISSION_RESOLVER: { resolveCourseAccessV2: async () => ({ ok: false, retryable: false, code: 'not_enrolled' }) },
    } as unknown as Env;
    const issued = await createBrowserTransferProof(env, user);
    const { proof } = await json(issued) as { proof: string };
    assert.equal((await authorizeBrowserTransferSource({ ...env, APP_BASE_PATH: undefined }, user, proof)).status, 200);
    const staged = await stageBrowserTransfer(env, user, proof, ['personal-ok', 'course-revoked']);
    assert.equal(staged.status, 200);
    assert.deepEqual((await json(staged)).allowedJobIds, ['personal-ok']);
    const checked = await reauthorizeBrowserTransferJobs(env, user, ['personal-ok', 'course-revoked']);
    assert.equal(checked.status, 200);
    assert.deepEqual((await json(checked)).allowedJobIds, ['personal-ok']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
