#!/usr/bin/env node

import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch as hostArchitecture } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = 'efficientat-comparator/uv.lock';
const MAPPING_PATH = 'efficientat-comparator/mapping.json';
const LOCK_DIGEST_PATH = '/opt/efficientat-comparator-provenance/uv-lock.sha256';
const SOURCE_MANIFEST_PATH = '/opt/efficientat-comparator-provenance/source-sha256.json';
const MODEL_SHA256 = '0bd7dc2443af498c289a2e739f02ebb515d6aa3fd3ab9db539c86123ae368a4e';
const CLASS_MAP_SHA256 = 'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429';
const MAPPING_SHA256 = 'b8aa419a47b612144655b2f3409fbb6eb27aabed79b49717a20f96a0f15ad50d';
const LICENSE_SHA256 = '7a45b1641304427db80df436cab61c04ddb634d97e9a8b7a93de41db940fa8b5';
const OUTPUT_SCHEMA = 'stem-splitter.efficientat-comparator-output.v1';
const CLASSIFIER_VERSION =
  'efficientat-mn10-audioset-527-pcm22050-sinc32k-upstream-mel-single-clip-sigmoid-second-window-v1@github-release-v0.0.1';
const SCORING_POLICY_VERSION = 'single-clip-sigmoid-second-window-v1';
const VOCABULARY_VERSION = 'classroom-instruments-v1';
const VOCABULARY_SHA256 = '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140';
const INPUT_SAMPLE_RATE = 22_050;
const CONTROL_SECONDS = 3;
const CONTROL_SAMPLES = INPUT_SAMPLE_RATE * CONTROL_SECONDS;
const DEFAULT_MAX_IMAGE_BYTES = 1024 * 1024 * 1024;
const SOURCE_FILES = [
  'instrument-discovery/vocabulary.json',
  'efficientat-comparator/LICENSE.EfficientAT',
  'efficientat-comparator/Dockerfile',
  'efficientat-comparator/backend.py',
  'efficientat-comparator/cli.py',
  'efficientat-comparator/constants.py',
  'efficientat-comparator/contract.py',
  'efficientat-comparator/download_model.py',
  'efficientat-comparator/mapping.json',
  'efficientat-comparator/model.py',
] as const;

interface MappingIdentity {
  supportedIds: string[];
}

interface ImageExecution {
  id: string;
  platform: 'linux/amd64' | 'linux/arm64';
  sizeBytes: number;
  emulated: boolean;
}

interface ComparatorSummary {
  loadMs: number;
  timingMs: number;
  resampledSamples: number;
  patches: number;
  inferenceMs: number;
  metricCount: number;
  topClassCount: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function repositoryBytes(path: string): Buffer {
  return readFileSync(resolve(REPOSITORY_ROOT, path));
}

function repositorySha256(path: string): string {
  return sha256(repositoryBytes(path));
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return value as number;
}

function score(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function mappingIdentity(): MappingIdentity {
  const bytes = repositoryBytes(MAPPING_PATH);
  if (sha256(bytes) !== MAPPING_SHA256) throw new Error('EfficientAT mapping bytes drifted');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(value)) throw new Error('EfficientAT mapping root is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'classifierVersion',
      'modelSha256',
      'classMapSha256',
      'vocabularyVersion',
      'vocabularySha256',
      'reviewStatus',
      'scoringPolicy',
      'mapped',
      'unsupported',
    ],
    'EfficientAT mapping'
  );
  if (
    value.$schema !== 'stem-splitter.efficientat-class-mapping.v1' ||
    value.classifierVersion !== CLASSIFIER_VERSION ||
    value.modelSha256 !== MODEL_SHA256 ||
    value.classMapSha256 !== CLASS_MAP_SHA256 ||
    value.vocabularyVersion !== VOCABULARY_VERSION ||
    value.vocabularySha256 !== VOCABULARY_SHA256 ||
    value.reviewStatus !== 'offline-comparator-uncalibrated' ||
    !Array.isArray(value.mapped) ||
    !Array.isArray(value.unsupported)
  ) {
    throw new Error('EfficientAT mapping identity does not match');
  }
  const supportedIds = value.mapped.map((item) => {
    if (!record(item)) throw new Error('EfficientAT mapped item is invalid');
    exactKeys(item, ['instrumentId', 'classes'], 'EfficientAT mapped item');
    if (
      typeof item.instrumentId !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.instrumentId) ||
      !Array.isArray(item.classes) ||
      item.classes.length < 1
    ) {
      throw new Error('EfficientAT mapped item is invalid');
    }
    return item.instrumentId;
  });
  if (supportedIds.length !== 37 || new Set(supportedIds).size !== supportedIds.length) {
    throw new Error('EfficientAT supported-label surface drifted');
  }
  if (value.unsupported.length !== 14) throw new Error('EfficientAT unsupported-label surface drifted');
  return { supportedIds };
}

