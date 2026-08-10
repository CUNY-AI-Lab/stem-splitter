import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import {
  actualFileSha1,
  approvedCorpusAudioPath,
  loadAndValidateEvaluationInputs,
  type DiscoverySourceExpectation,
} from './eval-instrument-discovery.mts';

const REPORT_SCHEMA = 'stem-splitter.yamnet-comparator-evaluation.v2';
const OUTPUT_SCHEMA = 'stem-splitter.yamnet-comparator-output.v1';
const MAPPING_SCHEMA = 'stem-splitter.yamnet-class-mapping.v1';
const MAPPING_PATH = 'yamnet-comparator/mapping.json';
const VOCABULARY_PATH = 'instrument-discovery/vocabulary.json';
const LOCK_PATH = 'yamnet-comparator/uv.lock';
const EXPECTATIONS_PATH = 'tests/corpus/instrument-discovery-expectations.json';
const CORPUS_PATH = 'tests/corpus/corpus.json';
const MAPPING_SHA256 = 'cda962367ff7cf0b65674b5cbd8cb8289a34789c671df83d4e27ba583e4b3318';
const MODEL_SHA256 = '141fba1cdaae842c816f28edc4937e8b4f0af4c8df21862ccc6b52dc567993c3';
const CLASS_MAP_SHA256 = 'cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2';
const VOCABULARY_SHA256 = '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140';
const CLASSIFIER_VERSION =
  'google-yamnet-tflite-v1-max-class-top3-patch-mean-second-window-v1@kaggle-version-763';
const SCORING_POLICY_VERSION = 'max-class-top3-patch-mean-second-window-v1';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_SOURCE_DURATION_SECONDS = 15 * 60;
const DEFAULT_DECODER_TIMEOUT_MS = 60_000;
const SOURCE_MANIFEST_PATH = '/opt/yamnet-comparator-provenance/source-sha256.json';
const LOCK_DIGEST_PATH = '/opt/yamnet-comparator-provenance/uv-lock.sha256';
const SOURCE_FILES = [
  'instrument-discovery/vocabulary.json',
  'yamnet-comparator/Dockerfile',
  'yamnet-comparator/backend.py',
  'yamnet-comparator/cli.py',
  'yamnet-comparator/constants.py',
  'yamnet-comparator/contract.py',
  'yamnet-comparator/download_model.py',
  'yamnet-comparator/mapping.json',
] as const;

/** Every repository file whose bytes can change corpus selection or scores. */
export const YAMNET_EVALUATION_SOURCE_PATHS = Object.freeze({
  evaluator: 'scripts/eval-yamnet-comparator.mts',
  runner: 'scripts/run-yamnet-comparator-eval.sh',
  inputLoader: 'scripts/eval-instrument-discovery.mts',
  analysisConfig: 'audio-analysis/config.ts',
  analysisDecoder: 'audio-analysis/decoder.ts',
  analysisProcessBoundary: 'audio-analysis/process.ts',
  discoveryWindowPolicy: 'audio-analysis/discovery.ts',
  analysisContractPins: 'src/analysis/types.ts',
  instrumentVocabularyModule: 'src/analysis/instrument-vocabulary.ts',
  vocabulary: VOCABULARY_PATH,
  corpus: CORPUS_PATH,
  expectations: EXPECTATIONS_PATH,
  mapping: MAPPING_PATH,
  packageManifest: 'package.json',
  bunLock: 'bun.lock',
  typescriptConfig: 'tsconfig.json',
  dependencyLock: LOCK_PATH,
} as const);

interface MappedClass {
  index: number;
  mid: string;
  displayName: string;
}

export interface MappingDocument {
  classifierVersion: string;
  modelSha256: string;
  classMapSha256: string;
  vocabularyVersion: string;
  vocabularySha256: string;
  supportedIds: string[];
  unsupported: Array<{ instrumentId: string; reason: string }>;
  scoringPolicy: Record<string, unknown>;
}

interface WindowMetric {
  top3Mean: number;
  maximum: number;
  mean: number;
  patchesAtLeastHalf: number;
}

export interface ComparatorWindow {
  resampledSamples: number;
  patches: number;
  inferenceMs: number;
  metrics: Record<string, WindowMetric>;
  topClasses: Array<{
    index: number;
    mid: string;
    displayName: string;
    top3Mean: number;
  }>;
}

