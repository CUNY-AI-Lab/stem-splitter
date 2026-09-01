import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EFFICIENTAT_EVALUATION_SOURCE_PATHS,
  efficientatEvaluationSourcePins,
  loadMapping,
  secondWindowScore,
  validateComparatorOutput,
} from '../scripts/eval-efficientat-comparator.mts';
import { validateSmokeOutput } from '../scripts/smoke-efficientat-comparator-image.mts';

const mapping = JSON.parse(readFileSync('efficientat-comparator/mapping.json', 'utf8')) as {
  mapped: Array<{ instrumentId: string }>;
  unsupported: Array<{ instrumentId: string }>;
  scoringPolicy: Record<string, unknown>;
};
const supportedIds = mapping.mapped.map((item) => item.instrumentId);

function validOutput() {
  const metrics = Object.fromEntries(
    supportedIds.map((id, index) => {
      const score = Number((0.2 + index / 1000).toFixed(8));
      return [
        id,
        {
          top3Mean: score,
          maximum: score,
          mean: score,
          patchesAtLeastHalf: 0,
        },
      ];
    })
  );
  return {
    $schema: 'stem-splitter.efficientat-comparator-output.v1',
    classifierVersion:
      'efficientat-mn10-audioset-527-pcm22050-sinc32k-upstream-mel-single-clip-sigmoid-second-window-v1@github-release-v0.0.1',
    modelSha256: '0bd7dc2443af498c289a2e739f02ebb515d6aa3fd3ab9db539c86123ae368a4e',
    classMapSha256: 'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429',
    mappingSha256: 'b8aa419a47b612144655b2f3409fbb6eb27aabed79b49717a20f96a0f15ad50d',
    vocabularyVersion: 'classroom-instruments-v1',
    vocabularySha256: '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140',
    scoringPolicyVersion: 'single-clip-sigmoid-second-window-v1',
    inputSampleRate: 22_050,
    windowsAnalyzed: 1,
    loadMs: 140,
    timingMs: 170,
    windows: [
      {
        resampledSamples: 96_000,
        patches: 1,
        inferenceMs: 30,
        metrics,
        topClasses: Array.from({ length: 12 }, (_, index) => ({
          index,
          mid: `/m/class_${index}`,
          displayName: `Class ${index}`,
          top3Mean: Number((0.99 - index / 100).toFixed(8)),
        })),
      },
    ],
  };
}

test('EfficientAT mapping adds ukulele while preserving explicit unsupported labels', () => {
  const vocabulary = JSON.parse(readFileSync('instrument-discovery/vocabulary.json', 'utf8')) as {
    instruments: Array<{ id: string }>;
  };
  const parsed = loadMapping(vocabulary.instruments.map((item) => item.id));
  assert.equal(parsed.supportedIds.length, 37);
  assert.equal(parsed.unsupported.length, 14);
  assert.ok(parsed.supportedIds.includes('ukulele'));
  assert.equal(new Set(parsed.supportedIds).size, 37);
  assert.deepEqual(mapping.scoringPolicy, {
    classAggregation: 'maximum',
    clipAggregation: 'single-sigmoid',
    trackAggregation: 'second-highest-window',
    singleWindowException: true,
    thresholdSelection: 'none',
  });
});

test('EfficientAT uses second-window support without selecting a threshold', () => {
  assert.equal(secondWindowScore([0.7]), 0.7);
  assert.equal(secondWindowScore([0.8, 0.4]), 0.4);
  assert.equal(secondWindowScore([0.2, 0.9, 0.6]), 0.6);
  assert.throws(() => secondWindowScore([]), /window scores/);
  assert.throws(() => secondWindowScore([Number.NaN]), /window scores/);
});

test('EfficientAT output requires every artifact and exact mapped-score pin', () => {
  const output = validOutput();
  const parsed = validateComparatorOutput(output, 1, supportedIds);
  assert.equal(parsed.windows.length, 1);
  assert.equal(Object.keys(parsed.windows[0].metrics).length, 37);
  assert.equal(parsed.windows[0].patches, 1);
  assert.throws(
    () => validateComparatorOutput({ ...output, modelSha256: '0'.repeat(64) }, 1, supportedIds),
    /identity/
  );
  const missing = structuredClone(output);
  delete missing.windows[0].metrics.ukulele;
  assert.throws(() => validateComparatorOutput(missing, 1, supportedIds), /metrics|missing/);
  const extraClip = structuredClone(output);
  extraClip.windows[0].patches = 2;
  assert.throws(() => validateComparatorOutput(extraClip, 1, supportedIds), /clip count/);
});

