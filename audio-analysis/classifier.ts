import '../public/autosplit.js';
import {
  AUDIO_ANALYSIS_SCHEMA_VERSION,
  PINNED_ROLE_CLASSIFIER_VERSION,
  type AudioAnalysisResultV1,
  type CoreModelContract,
  type CoreSplitChoice,
  type RoleFeaturesV1,
} from '../src/analysis/types.ts';

interface AutoSplitRuntime {
  extractFeatures(samples: Float32Array, sampleRate: number): RoleFeaturesV1;
  chooseSplit(features: RoleFeaturesV1): { choice: CoreSplitChoice; reason: string };
  ROLE_CLASSIFIER_VERSION: typeof PINNED_ROLE_CLASSIFIER_VERSION;
}

function runtime(): AutoSplitRuntime {
  const value = (globalThis as typeof globalThis & { AutoSplit?: AutoSplitRuntime }).AutoSplit;
  if (!value || value.ROLE_CLASSIFIER_VERSION !== PINNED_ROLE_CLASSIFIER_VERSION) {
    throw new Error('role classifier is unavailable or unpinned');
  }
  return value;
}

export function analyzePcm(input: {
  samples: Float32Array;
  sampleRate: number;
  analyzedSeconds: number;
  coreModels: readonly CoreModelContract[];
  fallbackModel: string;
  totalMs: number;
}): AudioAnalysisResultV1 {
  const classifier = runtime();
  const features = classifier.extractFeatures(input.samples, input.sampleRate);
  const verdict = classifier.chooseSplit(features);
  const desiredTracks = { two: 2, four: 4, six: 6 }[verdict.choice];
  const resolved = input.coreModels.find((model) => model.stems.length === desiredTracks);

  if (!resolved) {
    return {
      schemaVersion: AUDIO_ANALYSIS_SCHEMA_VERSION,
      roleClassifier: { version: classifier.ROLE_CLASSIFIER_VERSION },
      decision: {
        choice: 'fallback',
        resolvedCoreModel: input.fallbackModel,
        confidence: null,
        features,
        reason: 'the recommended track count is unavailable — using the default split',
      },
      detectedInstruments: [],
      timing: { totalMs: input.totalMs, analyzedSeconds: input.analyzedSeconds },
      degraded: { active: true, code: 'analysis_model_unsupported' },
    };
  }

  return {
    schemaVersion: AUDIO_ANALYSIS_SCHEMA_VERSION,
    roleClassifier: { version: classifier.ROLE_CLASSIFIER_VERSION },
    decision: {
      choice: verdict.choice,
      resolvedCoreModel: resolved.id,
      confidence: null,
      features,
      reason: verdict.reason,
    },
    detectedInstruments: [],
    timing: { totalMs: input.totalMs, analyzedSeconds: input.analyzedSeconds },
    degraded: { active: false, code: null },
  };
}

export function roleClassifierVersion(): string {
  return runtime().ROLE_CLASSIFIER_VERSION;
}
