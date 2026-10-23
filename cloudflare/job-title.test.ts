import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { SqliteD1 } from '../server/d1.ts';
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { verifyCailIdentity } from './verify.ts';
import { dailyWindow } from '../src/daily-allowance.ts';

const origin = 'https://split.test';
const owner = TEST_SUBJECTS.alice;
const other = TEST_SUBJECTS.bob;
const instructor = TEST_SUBJECTS.carol;
const admin = 'cail-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const issuer = await createTestIdentityIssuer();
const tokens = new Map(await Promise.all([owner, other, instructor, admin].map(async subject =>
  [subject, await issuer.mintIdentityJwt({ subject, audience: 'cail:stem-splitter' })] as const)));

async function fixture() {
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  for (const subject of [owner, other, instructor, admin]) {
    await db.prepare('INSERT INTO app_users(subject,role) VALUES(?,?)')
      .bind(subject, [owner, instructor].includes(subject) ? 'instructor' : 'student').run();
  }
  await db.prepare(`INSERT INTO jobs(id,filename,source_key,status,model,stems)
    VALUES('recording','Long imported recording title','uploads/recording/source.mp3','done','htdemucs_ft','[]'),
      ('other-recording','Another recording','uploads/other/source.mp3','done','htdemucs_ft','[]')`).run();
  await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?),(?,?)')
    .bind('recording', owner, 'other-recording', other).run();
  for (const folder of ['lesson', 'second-lesson']) {
    await db.prepare('INSERT INTO folders(id,name,created_by) VALUES(?,?,?)').bind(folder, folder, owner).run();
    await db.prepare('INSERT INTO folder_items(folder_id,job_id,filename,model,added_by) VALUES(?,?,?,?,?)')
      .bind(folder, 'recording', 'Long imported recording title', 'htdemucs_ft', owner).run();
  }
  await db.prepare('INSERT INTO folder_items(folder_id,job_id,filename,model,added_by) VALUES(?,?,?,?,?)')
    .bind('lesson', 'other-recording', 'Another recording', 'htdemucs_ft', owner).run();
  const env = {
    DB: db, AUTH_MODE: 'cail', PUBLIC_BASE_URL: origin, CAIL_CLASSROOM_ENABLED: 'false',
    CAIL_IDENTITY_JWKS: issuer.jwksJson, verifyCailIdentity,
    ADMISSION_RESOLVER: {
      resolveMembership: async ({ subject }: { subject: string }) => ({
        ok: true, accessRole: subject === admin ? 'admin' : 'member', budgetScope: subject === admin ? 'admin' : 'person',
        revision: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      resolveCourseAccessV2: async () => ({ ok: false, code: 'not_enrolled', retryable: false }),
    },
  } as unknown as Env;
  const call = (path: string, subject: string | null = owner, init: RequestInit = {}) => app.fetch(new Request(origin + path, {
    ...init, headers: { Origin: origin, 'Content-Type': 'application/json',
      ...(subject ? { 'x-cail-identity-jwt': tokens.get(subject)! } : {}), ...init.headers },
  }), env);
  const rename = (title: unknown, subject: string | null = owner) =>
    call('/api/jobs/recording/title', subject, { method: 'PUT', body: JSON.stringify({ title }) });
  return { db, env, call, rename };
}

test('owners rename imported recordings and every folder snapshot in one transaction', async () => {
  const { db, call, rename } = await fixture();
  const title = '心の歌 — Águas de Março 🎵';
  const response = await rename(`  ${title}  `);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { filename: title });
  const recording = await db.prepare('SELECT filename,source_key,model,stems FROM jobs WHERE id=?').bind('recording').first();
  assert.deepEqual({ ...recording }, { filename: title, source_key: 'uploads/recording/source.mp3', model: 'htdemucs_ft', stems: '[]' });
  const { results } = await db.prepare('SELECT filename FROM folder_items WHERE job_id=?').bind('recording').all();
  assert.deepEqual(results.map(row => row.filename), [title, title]);
  assert.equal((await db.prepare('SELECT filename FROM folder_items WHERE job_id=?').bind('other-recording').first())?.filename, 'Another recording');
  assert.equal((await (await call('/api/jobs/recording')).json() as any).filename, title);
  const folder = await call('/api/teacher/folders/lesson');
  assert.equal(folder.status, 200);
  assert.equal((await folder.json() as any).items.find((item: any) => item.jobId === 'recording').filename, title);
  await call('/api/jobs/recording/share', owner, { method: 'POST', body: '{}' });
  assert.equal((await (await call('/api/shared-jobs/recording', null)).json() as any).filename, title);
});

test('private, shared and instructor review visibility grant no rename authority', async () => {
  const { db, call, rename } = await fixture();
  for (const subject of [other, instructor, admin]) assert.equal((await rename('Changed by another person', subject)).status, 404, subject);
  assert.equal((await rename('Anonymous edit', null)).status, 401);
  assert.equal((await call('/api/jobs/recording/title', owner, {
    method: 'PUT', headers: { Origin: 'https://other.test' }, body: '{"title":"Cross-site edit"}',
  })).status, 403);
  await call('/api/jobs/recording/share', owner, { method: 'POST', body: '{}' });
  assert.equal((await call('/api/shared-jobs/recording', null)).status, 200);
  assert.equal((await call('/api/shared-jobs/recording/title', null, { method: 'PUT', body: '{"title":"Public edit"}' })).status, 401);
  assert.equal((await call(`/api/teacher/students/${owner}/jobs/recording/title`, instructor, {
    method: 'PUT', body: '{"title":"Instructor review edit"}',
  })).status, 404);
  assert.equal((await db.prepare('SELECT filename FROM jobs WHERE id=?').bind('recording').first())?.filename, 'Long imported recording title');
});

