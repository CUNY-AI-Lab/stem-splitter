import { createHash } from 'node:crypto';

import { INSTRUMENT_REVIEW_OPTIONS } from '../../src/analysis/instrument-review.ts';
import {
  INSTRUMENT_EVALUATION_PLAN_PATH,
  INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
  INSTRUMENT_EVALUATION_REVIEW_SCHEMA,
  validateInstrumentEvaluationReview,
  type InstrumentEvaluationPlanV1,
  type InstrumentEvaluationReviewV1,
} from './instrument-evaluation.mts';

export const PRIVATE_INSTRUMENT_EVALUATION_REVIEW_SCHEMA =
  'stem-splitter.private-instrument-evaluation-review.v1' as const;

const PRIVATE_REVIEW_STATUS = 'pending-private-review' as const;
const REVIEW_PROTOCOL = 'instrument-evaluation-listening-v1' as const;
const VERDICTS = ['audible', 'absent', 'uncertain'] as const;
const SAFE_REVIEWER = /^[A-Za-z0-9][A-Za-z0-9 ._'()-]{0,119}$/;

type PrivateVerdict = (typeof VERDICTS)[number] | 'unreviewed';
type JsonRecord = Record<string, unknown>;

export interface PrivateInstrumentEvaluationReviewV1 {
  $schema: typeof PRIVATE_INSTRUMENT_EVALUATION_REVIEW_SCHEMA;
  planPath: typeof INSTRUMENT_EVALUATION_PLAN_PATH;
  planVersion: string;
  planSha256: string;
  status: typeof PRIVATE_REVIEW_STATUS;
  reviewProtocolVersion: typeof REVIEW_PROTOCOL;
  reviewer: string;
  reviewedAt: string;
  attestation: string;
  sources: Array<{
    partitionId: string;
    id: string;
    corpusKind: 'real-mix' | 'isolated-control' | 'synthetic-stem';
    sourceSha256: string;
    genreFamily: InstrumentEvaluationPlanV1['partitions'][number]['sources'][number]['genreFamily'];
    wholeSourceListened: boolean;
    verdicts: Array<{ instrumentId: string; verdict: PrivateVerdict }>;
  }>;
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sorted)) {
    throw new Error(`${context} does not match the private review schema`);
  }
}

function planSources(plan: InstrumentEvaluationPlanV1) {
  return plan.partitions.flatMap((partition) =>
    partition.sources.map((source) => ({
      partitionId: partition.id,
      corpusKind: partition.corpusKind,
      ...source,
    }))
  );
}

function canonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function createPrivateInstrumentEvaluationReviewTemplate(
  plan: InstrumentEvaluationPlanV1,
  planSha256: string
): PrivateInstrumentEvaluationReviewV1 {
  return {
    $schema: PRIVATE_INSTRUMENT_EVALUATION_REVIEW_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    status: PRIVATE_REVIEW_STATUS,
    reviewProtocolVersion: REVIEW_PROTOCOL,
    reviewer: '',
    reviewedAt: '',
    attestation: '',
    sources: planSources(plan).map((source) => ({
      partitionId: source.partitionId,
      id: source.id,
      corpusKind: source.corpusKind,
      sourceSha256: source.sourceSha256,
      genreFamily: source.genreFamily,
      wholeSourceListened: false,
      verdicts: INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => ({
        instrumentId: id,
        verdict: 'unreviewed',
      })),
    })),
  };
}

/**
 * Validate an in-progress private worksheet without weakening the finalizer.
 * Drafts may contain unreviewed labels and partially completed sources, but
 * their plan identity, ordering, source hashes, and verdict vocabulary remain
 * frozen. A source cannot claim complete listening while any label is still
 * unreviewed.
 */
