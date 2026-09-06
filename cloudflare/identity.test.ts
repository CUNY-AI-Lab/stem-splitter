import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { authorizeCailRequest, STEM_AUDIENCE, type AppPrincipal } from '../src/identity.ts';
import { SqliteD1 } from '../server/d1.ts';
import type { Env } from '../src/env.ts';
import { verifyCailIdentity } from './verify.ts';

const issuer = await createTestIdentityIssuer();
const alice = await issuer.mintIdentityJwt({ audience: STEM_AUDIENCE, subject: TEST_SUBJECTS.alice });
const bob = await issuer.mintIdentityJwt({ audience: STEM_AUDIENCE, subject: TEST_SUBJECTS.bob });
function setup() {
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const membership = { ok: true, expiresAt: new Date(Date.now() + 60000).toISOString(), revision: 1, accessRole: 'member', budgetScope: 'person' };
  const env = { AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://split.test', CAIL_IDENTITY_JWKS: issuer.jwksJson, DB: db, verifyCailIdentity,
    ADMISSION_RESOLVER: { resolveMembership: async () => membership } } as unknown as Env;
  return { db, env, membership };
}
function req(path = '/api/account', token = alice, method = 'GET', origin = 'https://split.test') {
  return new Request(`https://split.test${path}`, { method, headers: { 'x-cail-identity-jwt': token, origin } });
}

test('valid CAIL identity becomes a student; display and entitlement claims never grant instructor authority', async () => {
  const { env } = setup();
  const token = await issuer.mintIdentityJwt({ audience: STEM_AUDIENCE, entitlements: ['admin', 'instructor'] });
  const request = req('/api/account', token);
  const principals: AppPrincipal[] = [];
  assert.equal(await authorizeCailRequest(request, env, (principal) => principals.push(principal)), null);
  assert.equal(principals[0]?.role, 'student');
  assert.equal((await authorizeCailRequest(req('/api/teacher/prompt', token), env))?.status, 403);
});
test('wrong audience, array audience, expired token, wrong issuer, forged header fail authentication', async () => {
  const { env } = setup();
  const tokens = ['forged', '', await issuer.mintIdentityJwt({ audience: 'cail:gateway' }),
    await issuer.mintIdentityJwt({ audience: [STEM_AUDIENCE] }),
    await issuer.mintIdentityJwt({ audience: STEM_AUDIENCE, expiresInSeconds: -120 }),
    await issuer.mintIdentityJwt({ audience: STEM_AUDIENCE, issuer: 'https://attacker.test' })];
  for (const token of tokens) assert.equal((await authorizeCailRequest(req('/api/account', token), env))?.status, 401);
});
test('invalid verification configuration returns 503', async () => {
  const { env } = setup();
  env.CAIL_IDENTITY_JWKS = '{}';
  assert.equal((await authorizeCailRequest(req(), env))?.status, 503);
});
test('revocation and expiry take effect on the next request; resolver errors are 503', async () => {
  const { env, membership } = setup();
  assert.equal(await authorizeCailRequest(req(), env), null);
  membership.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await authorizeCailRequest(req(), env))?.status, 403);
  env.ADMISSION_RESOLVER = { resolveMembership: async () => ({ ok: false, code: 'not_admitted', retryable: false }) };
  assert.equal((await authorizeCailRequest(req(), env))?.status, 403);
  env.ADMISSION_RESOLVER = { resolveMembership: async () => { throw new Error('private resolver details'); } };
  const response = await authorizeCailRequest(req(), env);
  assert.equal(response?.status, 503);
  assert.doesNotMatch(await response!.text(), /private resolver/);
});
test('browser writes require the exact same origin; ordinary identity headers cannot substitute', async () => {
  const { env } = setup();
  assert.equal((await authorizeCailRequest(req('/api/jobs', alice, 'POST', 'https://attacker.test'), env))?.status, 403);
  const forged = new Request('https://split.test/api/account', { headers: { 'x-cail-subject': TEST_SUBJECTS.alice, 'x-class-code': 'anything' } });
  assert.equal((await authorizeCailRequest(forged, env))?.status, 401);
});
test('jobs and stem audio require ownership; an unclaimed legacy job is closed', async () => {
  const { env, db } = setup();
  await authorizeCailRequest(req(), env);
  await db.prepare("INSERT INTO jobs (id, filename, source_key, status) VALUES ('owned', 'song', 'uploads/x/song.wav', 'done')").run();
  await db.prepare("INSERT INTO job_owners (job_id, subject) VALUES ('owned', ?)").bind(TEST_SUBJECTS.alice).run();
  for (const path of ['/api/jobs/owned', '/api/files/stems/owned/vocals.mp3']) {
    assert.equal(await authorizeCailRequest(req(path), env), null);
    assert.equal((await authorizeCailRequest(req(path, bob), env))?.status, 404);
  }
  assert.equal((await authorizeCailRequest(req('/api/jobs/legacy'), env))?.status, 404);
});
test('workspace disable and instructor expiry are enforced without a new login', async () => {
  const { env, db } = setup();
  await authorizeCailRequest(req(), env);
  await db.prepare('UPDATE app_users SET role = ?, role_expires_at = ?, updated_by = ?, revision = revision + 1 WHERE subject = ?')
    .bind('instructor', new Date(Date.now() + 60000).toISOString(), TEST_SUBJECTS.bob, TEST_SUBJECTS.alice).run();
  assert.equal(await authorizeCailRequest(req('/api/teacher/prompt'), env), null);
  await db.prepare('UPDATE app_users SET disabled = 1, revision = revision + 1 WHERE subject = ?').bind(TEST_SUBJECTS.alice).run();
  assert.equal((await authorizeCailRequest(req(), env))?.status, 403);
  const events = await db.prepare('SELECT * FROM app_user_events').all();
  assert.equal(events.results.length, 2);
  await assert.rejects(db.prepare('DELETE FROM app_user_events').run(), /immutable/);
});
test('only current Admission administrators gain account-management authority', async () => {
  const { env, membership } = setup();
  assert.equal((await authorizeCailRequest(req('/api/admin/users'), env))?.status, 403);
  membership.accessRole = 'admin'; membership.budgetScope = 'admin';
  assert.equal(await authorizeCailRequest(req('/api/admin/users'), env), null);
  membership.accessRole = 'member'; membership.budgetScope = 'person';
  assert.equal((await authorizeCailRequest(req('/api/admin/users'), env))?.status, 403);
});
