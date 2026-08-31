import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  loadRailwayAutoShadowAcceptance,
  RAILWAY_AUTO_SHADOW_ACCEPTANCE_PATH,
  validateRailwayAutoShadowAcceptance,
} from '../scripts/lib/railway-auto-shadow-acceptance.mts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

function evidence(): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, RAILWAY_AUTO_SHADOW_ACCEPTANCE_PATH), 'utf8')
  ) as Record<string, any>;
}

test('Railway Auto shadow acceptance binds all source types, fallback, audience guard, and screenshots', () => {
  const accepted = loadRailwayAutoShadowAcceptance(REPOSITORY_ROOT);
  assert.equal(accepted.restoreDeploymentId, '41237f5b-88e6-4356-832b-d002c58a6575');
  assert.deepEqual(accepted.jobIds, [
    '99e780fe-1a16-4a8e-b908-4955571f52b5',
    'a770fd04-694e-45f4-8aa3-125bff7d3403',
    'b09fac45-6f8f-4f48-96e3-a5da12d2931c',
    '3f106bad-f416-4372-9195-a374d673cfdd',
  ]);
});

test('Railway Auto shadow acceptance fails closed on authority, source, fallback, audience, and screenshot drift', () => {
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ['schema', (value) => { value.$schema = 'stem-splitter.railway-auto-shadow-acceptance.v0'; }],
    ['CI source', (value) => { value.source.ci.headSha = '0'.repeat(40); }],
    ['authority', (value) => { value.journeys[0].analysis.shadowApplied = true; }],
    ['remote recommendation', (value) => { value.journeys[2].analysis.choice = 'four'; }],
    ['fallback', (value) => { value.fallback.degradedCode = null; }],
    ['audience', (value) => { value.audienceGuard.sourceHashPresent = true; }],
    ['screenshot', (value) => { value.screenshots[0].sha256 = '0'.repeat(64); }],
    ['secret output', (value) => { value.safety.secretsPrinted = 1; }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = evidence();
    mutate(candidate);
    assert.throws(
      () => validateRailwayAutoShadowAcceptance(candidate, REPOSITORY_ROOT),
      undefined,
      name
    );
  }
});
