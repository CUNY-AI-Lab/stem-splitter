#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA,
  AUDIO_ANALYSIS_MAX_IMAGE_BYTES,
  audioAnalysisImageSourceEvidence,
  validateAudioAnalysisImageEvidence,
} from './lib/audio-analysis-image-evidence.mts';
import { AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION } from '../src/analysis/source-scope.ts';
import { PINNED_ROLE_CLASSIFIER_VERSION } from '../src/analysis/types.ts';

let image = '';
let output = '';
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[++index];
  if (!value) throw new Error(`${argument} requires a value`);
  if (argument === '--image') image = value;
  else if (argument === '--output') output = value;
  else throw new Error(`Unknown argument: ${argument}`);
}
if (!/^[A-Za-z0-9._/:@-]{1,255}$/.test(image)) throw new Error('--image is invalid');
if (!output) throw new Error('--output is required');

function command(name: string, args: string[]): string {
  return execFileSync(name, args, { encoding: 'utf8' }).trim();
}

function requiredEnvironment(name: string, pattern: RegExp): string {
  const value = process.env[name] ?? '';
  if (!pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

const repositoryRoot = process.cwd();
const commit = requiredEnvironment('AUDIO_ANALYSIS_SOURCE_COMMIT', /^[a-f0-9]{40}$/);
const repository = requiredEnvironment(
  'GITHUB_REPOSITORY',
  /^CUNY-AI-Lab\/stem-splitter$/
);
const runId = requiredEnvironment('GITHUB_RUN_ID', /^[1-9][0-9]*$/);
const runAttempt = Number(requiredEnvironment('GITHUB_RUN_ATTEMPT', /^[1-9][0-9]*$/));
const eventName = requiredEnvironment(
  'GITHUB_EVENT_NAME',
  /^(?:pull_request|push|workflow_dispatch)$/
);
if (command('git', ['rev-parse', 'HEAD']) !== commit) {
  throw new Error('GitHub SHA does not match the checked-out commit');
}
if (command('git', ['status', '--porcelain', '--untracked-files=all']) !== '') {
  throw new Error('image evidence checkout is dirty');
}

const runnerOs = command('uname', ['-s']);
const runnerArchitecture = command('uname', ['-m']);
const dockerPlatform = command('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}']);
const inspected = JSON.parse(
  command('docker', ['image', 'inspect', '--format', '{{json .}}', image])
) as {
  Id?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Size?: unknown;
  Config?: { User?: unknown; Cmd?: unknown };
};

const evidence = {
  $schema: AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA,
  status: 'passed',
  commit,
  capturedAt: new Date().toISOString(),
  github: {
    repository,
    workflow: 'CI',
    job: 'analysis-image',
    eventName,
    runId,
    runAttempt,
    sourceCommit: commit,
  },
  runner: {
    os: runnerOs,
    architecture: runnerArchitecture,
    dockerPlatform,
  },
  image: {
    id: inspected.Id,
    platform: `${inspected.Os}/${inspected.Architecture}`,
    sizeBytes: inspected.Size,
    maximumBytes: AUDIO_ANALYSIS_MAX_IMAGE_BYTES,
    user: inspected.Config?.User,
    command: inspected.Config?.Cmd,
  },
  pins: {
    node: '22.23.1',
    bun: '1.3.14',
    ffmpeg: '8.0.3',
    classifier: PINNED_ROLE_CLASSIFIER_VERSION,
    sourceScope: AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION,
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
  sources: audioAnalysisImageSourceEvidence(repositoryRoot),
};
validateAudioAnalysisImageEvidence(evidence, repositoryRoot);
const outputPath = resolve(output);
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
  flag: 'wx',
});
process.stdout.write(
  `${JSON.stringify({
    schema: AUDIO_ANALYSIS_IMAGE_EVIDENCE_SCHEMA,
    output: outputPath,
    commit,
    runId,
    runAttempt,
    imageId: inspected.Id,
    platform: `${inspected.Os}/${inspected.Architecture}`,
    sizeBytes: inspected.Size,
  })}\n`
);
