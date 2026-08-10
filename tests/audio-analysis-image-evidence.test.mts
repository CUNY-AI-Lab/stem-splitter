import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA,
  AUDIO_ANALYSIS_IMAGE_EVIDENCE_SOURCES,
  AUDIO_ANALYSIS_MAX_IMAGE_BYTES,
  audioAnalysisImageSourceEvidence,
  validateAudioAnalysisImageEvidence,
} from '../scripts/lib/audio-analysis-image-evidence.mts';
import {
  AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH,
  validateAudioPipelinePromotionEvidence,
  validateAudioPipelinePromotionManifest,
} from '../scripts/lib/audio-pipeline-promotion.mts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

function validEvidence(): Record<string, any> {
  const commit = 'a'.repeat(40);
  return {
    $schema: AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA,
    status: 'passed',
    commit,
    capturedAt: '2026-08-10T13:00:00.000Z',
    github: {
      repository: 'CUNY-AI-Lab/stem-splitter',
      workflow: 'CI',
      job: 'analysis-image',
      eventName: 'pull_request',
      runId: '123456789',
      runAttempt: 1,
      sourceCommit: commit,
    },
    runner: {
      os: 'Linux',
      architecture: 'x86_64',
      dockerPlatform: 'linux/x86_64',
    },
    image: {
      id: `sha256:${'b'.repeat(64)}`,
      platform: 'linux/amd64',
      sizeBytes: AUDIO_ANALYSIS_MAX_IMAGE_BYTES,
      maximumBytes: AUDIO_ANALYSIS_MAX_IMAGE_BYTES,
      user: 'node',
      command: ['node', '--max-old-space-size=256', 'dist/server.mjs'],
    },
    pins: {
      node: '22.23.1',
      bun: '1.3.14',
      ffmpeg: '8.0.3',
      classifier: 'autosplit-role-v4',
      sourceScope: 'analysis-source-scope-v2',
    },
    smoke: {
      constrainedRuntime: true,
      sourceFingerprint: true,
      authoritativeSnapshot: true,
      maximumDuration: true,
      failureBoundaries: true,
      temporarySourcesClean: true,
      secretRedaction: true,
    },
    sources: audioAnalysisImageSourceEvidence(REPOSITORY_ROOT),
  };
}

test('native image evidence binds the GitHub runner, image, pins, smoke, and source bytes', () => {
  const summary = validateAudioAnalysisImageEvidence(validEvidence(), REPOSITORY_ROOT);
  assert.equal(summary.schema, AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA);
  assert.equal(summary.runId, '123456789');
  assert.equal(summary.imageSizeBytes, AUDIO_ANALYSIS_MAX_IMAGE_BYTES);
  assert.equal(summary.sourceHashes.length, AUDIO_ANALYSIS_IMAGE_EVIDENCE_SOURCES.length);
});

test('native image evidence fails closed on host, image, smoke, pin, and source drift', () => {
  const mutations: Array<[string, (value: Record<string, any>) => void, RegExp]> = [
    ['host', (value) => { value.runner.architecture = 'aarch64'; }, /runner architecture drifted/],
    ['Docker host', (value) => { value.runner.dockerPlatform = 'linux/aarch64'; }, /Docker platform drifted/],
    ['image platform', (value) => { value.image.platform = 'linux/arm64'; }, /image platform drifted/],
    ['image size', (value) => { value.image.sizeBytes += 1; }, /image-size boundary/],
    ['runtime user', (value) => { value.image.user = 'root'; }, /runtime user drifted/],
    ['classifier pin', (value) => { value.pins.classifier = 'autosplit-role-v3'; }, /classifier pin drifted/],
    ['smoke', (value) => { value.smoke.secretRedaction = false; }, /secretRedaction did not pass/],
    ['source hash', (value) => { value.sources[0].sha256 = '0'.repeat(64); }, /source 0 drifted/],
    ['source missing', (value) => { value.sources.pop(); }, /source coverage is incomplete/],
    ['extra field', (value) => { value.image.tag = 'latest'; }, /image evidence schema/],
  ];
  for (const [label, mutate, expected] of mutations) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.throws(
      () => validateAudioAnalysisImageEvidence(evidence, REPOSITORY_ROOT),
      expected,
      label
    );
  }
});

test('the native workflow proves the host and uploads commit-bound evidence after smoke', () => {
  const workflow = readFileSync(resolve(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /name: Pinned analysis image \(native amd64\)/);
  assert.match(workflow, /test "\$\(uname -m\)" = x86_64/);
  assert.match(workflow, /docker info --format '[^']*'\)" = linux\/x86_64/);
  assert.match(workflow, /docker build --pull --platform linux\/amd64/);
  assert.match(workflow, /AUDIO_ANALYSIS_EXPECTED_PLATFORM: linux\/amd64/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /AUDIO_ANALYSIS_SOURCE_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  const smokeIndex = workflow.indexOf('./scripts/smoke-audio-analysis-image.sh');
  const captureIndex = workflow.indexOf('scripts/capture-audio-analysis-image-evidence.mts');
  const uploadIndex = workflow.indexOf('actions/upload-artifact@');
  assert.ok(smokeIndex >= 0 && smokeIndex < captureIndex && captureIndex < uploadIndex);
});

test('image evidence covers every repository input copied by the Dockerfile', () => {
  const dockerfile = readFileSync(resolve(REPOSITORY_ROOT, 'audio-analysis/Dockerfile'), 'utf8');
  const copiedSources = dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && !line.startsWith('COPY --from='))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
  for (const source of copiedSources) {
    assert.ok(
      AUDIO_ANALYSIS_IMAGE_EVIDENCE_SOURCES.includes(source as any),
      `${source} is not bound into native image evidence`
    );
  }
});

test('the current promotion cannot claim native amd64 before canonical CI evidence exists', () => {
  const raw = JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH), 'utf8')
  );
  raw.evidence.nativeAmd64Image = true;
  raw.blockers = raw.blockers.filter((blocker: string) => blocker !== 'native-amd64-image-missing');
  const manifest = validateAudioPipelinePromotionManifest(raw);
  assert.throws(
    () => validateAudioPipelinePromotionEvidence(REPOSITORY_ROOT, manifest),
    /ENOENT/
  );
});
