import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import {
  PINNED_INSTRUMENT_CLASSIFIER_VERSION,
  PINNED_INSTRUMENT_MODEL_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
  type InstrumentDetectionV1,
} from '../src/analysis/types.ts';

const CORPUS_PATH = 'tests/corpus/corpus.json';
const EXPECTATIONS_PATH = 'tests/corpus/instrument-discovery-expectations.json';
const VOCABULARY_PATH = 'instrument-discovery/vocabulary.json';
const EVALUATION_SCHEMA = 'stem-splitter.instrument-discovery-evaluation.v1';
const DISCOVERY_REPORT_SCHEMA = 'stem-splitter.instrument-discovery-evaluation-report.v2';
const PROMOTION_PLATFORM = 'linux/amd64';
const DEPENDENCY_LOCK_PATH = 'instrument-discovery/uv.lock';
const MAX_SOURCE_DURATION_SECONDS = 15 * 60;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const DEFAULT_DECODER_TIMEOUT_MS = 60_000;
const CORPUS_AUDIO_ROOT = resolve('tests/corpus/audio');

const OVERLAP_GROUPS = [
  { parentId: 'strings', childIds: ['violin', 'viola', 'cello', 'double-bass'] },
  { parentId: 'brass', childIds: ['trumpet', 'trombone', 'horn', 'tuba'] },
  {
    parentId: 'percussion',
    childIds: ['drum-kit', 'timpani', 'mallet-percussion', 'vibraphone', 'marimba', 'bongos'],
  },
] as const;

export interface ExpectedInstrumentGroup {
  corpusTerms: string[];
  acceptedIds: string[];
}

export interface DiscoverySourceExpectation {
  slug: string;
  expectedGroups: ExpectedInstrumentGroup[];
  hardNegativeIds: string[];
  rationale: string;
}

export interface ConfusionTrial {
  id: string;
  leftIds: string[];
  rightIds: string[];
  status: 'bidirectional' | 'one-direction' | 'corpus-gap';
  sourceSlugs: string[];
  rationale: string;
}

export interface DiscoveryEvaluationManifest {
  $schema: string;
  classifierVersion: string;
  weightsSha256: string;
  vocabularyVersion: string;
  vocabularySha256: string;
  analysisSampleRate: number;
  reviewStatus: string;
  sources: DiscoverySourceExpectation[];
  confusionTrials: ConfusionTrial[];
}

export interface CorpusSource {
  slug: string;
  kind: 'file' | 'youtube';
  source: string;
  coverage?: string[];
  expectedInstruments?: string[];
  provenance?: {
    archiveIdentifier: string;
    archiveFile?: string;
    sha1?: string;
    license: string;
    licenseUrl: string;
    verifiedAt: string;
  };
}

interface InstrumentDefinition {
  id: string;
  label: string;
  family: string;
  confusableWith: string[];
}

interface VocabularyDocument {
  version: string;
  reviewStatus: string;
  families: Record<string, { possibleThreshold: number; uncertainFloor: number }>;
  instruments: InstrumentDefinition[];
}

export interface CandidateExecutionProvenance {
  image: {
    id: string;
    platform: 'linux/amd64';
  };
  dependencyLock: {
    path: typeof DEPENDENCY_LOCK_PATH;
    sha256: string;
  };
}

export interface EvaluatedExpectedGroup extends ExpectedInstrumentGroup {
  state: 'possible' | 'uncertain' | 'missed';
  matchedDetectionIds: string[];
}