export interface ComparatorResult {
  loadMs: number;
  timingMs: number;
  windows: ComparatorWindow[];
}

export interface ImageExecution {
  id: string;
  platform: 'linux/amd64' | 'linux/arm64';
  sizeBytes: number;
  host: string;
  emulated: boolean;
  lockSha256: string;
  sourceSha256: Record<string, string>;
}

interface EvaluatedGroup {
  corpusTerms: string[];
  acceptedIds: string[];
  supportedAcceptedIds: string[];
  state: 'eligible' | 'unsupported';
  score: number | null;
  rank: number | null;
  family: string;
}

interface Observation {
  slug: string;
  coverage: string[];
  sourceSha1: string;
  sourceSha256: string;
  analysisPcmSha256: string;
  analysisWindowSamples: number[];
  sourceBytes: number;
  sourceDurationSeconds: number;
  analyzedSeconds: number;
  windowsAnalyzed: number;
  loadMs: number;
  inferenceMs: number;
  timingMs: number;
  trackScores: Record<string, number>;
  topMapped: Array<{ id: string; score: number }>;
  topAudioSetByWindow: ComparatorWindow['topClasses'][];
  expectedGroups: EvaluatedGroup[];
  hardNegatives: Array<{ id: string; score: number }>;
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

function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function yamnetEvaluationSourcePins(): Record<
  keyof typeof YAMNET_EVALUATION_SOURCE_PATHS,
  { path: string; sha256: string }
> {
  return Object.fromEntries(
    Object.entries(YAMNET_EVALUATION_SOURCE_PATHS).map(([name, path]) => [
      name,
      { path, sha256: sha256File(path) },
    ])
  ) as Record<
    keyof typeof YAMNET_EVALUATION_SOURCE_PATHS,
    { path: string; sha256: string }
  >;
}

function assertEvaluationSourcesUnchanged(
  expected: ReturnType<typeof yamnetEvaluationSourcePins>
): void {
  const current = yamnetEvaluationSourcePins();
  for (const name of Object.keys(YAMNET_EVALUATION_SOURCE_PATHS) as Array<
    keyof typeof YAMNET_EVALUATION_SOURCE_PATHS
  >) {
    if (
      current[name].path !== expected[name].path ||
      current[name].sha256 !== expected[name].sha256
    ) {
      throw new Error(`YAMNet evaluation source changed during execution: ${name}`);
    }
  }
}

function boundedNumber(value: unknown, minimum: number, maximum: number, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return value as number;
}

function normalizedId(value: unknown, context: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

export function loadMapping(vocabularyIds: string[]): MappingDocument {
  const bytes = readFileSync(MAPPING_PATH);
  if (sha256Bytes(bytes) !== MAPPING_SHA256) throw new Error('YAMNet mapping bytes drifted');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(value)) throw new Error('YAMNet mapping root is invalid');
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
    'YAMNet mapping'
  );
  if (
    value.$schema !== MAPPING_SCHEMA ||
    value.classifierVersion !== CLASSIFIER_VERSION ||
    value.modelSha256 !== MODEL_SHA256 ||
    value.classMapSha256 !== CLASS_MAP_SHA256 ||
    value.vocabularyVersion !== 'classroom-instruments-v1' ||
    value.vocabularySha256 !== VOCABULARY_SHA256 ||
    value.reviewStatus !== 'offline-comparator-uncalibrated' ||
    !record(value.scoringPolicy) ||
    !Array.isArray(value.mapped) ||
    !Array.isArray(value.unsupported)
  ) {
    throw new Error('YAMNet mapping identity does not match');
  }
  const expectedPolicy = {
    classAggregation: 'maximum',
    patchAggregation: 'top-k-mean',
    topPatchCount: 3,
    trackAggregation: 'second-highest-window',
    singleWindowException: true,
    thresholdSelection: 'none',
  };
  if (JSON.stringify(value.scoringPolicy) !== JSON.stringify(expectedPolicy)) {
    throw new Error('YAMNet scoring policy drifted');
  }
  const supportedIds: string[] = [];
  const seenIndexes = new Set<number>();
  for (const item of value.mapped) {
    if (!record(item)) throw new Error('YAMNet mapped item is invalid');
    exactKeys(item, ['instrumentId', 'classes'], 'YAMNet mapped item');
    const instrumentId = normalizedId(item.instrumentId, 'YAMNet mapped instrument id');
    if (supportedIds.includes(instrumentId) || !Array.isArray(item.classes) || !item.classes.length) {
      throw new Error('YAMNet mapped instrument is invalid');
    }
    for (const rawClass of item.classes) {
      if (!record(rawClass)) throw new Error('YAMNet mapped class is invalid');
      exactKeys(rawClass, ['index', 'mid', 'displayName'], 'YAMNet mapped class');
      const candidate = rawClass as unknown as MappedClass;
      if (
        !Number.isSafeInteger(candidate.index) ||
        candidate.index < 0 ||
        candidate.index > 520 ||
        seenIndexes.has(candidate.index) ||
        typeof candidate.mid !== 'string' ||
        !/^\/(?:g|m|t)\/[A-Za-z0-9_]+$/.test(candidate.mid) ||
        typeof candidate.displayName !== 'string' ||
        !candidate.displayName.trim()
      ) {
        throw new Error('YAMNet mapped class identity is invalid');
      }
      seenIndexes.add(candidate.index);
    }
    supportedIds.push(instrumentId);
  }
  const unsupported = value.unsupported.map((item) => {
    if (!record(item)) throw new Error('YAMNet unsupported item is invalid');
    exactKeys(item, ['instrumentId', 'reason'], 'YAMNet unsupported item');
    const instrumentId = normalizedId(item.instrumentId, 'YAMNet unsupported instrument id');
    if (typeof item.reason !== 'string' || item.reason.trim().length < 20) {
      throw new Error('YAMNet unsupported reason is invalid');
    }
    return { instrumentId, reason: item.reason };
  });
  const allIds = [...supportedIds, ...unsupported.map((item) => item.instrumentId)];
  if (
    allIds.length !== vocabularyIds.length ||
    new Set(allIds).size !== allIds.length ||
    vocabularyIds.some((id) => !allIds.includes(id))
  ) {
    throw new Error('YAMNet mapping does not partition the vocabulary');
  }
  return {
    classifierVersion: CLASSIFIER_VERSION,
    modelSha256: MODEL_SHA256,
    classMapSha256: CLASS_MAP_SHA256,
    vocabularyVersion: 'classroom-instruments-v1',
    vocabularySha256: VOCABULARY_SHA256,
    supportedIds,
    unsupported,
    scoringPolicy: expectedPolicy,
  };
}