test('titles require bounded single-line text and retain Unicode as plain text', async () => {
  const { db, call, rename } = await fixture();
  for (const title of [null, 17, [], {}, '', '   ', 'a'.repeat(201), 'Line one\nLine two', 'Null\u0000byte', 'Hidden\u202eorder', 'Line\u2028break']) {
    assert.equal((await rename(title)).status, 400, JSON.stringify(title));
  }
  for (const body of ['null', '[]', '{}', '{"title":']) {
    assert.equal((await call('/api/jobs/recording/title', owner, { method: 'PUT', body })).status, 400, body);
  }
  assert.equal((await call('/api/jobs/missing/title', owner, { method: 'PUT', body: '{"title":"Title"}' })).status, 404);
  assert.equal((await rename('🎵'.repeat(200))).status, 200, 'limit counts Unicode code points');
  const literal = '<b>Music & listening</b>';
  assert.deepEqual(await (await rename(literal)).json(), { filename: literal });
  assert.equal((await db.prepare('SELECT filename FROM jobs WHERE id=?').bind('recording').first())?.filename, literal);
});

test('a folder update failure rolls back the recording title', async t => {
  const { db, rename } = await fixture();
  db.applySchema(`CREATE TRIGGER reject_folder_title BEFORE UPDATE OF filename ON folder_items
    BEGIN SELECT RAISE(ABORT, 'fixture folder write failed'); END;`);
  t.mock.method(console, 'error', () => {});
  assert.equal((await rename('Title that cannot be committed')).status, 503);
  assert.equal((await db.prepare('SELECT filename FROM jobs WHERE id=?').bind('recording').first())?.filename, 'Long imported recording title');
  const { results } = await db.prepare('SELECT filename FROM folder_items WHERE job_id=?').bind('recording').all();
  assert.ok(results.every(row => row.filename === 'Long imported recording title'));
});

test('legacy recording rename uses the existing class-code write gate', async () => {
  const { db, env } = await fixture();
  env.AUTH_MODE = 'class-code';
  env.CLASS_CODE = 'fixture-class-code';
  const rename = (code: string) => app.fetch(new Request(origin + '/api/jobs/recording/title', {
    method: 'PUT', headers: { 'x-class-code': code, 'Content-Type': 'application/json' }, body: '{"title":"Legacy title"}',
  }), env);
  assert.equal((await rename('')).status, 401);
  assert.equal((await rename('wrong')).status, 401);
  assert.equal((await rename('fixture-class-code')).status, 200);
  assert.equal((await db.prepare('SELECT filename FROM jobs WHERE id=?').bind('recording').first())?.filename, 'Legacy title');
});

test('guest owners can rename their recording while other guest and member recordings stay private', async () => {
  const { db, env } = await fixture();
  const subject = 'guest-' + 'a'.repeat(64), otherGuest = 'guest-' + 'b'.repeat(64);
  const expiresAt = Date.now() + 60_000, verifiedDay = dailyWindow().day;
  for (const guest of [subject, otherGuest]) {
    await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
      .bind(guest, Date.now(), expiresAt, verifiedDay).run();
  }
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('guest-recording','Imported guest title','uploads/guest/source.mp3','done')").run();
  await db.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind('guest-recording', subject).run();
  env.guestRuntimeReady = true;
  const rename = (guest: string, id = 'guest-recording', method = 'PUT') => app.fetch(new Request(origin + `/api/jobs/${id}/title`, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{"title":"Guest’s chosen title"}' }),
  }), { ...env, guestSession: { subject: guest, expiresAt, verifiedDay } });
  assert.equal((await rename(otherGuest)).status, 404);
  assert.equal((await rename(subject, 'recording')).status, 404);
  assert.equal((await rename(subject, 'guest-recording', 'POST')).status, 403);
  assert.equal((await rename(subject, 'guest-recording', 'GET')).status, 403);
  const response = await rename(subject);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { filename: 'Guest’s chosen title' });
  assert.equal((await db.prepare('SELECT filename FROM jobs WHERE id=?').bind('guest-recording').first())?.filename, 'Guest’s chosen title');
});

test('folder rename preserves identity and contents, validates names and enforces existing ownership', async () => {
  const {db,call}=await fixture();
  const path='/api/teacher/folders/lesson';
  const update=(name:unknown,expectedName='lesson',subject:string|null=owner)=>call(path,subject,{method:'PUT',body:JSON.stringify({name,expectedName})});
  const before=await db.prepare('SELECT * FROM folder_items WHERE folder_id=?').bind('lesson').all();
  for(const name of ['', '  ', 'x'.repeat(81),null])assert.equal((await update(name)).status,400);
  assert.equal((await update('Forbidden','lesson',instructor)).status,404);
  assert.equal((await update('Forbidden','lesson',other)).status,403);
  assert.equal((await update('Forbidden','lesson',null)).status,401);
  assert.equal((await update('  New teaching folder  ')).status,200);
  assert.equal((await update('Stale edit')).status,409);
  assert.equal((await update('New teaching folder','New teaching folder')).status,200);
  const detail=await(await call(path)).json() as any;
  assert.equal(detail.folder.id,'lesson');assert.equal(detail.folder.name,'New teaching folder');
  assert.equal((await db.prepare('SELECT created_by FROM folders WHERE id=?').bind('lesson').first())?.created_by,owner);
  assert.deepEqual(await db.prepare('SELECT * FROM folder_items WHERE folder_id=?').bind('lesson').all(),before);
});
