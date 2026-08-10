import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  INSTRUMENT_FEEDBACK_GENRE_FAMILIES,
  type InstrumentFeedbackGenreFamily,
} from '../../src/analysis/instrument-feedback.ts';
import {
  INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
  INSTRUMENT_REVIEW_OPTIONS,
  INSTRUMENT_REVIEW_OPTIONS_BY_ID,
  type InstrumentReviewKind,
} from '../../src/analysis/instrument-review.ts';

export const INSTRUMENT_EVALUATION_PLAN_SCHEMA =
  'stem-splitter.instrument-evaluation-plan.v1' as const;
export const INSTRUMENT_EVALUATION_REVIEW_SCHEMA =
  'stem-splitter.instrument-evaluation-review.v1' as const;
export const INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA =
  'stem-splitter.instrument-candidate-observations.v2' as const;
export const INSTRUMENT_EVALUATION_METRICS_SCHEMA =
  'stem-splitter.instrument-evaluation-metrics.v2' as const;
export const INSTRUMENT_EVALUATION_PLAN_PATH =
  'tests/corpus/instrument-evaluation-plan.json' as const;

export const INSTRUMENT_EVALUATION_REVIEW_ATTESTATION =
  'I listened to every source in full and reviewed every pinned vocabulary label; any uncertainty is explicit.' as const;

const PLAN_STATUS = 'review-pending-no-promotion-claim' as const;
const REVIEW_STATUS = 'reviewed-deidentified-ground-truth' as const;
const REVIEW_PROTOCOL = 'instrument-evaluation-listening-v1' as const;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CORPUS_KINDS = ['real-mix', 'isolated-control', 'synthetic-stem'] as const;
const REVIEW_VERDICTS = ['audible', 'absent', 'uncertain'] as const;
const CANDIDATE_STATES = ['possible', 'uncertain'] as const;
const CANDIDATE_OUTCOMES = ['classified', 'abstained', 'degraded'] as const;
const CANDIDATE_OUTCOME_REASONS = {
  classified: ['threshold-policy-applied'],
  abstained: ['no-label-cleared-threshold', 'insufficient-confidence-margin'],
  degraded: ['service-timeout', 'service-unavailable', 'invalid-response', 'unsupported-source'],
} as const;
const REQUIRED_METRICS = [
  'detection-precision',
  'detection-recall',
  'selective-coverage',
  'abstention-rate',
  'service-failure-rate',
  'per-genre',
  'per-instrument-family',
  'per-review-kind',
] as const;
const REQUIRED_REAL_MIX_GENRES: readonly InstrumentFeedbackGenreFamily[] = [
  'rock',
  'jazz',
  'orchestral-chamber',
  'electronic',
  'hip-hop',
  'folk-traditional',
  'sparse-acoustic',
];
const REQUIRED_INSTRUMENT_FAMILIES = [
  'voice',
  'bowed-strings',
  'plucked-strings',
  'brass',
  'woodwind',
  'keys',
  'electronic',
  'percussion',
  'free-reed',
  'traditional',
] as const;
const REQUIRED_REVIEW_KINDS: readonly InstrumentReviewKind[] = [
  'specific-instrument-or-voice',
  'family-or-ensemble',
  'production-texture',
];

type CorpusKind = (typeof CORPUS_KINDS)[number];
type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
type CandidateState = (typeof CANDIDATE_STATES)[number];
type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];
type CandidateOutcomeReason =
  (typeof CANDIDATE_OUTCOME_REASONS)[CandidateOutcome][number];

export interface InstrumentEvaluationPlanSourceV1 {
  id: string;
  sourceSha256: string;
  genreFamily: InstrumentFeedbackGenreFamily;
}

export interface InstrumentEvaluationPartitionV1 {
  id: string;
  corpusKind: CorpusKind;
  binding: 'stem-splitter-corpus-v1' | 'instrument-control-corpus-v1';
  manifestPath: string;
  manifestSha256: string;
  expectationsPath: string | null;
  expectationsSha256: string | null;
  sources: InstrumentEvaluationPlanSourceV1[];
}

export interface InstrumentEvaluationPlanV1 {
  $schema: typeof INSTRUMENT_EVALUATION_PLAN_SCHEMA;
  version: string;
  status: typeof PLAN_STATUS;
  vocabulary: {
    path: string;
    version: string;
    sha256: string;
    reviewOntologyVersion: typeof INSTRUMENT_REVIEW_ONTOLOGY_VERSION;
  };
  partitions: InstrumentEvaluationPartitionV1[];
  requiredCoverage: {
    realMixGenreFamilies: InstrumentFeedbackGenreFamily[];
    instrumentFamilies: string[];
    reviewKinds: InstrumentReviewKind[];
    minimumRealMixSourcesPerGenre: number;
    minimumAudibleSourcesPerInstrumentFamily: number;
  };
  reporting: {
    syntheticAndRealSeparate: true;
    isolatedAndMixedSeparate: true;
    aggregateOnlyPromotionForbidden: true;
    requiredMetrics: string[];
  };
}

export interface InstrumentEvaluationReviewV1 {
  $schema: typeof INSTRUMENT_EVALUATION_REVIEW_SCHEMA;
  planPath: typeof INSTRUMENT_EVALUATION_PLAN_PATH;
  planVersion: string;
  planSha256: string;
  status: typeof REVIEW_STATUS;
  reviewProtocolVersion: typeof REVIEW_PROTOCOL;
  privateReviewSha256: string;
  curatedAt: string;
  reviewAuthority: 'teacher-or-domain-reviewer';
  deidentified: true;
  rawTeacherFeedbackIncluded: false;
  attestation: typeof INSTRUMENT_EVALUATION_REVIEW_ATTESTATION;
  sources: Array<{
    partitionId: string;
    id: string;
    corpusKind: CorpusKind;
    sourceSha256: string;
    genreFamily: InstrumentFeedbackGenreFamily;
    wholeSourceListened: true;
    verdicts: Array<{ instrumentId: string; verdict: ReviewVerdict }>;
  }>;
}