export interface DiscoveryObservationEvaluation {
  expectedGroups: EvaluatedExpectedGroup[];
  hardNegativeDetections: InstrumentDetectionV1[];
  confusionCandidates: Array<{
    detection: InstrumentDetectionV1;
    confusableExpectedIds: string[];
  }>;
  unreviewedCandidates: InstrumentDetectionV1[];
  overlapCandidates: Array<{ parentId: string; childIds: string[] }>;
  summary: {
    expectedGroups: number;
    possibleGroups: number;
    uncertainGroups: number;
    missedGroups: number;
    hardNegativeDetections: number;
    confusionCandidates: number;
    unreviewedCandidates: number;
    abstained: boolean;
  };
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

export function validateCandidateExecutionProvenance(
  value: unknown
): CandidateExecutionProvenance {
  if (!record(value)) throw new Error('candidate execution provenance is invalid');
  exactKeys(value, ['image', 'dependencyLock'], 'candidate execution provenance');
  if (!record(value.image)) throw new Error('candidate image provenance is invalid');
  exactKeys(value.image, ['id', 'platform'], 'candidate image provenance');
  if (
    typeof value.image.id !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.image.id) ||
    value.image.platform !== PROMOTION_PLATFORM
  ) {
    throw new Error('candidate image provenance is invalid');
  }
  if (!record(value.dependencyLock)) {
    throw new Error('candidate dependency-lock provenance is invalid');
  }
  exactKeys(
    value.dependencyLock,
    ['path', 'sha256'],
    'candidate dependency-lock provenance'
  );
  if (
    value.dependencyLock.path !== DEPENDENCY_LOCK_PATH ||
    typeof value.dependencyLock.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.dependencyLock.sha256)
  ) {
    throw new Error('candidate dependency-lock provenance is invalid');
  }
  return {
    image: {
      id: value.image.id,
      platform: PROMOTION_PLATFORM,
    },
    dependencyLock: {
      path: DEPENDENCY_LOCK_PATH,
      sha256: value.dependencyLock.sha256,
    },
  };
}

function executionProvenanceFromEnvironment(): CandidateExecutionProvenance {
  return validateCandidateExecutionProvenance({
    image: {
      id: process.env.INSTRUMENT_DISCOVERY_EXECUTION_IMAGE_ID,
      platform: process.env.INSTRUMENT_DISCOVERY_EXECUTION_PLATFORM,
    },
    dependencyLock: {
      path: DEPENDENCY_LOCK_PATH,
      sha256: process.env.INSTRUMENT_DISCOVERY_DEPENDENCY_LOCK_SHA256,
    },
  });
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function normalizedId(value: unknown, context: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${context} is empty`);
  const parsed = value.map((item) => normalizedId(item, context));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${context} contains duplicates`);
  return parsed;
}

function actualSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function actualFileSha1(path: string, expectedBytes: number): Promise<string> {
  const hash = createHash('sha1');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_SOURCE_BYTES) throw new Error('corpus source grew beyond the byte limit');
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw new Error('corpus source changed while it was hashed');
  return hash.digest('hex');
}

export function approvedCorpusAudioPath(path: string, slug: string): { path: string; bytes: number } {
  const candidate = resolve(path);
  const relativePath = relative(CORPUS_AUDIO_ROOT, candidate);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`${slug}: corpus source is outside tests/corpus/audio`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`${slug}: ${path} is not hydrated; corpus audio is intentionally gitignored`);
  }
  const linkStatus = lstatSync(candidate);
  const status = statSync(candidate);
  if (
    linkStatus.isSymbolicLink() ||
    !status.isFile() ||
    realpathSync(candidate) !== candidate ||
    status.size < 1 ||
    status.size > MAX_SOURCE_BYTES
  ) {
    throw new Error(`${slug}: corpus source is not an approved bounded regular file`);
  }
  return { path: candidate, bytes: status.size };
}