test('EfficientAT smoke validates the complete synthetic response', () => {
  const output = validOutput();
  assert.deepEqual(validateSmokeOutput(output, supportedIds), {
    loadMs: 140,
    timingMs: 170,
    resampledSamples: 96_000,
    patches: 1,
    inferenceMs: 30,
    metricCount: 37,
    topClassCount: 12,
  });
  const inconsistentTiming = structuredClone(output);
  inconsistentTiming.timingMs = 100;
  assert.throws(() => validateSmokeOutput(inconsistentTiming, supportedIds), /timing/);
});

test('EfficientAT evaluators bind every score-affecting source and constrained container flag', () => {
  const evaluator = readFileSync('scripts/eval-efficientat-comparator.mts', 'utf8');
  const controls = readFileSync('scripts/eval-efficientat-controls.mts', 'utf8');
  const runner = readFileSync('scripts/run-efficientat-comparator-eval.sh', 'utf8');
  for (const requirement of [
    "'--pull'",
    "'never'",
    "'--network'",
    "'none'",
    "'--read-only'",
    "'/tmp:rw,noexec,nosuid,nodev,size=64m'",
    "'--cap-drop'",
    "'ALL'",
    "'no-new-privileges'",
    "'--pids-limit'",
    "'--cpus'",
    "'--memory'",
    "'--memory-swap'",
    "'--log-driver'",
  ]) {
    assert.equal(evaluator.includes(requirement), true, `evaluator is missing ${requirement}`);
  }
  assert.match(evaluator, /source-sha256\.json/);
  assert.match(evaluator, /promotionEligible: false/);
  assert.match(controls, /dataset-authored-controls-awaiting-teacher-listening/);
  assert.match(controls, /precisionClaim: 'none-review-pending'/);
  assert.match(runner, /EFFICIENTAT_COMPARATOR_IMAGE/);
  assert.doesNotMatch(evaluator, /--network[ =]host/);

  const sourcePins = efficientatEvaluationSourcePins();
  assert.deepEqual(Object.keys(sourcePins), Object.keys(EFFICIENTAT_EVALUATION_SOURCE_PATHS));
  for (const [name, path] of Object.entries(EFFICIENTAT_EVALUATION_SOURCE_PATHS)) {
    assert.deepEqual(sourcePins[name as keyof typeof sourcePins], {
      path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
  }
});

test('native workflow produces comparison evidence without enabling production', () => {
  const workflow = readFileSync('.github/workflows/efficientat-comparator-image.yml', 'utf8');
  const smoke = readFileSync('scripts/smoke-efficientat-comparator-image.mts', 'utf8');
  const comparison = readFileSync('scripts/compare-instrument-classifiers.mts', 'utf8');
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /docker build --pull --platform linux\/amd64/);
  assert.match(workflow, /EFFICIENTAT_COMPARATOR_EXPECTED_PLATFORM: linux\/amd64/);
  assert.match(workflow, /compare-instrument-classifiers\.mts/);
  assert.match(workflow, /instrument-classifier-comparison\.json/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /railway up|wrangler deploy/);
  for (const path of Object.values(EFFICIENTAT_EVALUATION_SOURCE_PATHS)) {
    const covered =
      workflow.includes(`- ${path}`) ||
      (path.startsWith('efficientat-comparator/') && workflow.includes('- efficientat-comparator/**'));
    assert.equal(covered, true, `native workflow does not watch ${path}`);
  }
  assert.match(smoke, /LICENSE\.EfficientAT/);
  assert.match(smoke, /PCM contains a non-finite sample/);
  assert.match(comparison, /selectedClassifier: null/);
  assert.match(comparison, /thresholdSelected: null/);
  assert.match(comparison, /promotionEligible: false/);
  assert.match(comparison, /exhaustive-label-and-isolated-control-review-incomplete/);
  assert.match(comparison, /candidate\.officialLicense !== 'MIT'/);
  assert.match(comparison, /candidate\.upstreamRepository !== 'fschmid56\/EfficientAT'/);
  assert.match(comparison, /candidate\.upstreamRevision !== '7e30f2bbe85439c15feedd9ba5ad8bff0a600fee'/);
  assert.match(comparison, /candidate\.modelSha256 !== EFFICIENTAT_MODEL_SHA256/);
  assert.match(comparison, /candidate\.mappingSha256 !== EFFICIENTAT_MAPPING_SHA256/);
  assert.match(comparison, /candidate\.scoringPolicy/);
});
