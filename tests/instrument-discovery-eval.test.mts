import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  evaluateDiscoveryObservation,
  loadAndValidateEvaluationInputs,
  validateCandidateExecutionProvenance,
} from '../scripts/eval-instrument-discovery.mts';
import type { InstrumentDetectionV1 } from '../src/analysis/types.ts';

function detection(
  id: string,
  label: string,
  state: 'possible' | 'uncertain',
  confidence: number
): InstrumentDetectionV1 {
  return {
    id,
    label,
    state,
    confidence,
    windowSupport: 2,
    windowsAnalyzed: 3,
  };
}

test('instrument discovery expectations partition the licensed corpus and expose confusion gaps', () => {
  const { corpusSources, expectations, vocabulary } = loadAndValidateEvaluationInputs();
  const fileSources = corpusSources.filter((source) => source.kind === 'file');

  assert.equal(expectations.sources.length, fileSources.length);
  assert.equal(expectations.sources.length, 11);
  assert.equal(vocabulary.instruments.length, 51);
  assert.deepEqual(
    expectations.confusionTrials.map((trial) => [trial.id, trial.status]),
    [
      ['electric-guitar-vs-synthesizer', 'bidirectional'],
      ['bass-guitar-vs-double-bass', 'bidirectional'],
      ['piano-vs-mallet-percussion', 'one-direction'],
      ['saxophone-vs-brass', 'one-direction'],
      ['solo-strings-vs-string-section', 'corpus-gap'],
      ['pitched-percussion-vs-keys', 'corpus-gap'],
    ]
  );
});

test('candidate evaluation separates expected, hard-negative, confusable, and unreviewed labels', () => {
  const { expectations, vocabulary } = loadAndValidateEvaluationInputs();
  const expectation = expectations.sources.find((source) => source.slug === 'shoegaze');
  assert.ok(expectation);

  const result = evaluateDiscoveryObservation(
    expectation,
    [
      detection('voice', 'Voice', 'uncertain', 0.64),
      detection('electric-guitar', 'Electric guitar', 'possible', 0.81),
      detection('drum-kit', 'Drum kit', 'possible', 0.86),
      detection('synthesizer', 'Synthesizer', 'uncertain', 0.62),
      detection('organ', 'Organ', 'uncertain', 0.61),
      detection('accordion', 'Accordion', 'uncertain', 0.60),
      detection('percussion', 'Percussion', 'uncertain', 0.59),
    ],
    vocabulary
  );

  assert.deepEqual(result.summary, {
    expectedGroups: 4,
    possibleGroups: 2,
    uncertainGroups: 1,
    missedGroups: 1,
    hardNegativeDetections: 1,
    confusionCandidates: 2,
    unreviewedCandidates: 1,
    abstained: false,
  });
  assert.deepEqual(
    result.expectedGroups.map((group) => [group.corpusTerms, group.state]),
    [
      [['vocals'], 'uncertain'],
      [['electric-guitar'], 'possible'],
      [['bass-guitar'], 'missed'],
      [['drum-kit'], 'possible'],
    ]
  );
  assert.deepEqual(result.hardNegativeDetections.map((item) => item.id), ['synthesizer']);
  assert.deepEqual(
    result.confusionCandidates.map((item) => [item.detection.id, item.confusableExpectedIds]),
    [
      ['organ', ['electric-guitar']],
      ['percussion', ['drum-kit']],
    ]
  );
  assert.deepEqual(result.unreviewedCandidates.map((item) => item.id), ['accordion']);
  assert.deepEqual(result.overlapCandidates, [
    { parentId: 'percussion', childIds: ['drum-kit'] },
  ]);
});

test('candidate evaluation reports a true abstention without forcing a nearest label', () => {
  const { expectations, vocabulary } = loadAndValidateEvaluationInputs();
  const expectation = expectations.sources.find((source) => source.slug === 'orchestral');
  assert.ok(expectation);

  const result = evaluateDiscoveryObservation(expectation, [], vocabulary);
  assert.equal(result.summary.abstained, true);
  assert.equal(result.summary.possibleGroups, 0);
  assert.equal(result.summary.uncertainGroups, 0);
  assert.equal(result.summary.missedGroups, expectation.expectedGroups.length);
});

test('candidate evaluation rejects classifier ids outside the pinned vocabulary', () => {
  const { expectations, vocabulary } = loadAndValidateEvaluationInputs();
  const expectation = expectations.sources[0];
  assert.throws(
    () =>
      evaluateDiscoveryObservation(
        expectation,
        [detection('invented-stem', 'Invented stem', 'possible', 0.99)],
        vocabulary
      ),
    /unknown or duplicate id/
  );
});