export function loadAndValidateEvaluationInputs(): {
  corpusSources: CorpusSource[];
  expectations: DiscoveryEvaluationManifest;
  vocabulary: VocabularyDocument;
} {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { sources?: unknown };
  if (!Array.isArray(corpus.sources)) throw new Error('audio corpus is invalid');
  const corpusSources = corpus.sources as CorpusSource[];

  const vocabularyBytes = readFileSync(VOCABULARY_PATH);
  if (actualSha256(vocabularyBytes) !== PINNED_INSTRUMENT_VOCABULARY_SHA256) {
    throw new Error('instrument vocabulary bytes do not match the application pin');
  }
  const vocabulary = JSON.parse(vocabularyBytes.toString('utf8')) as VocabularyDocument;
  if (
    vocabulary.version !== PINNED_INSTRUMENT_VOCABULARY_VERSION ||
    !record(vocabulary.families) ||
    !Array.isArray(vocabulary.instruments)
  ) {
    throw new Error('instrument vocabulary document is invalid');
  }
  const instrumentById = new Map(vocabulary.instruments.map((instrument) => [instrument.id, instrument]));
  if (instrumentById.size !== vocabulary.instruments.length) {
    throw new Error('instrument vocabulary ids are not unique');
  }

  const rawExpectations: unknown = JSON.parse(readFileSync(EXPECTATIONS_PATH, 'utf8'));
  if (!record(rawExpectations)) throw new Error('discovery expectations root is invalid');
  exactKeys(
    rawExpectations,
    [
      '$schema',
      'classifierVersion',
      'weightsSha256',
      'vocabularyVersion',
      'vocabularySha256',
      'analysisSampleRate',
      'reviewStatus',
      'sources',
      'confusionTrials',
    ],
    'discovery expectations'
  );
  if (
    rawExpectations.$schema !== EVALUATION_SCHEMA ||
    rawExpectations.classifierVersion !== PINNED_INSTRUMENT_CLASSIFIER_VERSION ||
    rawExpectations.weightsSha256 !== PINNED_INSTRUMENT_MODEL_SHA256 ||
    rawExpectations.vocabularyVersion !== PINNED_INSTRUMENT_VOCABULARY_VERSION ||
    rawExpectations.vocabularySha256 !== PINNED_INSTRUMENT_VOCABULARY_SHA256 ||
    rawExpectations.analysisSampleRate !== ANALYSIS_SAMPLE_RATE ||
    rawExpectations.reviewStatus !== 'candidate-baseline-not-a-release-gate' ||
    !Array.isArray(rawExpectations.sources) ||
    !Array.isArray(rawExpectations.confusionTrials)
  ) {
    throw new Error('discovery expectations do not match the pinned candidate');
  }

  const fileSources = corpusSources.filter((source) => source.kind === 'file');
  const corpusBySlug = new Map(fileSources.map((source) => [source.slug, source]));
  const sources: DiscoverySourceExpectation[] = [];
  const seenSourceSlugs = new Set<string>();
  for (const rawSource of rawExpectations.sources) {
    if (!record(rawSource)) throw new Error('discovery source expectation is invalid');
    exactKeys(
      rawSource,
      ['slug', 'expectedGroups', 'hardNegativeIds', 'rationale'],
      'discovery source expectation'
    );
    const slug = normalizedId(rawSource.slug, 'discovery source slug');
    if (seenSourceSlugs.has(slug)) throw new Error(`discovery source ${slug} is duplicated`);
    seenSourceSlugs.add(slug);
    const corpusSource = corpusBySlug.get(slug);
    if (!corpusSource || !Array.isArray(corpusSource.expectedInstruments)) {
      throw new Error(`discovery source ${slug} does not map to an annotated file source`);
    }
    if (!Array.isArray(rawSource.expectedGroups) || !rawSource.expectedGroups.length) {
      throw new Error(`${slug}: expected groups are required`);
    }
    const expectedGroups: ExpectedInstrumentGroup[] = [];
    const mappedTerms = new Set<string>();
    const acceptedIds = new Set<string>();
    for (const rawGroup of rawSource.expectedGroups) {
      if (!record(rawGroup)) throw new Error(`${slug}: expected group is invalid`);
      exactKeys(rawGroup, ['corpusTerms', 'acceptedIds'], `${slug}: expected group`);
      const corpusTerms = stringList(rawGroup.corpusTerms, `${slug}: corpus terms`);
      const groupAcceptedIds = stringList(rawGroup.acceptedIds, `${slug}: accepted ids`);
      for (const term of corpusTerms) {
        if (!corpusSource.expectedInstruments.includes(term) || mappedTerms.has(term)) {
          throw new Error(`${slug}: corpus term ${term} is missing or mapped more than once`);
        }
        mappedTerms.add(term);
      }
      for (const id of groupAcceptedIds) {
        if (!instrumentById.has(id) || acceptedIds.has(id)) {
          throw new Error(`${slug}: accepted id ${id} is unknown or reused`);
        }
        acceptedIds.add(id);
      }
      expectedGroups.push({ corpusTerms, acceptedIds: groupAcceptedIds });
    }
    if (
      mappedTerms.size !== corpusSource.expectedInstruments.length ||
      corpusSource.expectedInstruments.some((term) => !mappedTerms.has(term))
    ) {
      throw new Error(`${slug}: expected groups do not partition the corpus annotations`);
    }
    const hardNegativeIds = Array.isArray(rawSource.hardNegativeIds)
      ? rawSource.hardNegativeIds.map((id) => normalizedId(id, `${slug}: hard-negative id`))
      : [];
    if (new Set(hardNegativeIds).size !== hardNegativeIds.length) {
      throw new Error(`${slug}: hard-negative ids contain duplicates`);
    }
    for (const id of hardNegativeIds) {
      if (!instrumentById.has(id) || acceptedIds.has(id)) {
        throw new Error(`${slug}: hard-negative id ${id} is unknown or expected`);
      }
    }
    if (typeof rawSource.rationale !== 'string' || rawSource.rationale.trim().length < 40) {
      throw new Error(`${slug}: evaluation rationale is too short`);
    }
    sources.push({
      slug,
      expectedGroups,
      hardNegativeIds,
      rationale: rawSource.rationale,
    });
  }
  if (
    sources.length !== fileSources.length ||
    fileSources.some((source) => !seenSourceSlugs.has(source.slug))
  ) {
    throw new Error('discovery expectations must cover every authorized file source exactly once');
  }

  const expectationBySlug = new Map(sources.map((source) => [source.slug, source]));
  const confusionTrials: ConfusionTrial[] = [];
  const seenTrialIds = new Set<string>();
  for (const rawTrial of rawExpectations.confusionTrials) {
    if (!record(rawTrial)) throw new Error('confusion trial is invalid');
    exactKeys(
      rawTrial,
      ['id', 'leftIds', 'rightIds', 'status', 'sourceSlugs', 'rationale'],
      'confusion trial'
    );
    const id = normalizedId(rawTrial.id, 'confusion trial id');
    if (seenTrialIds.has(id)) throw new Error(`confusion trial ${id} is duplicated`);
    seenTrialIds.add(id);
    const leftIds = stringList(rawTrial.leftIds, `${id}: left ids`);
    const rightIds = stringList(rawTrial.rightIds, `${id}: right ids`);
    if (leftIds.some((candidate) => rightIds.includes(candidate))) {
      throw new Error(`${id}: confusion sides overlap`);
    }
    for (const candidate of [...leftIds, ...rightIds]) {
      if (!instrumentById.has(candidate)) throw new Error(`${id}: unknown id ${candidate}`);
    }
    if (
      rawTrial.status !== 'bidirectional' &&
      rawTrial.status !== 'one-direction' &&
      rawTrial.status !== 'corpus-gap'
    ) {
      throw new Error(`${id}: confusion status is invalid`);
    }
    if (!Array.isArray(rawTrial.sourceSlugs)) throw new Error(`${id}: source slugs are invalid`);
    const sourceSlugs = rawTrial.sourceSlugs.map((slug) => normalizedId(slug, `${id}: source slug`));
    if (new Set(sourceSlugs).size !== sourceSlugs.length) {
      throw new Error(`${id}: source slugs contain duplicates`);
    }
    if (typeof rawTrial.rationale !== 'string' || rawTrial.rationale.trim().length < 40) {
      throw new Error(`${id}: confusion rationale is too short`);
    }
    let leftPositive = false;
    let rightPositive = false;
    for (const slug of sourceSlugs) {
      const expectation = expectationBySlug.get(slug);
      if (!expectation) throw new Error(`${id}: source ${slug} is not in the evaluation manifest`);
      const accepted = new Set(expectation.expectedGroups.flatMap((group) => group.acceptedIds));
      const negative = new Set(expectation.hardNegativeIds);
      const leftExpectedRightNegative =
        leftIds.some((candidate) => accepted.has(candidate)) &&
        rightIds.some((candidate) => negative.has(candidate));
      const rightExpectedLeftNegative =
        rightIds.some((candidate) => accepted.has(candidate)) &&
        leftIds.some((candidate) => negative.has(candidate));
      if (!leftExpectedRightNegative && !rightExpectedLeftNegative) {
        throw new Error(`${id}: source ${slug} lacks directional positive/negative evidence`);
      }
      leftPositive ||= leftExpectedRightNegative;
      rightPositive ||= rightExpectedLeftNegative;
    }
    if (
      (rawTrial.status === 'corpus-gap' && sourceSlugs.length) ||
      (rawTrial.status !== 'corpus-gap' && !sourceSlugs.length) ||
      (rawTrial.status === 'bidirectional' && (!leftPositive || !rightPositive)) ||
      (rawTrial.status === 'one-direction' && leftPositive === rightPositive)
    ) {
      throw new Error(`${id}: confusion status does not match its directional evidence`);
    }
    confusionTrials.push({
      id,
      leftIds,
      rightIds,
      status: rawTrial.status,
      sourceSlugs,
      rationale: rawTrial.rationale,
    });
  }

  return {
    corpusSources,
    expectations: {
      $schema: EVALUATION_SCHEMA,
      classifierVersion: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
      weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
      vocabularyVersion: PINNED_INSTRUMENT_VOCABULARY_VERSION,
      vocabularySha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
      analysisSampleRate: ANALYSIS_SAMPLE_RATE,
      reviewStatus: 'candidate-baseline-not-a-release-gate',
      sources,
      confusionTrials,
    },
    vocabulary,
  };
}