export function secondWindowScore(values: number[]): number {
  if (
    values.length < 1 ||
    values.length > 3 ||
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error('YAMNet window scores are invalid');
  }
  const ordered = [...values].sort((left, right) => right - left);
  return ordered.length === 1 ? ordered[0] : ordered[1];
}

export function validateComparatorOutput(
  value: unknown,
  expectedWindows: number,
  supportedIds: string[]
): ComparatorResult {
  if (!record(value)) throw new Error('YAMNet output root is invalid');
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
    'YAMNet output'
  );
  if (
    value.$schema !== OUTPUT_SCHEMA ||
    value.classifierVersion !== CLASSIFIER_VERSION ||
    value.modelSha256 !== MODEL_SHA256 ||
    value.classMapSha256 !== CLASS_MAP_SHA256 ||
    value.mappingSha256 !== MAPPING_SHA256 ||
    value.vocabularyVersion !== 'classroom-instruments-v1' ||
    value.vocabularySha256 !== VOCABULARY_SHA256 ||
    value.scoringPolicyVersion !== SCORING_POLICY_VERSION ||
    value.inputSampleRate !== ANALYSIS_SAMPLE_RATE ||
    value.windowsAnalyzed !== expectedWindows ||
    !Array.isArray(value.windows) ||
    value.windows.length !== expectedWindows
  ) {
    throw new Error('YAMNet output identity does not match');
  }
  const loadMs = safeInteger(value.loadMs, 0, 300_000, 'YAMNet load timing');
  const timingMs = safeInteger(value.timingMs, 0, 300_000, 'YAMNet total timing');
  const windows: ComparatorWindow[] = value.windows.map((window, windowIndex) => {
    if (!record(window)) throw new Error('YAMNet output window is invalid');
    exactKeys(
      window,
      ['resampledSamples', 'patches', 'inferenceMs', 'metrics', 'topClasses'],
      'YAMNet output window'
    );
    const resampledSamples = safeInteger(
      window.resampledSamples,
      15_600,
      240_001,
      'YAMNet resampled samples'
    );
    const patches = safeInteger(window.patches, 1, 32, 'YAMNet patch count');
    const inferenceMs = safeInteger(window.inferenceMs, 0, 300_000, 'YAMNet inference timing');
    if (!record(window.metrics) || Object.keys(window.metrics).length !== supportedIds.length) {
      throw new Error('YAMNet mapped metrics are invalid');
    }
    const metrics: Record<string, WindowMetric> = {};
    for (const id of supportedIds) {
      const metric = window.metrics[id];
      if (!record(metric)) throw new Error(`YAMNet metric ${id} is missing`);
      exactKeys(
        metric,
        ['top3Mean', 'maximum', 'mean', 'patchesAtLeastHalf'],
        `YAMNet metric ${id}`
      );
      metrics[id] = {
        top3Mean: boundedNumber(metric.top3Mean, 0, 1, `${id} top-three score`),
        maximum: boundedNumber(metric.maximum, 0, 1, `${id} maximum score`),
        mean: boundedNumber(metric.mean, 0, 1, `${id} mean score`),
        patchesAtLeastHalf: safeInteger(
          metric.patchesAtLeastHalf,
          0,
          patches,
          `${id} patch support`
        ),
      };
    }
    if (!Array.isArray(window.topClasses) || window.topClasses.length !== 12) {
      throw new Error('YAMNet top AudioSet classes are invalid');
    }
    let previousScore = Number.POSITIVE_INFINITY;
    const seenIndexes = new Set<number>();
    const topClasses = window.topClasses.map((item) => {
      if (!record(item)) throw new Error('YAMNet top AudioSet class is invalid');
      exactKeys(item, ['index', 'mid', 'displayName', 'top3Mean'], 'YAMNet top AudioSet class');
      const index = safeInteger(item.index, 0, 520, 'YAMNet AudioSet class index');
      const score = boundedNumber(item.top3Mean, 0, 1, 'YAMNet AudioSet class score');
      if (
        seenIndexes.has(index) ||
        score > previousScore ||
        typeof item.mid !== 'string' ||
        !/^\/(?:g|m|t)\/[A-Za-z0-9_]+$/.test(item.mid) ||
        typeof item.displayName !== 'string' ||
        !item.displayName.trim()
      ) {
        throw new Error('YAMNet top AudioSet class identity is invalid');
      }
      seenIndexes.add(index);
      previousScore = score;
      return { index, mid: item.mid, displayName: item.displayName, top3Mean: score };
    });
    if (windowIndex >= expectedWindows) throw new Error('YAMNet returned an extra window');
    return { resampledSamples, patches, inferenceMs, metrics, topClasses };
  });
  return { loadMs, timingMs, windows };
}

