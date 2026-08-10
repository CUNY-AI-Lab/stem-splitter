import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertQueryIsolationOutputDuration,
  loadQueryIsolationBakeoffManifest,
  QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY,
  QUERY_ISOLATION_BAKEOFF_VERSION,
  SAM_AUDIO_REPLICATE_VERSION,
  scoreQueryIsolationObjectiveOutput,
  type QueryIsolationBakeoffMode,
} from './lib/query-isolation-bakeoff.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_SCHEMA = 'stem-splitter.query-isolation-score.v1';
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_SECONDS = 26;

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const supported = new Set([
    '--case',
    '--mode',
    '--provider-version',
    '--target-output',
    '--residual-output',
    '--latency-ms',
    '--cost-usd',
    '--json',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!supported.has(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid query-isolation score argument: ${flag ?? '(missing)'}`);
    }
    if (Object.hasOwn(result, flag)) throw new Error(`duplicate score argument: ${flag}`);
    result[flag] = value;
  }
  return result;
}

function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function boundedNumber(value: string, minimum: number, maximum: number, context: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return parsed;
}

function regularOutput(path: string): { path: string; bytes: number; sha256: string } {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 44 || stat.size > MAX_OUTPUT_BYTES) {
    throw new Error(`${path}: provider output is not a bounded regular audio file`);
  }
  return {
    path: absolute,
    bytes: stat.size,
    sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
  };
}

function durationSeconds(path: string, expectedDurationSeconds: number): number {
  const output = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { encoding: 'utf8', timeout: 15_000 }
  );
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_DURATION_SECONDS) {
    throw new Error(`${path}: provider output duration is invalid`);
  }
  assertQueryIsolationOutputDuration(duration, expectedDurationSeconds);
  return duration;
}

function decodeF32(
  path: string,
  sampleRate: number,
  expectedDurationSeconds: number
): Float32Array {
  durationSeconds(path, expectedDurationSeconds);
  const maximumPcmBytes = MAX_DURATION_SECONDS * sampleRate * 4 + 4096;
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      '-',
    ],
    { encoding: 'buffer', timeout: 30_000, maxBuffer: maximumPcmBytes }
  );
  if (!bytes.length || bytes.length % 4 !== 0 || bytes.length > maximumPcmBytes) {
    throw new Error(`${path}: decoded provider output is invalid`);
  }
  return new Float32Array(
    new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  );
}

function round(value: number | null, digits = 4): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

const args = parseArgs(process.argv.slice(2));
const manifest = loadQueryIsolationBakeoffManifest(REPOSITORY_ROOT);
const caseId = required(args, '--case');
const candidate = manifest.objectiveCases.find((item) => item.id === caseId);
if (!candidate) throw new Error(`unknown objective bake-off case: ${caseId}`);
const mode = required(args, '--mode') as QueryIsolationBakeoffMode;
if (!(candidate.modes as readonly QueryIsolationBakeoffMode[]).includes(mode)) {
  throw new Error(`${caseId}: score mode is not allowed`);
}
const expectedVersion =
  mode === 'audiosep-text'
    ? 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8'
    : SAM_AUDIO_REPLICATE_VERSION;
if (required(args, '--provider-version') !== expectedVersion) {
  throw new Error('provider output is not bound to the reviewed evaluation version');
}
const latencyMs = boundedNumber(required(args, '--latency-ms'), 1, 60 * 60 * 1000, 'latency');
const costUsd = boundedNumber(required(args, '--cost-usd'), 0, 100, 'cost');
const targetOutput = regularOutput(required(args, '--target-output'));
const residualArgument = args['--residual-output'];
if (mode === 'audiosep-text' && residualArgument) {
  throw new Error('AudioSep evaluation cannot claim an uncontracted residual');
}
if (mode !== 'audiosep-text' && !residualArgument) {
  throw new Error('SAM-Audio evaluation requires the requested residual output');
}
const residualOutput = residualArgument ? regularOutput(residualArgument) : null;

const fixtureDirectory = resolve(
  REPOSITORY_ROOT,
  QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY,
  caseId
);
const mixturePath = resolve(fixtureDirectory, 'mixture.wav');
const targetReferencePath = resolve(fixtureDirectory, 'target.wav');
const residualReferencePath = resolve(fixtureDirectory, 'residual.wav');
for (const path of [mixturePath, targetReferencePath, residualReferencePath]) regularOutput(path);

const score = scoreQueryIsolationObjectiveOutput({
  sampleRate: manifest.fixturePolicy.sampleRate,
  mixture: decodeF32(
    mixturePath,
    manifest.fixturePolicy.sampleRate,
    manifest.fixturePolicy.durationSeconds
  ),
  targetReference: decodeF32(
    targetReferencePath,
    manifest.fixturePolicy.sampleRate,
    manifest.fixturePolicy.durationSeconds
  ),
  residualReference: decodeF32(
    residualReferencePath,
    manifest.fixturePolicy.sampleRate,
    manifest.fixturePolicy.durationSeconds
  ),
  targetEstimate: decodeF32(
    targetOutput.path,
    manifest.fixturePolicy.sampleRate,
    manifest.fixturePolicy.durationSeconds
  ),
  ...(residualOutput
    ? {
        residualEstimate: decodeF32(
          residualOutput.path,
          manifest.fixturePolicy.sampleRate,
          manifest.fixturePolicy.durationSeconds
        ),
      }
    : {}),
});

const report = {
  schemaVersion: REPORT_SCHEMA,
  bakeoffVersion: QUERY_ISOLATION_BAKEOFF_VERSION,
  claimStatus: 'diagnostic-only-awaiting-complete-provider-runs-and-teacher-review',
  caseId,
  mode,
  provider: {
    id: mode === 'audiosep-text' ? 'audiosep' : 'sam-audio',
    version: expectedVersion,
  },
  fixture: {
    mixtureSha256: regularOutput(mixturePath).sha256,
    targetReferenceSha256: regularOutput(targetReferencePath).sha256,
    residualReferenceSha256: regularOutput(residualReferencePath).sha256,
  },
  outputs: {
    target: { bytes: targetOutput.bytes, sha256: targetOutput.sha256 },
    residual: residualOutput
      ? { bytes: residualOutput.bytes, sha256: residualOutput.sha256 }
      : null,
  },
  metrics: {
    targetLagSamples: score.targetLagSamples,
    targetSiSdrDb: round(score.targetSiSdrDb),
    mixtureBaselineSiSdrDb: round(score.mixtureBaselineSiSdrDb),
    siSdrImprovementDb: round(score.siSdrImprovementDb),
    targetInterferenceRejectionDb: round(score.targetInterferenceRejectionDb),
    residualLagSamples: score.residualLagSamples,
    residualSiSdrDb: round(score.residualSiSdrDb),
    reconstructionLagSamples: score.reconstructionLagSamples,
    reconstructionResidualDb: round(score.reconstructionResidualDb),
    latencyMs,
    costUsd,
  },
  generatedAt: new Date().toISOString(),
};

const output = `${JSON.stringify(report, null, 2)}\n`;
if (args['--json']) writeFileSync(resolve(args['--json']), output, { mode: 0o600 });
process.stdout.write(output);