export function validateSmokeOutput(
  value: unknown,
  supportedIds: string[]
): ComparatorSummary {
  if (!record(value)) throw new Error('EfficientAT smoke output root is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'classifierVersion',
      'modelSha256',
      'classMapSha256',
      'mappingSha256',
      'vocabularyVersion',
      'vocabularySha256',
      'scoringPolicyVersion',
      'inputSampleRate',
      'windowsAnalyzed',
      'loadMs',
      'timingMs',
      'windows',
    ],
    'EfficientAT smoke output'
  );
  if (
    value.$schema !== OUTPUT_SCHEMA ||
    value.classifierVersion !== CLASSIFIER_VERSION ||
    value.modelSha256 !== MODEL_SHA256 ||
    value.classMapSha256 !== CLASS_MAP_SHA256 ||
    value.mappingSha256 !== MAPPING_SHA256 ||
    value.vocabularyVersion !== VOCABULARY_VERSION ||
    value.vocabularySha256 !== VOCABULARY_SHA256 ||
    value.scoringPolicyVersion !== SCORING_POLICY_VERSION ||
    value.inputSampleRate !== INPUT_SAMPLE_RATE ||
    value.windowsAnalyzed !== 1 ||
    !Array.isArray(value.windows) ||
    value.windows.length !== 1
  ) {
    throw new Error('EfficientAT smoke output identity does not match');
  }
  const loadMs = integer(value.loadMs, 0, 300_000, 'EfficientAT load timing');
  const timingMs = integer(value.timingMs, 0, 300_000, 'EfficientAT total timing');
  const window = value.windows[0];
  if (!record(window)) throw new Error('EfficientAT smoke output window is invalid');
  exactKeys(
    window,
    ['resampledSamples', 'patches', 'inferenceMs', 'metrics', 'topClasses'],
    'EfficientAT smoke output window'
  );
  const resampledSamples = integer(
    window.resampledSamples,
    96_000,
    96_000,
    'EfficientAT resampled sample count'
  );
  const patches = integer(window.patches, 1, 1, 'EfficientAT clip count');
  const inferenceMs = integer(window.inferenceMs, 0, 300_000, 'EfficientAT inference timing');
  if (timingMs + 2 < loadMs + inferenceMs) {
    throw new Error('EfficientAT timing accounting is invalid');
  }
  if (!record(window.metrics)) throw new Error('EfficientAT smoke metrics are invalid');
  exactKeys(window.metrics, supportedIds, 'EfficientAT smoke metrics');
  for (const id of supportedIds) {
    const metric = window.metrics[id];
    if (!record(metric)) throw new Error(`EfficientAT smoke metric ${id} is invalid`);
    exactKeys(
      metric,
      ['top3Mean', 'maximum', 'mean', 'patchesAtLeastHalf'],
      `EfficientAT smoke metric ${id}`
    );
    const top3Mean = score(metric.top3Mean, `${id} top-three score`);
    const maximum = score(metric.maximum, `${id} maximum score`);
    const mean = score(metric.mean, `${id} mean score`);
    integer(metric.patchesAtLeastHalf, 0, patches, `${id} patch support`);
    if (maximum < top3Mean || maximum < mean) {
      throw new Error(`EfficientAT smoke metric ${id} is inconsistent`);
    }
  }
  if (!Array.isArray(window.topClasses) || window.topClasses.length !== 12) {
    throw new Error('EfficientAT smoke top classes are invalid');
  }
  let previousScore = Number.POSITIVE_INFINITY;
  const indexes = new Set<number>();
  for (const item of window.topClasses) {
    if (!record(item)) throw new Error('EfficientAT smoke top class is invalid');
    exactKeys(item, ['index', 'mid', 'displayName', 'top3Mean'], 'EfficientAT smoke top class');
    const index = integer(item.index, 0, 526, 'EfficientAT top class index');
    const currentScore = score(item.top3Mean, 'EfficientAT top class score');
    if (
      indexes.has(index) ||
      currentScore > previousScore ||
      typeof item.mid !== 'string' ||
      !/^\/(?:g|m|t)\/[A-Za-z0-9_]+$/.test(item.mid) ||
      typeof item.displayName !== 'string' ||
      item.displayName.trim() !== item.displayName ||
      item.displayName.length < 1
    ) {
      throw new Error('EfficientAT smoke top class identity is invalid');
    }
    indexes.add(index);
    previousScore = currentScore;
  }
  return {
    loadMs,
    timingMs,
    resampledSamples,
    patches,
    inferenceMs,
    metricCount: supportedIds.length,
    topClassCount: window.topClasses.length,
  };
}

function positiveIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function inspectImage(imageReference: string): ImageExecution {
  if (
    !imageReference ||
    imageReference.startsWith('-') ||
    /[\s\u0000-\u001f\u007f]/.test(imageReference)
  ) {
    throw new Error('EfficientAT smoke image reference is invalid');
  }
  const raw = execFileSync('docker', ['image', 'inspect', imageReference], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 512 * 1024,
  });
  const document: unknown = JSON.parse(raw);
  if (!Array.isArray(document) || document.length !== 1 || !record(document[0])) {
    throw new Error('EfficientAT smoke image inspection is invalid');
  }
  const image = document[0];
  const config = image.Config;
  if (
    typeof image.Id !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
    image.Os !== 'linux' ||
    (image.Architecture !== 'amd64' && image.Architecture !== 'arm64') ||
    !Number.isSafeInteger(image.Size) ||
    (image.Size as number) < 1 ||
    !record(config) ||
    config.User !== '65532:65532' ||
    !Array.isArray(config.Entrypoint) ||
    config.Entrypoint.length !== 2 ||
    config.Entrypoint[0] !== 'python' ||
    config.Entrypoint[1] !== 'cli.py' ||
    (config.Cmd !== null && !(Array.isArray(config.Cmd) && config.Cmd.length === 0)) ||
    config.ExposedPorts != null ||
    config.Healthcheck != null ||
    !Array.isArray(config.Env) ||
    config.Env.some(
      (item) =>
        typeof item !== 'string' ||
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)=/i.test(item)
    )
  ) {
    throw new Error('EfficientAT smoke image runtime surface does not match');
  }
  const platform = `linux/${image.Architecture}` as 'linux/amd64' | 'linux/arm64';
  const expectedPlatform = process.env.EFFICIENTAT_COMPARATOR_EXPECTED_PLATFORM;
  if (
    expectedPlatform !== undefined &&
    expectedPlatform !== '' &&
    expectedPlatform !== 'linux/amd64' &&
    expectedPlatform !== 'linux/arm64'
  ) {
    throw new Error('EFFICIENTAT_COMPARATOR_EXPECTED_PLATFORM is invalid');
  }
  if (expectedPlatform && platform !== expectedPlatform) {
    throw new Error('EfficientAT smoke image platform does not match the expected platform');
  }
  const maximumBytes = positiveIntegerEnvironment(
    'EFFICIENTAT_COMPARATOR_MAX_IMAGE_BYTES',
    DEFAULT_MAX_IMAGE_BYTES,
    1,
    2 * 1024 * 1024 * 1024
  );
  if ((image.Size as number) > maximumBytes) {
    throw new Error('EfficientAT smoke image exceeds the size gate');
  }
  const nativeArchitecture =
    (hostArchitecture() === 'x64' && image.Architecture === 'amd64') ||
    (hostArchitecture() === 'arm64' && image.Architecture === 'arm64');
  return {
    id: image.Id,
    platform,
    sizeBytes: image.Size as number,
    emulated: !nativeArchitecture,
  };
}

let containerSequence = 0;

