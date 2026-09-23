import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfiguration, deploymentState } from './railway.mjs';
const vars = { NODE_AUTH_TOKEN: 'synthetic', CAIL_IDENTITY_JWKS: 'public', CAIL_READINESS_TOKEN: 'synthetic', WEBHOOK_SECRET: 'synthetic', CLASS_CODE: 'synthetic', DATA_DIR: '/data', CAIL_GATEWAY_URL: 'https://tools.ailab.gc.cuny.edu', CAIL_IDENTITY_ISSUER: 'https://tools.ailab.gc.cuny.edu/cail-sso', ASSISTANT_MODEL: 'glm-5.2', PUBLIC_BASE_URL: 'https://stem.example.test' };
test('release rejects unsafe storage, provider-prefixed models, incomplete identity and non-TLS origins', () => {
  assert.equal(validateConfiguration(vars), 'https://stem.example.test/api/fleet/readyz');
  for (const change of [{ DATA_DIR: '/tmp' }, { ASSISTANT_MODEL: 'vendor/model' }, { CAIL_IDENTITY_JWKS: '' }, { NODE_AUTH_TOKEN: '' }, { CAIL_GATEWAY_URL: 'https://tools.ailab.gc.cuny.edu/v1' }, { PUBLIC_BASE_URL: 'http://stem.example.test' }]) assert.throws(() => validateConfiguration({ ...vars, ...change }));
});
test('a different or failed deployment cannot satisfy an uploaded release', () => {
  assert.equal(deploymentState([{ id: 'mine', status: 'BUILDING' }], 'mine'), 'pending');
  assert.equal(deploymentState([{ id: 'mine', status: 'SUCCESS' }, { id: 'old', status: 'REMOVED' }], 'mine'), 'success');
  for (const items of [[{ id: 'other', status: 'SUCCESS' }], [{ id: 'mine', status: 'FAILED' }], [{ id: 'mine', status: 'SUCCESS' }, { id: 'other', status: 'SUCCESS' }], [{ id: 'mine', status: 'NEEDS_APPROVAL' }]]) assert.throws(() => deploymentState(items, 'mine'));
});