function readImageFile(imageId: string, path: string, maximumBytes: number): Buffer {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '32',
      '--memory',
      '64m',
      '--memory-swap',
      '64m',
      '--entrypoint',
      'cat',
      imageId,
      path,
    ],
    { timeout: 15_000, maxBuffer: maximumBytes }
  );
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length > maximumBytes) {
    throw new Error('YAMNet image provenance is unavailable');
  }
  return result.stdout;
}

export function inspectImage(imageReference: string): ImageExecution {
  if (!imageReference || /[\s\u0000-\u001f\u007f]/.test(imageReference)) {
    throw new Error('YAMNet image reference is invalid');
  }
  const raw = execFileSync('docker', ['image', 'inspect', imageReference], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 512 * 1024,
  });
  const document: unknown = JSON.parse(raw);
  if (!Array.isArray(document) || document.length !== 1 || !record(document[0])) {
    throw new Error('YAMNet image inspection is invalid');
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
    (image.Size as number) > 1024 * 1024 * 1024 ||
    !record(config) ||
    config.User !== '65532:65532' ||
    !Array.isArray(config.Entrypoint) ||
    config.Entrypoint.length !== 2 ||
    config.Entrypoint[0] !== 'python' ||
    config.Entrypoint[1] !== 'cli.py' ||
    config.ExposedPorts != null ||
    config.Healthcheck != null
  ) {
    throw new Error('YAMNet image runtime surface does not match');
  }
  const lockSha256 = readImageFile(image.Id, LOCK_DIGEST_PATH, 256).toString('ascii').trim();
  if (!/^[a-f0-9]{64}$/.test(lockSha256) || lockSha256 !== sha256File(LOCK_PATH)) {
    throw new Error('YAMNet image dependency lock does not match the worktree');
  }
  const manifestValue: unknown = JSON.parse(
    readImageFile(image.Id, SOURCE_MANIFEST_PATH, 16 * 1024).toString('utf8')
  );
  if (!record(manifestValue)) throw new Error('YAMNet image source manifest is invalid');
  exactKeys(manifestValue, SOURCE_FILES, 'YAMNet image source manifest');
  const sourceSha256: Record<string, string> = {};
  for (const path of SOURCE_FILES) {
    const digest = manifestValue[path];
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || digest !== sha256File(path)) {
      throw new Error(`YAMNet image source does not match ${path}`);
    }
    sourceSha256[path] = digest;
  }
  const platform = `linux/${image.Architecture}` as 'linux/amd64' | 'linux/arm64';
  const host = `${process.platform}/${process.arch}`;
  const nativeArchitecture =
    (process.arch === 'x64' && image.Architecture === 'amd64') ||
    (process.arch === 'arm64' && image.Architecture === 'arm64');
  return {
    id: image.Id,
    platform,
    sizeBytes: image.Size as number,
    host,
    emulated: !nativeArchitecture,
    lockSha256,
    sourceSha256,
  };
}