function scoreRank(state: InstrumentDetectionV1['state']): number {
  return state === 'possible' ? 2 : 1;
}

function confusable(
  left: string,
  right: string,
  instrumentById: ReadonlyMap<string, InstrumentDefinition>
): boolean {
  return (
    instrumentById.get(left)?.confusableWith.includes(right) === true ||
    instrumentById.get(right)?.confusableWith.includes(left) === true
  );
}

export function evaluateDiscoveryObservation(
  expectation: DiscoverySourceExpectation,
  detections: InstrumentDetectionV1[],
  vocabulary: VocabularyDocument
): DiscoveryObservationEvaluation {
  const instrumentById = new Map(vocabulary.instruments.map((instrument) => [instrument.id, instrument]));
  const detectionById = new Map<string, InstrumentDetectionV1>();
  for (const detection of detections) {
    if (!instrumentById.has(detection.id) || detectionById.has(detection.id)) {
      throw new Error(`${expectation.slug}: discovery returned an unknown or duplicate id`);
    }
    detectionById.set(detection.id, detection);
  }
  const expectedIds = new Set(expectation.expectedGroups.flatMap((group) => group.acceptedIds));
  const hardNegativeIds = new Set(expectation.hardNegativeIds);
  const expectedGroups = expectation.expectedGroups.map((group): EvaluatedExpectedGroup => {
    const matched = group.acceptedIds
      .map((id) => detectionById.get(id))
      .filter((detection): detection is InstrumentDetectionV1 => Boolean(detection))
      .sort((left, right) => scoreRank(right.state) - scoreRank(left.state) || right.confidence - left.confidence);
    return {
      ...group,
      state: matched.length ? matched[0].state : 'missed',
      matchedDetectionIds: matched.map((detection) => detection.id),
    };
  });

  const hardNegativeDetections: InstrumentDetectionV1[] = [];
  const confusionCandidates: DiscoveryObservationEvaluation['confusionCandidates'] = [];
  const unreviewedCandidates: InstrumentDetectionV1[] = [];
  for (const detection of detections) {
    if (expectedIds.has(detection.id)) continue;
    if (hardNegativeIds.has(detection.id)) {
      hardNegativeDetections.push(detection);
      continue;
    }
    const confusableExpectedIds = [...expectedIds]
      .filter((expectedId) => confusable(detection.id, expectedId, instrumentById))
      .sort();
    if (confusableExpectedIds.length) {
      confusionCandidates.push({ detection, confusableExpectedIds });
    } else {
      unreviewedCandidates.push(detection);
    }
  }

  const detectedIds = new Set(detections.map((detection) => detection.id));
  const overlapCandidates = OVERLAP_GROUPS.flatMap((group) => {
    if (!detectedIds.has(group.parentId)) return [];
    const childIds = group.childIds.filter((id) => detectedIds.has(id));
    return childIds.length ? [{ parentId: group.parentId, childIds }] : [];
  });
  const possibleGroups = expectedGroups.filter((group) => group.state === 'possible').length;
  const uncertainGroups = expectedGroups.filter((group) => group.state === 'uncertain').length;
  const missedGroups = expectedGroups.length - possibleGroups - uncertainGroups;
  return {
    expectedGroups,
    hardNegativeDetections,
    confusionCandidates,
    unreviewedCandidates,
    overlapCandidates,
    summary: {
      expectedGroups: expectedGroups.length,
      possibleGroups,
      uncertainGroups,
      missedGroups,
      hardNegativeDetections: hardNegativeDetections.length,
      confusionCandidates: confusionCandidates.length,
      unreviewedCandidates: unreviewedCandidates.length,
      abstained: detections.length === 0,
    },
  };
}

