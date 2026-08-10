import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { ANALYSIS_SAMPLE_RATE } from '../../audio-analysis/config.ts';
import { INSTRUMENT_REVIEW_OPTIONS } from '../../src/analysis/instrument-review.ts';
import { loadAndValidateEvaluationInputs } from '../eval-instrument-discovery.mts';
import {
  loadMapping,
  yamnetEvaluationSourcePins,
} from '../eval-yamnet-comparator.mts';
import { loadInstrumentControlManifest } from './instrument-control-corpus.mts';
import {
  INSTRUMENT_EVALUATION_PLAN_PATH,
  INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA,
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
  validateInstrumentCandidateObservations,
  type InstrumentCandidateObservationsV3,
  type InstrumentEvaluationPlanV1,
} from './instrument-evaluation.mts';

export const YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA =
  'stem-splitter.yamnet-candidate-source-report.v1' as const;

const CORPUS_REPORT_SCHEMA = 'stem-splitter.yamnet-comparator-evaluation.v2' as const;
const CONTROL_REPORT_SCHEMA = 'stem-splitter.yamnet-control-evaluation.v1' as const;
const GENERATOR_PATH = 'scripts/lib/yamnet-candidate-capture.mts' as const;
const DEPENDENCY_LOCK_PATH = 'yamnet-comparator/uv.lock' as const;
const CORPUS_EVALUATOR_PATH = 'scripts/eval-yamnet-comparator.mts' as const;
const CONTROL_EVALUATOR_PATH = 'scripts/eval-yamnet-controls.mts' as const;
const MAPPING_PATH = 'yamnet-comparator/mapping.json' as const;
const CORPUS_PATH = 'tests/corpus/corpus.json' as const;
const EXPECTATIONS_PATH = 'tests/corpus/instrument-discovery-expectations.json' as const;
const CONTROL_MANIFEST_PATH = 'tests/corpus/instrument-control-manifest.json' as const;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 805_306_368;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const IMAGE_SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,199}$/;

const IMAGE_SOURCE_PATHS = [
  'instrument-discovery/vocabulary.json',
  'yamnet-comparator/Dockerfile',
  'yamnet-comparator/backend.py',
  'yamnet-comparator/cli.py',
  'yamnet-comparator/constants.py',
  'yamnet-comparator/contract.py',
  'yamnet-comparator/download_model.py',
  MAPPING_PATH,
] as const;

const CONTROL_EVALUATOR_SOURCE_PATHS = {
  comparatorEvaluator: CORPUS_EVALUATOR_PATH,
  controlManifestLibrary: 'scripts/lib/instrument-control-corpus.mts',
  controlHydrator: 'scripts/hydrate-instrument-controls.mts',
  analysisConfig: 'audio-analysis/config.ts',
  analysisDecoder: 'audio-analysis/decoder.ts',
  discoveryWindowPolicy: 'audio-analysis/discovery.ts',
} as const;

const THRESHOLD_POLICY = Object.freeze({
  $schema: 'stem-splitter.yamnet-threshold-policy.v1',
  selection: 'none-review-pending',
  candidateOutcome: 'abstained',
  outcomeReason: 'no-label-cleared-threshold',
  detectionsAllowed: false,
  promotionEligible: false,
});

type JsonRecord = Record<string, unknown>;

export interface YamnetCandidateSourceReportV1 {
  $schema: typeof YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA;
  generatedAt: string;
  corpusReport: {
    path: string;
    schema: typeof CORPUS_REPORT_SCHEMA;
    sha256: string;
  };
  controlReport: {
    path: string;
    schema: typeof CONTROL_REPORT_SCHEMA;
    sha256: string;
  };
}

interface RepositoryJsonFile {
  path: string;
  sha256: string;
  value: unknown;
}

interface ValidatedExecution {
  imageId: string;
  imagePlatform: 'linux/amd64';
  hostPlatform: 'linux/amd64';
  emulated: false;
  dependencyLockSha256: string;
}