function comparatorTimeout(emulated: boolean): number {
  const raw = process.env.YAMNET_COMPARATOR_TIMEOUT_MS;
  if (raw === undefined || raw === '') return emulated ? 180_000 : 60_000;
  if (!/^\d+$/.test(raw)) throw new Error('YAMNET_COMPARATOR_TIMEOUT_MS is invalid');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 300_000) {
    throw new Error('YAMNET_COMPARATOR_TIMEOUT_MS is invalid');
  }
  return value;
}

export function runComparator(
  execution: ImageExecution,
  slug: string,
  pcm: Buffer,
  windowCounts: number[],
  supportedIds: string[]
): ComparatorResult {
  const containerName = `stem-splitter-yamnet-eval-${process.pid}-${slug}`;
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
    execution.id,
    '--window-samples',
    windowCounts.join(','),
    '--sample-rate',
    String(ANALYSIS_SAMPLE_RATE),
    '--threads',
    '1',
  ];
  try {
    const result = spawnSync('docker', args, {
      input: pcm,
      timeout: comparatorTimeout(execution.emulated),
      maxBuffer: MAX_RESPONSE_BYTES + MAX_STDERR_BYTES,
    });
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr) ||
      result.stdout.length < 2 ||
      result.stdout.length > MAX_RESPONSE_BYTES ||
      result.stderr.length > MAX_STDERR_BYTES
    ) {
      throw new Error(`${slug}: constrained YAMNet comparator failed`);
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.toString('utf8'));
    } catch {
      throw new Error(`${slug}: YAMNet comparator did not return JSON`);
    }
    return validateComparatorOutput(value, windowCounts.length, supportedIds);
  } finally {
    try {
      execFileSync('docker', ['rm', '--force', containerName], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } catch {
      // `--rm` removes successful containers; this is only timeout cleanup.
    }
  }
}

export function decoderVersion(binary: 'ffmpeg' | 'ffprobe'): string {
  const firstLine = execFileSync(binary, ['-version'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  }).split(/\r?\n/, 1)[0] ?? '';
  const match = firstLine.match(new RegExp(`^${binary} version ([^ ]+)`));
  if (!match) throw new Error(`${binary} version is unavailable`);
  return match[1];
}

export function trackScores(result: ComparatorResult, supportedIds: string[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const id of supportedIds) {
    scores[id] = secondWindowScore(result.windows.map((window) => window.metrics[id].top3Mean));
  }
  return scores;
}

