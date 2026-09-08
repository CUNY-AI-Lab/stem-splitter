import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { assistantRequestEnv, fleetConfiguration } from '../src/fleet.ts';
import type { Env } from '../src/env.ts';

const issuer = await createTestIdentityIssuer();
const env = { CAIL_IDENTITY_ISSUER: issuer.issuer, CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_GATEWAY_URL: 'http://127.0.0.1:9999', CAIL_SOURCE_VERSION: 'a'.repeat(40), LOCAL_DEV: '1', ASSISTANT_MODEL: 'test' } as Env;
async function token(audience: string, subject = `cail-${'1'.repeat(32)}`) {
 return issuer.mintIdentityJwt({ audience, subject });
}
test('configuration fails closed without exact release and private verifier configuration', async () => {
 assert.equal(await fleetConfiguration({} as Env), null);
 assert.equal(await fleetConfiguration({ ...env, CAIL_SOURCE_VERSION: 'main' }), null);
});
test('model authority requires separate matching audience-bound identities', async () => {
 assert.notEqual(await fleetConfiguration(env), null);
 const app = await token('cail:stem-splitter');
 const gateway = await token('cail:gateway');
 const request = (a: string, g?: string) => new Request('http://localhost/api/jobs/shared/chat', { headers: { 'x-cail-identity-jwt': a, ...(g ? { 'x-cail-gateway-identity-jwt': g } : {}) } });
 assert.equal(await assistantRequestEnv(env, request(app), 'shared'), 401);
 assert.equal(await assistantRequestEnv(env, request(gateway, gateway), 'shared'), 401);
 assert.equal(await assistantRequestEnv(env, request(app, await token('cail:gateway', `cail-${'2'.repeat(32)}`)), 'shared'), 401);
 const authorized = await assistantRequestEnv(env, request(app, gateway), 'shared');
 assert.equal(typeof authorized, 'object');
 if (typeof authorized === 'object') {
  assert.equal(authorized.CAIL_GATEWAY_IDENTITY_JWT, gateway);
  assert.equal(authorized.CAIL_CONVERSATION_ID, 'stem-splitter:shared');
  assert.equal('subject' in authorized, false);
 }
});