export function validatePrivateInstrumentEvaluationReviewDraft(
  value: unknown,
  plan: InstrumentEvaluationPlanV1,
  planSha256: string
): PrivateInstrumentEvaluationReviewV1 {
  if (!record(value)) throw new Error('private instrument evaluation review draft is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'planPath',
      'planVersion',
      'planSha256',
      'status',
      'reviewProtocolVersion',
      'reviewer',
      'reviewedAt',
      'attestation',
      'sources',
    ],
    'private instrument evaluation review draft'
  );
  if (
    value.$schema !== PRIVATE_INSTRUMENT_EVALUATION_REVIEW_SCHEMA ||
    value.planPath !== INSTRUMENT_EVALUATION_PLAN_PATH ||
    value.planVersion !== plan.version ||
    value.planSha256 !== planSha256 ||
    value.status !== PRIVATE_REVIEW_STATUS ||
    value.reviewProtocolVersion !== REVIEW_PROTOCOL ||
    typeof value.reviewer !== 'string' ||
    (value.reviewer !== '' && !SAFE_REVIEWER.test(value.reviewer)) ||
    typeof value.reviewedAt !== 'string' ||
    (value.reviewedAt !== '' && !canonicalIso(value.reviewedAt)) ||
    typeof value.attestation !== 'string' ||
    (value.attestation !== '' && value.attestation !== INSTRUMENT_EVALUATION_REVIEW_ATTESTATION) ||
    !Array.isArray(value.sources)
  ) {
    throw new Error('private instrument evaluation review draft is incomplete or drifted');
  }
  const expectedSources = planSources(plan);
  if (value.sources.length !== expectedSources.length) {
    throw new Error('private instrument evaluation review draft source coverage is incomplete');
  }
  const completionMetadata = [
    value.reviewer !== '',
    value.reviewedAt !== '',
    value.attestation !== '',
  ];
  if (completionMetadata.some(Boolean) && !completionMetadata.every(Boolean)) {
    throw new Error('private instrument evaluation review draft completion is partial');
  }
  const optionIds = INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => id);
  const sources = value.sources.map((rawSource, sourceIndex) => {
    const context = `private instrument review draft source ${sourceIndex + 1}`;
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
    const expected = expectedSources[sourceIndex];
    if (
      rawSource.partitionId !== expected.partitionId ||
      rawSource.id !== expected.id ||
      rawSource.corpusKind !== expected.corpusKind ||
      rawSource.sourceSha256 !== expected.sourceSha256 ||
      rawSource.genreFamily !== expected.genreFamily ||
      typeof rawSource.wholeSourceListened !== 'boolean' ||
      !Array.isArray(rawSource.verdicts) ||
      rawSource.verdicts.length !== optionIds.length
    ) {
      throw new Error(`${context} does not match the pinned source`);
    }
    const verdicts = rawSource.verdicts.map((rawVerdict, verdictIndex) => {
      if (!record(rawVerdict)) throw new Error(`${context} verdict is invalid`);
      exactKeys(rawVerdict, ['instrumentId', 'verdict'], `${context} verdict`);
      if (
        rawVerdict.instrumentId !== optionIds[verdictIndex] ||
        typeof rawVerdict.verdict !== 'string' ||
        rawVerdict.verdict !== 'unreviewed' &&
          !(VERDICTS as readonly string[]).includes(rawVerdict.verdict)
      ) {
        throw new Error(`${context} contains an invalid or reordered verdict`);
      }
      return {
        instrumentId: rawVerdict.instrumentId,
        verdict: rawVerdict.verdict as PrivateVerdict,
      };
    });
    if (
      rawSource.wholeSourceListened &&
      verdicts.some(({ verdict }) => verdict === 'unreviewed')
    ) {
      throw new Error(`${context} cannot be complete while labels remain unreviewed`);
    }
    return {
      partitionId: expected.partitionId,
      id: expected.id,
      corpusKind: expected.corpusKind,
      sourceSha256: expected.sourceSha256,
      genreFamily: expected.genreFamily,
      wholeSourceListened: rawSource.wholeSourceListened,
      verdicts,
    };
  });
  if (
    completionMetadata.every(Boolean) &&
    sources.some(
      (source) =>
        !source.wholeSourceListened ||
        source.verdicts.some(({ verdict }) => verdict === 'unreviewed')
    )
  ) {
    throw new Error('private instrument evaluation review draft is attested before completion');
  }
  return {
    $schema: PRIVATE_INSTRUMENT_EVALUATION_REVIEW_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    status: PRIVATE_REVIEW_STATUS,
    reviewProtocolVersion: REVIEW_PROTOCOL,
    reviewer: value.reviewer,
    reviewedAt: value.reviewedAt,
    attestation: value.attestation,
    sources,
  };
}

