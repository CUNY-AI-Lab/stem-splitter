import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  secondWindowScore,
  validateComparatorOutput,
} from '../scripts/eval-yamnet-comparator.mts';

const mapping = JSON.parse(readFileSync('yamnet-comparator/mapping.json', 'utf8')) as {
  mapped: Array<{ instrumentId: string }>;
  unsupported: Array<{ instrumentId: string }>;
};
const supportedIds = mapping.mapped.map((item) => item.instrumentId);

function validOutput() {
  const metrics = Object.fromEntries(
    supportedIds.map((id, index) => [
      id,
      {
        top3Mean: Number((0.1 + index / 1000).toFixed(8)),
        maximum: Number((0.2 + index / 1000).toFixed(8)),
        mean: Number((0.05 + index / 1000).toFixed(8)),
        patchesAtLeastHalf: 0,
      },
    ])
  );
  return {
    $schema: 'stem-splitter.yamnet-comparator-output.v1',
    classifierVersion:
      'google-yamnet-tflite-v1-max-class-top3-patch-mean-second-window-v1@kaggle-version-763',
    modelSha256: '141fba1cdaae842c816f28edc4937e8b4f0af4c8df21862ccc6b52dc567993c3',
    classMapSha256: 'cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2',
    mappingSha256: 'cda962367ff7cf0b65674b5cbd8cb8289a34789c671df83d4e27ba583e4b3318',
    vocabularyVersion: 'classroom-instruments-v1',
    vocabularySha256: '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140',
    scoringPolicyVersion: 'max-class-top3-patch-mean-second-window-v1',
    inputSampleRate: 22_050,
    windowsAnalyzed: 1,
    loadMs: 140,
    timingMs: 170,
    windows: [
      {
        resampledSamples: 48_000,
        patches: 6,
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

test('YAMNet comparator uses a two-window support score without forcing three windows', () => {
  assert.equal(secondWindowScore([0.7]), 0.7);
  assert.equal(secondWindowScore([0.8, 0.4]), 0.4);
  assert.equal(secondWindowScore([0.2, 0.9, 0.6]), 0.6);
  assert.throws(() => secondWindowScore([]), /window scores/);
  assert.throws(() => secondWindowScore([1.1]), /window scores/);
  assert.throws(() => secondWindowScore([Number.NaN]), /window scores/);
});

test('YAMNet comparator output requires every exact artifact and mapped-score pin', () => {
  const output = validOutput();
  const parsed = validateComparatorOutput(output, 1, supportedIds);
  assert.equal(parsed.windows.length, 1);
  assert.equal(Object.keys(parsed.windows[0].metrics).length, 36);

  assert.throws(
    () => validateComparatorOutput({ ...output, modelSha256: '0'.repeat(64) }, 1, supportedIds),
    /identity/
  );
  const missing = structuredClone(output);
  delete missing.windows[0].metrics.voice;
  assert.throws(() => validateComparatorOutput(missing, 1, supportedIds), /metrics|missing/);
  const reordered = structuredClone(output);
  reordered.windows[0].topClasses[1].top3Mean = 1;
  assert.throws(() => validateComparatorOutput(reordered, 1, supportedIds), /class identity/);
});

test('YAMNet mapping preserves unsupported labels and selects no threshold', () => {
  assert.equal(supportedIds.length, 36);
  assert.equal(mapping.unsupported.length, 15);
  assert.deepEqual(
    mapping.unsupported
      .map((item) => item.instrumentId)
      .filter((id) => ['oboe', 'bassoon', 'viola', 'koto'].includes(id))
      .sort(),
    ['bassoon', 'koto', 'oboe', 'viola']
  );
  const raw = JSON.parse(readFileSync('yamnet-comparator/mapping.json', 'utf8'));
  assert.equal(raw.scoringPolicy.thresholdSelection, 'none');
});

test('YAMNet corpus evaluator constrains every inference container and binds image source', () => {
  const evaluator = readFileSync('scripts/eval-yamnet-comparator.mts', 'utf8');
  const runner = readFileSync('scripts/run-yamnet-comparator-eval.sh', 'utf8');
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
    "'none'",
  ]) {
    assert.equal(evaluator.includes(requirement), true, `evaluator is missing ${requirement}`);
  }
  assert.match(evaluator, /source-sha256\.json/);
  assert.match(evaluator, /lockSha256 !== sha256File\(LOCK_PATH\)/);
  assert.match(evaluator, /writeFileSync\(outputPath, serialized, \{ flag: 'wx', mode: 0o600 \}\)/);
  assert.match(evaluator, /promotionEligible: false/);
  assert.match(evaluator, /threshold-sweep results are not precision claims/);
  assert.match(runner, /YAMNET_COMPARATOR_IMAGE/);
  assert.doesNotMatch(evaluator, /--network[ =]host/);
});