function aggregateBucket(
  observations: Array<{
    evaluation: DiscoveryObservationEvaluation;
    serviceTimingMs: number;
    elapsedMs: number;
  }>
): Record<string, number> {
  const expectedGroups = observations.reduce(
    (sum, observation) => sum + observation.evaluation.summary.expectedGroups,
    0
  );
  const possibleGroups = observations.reduce(
    (sum, observation) => sum + observation.evaluation.summary.possibleGroups,
    0
  );
  const uncertainGroups = observations.reduce(
    (sum, observation) => sum + observation.evaluation.summary.uncertainGroups,
    0
  );
  const matchedGroups = possibleGroups + uncertainGroups;
  return {
    sources: observations.length,
    expectedGroups,
    matchedGroups,
    possibleGroups,
    uncertainGroups,
    missedGroups: expectedGroups - matchedGroups,
    annotatedGroupRecallBasisPoints: expectedGroups
      ? Math.round((matchedGroups / expectedGroups) * 10_000)
      : 0,
    hardNegativeDetections: observations.reduce(
      (sum, observation) => sum + observation.evaluation.summary.hardNegativeDetections,
      0
    ),
    confusionCandidates: observations.reduce(
      (sum, observation) => sum + observation.evaluation.summary.confusionCandidates,
      0
    ),
    unreviewedCandidates: observations.reduce(
      (sum, observation) => sum + observation.evaluation.summary.unreviewedCandidates,
      0
    ),
    abstentions: observations.filter((observation) => observation.evaluation.summary.abstained).length,
    serviceTimingMs: observations.reduce((sum, observation) => sum + observation.serviceTimingMs, 0),
    elapsedMs: observations.reduce((sum, observation) => sum + observation.elapsedMs, 0),
  };
}