export interface InstrumentCandidateObservationsV2 {
  $schema: typeof INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA;
  planPath: typeof INSTRUMENT_EVALUATION_PLAN_PATH;
  planVersion: string;
  planSha256: string;
  generatedAt: string;
  candidate: {
    classifierVersion: string;
    modelSha256: string;
    vocabularyVersion: string;
    vocabularySha256: string;
    preprocessingVersion: string;
    thresholdPolicyVersion: string;
  };
  sources: Array<{
    partitionId: string;
    id: string;
    sourceSha256: string;
    outcome: CandidateOutcome;
    outcomeReason: CandidateOutcomeReason;
    detections: Array<{
      instrumentId: string;
      state: CandidateState;
      confidence: number;
    }>;
  }>;
}

export interface InstrumentMetricCountsV2 {
  evaluated: number;
  classifiedDecisions: number;
  groundTruthAudible: number;
  groundTruthAbsent: number;
  groundTruthUncertain: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  candidateUncertainDecisions: number;
  sourceAbstentionDecisions: number;
  serviceFailureDecisions: number;
  precisionBasisPoints: number | null;
  recallBasisPoints: number | null;
  selectiveCoverageRateBasisPoints: number | null;
  abstentionRateBasisPoints: number | null;
  serviceFailureRateBasisPoints: number | null;
}

export interface InstrumentEvaluationMetricsV2 {
  $schema: typeof INSTRUMENT_EVALUATION_METRICS_SCHEMA;
  planVersion: string;
  reviewStatus: typeof REVIEW_STATUS;
  candidate: InstrumentCandidateObservationsV2['candidate'];
  diagnosticAllLabels: InstrumentMetricCountsV2 & {
    promotionUse: 'forbidden-overlapping-label-kinds';
  };
  byKind: Record<InstrumentReviewKind, InstrumentMetricCountsV2>;
  byGenre: Partial<Record<InstrumentFeedbackGenreFamily, InstrumentMetricCountsV2>>;
  byInstrumentFamily: Record<string, InstrumentMetricCountsV2>;
  byInstrument: Record<string, InstrumentMetricCountsV2>;
  byCorpusKind: Partial<Record<CorpusKind, InstrumentMetricCountsV2>>;
  coverage: {
    realMixSourcesByGenre: Partial<Record<InstrumentFeedbackGenreFamily, number>>;
    audibleSpecificSourcesByFamily: Record<string, number>;
    abstainedSources: string[];
    degradedSources: string[];
    reviewUncertainDecisions: number;
  };
  coverageReady: boolean;
  coverageBlockers: string[];
  promotionEligible: false;
  promotionBlockers: string[];
  caveat: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sorted)) {
    throw new Error(`${context} does not match the evaluation schema`);
  }
}

function safeId(value: unknown, context: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${context} is invalid`);
  return value;
}

function safeVersion(value: unknown, context: string): string {
  if (typeof value !== 'string' || !SAFE_VERSION.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function sha256(value: unknown, context: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${context} is invalid`);
  return value;
}