export function finalizePrivateInstrumentEvaluationReview(
  value: unknown,
  serializedPrivateReview: string,
  plan: InstrumentEvaluationPlanV1,
  planSha256: string
): InstrumentEvaluationReviewV1 {
  if (!record(value)) throw new Error('private instrument evaluation review is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'planPath',
      'planVersion',
      'planSha256',
      'status',
      'reviewProtocolVersion',
      'reviewer',
      'reviewedAt',
      'attestation',
      'sources',
    ],
    'private instrument evaluation review'
  );
  if (
    value.$schema !== PRIVATE_INSTRUMENT_EVALUATION_REVIEW_SCHEMA ||
    value.planPath !== INSTRUMENT_EVALUATION_PLAN_PATH ||
    value.planVersion !== plan.version ||
    value.planSha256 !== planSha256 ||
    value.status !== PRIVATE_REVIEW_STATUS ||
    value.reviewProtocolVersion !== REVIEW_PROTOCOL ||
    typeof value.reviewer !== 'string' ||
    !SAFE_REVIEWER.test(value.reviewer) ||
    !canonicalIso(value.reviewedAt) ||
    value.attestation !== INSTRUMENT_EVALUATION_REVIEW_ATTESTATION ||
    !Array.isArray(value.sources)
  ) {
    throw new Error('private instrument evaluation review is incomplete or drifted');
  }
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(serializedPrivateReview);
  } catch {
    throw new Error('private instrument evaluation review bytes are not JSON');
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(value)) {
    throw new Error('private instrument evaluation review bytes do not match the reviewed value');
  }
  const expectedSources = planSources(plan);
  if (value.sources.length !== expectedSources.length) {
    throw new Error('private instrument evaluation source coverage is incomplete');
  }
  const optionIds = INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => id);
  const sources = value.sources.map((rawSource, sourceIndex) => {
    const context = `private instrument review source ${sourceIndex + 1}`;
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
    const expected = expectedSources[sourceIndex];
    if (
      rawSource.partitionId !== expected.partitionId ||
      rawSource.id !== expected.id ||
      rawSource.corpusKind !== expected.corpusKind ||
      rawSource.sourceSha256 !== expected.sourceSha256 ||
      rawSource.genreFamily !== expected.genreFamily ||
      rawSource.wholeSourceListened !== true ||
      !Array.isArray(rawSource.verdicts) ||
      rawSource.verdicts.length !== optionIds.length
    ) {
      throw new Error(`${context} is incomplete or does not match the pinned source`);
    }
    const verdicts = rawSource.verdicts.map((rawVerdict, verdictIndex) => {
      if (!record(rawVerdict)) throw new Error(`${context} verdict is invalid`);
      exactKeys(rawVerdict, ['instrumentId', 'verdict'], `${context} verdict`);
      if (
        rawVerdict.instrumentId !== optionIds[verdictIndex] ||
        typeof rawVerdict.verdict !== 'string' ||
        !(VERDICTS as readonly string[]).includes(rawVerdict.verdict)
      ) {
        throw new Error(`${context} contains an unreviewed or reordered verdict`);
      }
      return {
        instrumentId: rawVerdict.instrumentId,
        verdict: rawVerdict.verdict as (typeof VERDICTS)[number],
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
  const publicReview: InstrumentEvaluationReviewV1 = {
    $schema: INSTRUMENT_EVALUATION_REVIEW_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    status: 'reviewed-deidentified-ground-truth',
    reviewProtocolVersion: REVIEW_PROTOCOL,
    privateReviewSha256: createHash('sha256').update(serializedPrivateReview).digest('hex'),
    curatedAt: value.reviewedAt,
    reviewAuthority: 'teacher-or-domain-reviewer',
    deidentified: true,
    rawTeacherFeedbackIncluded: false,
    attestation: INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
    sources,
  };
  return validateInstrumentEvaluationReview(publicReview, plan, planSha256);
}
