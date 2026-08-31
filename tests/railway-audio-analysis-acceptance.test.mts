import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  loadRailwayAudioAnalysisAcceptance,
  RAILWAY_AUDIO_ANALYSIS_ACCEPTANCE_PATH,
  validateRailwayAudioAnalysisAcceptance,
} from '../scripts/lib/railway-audio-analysis-acceptance.mts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

function evidence(): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, RAILWAY_AUDIO_ANALYSIS_ACCEPTANCE_PATH), 'utf8')
  ) as Record<string, any>;
}

test('the Railway analyzer acceptance binds private topology, limits, restart, and rollback', () => {
  const accepted = loadRailwayAudioAnalysisAcceptance(REPOSITORY_ROOT);
  assert.equal(accepted.analyzerServiceId, 'f8e3b4a6-f370-4877-a6fb-64655e43ce25');
  assert.equal(accepted.restartDeploymentId, 'd2734626-d06a-41ba-a90e-9f7d57b09418');
  assert.equal(accepted.offDeploymentId, '8ae0e06a-1106-4892-810b-f01e5e4d6c14');
});

test('Railway analyzer acceptance fails closed on topology, runtime, rollback, and safety drift', () => {
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ['schema', (value) => { value.$schema = 'stem-splitter.railway-audio-analysis-acceptance.v0'; }],
    ['public domain', (value) => { value.railway.publicDomain = 'audio-analysis.example'; }],
    ['resource cap', (value) => { value.railway.limits.memoryBytes = 2_000_000_000; }],
    ['classifier', (value) => { value.runtime.readiness.classifierVersion = 'autosplit-role-v3'; }],
    ['source', (value) => { value.source.testAudio.sha256 = '0'.repeat(64); }],
    ['restart', (value) => { value.railway.restartDeploymentStatus = 'FAILED'; }],
    ['rollback', (value) => { value.rollback.offRoutingAdvertised = true; }],
    ['secret output', (value) => { value.safety.secretsPrinted = 1; }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = evidence();
    mutate(candidate);
    assert.throws(
      () => validateRailwayAudioAnalysisAcceptance(candidate, REPOSITORY_ROOT),
      undefined,
      name
    );
  }
});
