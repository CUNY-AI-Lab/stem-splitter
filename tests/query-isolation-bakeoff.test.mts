import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { findSamAudioEvaluationPinViolations } from '../scripts/lib/pin-check.mjs';
import {
  assertQueryIsolationOutputDuration,
  buildQueryIsolationEvaluationInput,
  loadQueryIsolationBakeoffManifest,
  QUERY_ISOLATION_BAKEOFF_MANIFEST_PATH,
  reconstructionResidualDb,
  SAM_AUDIO_REPLICATE_VERSION,
  samAudioEvaluationContractSurface,
  scaleInvariantSdrDb,
  scoreQueryIsolationObjectiveOutput,
  validateQueryIsolationBakeoffManifest,
} from '../scripts/lib/query-isolation-bakeoff.mts';
import { loadInstrumentControlManifest } from '../scripts/lib/instrument-control-corpus.mts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

function rawManifest(): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, QUERY_ISOLATION_BAKEOFF_MANIFEST_PATH), 'utf8')
  );
}

function cloneManifest(): Record<string, any> {
  return structuredClone(rawManifest());
}

function TypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...TypeScriptFiles(path));
    else if (entry.isFile() && /\.(?:ts|mts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('the bake-off binds every wind control and six non-rock real-mix targets', () => {
  const manifest = loadQueryIsolationBakeoffManifest(REPOSITORY_ROOT);
  const controls = loadInstrumentControlManifest(REPOSITORY_ROOT);
  assert.equal(manifest.objectiveCases.length, 8);
  assert.deepEqual(
    new Set(manifest.objectiveCases.map((candidate) => candidate.targetControlId)),
    new Set(controls.controls.map((control) => control.id))
  );
  assert.equal(manifest.subjectiveCases.length, 6);
  assert.deepEqual(
    manifest.subjectiveCases.map((candidate) => candidate.sourceSlug),
    ['folk-duet', 'orchestral', 'jazz-sax', 'hip-hop', 'bluegrass', 'synthwave']
  );
  assert.ok(
    manifest.objectiveCases.every((candidate) =>
      candidate.modes.includes('sam-audio-span')
    )
  );
});

test('the SAM-Audio boundary is evaluation-only and preserves every unresolved approval gate', () => {
  const surface = samAudioEvaluationContractSurface();
  assert.equal(surface.purpose, 'evaluation-only');
  assert.equal(surface.reviewedVersion, SAM_AUDIO_REPLICATE_VERSION);
  assert.equal(surface.checkpointSha256, null);
  assert.equal(surface.institutionalLicenseApproval, false);
  assert.equal(surface.hostedWrapperBinding, 'unverified');

  const source = TypeScriptFiles(resolve(REPOSITORY_ROOT, 'src'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /geopti\/sam-audio|REPLICATE_SAM_AUDIO|samAudioReplicateProvider/);
});

test('the evaluation manifest fails closed on provider, license, checkpoint, and corpus drift', () => {
  const mutations: Array<[string, (value: Record<string, any>) => void]> = [
    ['provider disposition', (value) => { value.providers[1].disposition = 'teacher-beta'; }],
    ['license blocker', (value) => { value.providers[1].blockers.shift(); }],
    ['checkpoint identity', (value) => { value.providers[1].checkpointSha256 = 'a'.repeat(64); }],
    ['wrapper binding', (value) => { value.providers[1].wrapperBinding = 'provider-attested'; }],
    ['fixture span', (value) => { value.fixturePolicy.positiveSpan = [0, 24]; }],
    ['cross-piece mixture', (value) => { value.objectiveCases[0].interfererControlIds[0] = 'oboe-ba1'; }],
    ['subjective target', (value) => { value.subjectiveCases[1].expectedInstrument = 'guitar'; }],
  ];
  for (const [label, mutate] of mutations) {
    const value = cloneManifest();
    mutate(value);
    assert.throws(
      () => validateQueryIsolationBakeoffManifest(value, REPOSITORY_ROOT),
      undefined,
      label
    );
  }
});

test('provider payloads share one case while preserving AudioSep and SAM semantics', () => {
  const manifest = loadQueryIsolationBakeoffManifest(REPOSITORY_ROOT);
  const candidate = manifest.objectiveCases[0];
  const sourceUrl = 'https://evaluation.example/an1-flute/mixture.wav?expires=123';
  assert.deepEqual(
    buildQueryIsolationEvaluationInput(manifest, candidate, 'audiosep-text', sourceUrl),
    {
      purpose: 'evaluation-only',
      providerId: 'audiosep',
      model: 'cjwbw/audiosep',
      version: 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8',
      mode: 'audiosep-text',
      input: { audio_file: sourceUrl, text: 'flute' },
    }
  );
  assert.deepEqual(
    buildQueryIsolationEvaluationInput(manifest, candidate, 'sam-audio-span', sourceUrl),
    {
      purpose: 'evaluation-only',
      providerId: 'sam-audio',
      model: 'geopti/sam-audio-large',
      version: SAM_AUDIO_REPLICATE_VERSION,
      mode: 'sam-audio-span',
      input: {
        audio: sourceUrl,
        description: 'flute',
        use_span_prompting: true,
        span_anchors: '[["+",6,18],["-",0,5],["-",19,24]]',
        predict_spans: false,
        output_residual: true,
      },
    }
  );
  assert.throws(
    () =>
      buildQueryIsolationEvaluationInput(
        manifest,
        manifest.subjectiveCases[0],
        'sam-audio-span',
        sourceUrl
      ),
    /mode is not allowed/
  );
  assert.throws(
    () => buildQueryIsolationEvaluationInput(manifest, candidate, 'sam-audio-text', 'file:///mix.wav'),
    /credential-free HTTPS/
  );
});

const PINNED_SAM_SCHEMA = {
  components: {
    schemas: {
      Input: {
        required: ['audio'],
        properties: {
          audio: { type: 'string', format: 'uri' },
          description: { type: 'string', default: 'speech' },
          span_anchors: { type: 'string', default: '[]' },
          predict_spans: { type: 'boolean', default: false },
          output_residual: { type: 'boolean', default: false },
          use_span_prompting: { type: 'boolean', default: false },
        },
      },
      Output: { type: 'array', items: { type: 'string', format: 'uri' } },
    },
  },
};

test('the SAM-Audio schema guard detects input, type, requirement, and output drift', () => {
  const surface = samAudioEvaluationContractSurface();
  assert.deepEqual(findSamAudioEvaluationPinViolations(surface, PINNED_SAM_SCHEMA), []);

  const drifted = structuredClone(PINNED_SAM_SCHEMA) as any;
  drifted.components.schemas.Input.required = [];
  delete drifted.components.schemas.Input.properties.span_anchors;
  drifted.components.schemas.Input.properties.output_residual.type = 'string';
  drifted.components.schemas.Output = { type: 'string', format: 'uri' };
  const failures = findSamAudioEvaluationPinViolations(surface, drifted);
  assert.ok(failures.some((failure) => failure.includes('"audio" is no longer required')));
  assert.ok(failures.some((failure) => failure.includes('"span_anchors" no longer exists')));
  assert.ok(failures.some((failure) => failure.includes('"output_residual" is no longer boolean')));
  assert.ok(failures.some((failure) => failure.includes('array of URI strings')));
});

test('objective metrics reward a true target and exact target-plus-residual reconstruction', () => {
  const length = 4096;
  const target = new Float32Array(length);
  const residual = new Float32Array(length);
  const mixture = new Float32Array(length);
  let targetState = 0x12345678;
  let residualState = 0x87654321;
  for (let index = 0; index < length / 2; index += 2) {
    targetState = (Math.imul(targetState, 1664525) + 1013904223) >>> 0;
    const value = (targetState / 0xffffffff - 0.5) * 0.4;
    target[index] = value;
    target[index + 1] = -value;
  }
  for (let index = length / 2; index < length; index += 2) {
    residualState = (Math.imul(residualState, 22695477) + 1) >>> 0;
    const value = (residualState / 0xffffffff - 0.5) * 0.3;
    residual[index] = value;
    residual[index + 1] = -value;
  }
  for (let index = 0; index < length; index += 1) {
    mixture[index] = target[index] + residual[index];
  }
  assert.ok(scaleInvariantSdrDb(target, target) > 100);
  assert.ok(scaleInvariantSdrDb(target, target) > scaleInvariantSdrDb(target, mixture));
  assert.ok(scaleInvariantSdrDb(target, residual) < -100);
  assert.equal(reconstructionResidualDb(mixture, target, residual), -120);
  const corrupted = new Float32Array(residual);
  corrupted.fill(0, length / 2, length / 2 + 512);
  assert.ok(reconstructionResidualDb(mixture, target, corrupted) > -120);

  const delay = 73;
  const delayedTarget = new Float32Array(length + delay);
  const delayedResidual = new Float32Array(length + delay);
  delayedTarget.set(target, delay);
  delayedResidual.set(residual, delay);
  const score = scoreQueryIsolationObjectiveOutput({
    sampleRate: 32_000,
    mixture,
    targetReference: target,
    residualReference: residual,
    targetEstimate: delayedTarget,
    residualEstimate: delayedResidual,
  });
  assert.equal(score.targetLagSamples, delay);
  assert.equal(score.residualLagSamples, delay);
  assert.equal(score.reconstructionLagSamples, delay);
  assert.ok(score.targetSiSdrDb > 100);
  assert.ok(score.residualSiSdrDb! > 100);
  assert.ok(score.siSdrImprovementDb > 20);
  assert.ok(score.targetInterferenceRejectionDb > 100);
  assert.ok(score.reconstructionResidualDb! < -100);
});

test('provider output duration must preserve the complete evaluation fixture', () => {
  assert.doesNotThrow(() => assertQueryIsolationOutputDuration(24, 24));
  assert.doesNotThrow(() => assertQueryIsolationOutputDuration(23.5, 24));
  assert.doesNotThrow(() => assertQueryIsolationOutputDuration(24.5, 24));
  assert.throws(() => assertQueryIsolationOutputDuration(1, 24), /must preserve/);
  assert.throws(() => assertQueryIsolationOutputDuration(23.49, 24), /must preserve/);
  assert.throws(() => assertQueryIsolationOutputDuration(24.51, 24), /must preserve/);
});