function isoTimestamp(value: unknown, context: string): string {
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
    value.length < 1 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function uniqueStringArray(
  value: unknown,
  context: string,
  validate: (item: unknown, itemContext: string) => string
): string[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`${context} is invalid`);
  const result = value.map((item, index) => validate(item, `${context}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${context} contains duplicates`);
  return result;
}

function digestFile(repositoryRoot: string, path: string): string {
  return createHash('sha256').update(readFileSync(resolve(repositoryRoot, path))).digest('hex');
}

function genre(value: unknown, context: string): InstrumentFeedbackGenreFamily {
  if (
    typeof value !== 'string' ||
    !INSTRUMENT_FEEDBACK_GENRE_FAMILIES.includes(value as InstrumentFeedbackGenreFamily)
  ) {
    throw new Error(`${context} is invalid`);
  }
  return value as InstrumentFeedbackGenreFamily;
}

function corpusKind(value: unknown, context: string): CorpusKind {
  if (typeof value !== 'string' || !(CORPUS_KINDS as readonly string[]).includes(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value as CorpusKind;
}

function reviewKind(value: unknown, context: string): InstrumentReviewKind {
  const kinds: readonly InstrumentReviewKind[] = [
    'specific-instrument-or-voice',
    'family-or-ensemble',
    'production-texture',
  ];
  if (typeof value !== 'string' || !kinds.includes(value as InstrumentReviewKind)) {
    throw new Error(`${context} is invalid`);
  }
  return value as InstrumentReviewKind;
}

function manifestSources(
  repositoryRoot: string,
  partition: InstrumentEvaluationPartitionV1
): Array<{ id: string; sourceSha256: string }> {
  const raw: unknown = JSON.parse(readFileSync(resolve(repositoryRoot, partition.manifestPath), 'utf8'));
  if (!record(raw) || !Array.isArray(raw.sources) && !Array.isArray(raw.controls)) {
    throw new Error(`${partition.id}: source manifest is invalid`);
  }
  if (partition.binding === 'stem-splitter-corpus-v1') {
    if (!Array.isArray(raw.sources)) throw new Error(`${partition.id}: corpus sources are invalid`);
    return raw.sources
      .filter((item): item is JsonRecord => record(item) && item.kind === 'file')
      .map((item) => {
        if (!record(item.provenance)) throw new Error(`${partition.id}: source provenance is invalid`);
        return {
          id: safeId(item.slug, `${partition.id} source id`),
          sourceSha256: sha256(item.provenance.contentSha256, `${partition.id} source SHA-256`),
        };
      });
  }
  if (!Array.isArray(raw.controls)) throw new Error(`${partition.id}: control sources are invalid`);
  return raw.controls.map((item) => {
    if (!record(item) || !record(item.media)) {
      throw new Error(`${partition.id}: control source is invalid`);
    }
    return {
      id: safeId(item.id, `${partition.id} source id`),
      sourceSha256: sha256(item.media.sha256, `${partition.id} source SHA-256`),
    };
  });
}

function validatePlanSource(value: unknown, context: string): InstrumentEvaluationPlanSourceV1 {
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(value, ['id', 'sourceSha256', 'genreFamily'], context);
  return {
    id: safeId(value.id, `${context} id`),
    sourceSha256: sha256(value.sourceSha256, `${context} source SHA-256`),
    genreFamily: genre(value.genreFamily, `${context} genre family`),
  };
}

function validatePartition(
  value: unknown,
  repositoryRoot: string,
  index: number
): InstrumentEvaluationPartitionV1 {
  const context = `evaluation partition ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(
    value,
    [
      'id',
      'corpusKind',
      'binding',
      'manifestPath',
      'manifestSha256',
      'expectationsPath',
      'expectationsSha256',
      'sources',
    ],
    context
  );
  const id = safeId(value.id, `${context} id`);
  const kind = corpusKind(value.corpusKind, `${context} corpus kind`);
  if (
    value.binding !== 'stem-splitter-corpus-v1' &&
    value.binding !== 'instrument-control-corpus-v1'
  ) {
    throw new Error(`${context} binding is invalid`);
  }
  if (
    (value.binding === 'stem-splitter-corpus-v1' && kind !== 'real-mix') ||
    (value.binding === 'instrument-control-corpus-v1' && kind !== 'isolated-control')
  ) {
    throw new Error(`${context} binding does not match its corpus kind`);
  }
  const manifestPath = relativePath(value.manifestPath, `${context} manifest path`);
  const manifestSha256 = sha256(value.manifestSha256, `${context} manifest SHA-256`);
  if (digestFile(repositoryRoot, manifestPath) !== manifestSha256) {
    throw new Error(`${context} manifest content drifted`);
  }
  let expectationsPath: string | null = null;
  let expectationsSha256: string | null = null;
  if (value.expectationsPath === null || value.expectationsSha256 === null) {
    if (value.expectationsPath !== null || value.expectationsSha256 !== null) {
      throw new Error(`${context} expectation identity is incomplete`);
    }
  } else {
    expectationsPath = relativePath(value.expectationsPath, `${context} expectations path`);
    expectationsSha256 = sha256(
      value.expectationsSha256,
      `${context} expectations SHA-256`
    );
    if (digestFile(repositoryRoot, expectationsPath) !== expectationsSha256) {
      throw new Error(`${context} expectations content drifted`);
    }
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1) {
    throw new Error(`${context} sources are invalid`);
  }
  const sources = value.sources.map((source, sourceIndex) =>
    validatePlanSource(source, `${context} source ${sourceIndex + 1}`)
  );
  if (new Set(sources.map(({ id: sourceId }) => sourceId)).size !== sources.length) {
    throw new Error(`${context} source ids are duplicated`);
  }
  const expectedSources = manifestSources(repositoryRoot, {
    id,
    corpusKind: kind,
    binding: value.binding,
    manifestPath,
    manifestSha256,
    expectationsPath,
    expectationsSha256,
    sources,
  });
  if (
    JSON.stringify(sources.map(({ id: sourceId, sourceSha256 }) => ({ id: sourceId, sourceSha256 }))) !==
    JSON.stringify(expectedSources)
  ) {
    throw new Error(`${context} does not cover its exact manifest sources in order`);
  }
  return {
    id,
    corpusKind: kind,
    binding: value.binding,
    manifestPath,
    manifestSha256,
    expectationsPath,
    expectationsSha256,
    sources,
  };
}

export function validateInstrumentEvaluationPlan(
  value: unknown,
  repositoryRoot = process.cwd()
): InstrumentEvaluationPlanV1 {
  if (!record(value)) throw new Error('instrument evaluation plan is invalid');
  exactKeys(
    value,
    ['$schema', 'version', 'status', 'vocabulary', 'partitions', 'requiredCoverage', 'reporting'],
    'instrument evaluation plan'
  );
  if (
    value.$schema !== INSTRUMENT_EVALUATION_PLAN_SCHEMA ||
    value.status !== PLAN_STATUS
  ) {
    throw new Error('instrument evaluation plan identity is invalid');
  }
  const version = safeVersion(value.version, 'instrument evaluation plan version');
  if (!record(value.vocabulary)) throw new Error('instrument evaluation vocabulary is invalid');
  exactKeys(
    value.vocabulary,
    ['path', 'version', 'sha256', 'reviewOntologyVersion'],
    'instrument evaluation vocabulary'
  );
  const vocabularyPath = relativePath(value.vocabulary.path, 'instrument evaluation vocabulary path');
  const vocabularyVersion = safeVersion(
    value.vocabulary.version,
    'instrument evaluation vocabulary version'
  );
  const vocabularySha256 = sha256(
    value.vocabulary.sha256,
    'instrument evaluation vocabulary SHA-256'
  );
  if (
    value.vocabulary.reviewOntologyVersion !== INSTRUMENT_REVIEW_ONTOLOGY_VERSION ||
    vocabularyVersion !== 'classroom-instruments-v1' ||
    digestFile(repositoryRoot, vocabularyPath) !== vocabularySha256
  ) {
    throw new Error('instrument evaluation vocabulary identity drifted');
  }
  if (!Array.isArray(value.partitions) || value.partitions.length < 2) {
    throw new Error('instrument evaluation partitions are incomplete');
  }
  const partitions = value.partitions.map((partition, index) =>
    validatePartition(partition, repositoryRoot, index)
  );
  if (
    new Set(partitions.map(({ id }) => id)).size !== partitions.length ||
    !partitions.some(({ corpusKind: kind }) => kind === 'real-mix') ||
    !partitions.some(({ corpusKind: kind }) => kind === 'isolated-control')
  ) {
    throw new Error('instrument evaluation partitions are duplicated or incomplete');
  }
  const allSourceIds = partitions.flatMap(({ sources }) => sources.map(({ id }) => id));
  if (new Set(allSourceIds).size !== allSourceIds.length) {
    throw new Error('instrument evaluation source ids overlap across partitions');
  }
  if (!record(value.requiredCoverage)) {
    throw new Error('instrument evaluation required coverage is invalid');
  }
  exactKeys(
    value.requiredCoverage,
    [
      'realMixGenreFamilies',
      'instrumentFamilies',
      'reviewKinds',
      'minimumRealMixSourcesPerGenre',
      'minimumAudibleSourcesPerInstrumentFamily',
    ],
    'instrument evaluation required coverage'
  );
  const realMixGenreFamilies = uniqueStringArray(
    value.requiredCoverage.realMixGenreFamilies,
    'required real-mix genre families',
    genre
  ) as InstrumentFeedbackGenreFamily[];
  const knownFamilies = new Set(INSTRUMENT_REVIEW_OPTIONS.map(({ family }) => family));
  const instrumentFamilies = uniqueStringArray(
    value.requiredCoverage.instrumentFamilies,
    'required instrument families',
    safeId
  );
  if (instrumentFamilies.some((family) => !knownFamilies.has(family))) {
    throw new Error('required instrument families contain an unknown family');
  }
  const reviewKinds = uniqueStringArray(
    value.requiredCoverage.reviewKinds,
    'required review kinds',
    reviewKind
  ) as InstrumentReviewKind[];
  if (
    JSON.stringify(realMixGenreFamilies) !== JSON.stringify(REQUIRED_REAL_MIX_GENRES) ||
    JSON.stringify(instrumentFamilies) !== JSON.stringify(REQUIRED_INSTRUMENT_FAMILIES) ||
    JSON.stringify(reviewKinds) !== JSON.stringify(REQUIRED_REVIEW_KINDS)
  ) {
    throw new Error('instrument evaluation required coverage policy drifted');
  }
  if (
    !Number.isSafeInteger(value.requiredCoverage.minimumRealMixSourcesPerGenre) ||
    (value.requiredCoverage.minimumRealMixSourcesPerGenre as number) < 1 ||
    !Number.isSafeInteger(value.requiredCoverage.minimumAudibleSourcesPerInstrumentFamily) ||
    (value.requiredCoverage.minimumAudibleSourcesPerInstrumentFamily as number) < 1
  ) {
    throw new Error('instrument evaluation minimum coverage is invalid');
  }
  if (!record(value.reporting)) throw new Error('instrument evaluation reporting is invalid');
  exactKeys(
    value.reporting,
    [
      'syntheticAndRealSeparate',
      'isolatedAndMixedSeparate',
      'aggregateOnlyPromotionForbidden',
      'requiredMetrics',
    ],
    'instrument evaluation reporting'
  );
  const requiredMetrics = uniqueStringArray(
    value.reporting.requiredMetrics,
    'instrument evaluation required metrics',
    safeId
  );
  if (
    value.reporting.syntheticAndRealSeparate !== true ||
    value.reporting.isolatedAndMixedSeparate !== true ||
    value.reporting.aggregateOnlyPromotionForbidden !== true ||
    JSON.stringify(requiredMetrics) !== JSON.stringify(REQUIRED_METRICS)
  ) {
    throw new Error('instrument evaluation reporting policy drifted');
  }
  return {
    $schema: INSTRUMENT_EVALUATION_PLAN_SCHEMA,
    version,
    status: PLAN_STATUS,
    vocabulary: {
      path: vocabularyPath,
      version: vocabularyVersion,
      sha256: vocabularySha256,
      reviewOntologyVersion: INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
    },
    partitions,
    requiredCoverage: {
      realMixGenreFamilies,
      instrumentFamilies,
      reviewKinds,
      minimumRealMixSourcesPerGenre: value.requiredCoverage.minimumRealMixSourcesPerGenre as number,
      minimumAudibleSourcesPerInstrumentFamily:
        value.requiredCoverage.minimumAudibleSourcesPerInstrumentFamily as number,
    },
    reporting: {
      syntheticAndRealSeparate: true,
      isolatedAndMixedSeparate: true,
      aggregateOnlyPromotionForbidden: true,
      requiredMetrics,
    },
  };
}

export function loadInstrumentEvaluationPlan(
  repositoryRoot = process.cwd()
): InstrumentEvaluationPlanV1 {
  const value: unknown = JSON.parse(
    readFileSync(resolve(repositoryRoot, INSTRUMENT_EVALUATION_PLAN_PATH), 'utf8')
  );
  return validateInstrumentEvaluationPlan(value, repositoryRoot);
}

export function instrumentEvaluationPlanSha256(repositoryRoot = process.cwd()): string {
  return digestFile(repositoryRoot, INSTRUMENT_EVALUATION_PLAN_PATH);
}

function flattenedPlanSources(plan: InstrumentEvaluationPlanV1) {
  return plan.partitions.flatMap((partition) =>
    partition.sources.map((source) => ({
      partitionId: partition.id,
      corpusKind: partition.corpusKind,
      ...source,
    }))
  );
}

function validatePlanBinding(
  value: JsonRecord,
  plan: InstrumentEvaluationPlanV1,
  planSha256: string,
  context: string
): void {
  if (
    value.planPath !== INSTRUMENT_EVALUATION_PLAN_PATH ||
    value.planVersion !== plan.version ||
    value.planSha256 !== planSha256
  ) {
    throw new Error(`${context} plan identity drifted`);
  }
}

export function validateInstrumentEvaluationReview(
  value: unknown,
  plan: InstrumentEvaluationPlanV1,
  planSha256: string
): InstrumentEvaluationReviewV1 {
  if (!record(value)) throw new Error('instrument evaluation review is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'planPath',
      'planVersion',
      'planSha256',
      'status',
      'reviewProtocolVersion',
      'privateReviewSha256',
      'curatedAt',
      'reviewAuthority',
      'deidentified',
      'rawTeacherFeedbackIncluded',
      'attestation',
      'sources',
    ],
    'instrument evaluation review'
  );
  validatePlanBinding(value, plan, planSha256, 'instrument evaluation review');
  if (
    value.$schema !== INSTRUMENT_EVALUATION_REVIEW_SCHEMA ||
    value.status !== REVIEW_STATUS ||
    value.reviewProtocolVersion !== REVIEW_PROTOCOL ||
    value.reviewAuthority !== 'teacher-or-domain-reviewer' ||
    value.deidentified !== true ||
    value.rawTeacherFeedbackIncluded !== false ||
    value.attestation !== INSTRUMENT_EVALUATION_REVIEW_ATTESTATION
  ) {
    throw new Error('instrument evaluation review policy is invalid');
  }
  const privateReviewSha256 = sha256(
    value.privateReviewSha256,
    'private instrument review SHA-256'
  );
  const curatedAt = isoTimestamp(value.curatedAt, 'instrument review curation timestamp');
  if (!Array.isArray(value.sources)) throw new Error('instrument review sources are invalid');
  const expectedSources = flattenedPlanSources(plan);
  if (value.sources.length !== expectedSources.length) {
    throw new Error('instrument review source coverage is incomplete');
  }
  const optionIds = INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => id);
  const sources = value.sources.map((rawSource, index) => {
    const context = `instrument review source ${index + 1}`;
    if (!record(rawSource)) throw new Error(`${context} is invalid`);
    exactKeys(
      rawSource,
      [
        'partitionId',
        'id',
        'corpusKind',
        'sourceSha256',
        'genreFamily',
        'wholeSourceListened',
        'verdicts',
      ],
      context
    );
    const expected = expectedSources[index];
    if (
      rawSource.partitionId !== expected.partitionId ||
      rawSource.id !== expected.id ||
      rawSource.corpusKind !== expected.corpusKind ||
      rawSource.sourceSha256 !== expected.sourceSha256 ||
      rawSource.genreFamily !== expected.genreFamily ||
      rawSource.wholeSourceListened !== true
    ) {
      throw new Error(`${context} does not match the pinned source plan`);
    }
    if (!Array.isArray(rawSource.verdicts) || rawSource.verdicts.length !== optionIds.length) {
      throw new Error(`${context} does not review the complete vocabulary`);
    }
    const verdicts = rawSource.verdicts.map((rawVerdict, verdictIndex) => {
      if (!record(rawVerdict)) throw new Error(`${context} verdict is invalid`);
      exactKeys(rawVerdict, ['instrumentId', 'verdict'], `${context} verdict`);
      if (
        rawVerdict.instrumentId !== optionIds[verdictIndex] ||
        typeof rawVerdict.verdict !== 'string' ||
        !(REVIEW_VERDICTS as readonly string[]).includes(rawVerdict.verdict)
      ) {
        throw new Error(`${context} verdict order or value is invalid`);
      }
      return {
        instrumentId: rawVerdict.instrumentId,
        verdict: rawVerdict.verdict as ReviewVerdict,
      };
    });
    return {
      partitionId: expected.partitionId,
      id: expected.id,
      corpusKind: expected.corpusKind,
      sourceSha256: expected.sourceSha256,
      genreFamily: expected.genreFamily,
      wholeSourceListened: true as const,
      verdicts,
    };
  });
  return {
    $schema: INSTRUMENT_EVALUATION_REVIEW_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    status: REVIEW_STATUS,
    reviewProtocolVersion: REVIEW_PROTOCOL,
    privateReviewSha256,
    curatedAt,
    reviewAuthority: 'teacher-or-domain-reviewer',
    deidentified: true,
    rawTeacherFeedbackIncluded: false,
    attestation: INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
    sources,
  };
}

export function validateInstrumentCandidateObservations(
  value: unknown,
  plan: InstrumentEvaluationPlanV1,
  planSha256: string
): InstrumentCandidateObservationsV2 {
  if (!record(value)) throw new Error('instrument candidate observations are invalid');
  exactKeys(
    value,
    ['$schema', 'planPath', 'planVersion', 'planSha256', 'generatedAt', 'candidate', 'sources'],
    'instrument candidate observations'
  );
  validatePlanBinding(value, plan, planSha256, 'instrument candidate observations');
  if (value.$schema !== INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA) {
    throw new Error('instrument candidate observation schema drifted');
  }
  const generatedAt = isoTimestamp(value.generatedAt, 'instrument candidate timestamp');
  if (!record(value.candidate)) throw new Error('instrument candidate identity is invalid');
  exactKeys(
    value.candidate,
    [
      'classifierVersion',
      'modelSha256',
      'vocabularyVersion',
      'vocabularySha256',
      'preprocessingVersion',
      'thresholdPolicyVersion',
    ],
    'instrument candidate identity'
  );
  const candidate = {
    classifierVersion: safeVersion(value.candidate.classifierVersion, 'candidate classifier version'),
    modelSha256: sha256(value.candidate.modelSha256, 'candidate model SHA-256'),
    vocabularyVersion: safeVersion(
      value.candidate.vocabularyVersion,
      'candidate vocabulary version'
    ),
    vocabularySha256: sha256(
      value.candidate.vocabularySha256,
      'candidate vocabulary SHA-256'
    ),
    preprocessingVersion: safeVersion(
      value.candidate.preprocessingVersion,
      'candidate preprocessing version'
    ),
    thresholdPolicyVersion: safeVersion(
      value.candidate.thresholdPolicyVersion,
      'candidate threshold policy version'
    ),
  };
  if (
    candidate.vocabularyVersion !== plan.vocabulary.version ||
    candidate.vocabularySha256 !== plan.vocabulary.sha256
  ) {
    throw new Error('candidate vocabulary drifted from the evaluation plan');
  }
  if (!Array.isArray(value.sources)) throw new Error('candidate sources are invalid');
  const expectedSources = flattenedPlanSources(plan);
  if (value.sources.length !== expectedSources.length) {
    throw new Error('candidate source coverage is incomplete');
  }
  const sources = value.sources.map((rawSource, index) => {
    const context = `candidate source ${index + 1}`;
    if (!record(rawSource)) throw new Error(`${context} is invalid`);
    exactKeys(
      rawSource,
      ['partitionId', 'id', 'sourceSha256', 'outcome', 'outcomeReason', 'detections'],
      context
    );
    const expected = expectedSources[index];
    if (
      rawSource.partitionId !== expected.partitionId ||
      rawSource.id !== expected.id ||
      rawSource.sourceSha256 !== expected.sourceSha256 ||
      typeof rawSource.outcome !== 'string' ||
      !(CANDIDATE_OUTCOMES as readonly string[]).includes(rawSource.outcome) ||
      !Array.isArray(rawSource.detections)
    ) {
      throw new Error(`${context} does not match the pinned source plan`);
    }
    const outcome = rawSource.outcome as CandidateOutcome;
    const outcomeReason = safeId(rawSource.outcomeReason, `${context} outcome reason`);
    if (
      !(CANDIDATE_OUTCOME_REASONS[outcome] as readonly string[]).includes(outcomeReason)
    ) {
      throw new Error(`${context} outcome reason does not match its outcome`);
    }
    if (outcome !== 'classified' && rawSource.detections.length > 0) {
      throw new Error(`${context} cannot report detections after abstention or degradation`);
    }
    const seen = new Set<string>();
    const detections = rawSource.detections.map((rawDetection) => {
      if (!record(rawDetection)) throw new Error(`${context} detection is invalid`);
      exactKeys(rawDetection, ['instrumentId', 'state', 'confidence'], `${context} detection`);
      const instrumentId = safeId(rawDetection.instrumentId, `${context} instrument id`);
      if (
        !INSTRUMENT_REVIEW_OPTIONS_BY_ID.has(instrumentId) ||
        seen.has(instrumentId) ||
        typeof rawDetection.state !== 'string' ||
        !(CANDIDATE_STATES as readonly string[]).includes(rawDetection.state) ||
        typeof rawDetection.confidence !== 'number' ||
        !Number.isFinite(rawDetection.confidence) ||
        rawDetection.confidence < 0 ||
        rawDetection.confidence > 1
      ) {
        throw new Error(`${context} detection is unknown, duplicated, or invalid`);
      }
      seen.add(instrumentId);
      return {
        instrumentId,
        state: rawDetection.state as CandidateState,
        confidence: rawDetection.confidence,
      };
    });
    return {
      partitionId: expected.partitionId,
      id: expected.id,
      sourceSha256: expected.sourceSha256,
      outcome,
      outcomeReason: outcomeReason as CandidateOutcomeReason,
      detections,
    };
  });
  return {
    $schema: INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    generatedAt,
    candidate,
    sources,
  };
}

interface MutableCounts {
  evaluated: number;
  classifiedDecisions: number;
  groundTruthAudible: number;
  groundTruthAbsent: number;
  groundTruthUncertain: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  candidateUncertainDecisions: number;
  sourceAbstentionDecisions: number;
  serviceFailureDecisions: number;
}

function emptyCounts(): MutableCounts {
  return {
    evaluated: 0,
    classifiedDecisions: 0,
    groundTruthAudible: 0,
    groundTruthAbsent: 0,
    groundTruthUncertain: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
    candidateUncertainDecisions: 0,
    sourceAbstentionDecisions: 0,
    serviceFailureDecisions: 0,
  };
}

function basisPoints(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) : null;
}

function finalizeCounts(counts: MutableCounts): InstrumentMetricCountsV2 {
  return {
    ...counts,
    precisionBasisPoints: basisPoints(
      counts.truePositive,
      counts.truePositive + counts.falsePositive
    ),
    recallBasisPoints: basisPoints(
      counts.truePositive,
      counts.truePositive + counts.falseNegative
    ),
    selectiveCoverageRateBasisPoints: basisPoints(
      counts.classifiedDecisions,
      counts.evaluated
    ),
    abstentionRateBasisPoints: basisPoints(
      counts.candidateUncertainDecisions + counts.sourceAbstentionDecisions,
      counts.evaluated
    ),
    serviceFailureRateBasisPoints: basisPoints(
      counts.serviceFailureDecisions,
      counts.evaluated
    ),
  };
}

function mapCounts<K extends string>(map: Map<K, MutableCounts>): Record<K, InstrumentMetricCountsV2> {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, finalizeCounts(value)])
  ) as Record<K, InstrumentMetricCountsV2>;
}

function countsFor<K extends string>(map: Map<K, MutableCounts>, key: K): MutableCounts {
  let counts = map.get(key);
  if (!counts) {
    counts = emptyCounts();
    map.set(key, counts);
  }
  return counts;
}

function addDecision(
  counts: MutableCounts,
  reviewVerdict: ReviewVerdict,
  candidateState: CandidateState | 'absent' | 'abstained' | 'degraded'
): void {
  if (reviewVerdict === 'uncertain') {
    counts.groundTruthUncertain += 1;
    return;
  }
  counts.evaluated += 1;
  if (reviewVerdict === 'audible') counts.groundTruthAudible += 1;
  else counts.groundTruthAbsent += 1;
  if (candidateState === 'degraded') {
    counts.serviceFailureDecisions += 1;
    return;
  }
  if (candidateState === 'abstained') {
    counts.sourceAbstentionDecisions += 1;
    return;
  }
  if (candidateState === 'uncertain') {
    counts.candidateUncertainDecisions += 1;
    return;
  }
  counts.classifiedDecisions += 1;
  const predicted = candidateState === 'possible';
  if (reviewVerdict === 'audible') {
    if (predicted) counts.truePositive += 1;
    else counts.falseNegative += 1;
  } else if (predicted) {
    counts.falsePositive += 1;
  } else {
    counts.trueNegative += 1;
  }
}

export function evaluateInstrumentCandidate(
  plan: InstrumentEvaluationPlanV1,
  review: InstrumentEvaluationReviewV1,
  candidate: InstrumentCandidateObservationsV2
): InstrumentEvaluationMetricsV2 {
  if (
    review.planVersion !== plan.version ||
    candidate.planVersion !== plan.version ||
    review.planSha256 !== candidate.planSha256
  ) {
    throw new Error('instrument evaluation inputs do not share one plan identity');
  }
  const allCounts = emptyCounts();
  const byKind = new Map<InstrumentReviewKind, MutableCounts>();
  const byGenre = new Map<InstrumentFeedbackGenreFamily, MutableCounts>();
  const byFamily = new Map<string, MutableCounts>();
  const byInstrument = new Map<string, MutableCounts>();
  const byCorpusKind = new Map<CorpusKind, MutableCounts>();
  const realMixSourcesByGenre = new Map<InstrumentFeedbackGenreFamily, number>();
  const audibleSpecificSourcesByFamily = new Map<string, Set<string>>();
  const abstainedSources: string[] = [];
  const degradedSources: string[] = [];
  let reviewUncertainDecisions = 0;

  for (let sourceIndex = 0; sourceIndex < review.sources.length; sourceIndex += 1) {
    const reviewedSource = review.sources[sourceIndex];
    const candidateSource = candidate.sources[sourceIndex];
    if (
      reviewedSource.partitionId !== candidateSource.partitionId ||
      reviewedSource.id !== candidateSource.id ||
      reviewedSource.sourceSha256 !== candidateSource.sourceSha256
    ) {
      throw new Error('instrument evaluation source order or identity drifted');
    }
    if (reviewedSource.corpusKind === 'real-mix') {
      realMixSourcesByGenre.set(
        reviewedSource.genreFamily,
        (realMixSourcesByGenre.get(reviewedSource.genreFamily) ?? 0) + 1
      );
    }
    const sourceIdentity = `${candidateSource.partitionId}/${candidateSource.id}`;
    if (candidateSource.outcome === 'abstained') abstainedSources.push(sourceIdentity);
    if (candidateSource.outcome === 'degraded') degradedSources.push(sourceIdentity);
    const detections = new Map(
      candidateSource.detections.map((detection) => [detection.instrumentId, detection])
    );
    for (const reviewedVerdict of reviewedSource.verdicts) {
      const option = INSTRUMENT_REVIEW_OPTIONS_BY_ID.get(reviewedVerdict.instrumentId)!;
      const detection = detections.get(reviewedVerdict.instrumentId);
      const candidateState: CandidateState | 'absent' | 'abstained' | 'degraded' =
        candidateSource.outcome === 'degraded'
          ? 'degraded'
          : candidateSource.outcome === 'abstained'
            ? 'abstained'
            : detection?.state ?? 'absent';
      if (reviewedVerdict.verdict === 'uncertain') reviewUncertainDecisions += 1;
      addDecision(allCounts, reviewedVerdict.verdict, candidateState);
      addDecision(
        countsFor(byKind, option.kind),
        reviewedVerdict.verdict,
        candidateState
      );
      addDecision(
        countsFor(byInstrument, option.id),
        reviewedVerdict.verdict,
        candidateState
      );
      if (option.kind === 'specific-instrument-or-voice') {
        addDecision(
          countsFor(byFamily, option.family),
          reviewedVerdict.verdict,
          candidateState
        );
        addDecision(
          countsFor(byCorpusKind, reviewedSource.corpusKind),
          reviewedVerdict.verdict,
          candidateState
        );
        if (reviewedSource.corpusKind === 'real-mix') {
          addDecision(
            countsFor(byGenre, reviewedSource.genreFamily),
            reviewedVerdict.verdict,
            candidateState
          );
        }
        if (reviewedVerdict.verdict === 'audible') {
          let sourceIds = audibleSpecificSourcesByFamily.get(option.family);
          if (!sourceIds) {
            sourceIds = new Set();
            audibleSpecificSourcesByFamily.set(option.family, sourceIds);
          }
          sourceIds.add(`${reviewedSource.partitionId}/${reviewedSource.id}`);
        }
      }
    }
  }

  const coverageBlockers: string[] = [];
  for (const requiredGenre of plan.requiredCoverage.realMixGenreFamilies) {
    const sourceCount = realMixSourcesByGenre.get(requiredGenre) ?? 0;
    if (sourceCount < plan.requiredCoverage.minimumRealMixSourcesPerGenre) {
      coverageBlockers.push(`genre-source-coverage-missing:${requiredGenre}`);
    }
    const metrics = byGenre.get(requiredGenre);
    if (!metrics || metrics.groundTruthAudible < 1) {
      coverageBlockers.push(`genre-positive-review-missing:${requiredGenre}`);
    }
  }
  for (const requiredFamily of plan.requiredCoverage.instrumentFamilies) {
    const sourceCount = audibleSpecificSourcesByFamily.get(requiredFamily)?.size ?? 0;
    if (sourceCount < plan.requiredCoverage.minimumAudibleSourcesPerInstrumentFamily) {
      coverageBlockers.push(`instrument-family-positive-missing:${requiredFamily}`);
    }
  }
  for (const requiredKind of plan.requiredCoverage.reviewKinds) {
    if ((byKind.get(requiredKind)?.evaluated ?? 0) < 1) {
      coverageBlockers.push(`review-kind-missing:${requiredKind}`);
    }
  }
  if (reviewUncertainDecisions > 0) coverageBlockers.push('review-uncertainty-present');
  if (degradedSources.length > 0) coverageBlockers.push('candidate-service-failure-present');

  const promotionBlockers = [
    ...coverageBlockers,
    'candidate-quality-floor-not-selected',
    'candidate-selection-decision-missing',
    'railway-shadow-evidence-missing',
  ];
  return {
    $schema: INSTRUMENT_EVALUATION_METRICS_SCHEMA,
    planVersion: plan.version,
    reviewStatus: REVIEW_STATUS,
    candidate: candidate.candidate,
    diagnosticAllLabels: {
      ...finalizeCounts(allCounts),
      promotionUse: 'forbidden-overlapping-label-kinds',
    },
    byKind: mapCounts(byKind) as Record<InstrumentReviewKind, InstrumentMetricCountsV2>,
    byGenre: mapCounts(byGenre),
    byInstrumentFamily: mapCounts(byFamily),
    byInstrument: mapCounts(byInstrument),
    byCorpusKind: mapCounts(byCorpusKind),
    coverage: {
      realMixSourcesByGenre: Object.fromEntries(
        [...realMixSourcesByGenre.entries()].sort(([left], [right]) => left.localeCompare(right))
      ),
      audibleSpecificSourcesByFamily: Object.fromEntries(
        [...audibleSpecificSourcesByFamily.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([family, sources]) => [family, sources.size])
      ),
      abstainedSources,
      degradedSources,
      reviewUncertainDecisions,
    },
    coverageReady: coverageBlockers.length === 0,
    coverageBlockers,
    promotionEligible: false,
    promotionBlockers,
    caveat:
      'Precision and recall cover only definite classified decisions; abstentions and service failures have separate rates and never become absence claims. All-label totals are diagnostic only because parent, child, ensemble, and production-texture labels overlap. Promotion requires separate kind, genre, family, quality-floor, human-selection, and Railway shadow evidence.',
  };
}

export function summarizeInstrumentEvaluationPlan(plan: InstrumentEvaluationPlanV1) {
  const sourcesByKind = Object.fromEntries(
    CORPUS_KINDS.map((kind) => [
      kind,
      plan.partitions
        .filter(({ corpusKind: partitionKind }) => partitionKind === kind)
        .reduce((sum, partition) => sum + partition.sources.length, 0),
    ])
  );
  const realMixSourcesByGenre: Partial<Record<InstrumentFeedbackGenreFamily, number>> = {};
  for (const partition of plan.partitions.filter(({ corpusKind: kind }) => kind === 'real-mix')) {
    for (const source of partition.sources) {
      realMixSourcesByGenre[source.genreFamily] =
        (realMixSourcesByGenre[source.genreFamily] ?? 0) + 1;
    }
  }
  return {
    schema: plan.$schema,
    version: plan.version,
    status: plan.status,
    sourcesByKind,
    realMixSourcesByGenre,
    requiredGenreFamilies: plan.requiredCoverage.realMixGenreFamilies,
    requiredInstrumentFamilies: plan.requiredCoverage.instrumentFamilies,
    requiredReviewKinds: plan.requiredCoverage.reviewKinds,
    promotionEligible: false,
    blockers: [
      'exhaustive-deidentified-review-missing',
      'candidate-observations-missing',
      'candidate-quality-floor-not-selected',
      'candidate-selection-decision-missing',
      'railway-shadow-evidence-missing',
    ],
  };
}
