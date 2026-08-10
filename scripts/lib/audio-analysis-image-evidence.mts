import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION } from '../../src/analysis/source-scope.ts';
import { PINNED_ROLE_CLASSIFIER_VERSION } from '../../src/analysis/types.ts';

export const AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA =
  'stem-splitter.audio-analysis-native-amd64.v1' as const;
export const AUDIO_ANALYSIS_IMAGE_EVIDENCE_PATH =
  'docs/acceptance/2026-08-10-v3.2-native-amd64-image/evidence.json' as const;
export const AUDIO_ANALYSIS_MAX_IMAGE_BYTES = 251_658_240 as const;

export const AUDIO_ANALYSIS_IMAGE_EVIDENCE_SOURCES = [
  '.dockerignore',
  '.github/workflows/ci.yml',
  'audio-analysis/Dockerfile',
  'audio-analysis/app.ts',
  'audio-analysis/classifier.ts',
  'audio-analysis/config.ts',
  'audio-analysis/decoder.ts',
  'audio-analysis/discovery.ts',
  'audio-analysis/process.ts',
  'audio-analysis/request.ts',
  'audio-analysis/server.ts',
  'audio-analysis/source.ts',
  'bun.lock',
  'instrument-discovery/vocabulary.json',
  'package.json',
  'public/autosplit.js',
  'scripts/capture-audio-analysis-image-evidence.mts',
  'scripts/fixtures/audio-analysis-source-server.mjs',
  'scripts/lib/audio-analysis-image-evidence.mts',
  'scripts/smoke-audio-analysis-image.sh',
  'src/analysis/instrument-vocabulary.ts',
  'src/analysis/source-scope.ts',
  'src/analysis/types.ts',
  'tests/fixtures/audio/README.md',
  'tests/fixtures/audio/bass.mp3',
  'tests/fixtures/audio/drums.mp3',
  'tests/fixtures/audio/other.mp3',
  'tests/fixtures/audio/quiet.mp3',
  'tests/fixtures/audio/source.wav',
  'tests/fixtures/audio/vocals.mp3',
  'tsconfig.audio-pipeline.json',
] as const;

type RecordValue = Record<string, unknown>;

export interface AudioAnalysisImageEvidenceSummary {
  schema: typeof AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA;
  commit: string;
  capturedAt: string;
  runId: string;
  runAttempt: number;
  imageId: string;
  imageSizeBytes: number;
  sourceHashes: string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function object(value: unknown, keys: readonly string[], context: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const record = value as RecordValue;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context} does not match the image evidence schema`);
  }
  return record;
}

function exactString(value: unknown, expected: string, context: string): string {
  if (value !== expected) throw new Error(`${context} drifted`);
  return expected;
}

function patternString(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${context} must be a positive integer`);
  }
  return Number(value);
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('image evidence capturedAt is invalid');
  }
  return value;
}

export function audioAnalysisImageSourceEvidence(
  repositoryRoot: string
): Array<{ path: string; sha256: string }> {
  return AUDIO_ANALYSIS_IMAGE_EVIDENCE_SOURCES.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(repositoryRoot, path))),
  }));
}