function runImage(
  execution: ImageExecution,
  suffix: string,
  input: Buffer,
  imageArguments: string[],
  options: { entrypoint?: string; timeoutMs: number; maxBuffer: number }
): SpawnSyncReturns<Buffer> {
  containerSequence += 1;
  const containerName = `stem-splitter-efficientat-smoke-${process.pid}-${containerSequence}-${suffix}`;
  const args = [
    'run',
    '--rm',
    '--pull',
    'never',
    '--name',
    containerName,
    '--platform',
    execution.platform,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--cpus',
    '2',
    '--memory',
    '768m',
    '--memory-swap',
    '768m',
    '--log-driver',
    'none',
    '-i',
  ];
  if (options.entrypoint) args.push('--entrypoint', options.entrypoint);
  args.push(execution.id, ...imageArguments);
  try {
    return spawnSync('docker', args, {
      input,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
    });
  } finally {
    try {
      execFileSync('docker', ['rm', '--force', containerName], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } catch {
      // Successful `--rm` runs have already removed the container.
    }
  }
}

function successfulOutput(result: SpawnSyncReturns<Buffer>, context: string): Buffer {
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdout.length < 1 ||
    result.stderr.length > 16 * 1024
  ) {
    throw new Error(`${context} failed`);
  }
  return result.stdout;
}

function readImageFile(
  execution: ImageExecution,
  path: string,
  maximumBytes: number
): Buffer {
  const result = runImage(execution, 'read', Buffer.alloc(0), [path], {
    entrypoint: 'cat',
    timeoutMs: 15_000,
    maxBuffer: maximumBytes,
  });
  const output = successfulOutput(result, 'EfficientAT image provenance read');
  if (output.length > maximumBytes) throw new Error('EfficientAT image provenance is oversized');
  return output;
}

function verifyImageProvenance(execution: ImageExecution): void {
  const lockSha = readImageFile(execution, LOCK_DIGEST_PATH, 256).toString('ascii').trim();
  if (!/^[a-f0-9]{64}$/.test(lockSha) || lockSha !== repositorySha256(LOCK_PATH)) {
    throw new Error('EfficientAT image dependency lock does not match the repository');
  }
  const sourceValue: unknown = JSON.parse(
    readImageFile(execution, SOURCE_MANIFEST_PATH, 16 * 1024).toString('utf8')
  );
  if (!record(sourceValue)) throw new Error('EfficientAT image source manifest is invalid');
  exactKeys(sourceValue, SOURCE_FILES, 'EfficientAT image source manifest');
  for (const path of SOURCE_FILES) {
    if (sourceValue[path] !== repositorySha256(path)) {
      throw new Error(`EfficientAT image source does not match ${path}`);
    }
  }

  const surfaceScript = [
    'import hashlib,json,pathlib',
    "roots=[pathlib.Path('/app'),pathlib.Path('/models/efficientat'),pathlib.Path('/opt/efficientat-comparator-provenance')]",
    "files={str(root):sorted(str(path.relative_to(root)) for path in root.rglob('*') if path.is_file()) for root in roots}",
    "symlinks=sorted(str(path) for root in roots for path in root.rglob('*') if path.is_symlink())",
    "license_sha=hashlib.sha256(pathlib.Path('/models/efficientat/LICENSE.EfficientAT').read_bytes()).hexdigest()",
    "print(json.dumps({'files':files,'symlinks':symlinks,'licenseSha256':license_sha},sort_keys=True,separators=(',',':')))",
  ].join(';');
  const surfaceResult = runImage(execution, 'surface', Buffer.alloc(0), ['-c', surfaceScript], {
    entrypoint: 'python',
    timeoutMs: 15_000,
    maxBuffer: 16 * 1024,
  });
  const surfaceValue: unknown = JSON.parse(
    successfulOutput(surfaceResult, 'EfficientAT runtime-surface check').toString('utf8')
  );
  if (!record(surfaceValue)) throw new Error('EfficientAT runtime-surface output is invalid');
  exactKeys(surfaceValue, ['files', 'symlinks', 'licenseSha256'], 'EfficientAT runtime surface');
  const expectedFiles = {
    '/app': [
      'backend.py',
      'cli.py',
      'constants.py',
      'contract.py',
      'mapping.json',
      'model.py',
      'vocabulary.json',
    ],
    '/models/efficientat': [
      'LICENSE.EfficientAT',
      'class_labels_indices.csv',
      'mn10_as_mAP_471.safetensors',
      'stem-splitter-model.json',
    ],
    '/opt/efficientat-comparator-provenance': ['source-sha256.json', 'uv-lock.sha256'],
  };
  if (
    JSON.stringify(surfaceValue.files) !== JSON.stringify(expectedFiles) ||
    !Array.isArray(surfaceValue.symlinks) ||
    surfaceValue.symlinks.length !== 0 ||
    surfaceValue.licenseSha256 !== LICENSE_SHA256
  ) {
    throw new Error('EfficientAT runtime surface does not match the pin');
  }
}