function evaluateObservation(
  expectation: DiscoverySourceExpectation,
  scores: Record<string, number>,
  supportedIds: Set<string>,
  familyById: Map<string, string>
): Pick<Observation, 'expectedGroups' | 'hardNegatives' | 'topMapped'> {
  const ranking = Object.entries(scores).sort(
    ([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId)
  );
  const rankById = new Map(ranking.map(([id], index) => [id, index + 1]));
  const expectedGroups = expectation.expectedGroups.map((group): EvaluatedGroup => {
    const supportedAcceptedIds = group.acceptedIds.filter((id) => supportedIds.has(id));
    const families = new Set(supportedAcceptedIds.map((id) => familyById.get(id) ?? 'unknown'));
    if (!supportedAcceptedIds.length) {
      return {
        ...group,
        supportedAcceptedIds,
        state: 'unsupported',
        score: null,
        rank: null,
        family: 'unsupported',
      };
    }
    return {
      ...group,
      supportedAcceptedIds,
      state: 'eligible',
      score: Math.max(...supportedAcceptedIds.map((id) => scores[id])),
      rank: Math.min(...supportedAcceptedIds.map((id) => rankById.get(id) ?? ranking.length + 1)),
      family: families.size === 1 ? [...families][0] : 'cross-family',
    };
  });
  return {
    expectedGroups,
    hardNegatives: expectation.hardNegativeIds
      .filter((id) => supportedIds.has(id))
      .map((id) => ({ id, score: scores[id] }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)),
    topMapped: ranking.slice(0, 12).map(([id, score]) => ({ id, score })),
  };
}

function summarizeObservations(observations: Observation[]) {
  const eligibleGroups = observations.flatMap((item) => item.expectedGroups).filter(
    (group) => group.state === 'eligible'
  );
  const unsupportedGroups = observations.flatMap((item) => item.expectedGroups).filter(
    (group) => group.state === 'unsupported'
  );
  const topHits = (maximumRank: number) =>
    eligibleGroups.filter((group) => (group.rank ?? Number.POSITIVE_INFINITY) <= maximumRank).length;
  const reciprocalRank = eligibleGroups.reduce(
    (sum, group) => sum + (group.rank ? 1 / group.rank : 0),
    0
  );
  const thresholdSweep = Array.from({ length: 19 }, (_, index) => (index + 1) / 20).map(
    (threshold) => {
      const expectedHits = eligibleGroups.filter((group) => (group.score ?? 0) >= threshold).length;
      const hardNegativeAlerts = observations.reduce(
        (sum, item) => sum + item.hardNegatives.filter((negative) => negative.score >= threshold).length,
        0
      );
      return {
        threshold,
        eligibleExpectedGroups: eligibleGroups.length,
        expectedHits,
        expectedRecallBasisPoints: eligibleGroups.length
          ? Math.round((expectedHits / eligibleGroups.length) * 10_000)
          : 0,
        hardNegativeAlerts,
      };
    }
  );
  return {
    sources: observations.length,
    eligibleExpectedGroups: eligibleGroups.length,
    unsupportedExpectedGroups: unsupportedGroups.length,
    top3ExpectedGroups: topHits(3),
    top5ExpectedGroups: topHits(5),
    top10ExpectedGroups: topHits(10),
    meanReciprocalRankBasisPoints: eligibleGroups.length
      ? Math.round((reciprocalRank / eligibleGroups.length) * 10_000)
      : 0,
    thresholdSweep,
    totalLoadMs: observations.reduce((sum, item) => sum + item.loadMs, 0),
    totalInferenceMs: observations.reduce((sum, item) => sum + item.inferenceMs, 0),
    totalComparatorMs: observations.reduce((sum, item) => sum + item.timingMs, 0),
  };
}

function bucketSummary(observations: Observation[]) {
  const summary = summarizeObservations(observations);
  return {
    sources: summary.sources,
    eligibleExpectedGroups: summary.eligibleExpectedGroups,
    unsupportedExpectedGroups: summary.unsupportedExpectedGroups,
    top5ExpectedGroups: summary.top5ExpectedGroups,
    meanReciprocalRankBasisPoints: summary.meanReciprocalRankBasisPoints,
  };
}

function parseArguments(args: string[]): {
  image: string;
  outputPath?: string;
  slugs: Set<string>;
} {
  let image = '';
  let outputPath: string | undefined;
  const slugs = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--image' || argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--image') {
        if (image) throw new Error('--image may be specified once');
        image = value;
      } else {
        if (outputPath) throw new Error('--output may be specified once');
        outputPath = value;
      }
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown YAMNet evaluation flag: ${argument}`);
    } else {
      slugs.add(normalizedId(argument, 'requested corpus slug'));
    }
  }
  if (!image) throw new Error('--image is required');
  return { image, outputPath, slugs };
}

async function main(): Promise<void> {
  if (endianness() !== 'LE') throw new Error('YAMNet evaluation requires a little-endian host');
  const { image, outputPath, slugs } = parseArguments(process.argv.slice(2));
  const evaluationSourcePins = yamnetEvaluationSourcePins();
  const ffmpegVersion = decoderVersion('ffmpeg');
  const ffprobeVersion = decoderVersion('ffprobe');
  const execution = inspectImage(image);
  const { corpusSources, expectations, vocabulary } = loadAndValidateEvaluationInputs();
  const vocabularyIds = vocabulary.instruments.map((item) => item.id);
  const mapping = loadMapping(vocabularyIds);
  const supportedIds = new Set(mapping.supportedIds);
  const familyById = new Map(vocabulary.instruments.map((item) => [item.id, item.family]));
  const expectationBySlug = new Map(expectations.sources.map((item) => [item.slug, item]));
  for (const slug of slugs) {
    if (!expectationBySlug.has(slug)) throw new Error(`unknown YAMNet corpus slug: ${slug}`);
  }
  const [{ decodeAnalysisWindows }, { discoveryWindowSampleCounts }] = await Promise.all([
    import('../audio-analysis/decoder.ts'),
    import('../audio-analysis/discovery.ts'),
  ]);
  const observations: Observation[] = [];
  for (const expectation of expectations.sources) {
    if (slugs.size && !slugs.has(expectation.slug)) continue;
    const source = corpusSources.find(
      (candidate) => candidate.kind === 'file' && candidate.slug === expectation.slug
    );
    if (!source) throw new Error(`${expectation.slug}: authorized source is missing`);
    const approved = approvedCorpusAudioPath(source.source, source.slug);
    const sourceSha1 = await actualFileSha1(approved.path, approved.bytes);
    if (source.provenance?.sha1 && sourceSha1 !== source.provenance.sha1) {
      throw new Error(`${source.slug}: hydrated audio does not match its recorded SHA-1`);
    }
    const sourceSha256 = sha256File(approved.path);
    const decoded = await decodeAnalysisWindows(approved.path, {
      timeoutMs: DEFAULT_DECODER_TIMEOUT_MS,
      maxSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
    });
    const windowCounts = discoveryWindowSampleCounts(decoded);
    const pcm = Buffer.from(
      decoded.samples.buffer,
      decoded.samples.byteOffset,
      decoded.samples.byteLength
    );
    const analysisPcmSha256 = sha256Bytes(pcm);
    const result = runComparator(execution, source.slug, pcm, windowCounts, mapping.supportedIds);
    if (sha256File(approved.path) !== sourceSha256) {
      throw new Error(`${source.slug}: hydrated audio changed during evaluation`);
    }
    const scores = trackScores(result, mapping.supportedIds);
    const evaluated = evaluateObservation(expectation, scores, supportedIds, familyById);
    observations.push({
      slug: source.slug,
      coverage: source.coverage ?? [],
      sourceSha1,
      sourceSha256,
      analysisPcmSha256,
      analysisWindowSamples: [...windowCounts],
      sourceBytes: approved.bytes,
      sourceDurationSeconds: Number(decoded.sourceDurationSeconds.toFixed(3)),
      analyzedSeconds: Number(decoded.analyzedSeconds.toFixed(3)),
      windowsAnalyzed: windowCounts.length,
      loadMs: result.loadMs,
      inferenceMs: result.windows.reduce((sum, window) => sum + window.inferenceMs, 0),
      timingMs: result.timingMs,
      trackScores: scores,
      topMapped: evaluated.topMapped,
      topAudioSetByWindow: result.windows.map((window) => window.topClasses),
      expectedGroups: evaluated.expectedGroups,
      hardNegatives: evaluated.hardNegatives,
    });
  }
  const summary = summarizeObservations(observations);
  const byCoverage: Record<string, ReturnType<typeof bucketSummary>> = {};
  for (const coverage of [...new Set(observations.flatMap((item) => item.coverage))].sort()) {
    byCoverage[coverage] = bucketSummary(
      observations.filter((observation) => observation.coverage.includes(coverage))
    );
  }
  const byFamily: Record<string, { eligibleGroups: number; top5Groups: number; meanRank: number }> = {};
  const families = [
    ...new Set(
      observations.flatMap((item) =>
        item.expectedGroups.filter((group) => group.state === 'eligible').map((group) => group.family)
      )
    ),
  ].sort();
  for (const family of families) {
    const groups = observations.flatMap((item) => item.expectedGroups).filter(
      (group) => group.state === 'eligible' && group.family === family
    );
    byFamily[family] = {
      eligibleGroups: groups.length,
      top5Groups: groups.filter((group) => (group.rank ?? Number.POSITIVE_INFINITY) <= 5).length,
      meanRank: groups.length
        ? Number((groups.reduce((sum, group) => sum + (group.rank ?? 0), 0) / groups.length).toFixed(3))
        : 0,
    };
  }
  const observationBySlug = new Map(observations.map((item) => [item.slug, item]));
  const confusionTrials = expectations.confusionTrials.map((trial) => ({
    id: trial.id,
    status: trial.status,
    observations: trial.sourceSlugs.flatMap((slug) => {
      const observation = observationBySlug.get(slug);
      const expectation = expectationBySlug.get(slug);
      if (!observation || !expectation) return [];
      const accepted = new Set(expectation.expectedGroups.flatMap((group) => group.acceptedIds));
      const negatives = new Set(expectation.hardNegativeIds);
      const leftScore = Math.max(
        ...trial.leftIds.filter((id) => supportedIds.has(id)).map((id) => observation.trackScores[id]),
        0
      );
      const rightScore = Math.max(
        ...trial.rightIds.filter((id) => supportedIds.has(id)).map((id) => observation.trackScores[id]),
        0
      );
      const leftExpected = trial.leftIds.some((id) => accepted.has(id)) && trial.rightIds.some((id) => negatives.has(id));
      const rightExpected = trial.rightIds.some((id) => accepted.has(id)) && trial.leftIds.some((id) => negatives.has(id));
      if (leftExpected === rightExpected) return [];
      return [
        {
          slug,
          expectedSide: leftExpected ? 'left' : 'right',
          leftScore,
          rightScore,
          expectedMargin: leftExpected ? leftScore - rightScore : rightScore - leftScore,
        },
      ];
    }),
  }));
  assertEvaluationSourcesUnchanged(evaluationSourcePins);
  const report = {
    $schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    status: 'comparison-only-no-threshold',
    promotionEligible: false,
    caveat:
      'Corpus annotations are non-exhaustive. Rank and threshold-sweep results are not precision claims and cannot select a live threshold without reviewed controls.',
    candidate: {
      classifierVersion: mapping.classifierVersion,
      modelSha256: mapping.modelSha256,
      classMapSha256: mapping.classMapSha256,
      mappingSha256: MAPPING_SHA256,
      vocabularyVersion: mapping.vocabularyVersion,
      vocabularySha256: mapping.vocabularySha256,
      scoringPolicyVersion: SCORING_POLICY_VERSION,
      scoringPolicy: mapping.scoringPolicy,
      supportedIds: mapping.supportedIds,
      unsupported: mapping.unsupported,
      officialLicense: 'Apache 2.0',
      kaggleVersionId: 763,
      tensorflowModelsRevision: '4d7bdd8c170ee90850f2f9ccef0f6d19b817de35',
    },
    execution,
    evaluationSources: {
      nodeVersion: process.version,
      corpusPath: CORPUS_PATH,
      corpusSha256: evaluationSourcePins.corpus.sha256,
      groundTruthPath: EXPECTATIONS_PATH,
      groundTruthSha256: evaluationSourcePins.expectations.sha256,
      mappingPath: MAPPING_PATH,
      mappingSha256: evaluationSourcePins.mapping.sha256,
      evaluatorPath: 'scripts/eval-yamnet-comparator.mts',
      evaluatorSha256: evaluationSourcePins.evaluator.sha256,
      ffmpegVersion,
      ffprobeVersion,
      analysisSampleRate: ANALYSIS_SAMPLE_RATE,
      sourcePins: evaluationSourcePins,
    },
    summary,
    byCoverage,
    byFamily,
    confusionTrials,
    observations,
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  assertEvaluationSourcesUnchanged(evaluationSourcePins);
  if (outputPath) {
    writeFileSync(outputPath, serialized, { flag: 'wx', mode: 0o600 });
  } else {
    process.stdout.write(serialized);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'YAMNet evaluation failed'}\n`);
    process.exitCode = 1;
  });
}