function decoderVersion(binary: 'ffmpeg' | 'ffprobe'): string {
  const line = execFileSync(binary, ['-version'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  }).split(/\r?\n/, 1)[0] ?? '';
  const match = line.match(new RegExp(`^${binary} version ([^ ]+)`));
  if (!match) throw new Error(`${binary} version is unavailable`);
  return match[1];
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === '') return 20_000;
  if (!/^\d+$/.test(value)) throw new Error('INSTRUMENT_DISCOVERY_EVAL_TIMEOUT_MS is invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 20_000) {
    throw new Error('INSTRUMENT_DISCOVERY_EVAL_TIMEOUT_MS is invalid');
  }
  return parsed;
}

function parseArguments(args: string[]): { outputPath?: string; slugs: Set<string> } {
  const slugs = new Set<string>();
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const candidate = args[index + 1];
      if (!candidate || candidate.startsWith('--') || outputPath) {
        throw new Error('--output requires one new path');
      }
      outputPath = candidate;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown instrument-discovery evaluation flag: ${argument}`);
    } else {
      slugs.add(normalizedId(argument, 'requested corpus slug'));
    }
  }
  return { outputPath, slugs };
}

async function main(): Promise<void> {
  const { outputPath, slugs } = parseArguments(process.argv.slice(2));
  const execution = executionProvenanceFromEnvironment();
  const { corpusSources, expectations, vocabulary } = loadAndValidateEvaluationInputs();
  // Keep CLI-only decoder/network dependencies out of the pure manifest and
  // scoring seam imported by the broad Node strip-types unit-test runner.
  const [{ decodeAnalysisWindows }, { discoveryWindowSampleCounts, httpInstrumentDiscoveryProvider }] =
    await Promise.all([
      import('../audio-analysis/decoder.ts'),
      import('../audio-analysis/discovery.ts'),
    ]);
  const expectationBySlug = new Map(expectations.sources.map((expectation) => [expectation.slug, expectation]));
  for (const slug of slugs) {
    if (!expectationBySlug.has(slug)) throw new Error(`unknown instrument-discovery corpus slug: ${slug}`);
  }
  const serviceUrl = process.env.INSTRUMENT_DISCOVERY_EVAL_URL ?? 'http://127.0.0.1:8080';
  const serviceToken = process.env.INSTRUMENT_DISCOVERY_EVAL_TOKEN ?? '';
  const provider = httpInstrumentDiscoveryProvider({
    baseUrl: serviceUrl,
    token: serviceToken,
    timeoutMs: parseTimeout(process.env.INSTRUMENT_DISCOVERY_EVAL_TIMEOUT_MS),
  });
  const serviceOriginKind = new URL(serviceUrl).hostname.endsWith('.railway.internal')
    ? 'railway-private'
    : 'loopback';
  const instrumentById = new Map(vocabulary.instruments.map((instrument) => [instrument.id, instrument]));
  const observations: Array<{
    slug: string;
    coverage: string[];
    sourceSha1: string;
    sourceBytes: number;
    sourceDurationSeconds: number;
    analyzedSeconds: number;
    windowsAnalyzed: number;
    serviceTimingMs: number;
    elapsedMs: number;
    detections: InstrumentDetectionV1[];
    evaluation: DiscoveryObservationEvaluation;
  }> = [];

  for (const expectation of expectations.sources) {
    if (slugs.size && !slugs.has(expectation.slug)) continue;
    const source = corpusSources.find(
      (candidate) => candidate.kind === 'file' && candidate.slug === expectation.slug
    );
    if (!source) throw new Error(`${expectation.slug}: authorized file source is missing`);
    const approvedSource = approvedCorpusAudioPath(source.source, expectation.slug);
    const sourceSha1 = await actualFileSha1(approvedSource.path, approvedSource.bytes);
    if (source.provenance?.sha1 && sourceSha1 !== source.provenance.sha1) {
      throw new Error(`${expectation.slug}: hydrated audio does not match the recorded Archive SHA-1`);
    }
    const startedAt = performance.now();
    const decoded = await decodeAnalysisWindows(approvedSource.path, {
      timeoutMs: DEFAULT_DECODER_TIMEOUT_MS,
      maxSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
    });
    const result = await provider.discover(decoded);
    const windowCounts = discoveryWindowSampleCounts(decoded);
    const evaluation = evaluateDiscoveryObservation(expectation, result.detections, vocabulary);
    observations.push({
      slug: source.slug,
      coverage: source.coverage ?? [],
      sourceSha1,
      sourceBytes: approvedSource.bytes,
      sourceDurationSeconds: Number(decoded.sourceDurationSeconds.toFixed(3)),
      analyzedSeconds: Number(decoded.analyzedSeconds.toFixed(3)),
      windowsAnalyzed: windowCounts.length,
      serviceTimingMs: result.timingMs,
      elapsedMs: Math.round(performance.now() - startedAt),
      detections: result.detections,
      evaluation,
    });
  }

  const byCoverage: Record<string, ReturnType<typeof aggregateBucket>> = {};
  const coverageTags = [...new Set(observations.flatMap((observation) => observation.coverage))].sort();
  for (const tag of coverageTags) {
    byCoverage[tag] = aggregateBucket(observations.filter((observation) => observation.coverage.includes(tag)));
  }

  const byFamily: Record<string, { eligibleExpectedGroups: number; matchedExpectedGroups: number; detections: number }> = {};
  for (const family of Object.keys(vocabulary.families).sort()) {
    let eligibleExpectedGroups = 0;
    let matchedExpectedGroups = 0;
    let detections = 0;
    for (const observation of observations) {
      detections += observation.detections.filter(
        (detection) => instrumentById.get(detection.id)?.family === family
      ).length;
      for (const group of observation.evaluation.expectedGroups) {
        if (!group.acceptedIds.some((id) => instrumentById.get(id)?.family === family)) continue;
        eligibleExpectedGroups += 1;
        if (
          group.matchedDetectionIds.some((id) => instrumentById.get(id)?.family === family)
        ) {
          matchedExpectedGroups += 1;
        }
      }
    }
    byFamily[family] = { eligibleExpectedGroups, matchedExpectedGroups, detections };
  }

  const observationBySlug = new Map(observations.map((observation) => [observation.slug, observation]));
  const confusionTrials = expectations.confusionTrials.map((trial) => ({
    ...trial,
    observations: trial.sourceSlugs
      .map((slug) => observationBySlug.get(slug))
      .filter((observation): observation is (typeof observations)[number] => Boolean(observation))
      .map((observation) => ({
        slug: observation.slug,
        leftDetectedIds: trial.leftIds.filter((id) =>
          observation.detections.some((detection) => detection.id === id)
        ),
        rightDetectedIds: trial.rightIds.filter((id) =>
          observation.detections.some((detection) => detection.id === id)
        ),
      })),
  }));

  const report = {
    $schema: DISCOVERY_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    reviewStatus: expectations.reviewStatus,
    interpretation: {
      routingEffect: 'none',
      thresholdMutation: 'none',
      precisionClaim: 'not-available-from-non-exhaustive-review-annotations',
      recallClaim: 'candidate-annotated-group-coverage-only',
    },
    execution,
    evaluationSourceSha256: {
      evaluator: sha256File('scripts/eval-instrument-discovery.mts'),
      runner: sha256File('scripts/run-instrument-discovery-eval.sh'),
      corpusManifest: sha256File(CORPUS_PATH),
      expectations: sha256File(EXPECTATIONS_PATH),
      vocabulary: sha256File(VOCABULARY_PATH),
      analysisConfig: sha256File('audio-analysis/config.ts'),
      analysisDecoder: sha256File('audio-analysis/decoder.ts'),
      discoveryClient: sha256File('audio-analysis/discovery.ts'),
    },
    serviceOriginKind,
    classifier: {
      version: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
      weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
    },
    vocabulary: {
      version: PINNED_INSTRUMENT_VOCABULARY_VERSION,
      sha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
      reviewStatus: vocabulary.reviewStatus,
    },
    decoder: {
      ffmpegVersion: decoderVersion('ffmpeg'),
      ffprobeVersion: decoderVersion('ffprobe'),
      sampleRate: ANALYSIS_SAMPLE_RATE,
      maximumSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
    },
    observations,
    summary: aggregateBucket(observations),
    byCoverage,
    byFamily,
    confusionTrials,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, rendered, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } else {
    process.stdout.write(rendered);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'instrument discovery evaluation failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