function controlPcm(): Buffer {
  const result = Buffer.allocUnsafe(CONTROL_SAMPLES * 4);
  for (let index = 0; index < CONTROL_SAMPLES; index += 1) {
    const time = index / INPUT_SAMPLE_RATE;
    const pulse = index % 2_205 < 6 ? 0.08 : 0;
    const value =
      0.12 * Math.sin(2 * Math.PI * 440 * time) +
      0.05 * Math.sin(2 * Math.PI * 880 * time) +
      pulse;
    result.writeFloatLE(value, index * 4);
  }
  return result;
}

function comparatorArguments(sampleRate: number, samples: number): string[] {
  return [
    '--window-samples',
    String(samples),
    '--sample-rate',
    String(sampleRate),
    '--threads',
    '1',
  ];
}

function assertContractFailure(
  execution: ImageExecution,
  suffix: string,
  input: Buffer,
  arguments_: string[],
  expectedMessage: string,
  timeoutMs: number
): void {
  const result = runImage(execution, suffix, input, arguments_, {
    timeoutMs,
    maxBuffer: 16 * 1024,
  });
  if (
    result.error ||
    result.signal ||
    result.status !== 2 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length !== 0 ||
    !Buffer.isBuffer(result.stderr) ||
    result.stderr.toString('utf8') !== `${expectedMessage}\n`
  ) {
    throw new Error(`EfficientAT ${suffix} rejection did not match the contract`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0].startsWith('--'))) {
    throw new Error('usage: smoke-efficientat-comparator-image.mts [IMAGE]');
  }
  const imageReference =
    args[0] ||
    process.env.EFFICIENTAT_COMPARATOR_IMAGE ||
    'stem-splitter-efficientat-comparator:v3.2-candidate';
  const execution = inspectImage(imageReference);
  const mapping = mappingIdentity();
  verifyImageProvenance(execution);
  const timeoutMs = positiveIntegerEnvironment(
    'EFFICIENTAT_COMPARATOR_SMOKE_TIMEOUT_MS',
    execution.emulated ? 180_000 : 60_000,
    10_000,
    300_000
  );
  const result = runImage(
    execution,
    'control',
    controlPcm(),
    comparatorArguments(INPUT_SAMPLE_RATE, CONTROL_SAMPLES),
    { timeoutMs, maxBuffer: 96 * 1024 }
  );
  const output = successfulOutput(result, 'EfficientAT constrained synthetic control');
  if (output.length > 64 * 1024) throw new Error('EfficientAT smoke output exceeds the contract');
  let outputValue: unknown;
  try {
    outputValue = JSON.parse(output.toString('utf8'));
  } catch {
    throw new Error('EfficientAT smoke output is not JSON');
  }
  const summary = validateSmokeOutput(outputValue, mapping.supportedIds);

  assertContractFailure(
    execution,
    'length-mismatch',
    Buffer.alloc(4),
    comparatorArguments(INPUT_SAMPLE_RATE, 2),
    'PCM window counts do not match the body',
    15_000
  );
  const nonfinite = Buffer.alloc(4);
  nonfinite.writeFloatLE(Number.NaN, 0);
  assertContractFailure(
    execution,
    'nonfinite',
    nonfinite,
    comparatorArguments(INPUT_SAMPLE_RATE, 1),
    'PCM contains a non-finite sample',
    15_000
  );
  assertContractFailure(
    execution,
    'sample-rate',
    Buffer.alloc(4),
    comparatorArguments(16_000, 1),
    'EfficientAT input sample rate does not match',
    timeoutMs
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        image: { id: execution.id, platform: execution.platform, sizeBytes: execution.sizeBytes },
        provenance: {
          dependencyLockSha256: repositorySha256(LOCK_PATH),
          mappingSha256: MAPPING_SHA256,
          modelSha256: MODEL_SHA256,
          classMapSha256: CLASS_MAP_SHA256,
          licenseSha256: LICENSE_SHA256,
        },
        control: summary,
        rejectionCases: ['length-mismatch', 'nonfinite-pcm', 'sample-rate-drift'],
      },
      null,
      2
    )}\n`
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'EfficientAT image smoke failed'}\n`);
    process.exitCode = 1;
  });
}
