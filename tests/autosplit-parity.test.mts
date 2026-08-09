import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePcm } from '../audio-analysis/classifier.ts';
import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import { parseAudioAnalysisResult } from '../src/analysis/contract.ts';
import { PINNED_ROLE_CLASSIFIER_VERSION } from '../src/analysis/types.ts';
import { goldenAutoSplitFixtures, GOLDEN_SAMPLE_RATE } from './fixtures/autosplit-golden.mts';
import '../public/autosplit.js';

const AutoSplit = (globalThis as Record<string, any>).AutoSplit as {
  extractFeatures(samples: Float32Array, sampleRate: number): Record<string, number | boolean>;
  chooseSplit(features: Record<string, number | boolean>): { choice: 'two' | 'four' | 'six'; reason: string };
  ANALYSIS_SAMPLE_RATE: number;
  ROLE_CLASSIFIER_VERSION: string;
};

const CORE_MODELS = [
  { id: 'vocals_instrumental', stems: ['vocals', 'instrumental'] },
  { id: 'htdemucs_ft', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] },
];

test('browser and server use the same pinned classifier and PCM rate', () => {
  assert.equal(AutoSplit.ROLE_CLASSIFIER_VERSION, PINNED_ROLE_CLASSIFIER_VERSION);
  assert.equal(AutoSplit.ANALYSIS_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE);
  assert.equal(GOLDEN_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE);
});

for (const fixture of goldenAutoSplitFixtures()) {
  test(`browser/server parity: ${fixture.id}`, () => {
    const bytes = Buffer.from(
      fixture.samples.buffer,
      fixture.samples.byteOffset,
      fixture.samples.byteLength
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);

    const browserFeatures = AutoSplit.extractFeatures(fixture.samples, GOLDEN_SAMPLE_RATE);
    const browserDecision = AutoSplit.chooseSplit(browserFeatures);
    const serverResult = analyzePcm({
      samples: fixture.samples,
      sampleRate: GOLDEN_SAMPLE_RATE,
      analyzedSeconds: fixture.samples.length / GOLDEN_SAMPLE_RATE,
      coreModels: CORE_MODELS,
      fallbackModel: 'htdemucs_ft',
      totalMs: 1,
    });

    assert.equal(browserDecision.choice, fixture.expectedChoice);
    assert.equal(serverResult.decision.choice, fixture.expectedChoice);
    assert.equal(serverResult.decision.reason, browserDecision.reason);
    assert.deepEqual(serverResult.decision.features, browserFeatures);
    assert.equal(serverResult.roleClassifier.version, AutoSplit.ROLE_CLASSIFIER_VERSION);
    assert.equal(serverResult.degraded.active, false);
    assert.deepEqual(
      parseAudioAnalysisResult(serverResult, CORE_MODELS, 'htdemucs_ft', false),
      serverResult
    );
  });
}