export function validateAudioAnalysisImageEvidence(
  value: unknown,
  repositoryRoot: string
): AudioAnalysisImageEvidenceSummary {
  const evidence = object(
    value,
    ['$schema', 'status', 'commit', 'capturedAt', 'github', 'runner', 'image', 'pins', 'smoke', 'sources'],
    'image evidence'
  );
  exactString(evidence.$schema, AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA, 'image evidence schema');
  exactString(evidence.status, 'passed', 'image evidence status');
  const commit = patternString(evidence.commit, /^[a-f0-9]{40}$/, 'image evidence commit');
  const capturedAt = timestamp(evidence.capturedAt);

  const github = object(
    evidence.github,
    ['repository', 'workflow', 'job', 'eventName', 'runId', 'runAttempt', 'sourceCommit'],
    'image evidence GitHub identity'
  );
  exactString(github.repository, 'CUNY-AI-Lab/stem-splitter', 'image evidence repository');
  exactString(github.workflow, 'CI', 'image evidence workflow');
  exactString(github.job, 'analysis-image', 'image evidence job');
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(String(github.eventName))) {
    throw new Error('image evidence eventName is invalid');
  }
  const runId = patternString(github.runId, /^[1-9][0-9]*$/, 'image evidence runId');
  const runAttempt = positiveInteger(github.runAttempt, 'image evidence runAttempt');
  exactString(github.sourceCommit, commit, 'image evidence GitHub source commit');

  const runner = object(
    evidence.runner,
    ['os', 'architecture', 'dockerPlatform'],
    'image evidence runner'
  );
  exactString(runner.os, 'Linux', 'image evidence runner OS');
  exactString(runner.architecture, 'x86_64', 'image evidence runner architecture');
  exactString(runner.dockerPlatform, 'linux/x86_64', 'image evidence Docker platform');

  const image = object(
    evidence.image,
    ['id', 'platform', 'sizeBytes', 'maximumBytes', 'user', 'command'],
    'image evidence image'
  );
  const imageId = patternString(image.id, /^sha256:[a-f0-9]{64}$/, 'image evidence image id');
  exactString(image.platform, 'linux/amd64', 'image evidence image platform');
  const imageSizeBytes = positiveInteger(image.sizeBytes, 'image evidence image size');
  if (imageSizeBytes < 10 * 1024 * 1024 || imageSizeBytes > AUDIO_ANALYSIS_MAX_IMAGE_BYTES) {
    throw new Error('image evidence is outside the accepted image-size boundary');
  }
  if (image.maximumBytes !== AUDIO_ANALYSIS_MAX_IMAGE_BYTES) {
    throw new Error('image evidence maximum size drifted');
  }
  exactString(image.user, 'node', 'image evidence runtime user');
  if (
    !Array.isArray(image.command) ||
    JSON.stringify(image.command) !==
      JSON.stringify(['node', '--max-old-space-size=256', 'dist/server.mjs'])
  ) {
    throw new Error('image evidence runtime command drifted');
  }

  const pins = object(
    evidence.pins,
    ['node', 'bun', 'ffmpeg', 'classifier', 'sourceScope'],
    'image evidence pins'
  );
  exactString(pins.node, '22.23.1', 'image evidence Node pin');
  exactString(pins.bun, '1.3.14', 'image evidence Bun pin');
  exactString(pins.ffmpeg, '8.0.3', 'image evidence FFmpeg pin');
  exactString(pins.classifier, PINNED_ROLE_CLASSIFIER_VERSION, 'image evidence classifier pin');
  exactString(pins.sourceScope, AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION, 'image evidence source-scope pin');

  const smoke = object(
    evidence.smoke,
    [
      'constrainedRuntime',
      'sourceFingerprint',
      'authoritativeSnapshot',
      'maximumDuration',
      'failureBoundaries',
      'temporarySourcesClean',
      'secretRedaction',
    ],
    'image evidence smoke'
  );
  for (const [key, passed] of Object.entries(smoke)) {
    if (passed !== true) throw new Error(`image evidence smoke ${key} did not pass`);
  }

  const expectedSources = audioAnalysisImageSourceEvidence(repositoryRoot);
  if (!Array.isArray(evidence.sources) || evidence.sources.length !== expectedSources.length) {
    throw new Error('image evidence source coverage is incomplete');
  }
  const sourceHashes = evidence.sources.map((candidate, index) => {
    const source = object(candidate, ['path', 'sha256'], `image evidence source ${index}`);
    const expected = expectedSources[index];
    if (source.path !== expected.path || source.sha256 !== expected.sha256) {
      throw new Error(`image evidence source ${index} drifted`);
    }
    return expected.sha256;
  });

  return {
    schema: AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA,
    commit,
    capturedAt,
    runId,
    runAttempt,
    imageId,
    imageSizeBytes,
    sourceHashes,
  };
}

export function loadAudioAnalysisImageEvidence(
  repositoryRoot: string,
  evidencePath: string = AUDIO_ANALYSIS_IMAGE_EVIDENCE_PATH
): AudioAnalysisImageEvidenceSummary {
  const value = JSON.parse(readFileSync(resolve(repositoryRoot, evidencePath), 'utf8')) as unknown;
  return validateAudioAnalysisImageEvidence(value, repositoryRoot);
}