interface ValidatedReports {
  candidate: {
    classifierVersion: string;
    modelSha256: string;
    vocabularyVersion: string;
    vocabularySha256: string;
    scoringPolicyVersion: string;
    scoringPolicy: JsonRecord;
    mappingSha256: string;
    classMapSha256: string;
    supportedIds: string[];
  };
  execution: ValidatedExecution;
  preprocessingPolicy: JsonRecord;
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertCanonicalRepositoryRoot(repositoryRoot: string): void {
  if (realpathSync(resolve(repositoryRoot)) !== realpathSync(process.cwd())) {
    throw new Error('YAMNet candidate capture repository root must match the current checkout');
  }
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(repositoryRoot: string, path: string): string {
  return sha256Bytes(readFileSync(resolve(repositoryRoot, path)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentVersion(prefix: string, value: unknown): { version: string; sha256: string } {
  const sha256 = sha256Bytes(stableJson(value));
  const version = `${prefix}@sha256-${sha256.slice(0, 12)}`;
  if (!SAFE_VERSION.test(version)) throw new Error(`${prefix} content version is invalid`);
  return { version, sha256 };
}

function canonicalIso(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function relativePath(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function readRepositoryJson(
  repositoryRoot: string,
  pathValue: unknown,
  context: string,
  expectedSha256?: unknown
): RepositoryJsonFile {
  const path = relativePath(pathValue, `${context} path`);
  const root = realpathSync(resolve(repositoryRoot));
  let candidate = root;
  for (const component of path.split('/')) {
    candidate = resolve(candidate, component);
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink()) throw new Error(`${context} path contains a symbolic link`);
  }
  const resolvedPath = realpathSync(candidate);
  const metadata = lstatSync(resolvedPath);
  if (
    !resolvedPath.startsWith(`${root}${sep}`) ||
    !metadata.isFile() ||
    metadata.size < 2 ||
    metadata.size > MAX_REPORT_BYTES
  ) {
    throw new Error(`${context} is not a bounded repository report`);
  }
  const bytes = readFileSync(resolvedPath);
  const sha256 = sha256Bytes(bytes);
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
    throw new Error(`${context} content drifted`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
  return { path, sha256, value };
}

function currentPin(repositoryRoot: string, path: string) {
  return { path, sha256: sha256File(repositoryRoot, path) };
}

function validatePinMap(
  value: unknown,
  expected: Record<string, { path: string; sha256: string }>,
  context: string
): void {
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(value, Object.keys(expected), context);
  for (const [name, pin] of Object.entries(expected)) {
    const actual = value[name];
    if (!record(actual)) throw new Error(`${context} ${name} is invalid`);
    exactKeys(actual, ['path', 'sha256'], `${context} ${name}`);
    if (actual.path !== pin.path || actual.sha256 !== pin.sha256) {
      throw new Error(`${context} ${name} drifted`);
    }
  }
}

function validateScoreMap(
  value: unknown,
  supportedIds: string[],
  context: string
): Record<string, number> {
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(value, supportedIds, context);
  const scores: Record<string, number> = {};
  for (const id of supportedIds) {
    const score = value[id];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`${context} contains an invalid ${id} score`);
    }
    scores[id] = score;
  }
  return scores;
}

function safeInteger(
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

function safeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function sameArray(value: unknown, expected: readonly unknown[], context: string): void {
  if (!Array.isArray(value) || stableJson(value) !== stableJson(expected)) {
    throw new Error(`${context} drifted`);
  }
}

function rankedScores(scores: Record<string, number>): Array<{ id: string; score: number }> {
  return Object.entries(scores)
    .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))
    .map(([id, score]) => ({ id, score }));
}

function validateTopMapped(
  value: unknown,
  scores: Record<string, number>,
  context: string
): void {
  if (!Array.isArray(value) || value.length !== 12) {
    throw new Error(`${context} must contain the exact top 12 mapped labels`);
  }
  const expected = rankedScores(scores).slice(0, 12);
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value[index];
    if (!record(actual)) throw new Error(`${context} item is invalid`);
    exactKeys(actual, ['id', 'score'], `${context} item`);
    if (actual.id !== expected[index].id || actual.score !== expected[index].score) {
      throw new Error(`${context} drifted from the score ranking`);
    }
  }
}

function validateTimingAndSource(
  observation: JsonRecord,
  maximumDurationSeconds: number,
  context: string
): { windows: number; inferenceMs: number; timingMs: number } {
  safeInteger(observation.sourceBytes, 1, 100 * 1024 * 1024, `${context} source bytes`);
  const sourceDuration = safeNumber(
    observation.sourceDurationSeconds,
    0.001,
    maximumDurationSeconds,
    `${context} source duration`
  );
  const analyzedSeconds = safeNumber(
    observation.analyzedSeconds,
    0.001,
    45,
    `${context} analyzed duration`
  );
  if (analyzedSeconds > sourceDuration + 0.002) {
    throw new Error(`${context} analyzed beyond its source duration`);
  }
  const windows = safeInteger(observation.windowsAnalyzed, 1, 3, `${context} windows`);
  const loadMs = safeInteger(observation.loadMs, 0, 300_000, `${context} load timing`);
  const inferenceMs = safeInteger(
    observation.inferenceMs,
    0,
    300_000,
    `${context} inference timing`
  );
  const timingMs = safeInteger(observation.timingMs, 0, 300_000, `${context} total timing`);
  if (timingMs < loadMs || timingMs < inferenceMs) {
    throw new Error(`${context} timing is internally inconsistent`);
  }
  return { windows, inferenceMs, timingMs };
}

function validateCandidateIdentity(
  corpusCandidate: unknown,
  controlCandidate: unknown,
  repositoryRoot: string
): ValidatedReports['candidate'] {
  if (!record(corpusCandidate) || !record(controlCandidate)) {
    throw new Error('YAMNet candidate identity is invalid');
  }
  exactKeys(
    corpusCandidate,
    [
      'classifierVersion',
      'modelSha256',
      'classMapSha256',
      'mappingSha256',
      'vocabularyVersion',
      'vocabularySha256',
      'scoringPolicyVersion',
      'scoringPolicy',
      'supportedIds',
      'unsupported',
      'officialLicense',
      'kaggleVersionId',
      'tensorflowModelsRevision',
    ],
    'YAMNet corpus candidate identity'
  );
  exactKeys(
    controlCandidate,
    [
      'classifierVersion',
      'modelSha256',
      'classMapSha256',
      'mappingPath',
      'mappingSha256',
      'vocabularyVersion',
      'vocabularySha256',
      'scoringPolicy',
      'supportedIds',
      'unsupported',
    ],
    'YAMNet control candidate identity'
  );
  const vocabularyIds = INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => id);
  const mapping = loadMapping(vocabularyIds, repositoryRoot);
  const expected = {
    classifierVersion: mapping.classifierVersion,
    modelSha256: mapping.modelSha256,
    classMapSha256: mapping.classMapSha256,
    mappingSha256: sha256File(repositoryRoot, MAPPING_PATH),
    vocabularyVersion: mapping.vocabularyVersion,
    vocabularySha256: mapping.vocabularySha256,
    scoringPolicyVersion:
      'max-class-top3-patch-mean-second-window-v1',
    scoringPolicy: mapping.scoringPolicy,
    supportedIds: mapping.supportedIds,
    unsupported: mapping.unsupported,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (stableJson(corpusCandidate[name]) !== stableJson(value)) {
      throw new Error(`YAMNet corpus candidate ${name} drifted`);
    }
    if (name !== 'scoringPolicyVersion' && stableJson(controlCandidate[name]) !== stableJson(value)) {
      throw new Error(`YAMNet control candidate ${name} drifted`);
    }
  }
  if (
    controlCandidate.mappingPath !== MAPPING_PATH ||
    corpusCandidate.officialLicense !== 'Apache 2.0' ||
    corpusCandidate.kaggleVersionId !== 763 ||
    corpusCandidate.tensorflowModelsRevision !==
      '4d7bdd8c170ee90850f2f9ccef0f6d19b817de35'
  ) {
    throw new Error('YAMNet candidate provenance drifted');
  }
  return expected;
}

function validateExecution(
  corpusExecution: unknown,
  controlExecution: unknown,
  repositoryRoot: string
): ValidatedExecution {
  if (!record(corpusExecution) || !record(controlExecution)) {
    throw new Error('YAMNet native execution is invalid');
  }
  const keys = ['id', 'platform', 'sizeBytes', 'host', 'emulated', 'lockSha256', 'sourceSha256'];
  exactKeys(corpusExecution, keys, 'YAMNet corpus execution');
  exactKeys(controlExecution, keys, 'YAMNet control execution');
  if (stableJson(corpusExecution) !== stableJson(controlExecution)) {
    throw new Error('YAMNet reports were not produced by one execution identity');
  }
  if (
    typeof corpusExecution.id !== 'string' ||
    !IMAGE_SHA256.test(corpusExecution.id) ||
    corpusExecution.platform !== 'linux/amd64' ||
    corpusExecution.host !== 'linux/x64' ||
    corpusExecution.emulated !== false ||
    !Number.isSafeInteger(corpusExecution.sizeBytes) ||
    (corpusExecution.sizeBytes as number) < 1 ||
    (corpusExecution.sizeBytes as number) > MAX_IMAGE_BYTES
  ) {
    throw new Error('YAMNet reports require one native linux/amd64 image');
  }
  const lockSha256 = sha256File(repositoryRoot, DEPENDENCY_LOCK_PATH);
  if (corpusExecution.lockSha256 !== lockSha256 || !record(corpusExecution.sourceSha256)) {
    throw new Error('YAMNet execution lock or source identity drifted');
  }
  exactKeys(corpusExecution.sourceSha256, IMAGE_SOURCE_PATHS, 'YAMNet image source pins');
  for (const path of IMAGE_SOURCE_PATHS) {
    if (corpusExecution.sourceSha256[path] !== sha256File(repositoryRoot, path)) {
      throw new Error(`YAMNet image source drifted: ${path}`);
    }
  }
  return {
    imageId: corpusExecution.id,
    imagePlatform: 'linux/amd64',
    hostPlatform: 'linux/amd64',
    emulated: false,
    dependencyLockSha256: lockSha256,
  };
}

function validateCorpusEvaluator(
  value: unknown,
  plan: InstrumentEvaluationPlanV1,
  repositoryRoot: string
): { ffmpegVersion: string; ffprobeVersion: string; sourcePins: JsonRecord } {
  if (!record(value)) throw new Error('YAMNet corpus evaluator provenance is invalid');
  exactKeys(
    value,
    [
      'nodeVersion',
      'corpusPath',
      'corpusSha256',
      'groundTruthPath',
      'groundTruthSha256',
      'mappingPath',
      'mappingSha256',
      'evaluatorPath',
      'evaluatorSha256',
      'ffmpegVersion',
      'ffprobeVersion',
      'analysisSampleRate',
      'sourcePins',
    ],
    'YAMNet corpus evaluator provenance'
  );
  const corpusPartition = plan.partitions[0];
  const expectedPins = yamnetEvaluationSourcePins(repositoryRoot);
  validatePinMap(value.sourcePins, expectedPins, 'YAMNet corpus evaluator source pins');
  if (
    value.nodeVersion !== 'v22.23.1' ||
    value.corpusPath !== CORPUS_PATH ||
    value.corpusSha256 !== corpusPartition.manifestSha256 ||
    value.groundTruthPath !== EXPECTATIONS_PATH ||
    value.groundTruthSha256 !== corpusPartition.expectationsSha256 ||
    value.mappingPath !== MAPPING_PATH ||
    value.mappingSha256 !== sha256File(repositoryRoot, MAPPING_PATH) ||
    value.evaluatorPath !== CORPUS_EVALUATOR_PATH ||
    value.evaluatorSha256 !== sha256File(repositoryRoot, CORPUS_EVALUATOR_PATH) ||
    value.analysisSampleRate !== ANALYSIS_SAMPLE_RATE ||
    typeof value.ffmpegVersion !== 'string' ||
    !value.ffmpegVersion ||
    typeof value.ffprobeVersion !== 'string' ||
    !value.ffprobeVersion
  ) {
    throw new Error('YAMNet corpus evaluator provenance drifted');
  }
  return {
    ffmpegVersion: value.ffmpegVersion,
    ffprobeVersion: value.ffprobeVersion,
    sourcePins: value.sourcePins as JsonRecord,
  };
}

function validateControlEvaluator(
  value: unknown,
  repositoryRoot: string,
  corpusEvaluator: ReturnType<typeof validateCorpusEvaluator>
): JsonRecord {
  if (!record(value)) throw new Error('YAMNet control evaluator provenance is invalid');
  exactKeys(
    value,
    [
      'path',
      'sha256',
      'sourcePins',
      'ffmpegVersion',
      'ffprobeVersion',
      'analysisSampleRate',
      'maximumSourceDurationSeconds',
    ],
    'YAMNet control evaluator provenance'
  );
  const expectedPins = Object.fromEntries(
    Object.entries(CONTROL_EVALUATOR_SOURCE_PATHS).map(([name, path]) => [
      name,
      currentPin(repositoryRoot, path),
    ])
  );
  validatePinMap(value.sourcePins, expectedPins, 'YAMNet control evaluator source pins');
  if (
    value.path !== CONTROL_EVALUATOR_PATH ||
    value.sha256 !== sha256File(repositoryRoot, CONTROL_EVALUATOR_PATH) ||
    value.ffmpegVersion !== corpusEvaluator.ffmpegVersion ||
    value.ffprobeVersion !== corpusEvaluator.ffprobeVersion ||
    value.analysisSampleRate !== ANALYSIS_SAMPLE_RATE ||
    value.maximumSourceDurationSeconds !== 120
  ) {
    throw new Error('YAMNet control evaluator provenance drifted');
  }
  return value;
}

function validateCorpusObservations(
  value: unknown,
  partition: InstrumentEvaluationPlanV1['partitions'][number],
  supportedIds: string[]
): void {
  if (!Array.isArray(value) || value.length !== partition.sources.length) {
    throw new Error('YAMNet corpus observation coverage is incomplete');
  }
  const { corpusSources, expectations } = loadAndValidateEvaluationInputs();
  const expectationById = new Map(expectations.sources.map((source) => [source.slug, source]));
  const corpusById = new Map(corpusSources.map((source) => [source.slug, source]));
  const supported = new Set(supportedIds);
  const familyById = new Map(INSTRUMENT_REVIEW_OPTIONS.map(({ id, family }) => [id, family]));
  for (let index = 0; index < value.length; index += 1) {
    const observation = value[index];
    const expected = partition.sources[index];
    if (!record(observation)) throw new Error('YAMNet corpus observation is invalid');
    exactKeys(
      observation,
      [
        'slug',
        'coverage',
        'sourceSha1',
        'sourceSha256',
        'analysisPcmSha256',
        'analysisWindowSamples',
        'sourceBytes',
        'sourceDurationSeconds',
        'analyzedSeconds',
        'windowsAnalyzed',
        'loadMs',
        'inferenceMs',
        'timingMs',
        'trackScores',
        'topMapped',
        'topAudioSetByWindow',
        'expectedGroups',
        'hardNegatives',
      ],
      `YAMNet corpus observation ${index + 1}`
    );
    const expectation = expectationById.get(expected.id);
    const corpusSource = corpusById.get(expected.id);
    if (
      observation.slug !== expected.id ||
      observation.sourceSha256 !== expected.sourceSha256 ||
      !expectation ||
      !corpusSource ||
      typeof observation.sourceSha1 !== 'string' ||
      !SHA1.test(observation.sourceSha1) ||
      typeof observation.analysisPcmSha256 !== 'string' ||
      !SHA256.test(observation.analysisPcmSha256) ||
      !Array.isArray(observation.analysisWindowSamples) ||
      !Array.isArray(observation.coverage) ||
      !Array.isArray(observation.topMapped) ||
      !Array.isArray(observation.topAudioSetByWindow) ||
      !Array.isArray(observation.expectedGroups) ||
      !Array.isArray(observation.hardNegatives)
    ) {
      throw new Error(`YAMNet corpus observation ${expected.id} drifted`);
    }
    if (
      corpusSource.provenance?.sha1 &&
      observation.sourceSha1 !== corpusSource.provenance.sha1
    ) {
      throw new Error(`${expected.id} Archive SHA-1 provenance drifted`);
    }
    sameArray(observation.coverage, corpusSource.coverage ?? [], `${expected.id} coverage`);
    const timing = validateTimingAndSource(observation, 15 * 60, expected.id);
    if (observation.analysisWindowSamples.length !== timing.windows) {
      throw new Error(`${expected.id} analysis-window count drifted`);
    }
    const totalSamples = observation.analysisWindowSamples.reduce(
      (sum: number, raw: unknown) =>
        sum + safeInteger(raw, 1, ANALYSIS_SAMPLE_RATE * 15, `${expected.id} window samples`),
      0
    );
    if (Math.abs(totalSamples / ANALYSIS_SAMPLE_RATE - (observation.analyzedSeconds as number)) > 0.001) {
      throw new Error(`${expected.id} analyzed duration drifted from its PCM plan`);
    }
    const scores = validateScoreMap(
      observation.trackScores,
      supportedIds,
      `${expected.id} YAMNet scores`
    );
    validateTopMapped(observation.topMapped, scores, `${expected.id} top mapped labels`);
    if (observation.topAudioSetByWindow.length !== timing.windows) {
      throw new Error(`${expected.id} AudioSet window coverage drifted`);
    }
    for (const window of observation.topAudioSetByWindow) {
      if (!Array.isArray(window) || window.length !== 12) {
        throw new Error(`${expected.id} AudioSet window is incomplete`);
      }
      let prior = Number.POSITIVE_INFINITY;
      const indexes = new Set<number>();
      for (const item of window) {
        if (!record(item)) throw new Error(`${expected.id} AudioSet class is invalid`);
        exactKeys(item, ['index', 'mid', 'displayName', 'top3Mean'], `${expected.id} AudioSet class`);
        const classIndex = safeInteger(item.index, 0, 520, `${expected.id} AudioSet index`);
        const score = safeNumber(item.top3Mean, 0, 1, `${expected.id} AudioSet score`);
        if (
          indexes.has(classIndex) ||
          score > prior ||
          typeof item.mid !== 'string' ||
          !/^\/(?:g|m|t)\/[A-Za-z0-9_]+$/.test(item.mid) ||
          typeof item.displayName !== 'string' ||
          !item.displayName.trim()
        ) {
          throw new Error(`${expected.id} AudioSet class drifted`);
        }
        indexes.add(classIndex);
        prior = score;
      }
    }
    const ranking = rankedScores(scores);
    const rankById = new Map(ranking.map(({ id }, rank) => [id, rank + 1]));
    const expectedGroups = expectation.expectedGroups.map((group) => {
      const supportedAcceptedIds = group.acceptedIds.filter((id) => supported.has(id));
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
      const families = new Set(
        supportedAcceptedIds.map((id) => familyById.get(id) ?? 'unknown')
      );
      return {
        ...group,
        supportedAcceptedIds,
        state: 'eligible',
        score: Math.max(...supportedAcceptedIds.map((id) => scores[id])),
        rank: Math.min(...supportedAcceptedIds.map((id) => rankById.get(id)!)),
        family: families.size === 1 ? [...families][0] : 'cross-family',
      };
    });
    sameArray(observation.expectedGroups, expectedGroups, `${expected.id} expected groups`);
    const hardNegatives = expectation.hardNegativeIds
      .filter((id) => supported.has(id))
      .map((id) => ({ id, score: scores[id] }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    sameArray(observation.hardNegatives, hardNegatives, `${expected.id} hard negatives`);
  }
}

function validateControlObservations(
  value: unknown,
  partition: InstrumentEvaluationPlanV1['partitions'][number],
  supportedIds: string[],
  repositoryRoot: string
): void {
  if (!Array.isArray(value) || value.length !== partition.sources.length) {
    throw new Error('YAMNet control observation coverage is incomplete');
  }
  const manifest = loadInstrumentControlManifest(repositoryRoot);
  const controlById = new Map(manifest.controls.map((control) => [control.id, control]));
  const familyById = new Map(INSTRUMENT_REVIEW_OPTIONS.map(({ id, family }) => [id, family]));
  const supported = new Set(supportedIds);
  for (let index = 0; index < value.length; index += 1) {
    const observation = value[index];
    const expected = partition.sources[index];
    if (!record(observation)) throw new Error('YAMNet control observation is invalid');
    exactKeys(
      observation,
      [
        'id',
        'instrument',
        'family',
        'positiveIds',
        'sourceBytes',
        'sourceSha256',
        'sourceDurationSeconds',
        'declaredDurationSeconds',
        'analyzedSeconds',
        'windowsAnalyzed',
        'loadMs',
        'inferenceMs',
        'timingMs',
        'trackScores',
        'positives',
        'specificPositive',
        'candidateNegativeCount',
        'topCandidateNegatives',
        'topMapped',
      ],
      `YAMNet control observation ${index + 1}`
    );
    const control = controlById.get(expected.id);
    if (
      observation.id !== expected.id ||
      observation.sourceSha256 !== expected.sourceSha256 ||
      !control ||
      observation.instrument !== control.instrument ||
      observation.family !== familyById.get(control.instrument) ||
      observation.sourceBytes !== control.media.bytes ||
      typeof observation.sourceDurationSeconds !== 'number' ||
      Math.abs(observation.sourceDurationSeconds - control.media.durationSeconds) > 0.02 ||
      !Array.isArray(observation.positiveIds) ||
      !Array.isArray(observation.positives) ||
      !record(observation.specificPositive) ||
      !Array.isArray(observation.topCandidateNegatives) ||
      !Array.isArray(observation.topMapped)
    ) {
      throw new Error(`YAMNet control observation ${expected.id} drifted`);
    }
    sameArray(observation.positiveIds, control.positiveIds, `${expected.id} positive ids`);
    validateTimingAndSource(observation, 120, expected.id);
    if (observation.declaredDurationSeconds !== control.media.durationSeconds) {
      throw new Error(`${expected.id} declared duration drifted`);
    }
    const scores = validateScoreMap(
      observation.trackScores,
      supportedIds,
      `${expected.id} YAMNet scores`
    );
    validateTopMapped(observation.topMapped, scores, `${expected.id} top mapped labels`);
    const ranking = rankedScores(scores);
    const rankById = new Map(ranking.map(({ id }, rank) => [id, rank + 1]));
    const positives = control.positiveIds.map((id) =>
      supported.has(id)
        ? { id, state: 'eligible', score: scores[id], rank: rankById.get(id) }
        : { id, state: 'unsupported', score: null, rank: null }
    );
    sameArray(observation.positives, positives, `${expected.id} positive scores`);
    const specific = positives.find(({ id }) => id === control.instrument);
    if (!specific || stableJson(observation.specificPositive) !== stableJson(specific)) {
      throw new Error(`${expected.id} specific positive drifted`);
    }
    const candidateNegatives = ranking
      .filter(({ id }) => !control.positiveIds.includes(id))
      .map(({ id, score }) => ({ id, score }));
    if (observation.candidateNegativeCount !== candidateNegatives.length) {
      throw new Error(`${expected.id} candidate-negative count drifted`);
    }
    sameArray(
      observation.topCandidateNegatives,
      candidateNegatives.slice(0, 12),
      `${expected.id} candidate negatives`
    );
  }
}

function validateNativeReports(
  corpusValue: unknown,
  controlValue: unknown,
  repositoryRoot: string
): ValidatedReports {
  if (!record(corpusValue) || !record(controlValue)) {
    throw new Error('YAMNet native reports are invalid');
  }
  exactKeys(
    corpusValue,
    [
      '$schema',
      'generatedAt',
      'status',
      'promotionEligible',
      'caveat',
      'candidate',
      'execution',
      'evaluationSources',
      'summary',
      'byCoverage',
      'byFamily',
      'confusionTrials',
      'observations',
    ],
    'YAMNet corpus report'
  );
  exactKeys(
    controlValue,
    [
      '$schema',
      'generatedAt',
      'status',
      'promotionEligible',
      'thresholdSelected',
      'precisionClaim',
      'caveat',
      'corpus',
      'candidate',
      'execution',
      'evaluator',
      'summary',
      'byFamily',
      'observations',
    ],
    'YAMNet control report'
  );
  canonicalIso(corpusValue.generatedAt, 'YAMNet corpus report timestamp');
  canonicalIso(controlValue.generatedAt, 'YAMNet control report timestamp');
  if (
    corpusValue.$schema !== CORPUS_REPORT_SCHEMA ||
    corpusValue.status !== 'comparison-only-no-threshold' ||
    corpusValue.promotionEligible !== false ||
    controlValue.$schema !== CONTROL_REPORT_SCHEMA ||
    controlValue.status !== 'dataset-authored-controls-awaiting-teacher-listening' ||
    controlValue.promotionEligible !== false ||
    controlValue.thresholdSelected !== null ||
    controlValue.precisionClaim !== 'none-review-pending'
  ) {
    throw new Error('YAMNet report disposition is not capture-safe');
  }
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const candidate = validateCandidateIdentity(
    corpusValue.candidate,
    controlValue.candidate,
    repositoryRoot
  );
  const execution = validateExecution(corpusValue.execution, controlValue.execution, repositoryRoot);
  const corpusEvaluator = validateCorpusEvaluator(
    corpusValue.evaluationSources,
    plan,
    repositoryRoot
  );
  const controlEvaluator = validateControlEvaluator(
    controlValue.evaluator,
    repositoryRoot,
    corpusEvaluator
  );
  if (!record(controlValue.corpus)) throw new Error('YAMNet control corpus is invalid');
  exactKeys(
    controlValue.corpus,
    [
      'manifestPath',
      'manifestSha256',
      'version',
      'reviewStatus',
      'negativePolicy',
      'dataset',
      'audioDistribution',
    ],
    'YAMNet control corpus'
  );
  const controlManifest = loadInstrumentControlManifest(repositoryRoot);
  if (
    controlValue.corpus.manifestPath !== CONTROL_MANIFEST_PATH ||
    controlValue.corpus.manifestSha256 !== plan.partitions[1].manifestSha256 ||
    controlValue.corpus.version !== controlManifest.version ||
    controlValue.corpus.reviewStatus !== controlManifest.reviewStatus ||
    stableJson(controlValue.corpus.negativePolicy) !== stableJson(controlManifest.negativePolicy) ||
    stableJson(controlValue.corpus.dataset) !== stableJson(controlManifest.dataset) ||
    controlValue.corpus.audioDistribution !== 'gitignored-hydrated-by-exact-sha256'
  ) {
    throw new Error('YAMNet control corpus identity drifted');
  }
  if (
    !record(corpusValue.summary) ||
    corpusValue.summary.sources !== plan.partitions[0].sources.length ||
    !record(controlValue.summary) ||
    controlValue.summary.controls !== plan.partitions[1].sources.length ||
    !record(corpusValue.byCoverage) ||
    !record(corpusValue.byFamily) ||
    !Array.isArray(corpusValue.confusionTrials) ||
    !record(controlValue.byFamily)
  ) {
    throw new Error('YAMNet report summary coverage drifted');
  }
  validateCorpusObservations(corpusValue.observations, plan.partitions[0], candidate.supportedIds);
  validateControlObservations(
    controlValue.observations,
    plan.partitions[1],
    candidate.supportedIds,
    repositoryRoot
  );
  const preprocessingPolicy = {
    $schema: 'stem-splitter.yamnet-preprocessing-policy.v1',
    analysisSampleRate: ANALYSIS_SAMPLE_RATE,
    ffmpegVersion: corpusEvaluator.ffmpegVersion,
    ffprobeVersion: corpusEvaluator.ffprobeVersion,
    corpusSourcePins: corpusEvaluator.sourcePins,
    controlEvaluator,
  };
  return { candidate, execution, preprocessingPolicy };
}

function reportReference<T extends typeof CORPUS_REPORT_SCHEMA | typeof CONTROL_REPORT_SCHEMA>(
  file: RepositoryJsonFile,
  schema: T
): { path: string; schema: T; sha256: string } {
  if (!record(file.value) || file.value.$schema !== schema) {
    throw new Error(`YAMNet report ${file.path} has the wrong schema`);
  }
  return { path: file.path, schema, sha256: file.sha256 };
}

export function createYamnetCandidateSourceReport(
  corpusReportPath: string,
  controlReportPath: string,
  generatedAt: string,
  repositoryRoot = process.cwd()
): YamnetCandidateSourceReportV1 {
  assertCanonicalRepositoryRoot(repositoryRoot);
  const timestamp = canonicalIso(generatedAt, 'YAMNet source-report timestamp');
  const corpus = readRepositoryJson(repositoryRoot, corpusReportPath, 'YAMNet corpus report');
  const control = readRepositoryJson(repositoryRoot, controlReportPath, 'YAMNet control report');
  validateNativeReports(corpus.value, control.value, repositoryRoot);
  const newestInput = Math.max(
    Date.parse((corpus.value as JsonRecord).generatedAt as string),
    Date.parse((control.value as JsonRecord).generatedAt as string)
  );
  if (Date.parse(timestamp) < newestInput) {
    throw new Error('YAMNet source report predates an input report');
  }
  return {
    $schema: YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA,
    generatedAt: timestamp,
    corpusReport: reportReference(corpus, CORPUS_REPORT_SCHEMA),
    controlReport: reportReference(control, CONTROL_REPORT_SCHEMA),
  };
}

export function validateYamnetCandidateSourceReport(
  value: unknown,
  repositoryRoot = process.cwd()
): { sourceReport: YamnetCandidateSourceReportV1; reports: ValidatedReports } {
  assertCanonicalRepositoryRoot(repositoryRoot);
  if (!record(value)) throw new Error('YAMNet candidate source report is invalid');
  exactKeys(
    value,
    ['$schema', 'generatedAt', 'corpusReport', 'controlReport'],
    'YAMNet candidate source report'
  );
  const generatedAt = canonicalIso(value.generatedAt, 'YAMNet candidate source-report timestamp');
  if (value.$schema !== YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA) {
    throw new Error('YAMNet candidate source-report schema drifted');
  }
  const loadReference = <T extends string>(
    raw: unknown,
    schema: T,
    context: string
  ): RepositoryJsonFile & { reference: { path: string; schema: T; sha256: string } } => {
    if (!record(raw)) throw new Error(`${context} reference is invalid`);
    exactKeys(raw, ['path', 'schema', 'sha256'], `${context} reference`);
    if (raw.schema !== schema || typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
      throw new Error(`${context} reference drifted`);
    }
    const file = readRepositoryJson(repositoryRoot, raw.path, context, raw.sha256);
    if (!record(file.value) || file.value.$schema !== schema) {
      throw new Error(`${context} bytes have the wrong schema`);
    }
    return {
      ...file,
      reference: { path: file.path, schema, sha256: file.sha256 },
    };
  };
  const corpus = loadReference(value.corpusReport, CORPUS_REPORT_SCHEMA, 'YAMNet corpus report');
  const control = loadReference(value.controlReport, CONTROL_REPORT_SCHEMA, 'YAMNet control report');
  const newestInput = Math.max(
    Date.parse((corpus.value as JsonRecord).generatedAt as string),
    Date.parse((control.value as JsonRecord).generatedAt as string)
  );
  if (Date.parse(generatedAt) < newestInput) {
    throw new Error('YAMNet candidate source report predates an input report');
  }
  return {
    sourceReport: {
      $schema: YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA,
      generatedAt,
      corpusReport: corpus.reference,
      controlReport: control.reference,
    },
    reports: validateNativeReports(corpus.value, control.value, repositoryRoot),
  };
}

export function captureYamnetInstrumentCandidate(
  sourceReportPath: string,
  generatedAt: string,
  repositoryRoot = process.cwd()
): InstrumentCandidateObservationsV3 {
  assertCanonicalRepositoryRoot(repositoryRoot);
  const timestamp = canonicalIso(generatedAt, 'YAMNet candidate timestamp');
  const sourceFile = readRepositoryJson(
    repositoryRoot,
    sourceReportPath,
    'YAMNet candidate source report'
  );
  const { sourceReport, reports } = validateYamnetCandidateSourceReport(
    sourceFile.value,
    repositoryRoot
  );
  if (Date.parse(timestamp) < Date.parse(sourceReport.generatedAt)) {
    throw new Error('YAMNet candidate predates its source report');
  }
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const planSha256 = instrumentEvaluationPlanSha256(repositoryRoot);
  const preprocessing = contentVersion(
    'yamnet-analysis-preprocessing-v1',
    reports.preprocessingPolicy
  );
  const classifierPolicyValue = {
    $schema: 'stem-splitter.yamnet-classifier-policy.v1',
    scoringPolicyVersion: reports.candidate.scoringPolicyVersion,
    scoringPolicy: reports.candidate.scoringPolicy,
    mappingSha256: reports.candidate.mappingSha256,
    classMapSha256: reports.candidate.classMapSha256,
    supportedIds: reports.candidate.supportedIds,
  };
  const classifierPolicy = contentVersion(
    'yamnet-classifier-policy-v1',
    classifierPolicyValue
  );
  const thresholdPolicy = contentVersion(
    'yamnet-review-pending-abstain-all-v1',
    THRESHOLD_POLICY
  );
  const candidate: InstrumentCandidateObservationsV3 = {
    $schema: INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    generatedAt: timestamp,
    candidate: {
      classifierVersion: reports.candidate.classifierVersion,
      modelSha256: reports.candidate.modelSha256,
      vocabularyVersion: reports.candidate.vocabularyVersion,
      vocabularySha256: reports.candidate.vocabularySha256,
      preprocessingVersion: preprocessing.version,
      preprocessingSha256: preprocessing.sha256,
      classifierPolicyVersion: classifierPolicy.version,
      classifierPolicySha256: classifierPolicy.sha256,
      thresholdPolicyVersion: thresholdPolicy.version,
      thresholdPolicySha256: thresholdPolicy.sha256,
    },
    evidence: {
      sourceReport: {
        path: sourceFile.path,
        schema: YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA,
        sha256: sourceFile.sha256,
      },
      generator: {
        path: GENERATOR_PATH,
        sha256: sha256File(repositoryRoot, GENERATOR_PATH),
      },
      execution: {
        imageId: reports.execution.imageId,
        imagePlatform: 'linux/amd64',
        hostPlatform: 'linux/amd64',
        emulated: false,
      },
      dependencyLock: {
        path: DEPENDENCY_LOCK_PATH,
        sha256: reports.execution.dependencyLockSha256,
      },
    },
    sources: plan.partitions.flatMap((partition) =>
      partition.sources.map((source) => ({
        partitionId: partition.id,
        id: source.id,
        sourceSha256: source.sourceSha256,
        outcome: 'abstained' as const,
        outcomeReason: 'no-label-cleared-threshold' as const,
        detections: [],
      }))
    ),
  };
  return validateInstrumentCandidateObservations(
    candidate,
    plan,
    planSha256,
    repositoryRoot
  );
}