test('candidate report provenance accepts only an exact linux/amd64 image and lock identity', () => {
  const valid = {
    image: {
      id: `sha256:${'a'.repeat(64)}`,
      platform: 'linux/amd64',
    },
    dependencyLock: {
      path: 'instrument-discovery/uv.lock',
      sha256: 'b'.repeat(64),
    },
  };
  assert.deepEqual(validateCandidateExecutionProvenance(valid), valid);

  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, image: { ...valid.image, platform: 'linux/arm64' } },
    { ...valid, image: { ...valid.image, id: 'stem-splitter:latest' } },
    { ...valid, dependencyLock: { ...valid.dependencyLock, path: 'other.lock' } },
    { ...valid, dependencyLock: { ...valid.dependencyLock, sha256: 'short' } },
  ]) {
    assert.throws(() => validateCandidateExecutionProvenance(invalid), /provenance|schema/);
  }
});

test('image evaluation runner is ephemeral, constrained, and writes private evidence', () => {
  const runner = readFileSync('scripts/run-instrument-discovery-eval.sh', 'utf8');
  const evaluator = readFileSync('scripts/eval-instrument-discovery.mts', 'utf8');

  for (const requirement of [
    'com.docker.network.bridge.enable_ip_masquerade=false',
    '--pull never',
    "discovery_eval_publish='127.0.0.1::8080'",
    '--publish "$discovery_eval_publish"',
    '--read-only',
    '--cap-drop ALL',
    '--security-opt no-new-privileges',
    '--pids-limit 128',
    '--cpus 2',
    '--memory 2g',
    '--memory-swap 2g',
    '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m',
  ]) {
    assert.equal(runner.includes(requirement), true, `runner is missing ${requirement}`);
  }
  assert.match(runner, /trap cleanup EXIT HUP INT TERM/);
  assert.match(runner, /openssl rand -hex 32/);
  assert.match(runner, /INSTRUMENT_DISCOVERY_EVAL_READY_SECONDS:-240/);
  assert.match(runner, /discovery_eval_health.*unhealthy/s);
  assert.match(runner, /discovery_eval_failure_reason=unhealthy/);
  assert.match(runner, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.match(runner, /linux\/amd64/);
  assert.match(runner, /instrument-discovery-provenance\/uv-lock\.sha256/);
  assert.match(runner, /INSTRUMENT_DISCOVERY_EXECUTION_IMAGE_ID/);
  assert.match(runner, /INSTRUMENT_DISCOVERY_DEPENDENCY_LOCK_SHA256/);
  assert.doesNotMatch(runner, /--network[ =]host/);
  assert.match(evaluator, /flag: 'wx', mode: 0o600/);
  assert.match(evaluator, /MAX_SOURCE_BYTES = 100 \* 1024 \* 1024/);
  assert.match(evaluator, /createReadStream\(path\)/);
  assert.match(evaluator, /stem-splitter\.instrument-discovery-evaluation-report\.v2/);
  assert.match(evaluator, /evaluationSourceSha256/);
});

test('offline score audit is networkless and cleans up its private PCM workspace', () => {
  const runner = readFileSync('scripts/run-instrument-discovery-score-audit.sh', 'utf8');
  const audit = readFileSync('instrument-discovery/score_audit.py', 'utf8');

  for (const requirement of [
    '--pull never',
    '--network none',
    '--read-only',
    '--cap-drop ALL',
    '--security-opt no-new-privileges',
    '--pids-limit 128',
    '--cpus 2',
    '--memory 2g',
    '--memory-swap 2g',
    '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m',
    '--name "$discovery_score_container"',
  ]) {
    assert.equal(runner.includes(requirement), true, `score runner is missing ${requirement}`);
  }
  assert.match(runner, /trap cleanup EXIT HUP INT TERM/);
  assert.match(runner, /docker rm --force "\$discovery_score_container"/);
  assert.match(runner, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.match(runner, /linux\/amd64/);
  assert.match(runner, /instrument-discovery-provenance\/uv-lock\.sha256/);
  assert.match(runner, /INSTRUMENT_DISCOVERY_EXECUTION_IMAGE_ID/);
  assert.match(runner, /INSTRUMENT_DISCOVERY_DEPENDENCY_LOCK_SHA256/);
  assert.match(audit, /diagnosticOnly.*True/s);
  assert.match(audit, /networkRequired.*False/s);
  assert.match(audit, /thresholdMutation.*none/s);
  assert.match(audit, /stem-splitter\.instrument-discovery-score-audit\.v3/);
});
