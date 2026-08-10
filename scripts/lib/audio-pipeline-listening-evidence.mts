import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  RAILWAY_ROLLBACK_BASELINE_SHA256,
  loadRailwayRollbackBaselineEvidence,
  type RailwayRollbackBaselineSummary,
} from './railway-baseline-evidence.mts';

export const AUDIO_PIPELINE_LISTENING_SCHEMA =
  'stem-splitter.audio-pipeline-listening.v1' as const;
export const AUDIO_PIPELINE_LISTENING_EVIDENCE_PATH =
  'docs/acceptance/2026-08-10-v3.2-manual-listening/review.json' as const;
export const AUDIO_PIPELINE_LISTENING_ATTESTATION =
  'I listened to the complete authorized source and every frozen stem, and I accept this result for the v3.2 pre-provision gate.' as const;

const RELEASE_ID = 'v3.2-autosplit-role-v4';
const REVIEWER_ROLES = ['teacher', 'domain-reviewer'] as const;
const CHECK_KEYS = [
  'sourceReviewedInFull',
  'eachStemReviewedInFull',
  'noCorruptionOrTruncation',
  'vocalsUsable',
  'drumsUsable',
  'bassUsable',
  'otherUsable',
  'classroomUseAccepted',
] as const;

type RecordValue = Record<string, unknown>;

export interface AudioPipelineListeningEvidenceSummary {
  schema: typeof AUDIO_PIPELINE_LISTENING_SCHEMA;
  releaseId: typeof RELEASE_ID;
  reviewedAt: string;
  reviewedBy: string;
  reviewerRole: (typeof REVIEWER_ROLES)[number];
  decision: 'accepted';
  baselineArtifactSha256: typeof RAILWAY_ROLLBACK_BASELINE_SHA256;
  jobId: string;
  sourceSha256: string;
  model: string;
  stemHashes: string[];
}

function object(value: unknown, keys: readonly string[], context: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const record = value as RecordValue;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context} does not match the listening schema`);
  }
  return record;
}

function boundedText(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('listening reviewedAt is invalid');
  }
  return value;
}

export function createPendingAudioPipelineListeningReview(
  baseline: RailwayRollbackBaselineSummary
): Record<string, unknown> {
  return {
    $schema: AUDIO_PIPELINE_LISTENING_SCHEMA,
    releaseId: RELEASE_ID,
    baselineArtifactSha256: baseline.artifactSha256,
    jobId: baseline.jobId,
    sourceSha256: baseline.sourceSha256,
    model: baseline.model,
    reviewedAt: '',
    reviewedBy: '',
    reviewerRole: '',
    decision: 'pending',
    checks: Object.fromEntries(CHECK_KEYS.map((key) => [key, false])),
    stems: baseline.stems.map((stem) => ({
      ...stem,
      verdict: 'pending',
      notes: '',
    })),
    notes: '',
    attestation: '',
  };
}

export function validateAudioPipelineListeningEvidence(
  value: unknown,
  baseline: RailwayRollbackBaselineSummary
): AudioPipelineListeningEvidenceSummary {
  const review = object(
    value,
    [
      '$schema',
      'releaseId',
      'baselineArtifactSha256',
      'jobId',
      'sourceSha256',
      'model',
      'reviewedAt',
      'reviewedBy',
      'reviewerRole',
      'decision',
      'checks',
      'stems',
      'notes',
      'attestation',
    ],
    'listening review'
  );
  if (review.$schema !== AUDIO_PIPELINE_LISTENING_SCHEMA) {
    throw new Error('listening schema version drifted');
  }
  if (
    review.releaseId !== RELEASE_ID ||
    review.baselineArtifactSha256 !== RAILWAY_ROLLBACK_BASELINE_SHA256 ||
    review.baselineArtifactSha256 !== baseline.artifactSha256 ||
    review.jobId !== baseline.jobId ||
    review.sourceSha256 !== baseline.sourceSha256 ||
    review.model !== baseline.model
  ) {
    throw new Error('listening review drifted from the frozen release baseline');
  }
  const reviewedAt = timestamp(review.reviewedAt);
  if (Date.parse(reviewedAt) < Date.parse(baseline.capturedAt)) {
    throw new Error('listening review predates the frozen baseline');
  }
  const reviewedBy = boundedText(review.reviewedBy, 'listening reviewedBy', 2, 120);
  if (!REVIEWER_ROLES.includes(review.reviewerRole as (typeof REVIEWER_ROLES)[number])) {
    throw new Error('listening reviewerRole is invalid');
  }
  const reviewerRole = review.reviewerRole as (typeof REVIEWER_ROLES)[number];
  if (review.decision !== 'accepted') {
    throw new Error('listening decision must be accepted');
  }
  if (review.attestation !== AUDIO_PIPELINE_LISTENING_ATTESTATION) {
    throw new Error('listening attestation is incomplete');
  }
  boundedText(review.notes, 'listening notes', 0, 4_000);

  const checks = object(review.checks, CHECK_KEYS, 'listening checks');
  for (const key of CHECK_KEYS) {
    if (checks[key] !== true) throw new Error(`listening check ${key} is not accepted`);
  }

  if (!Array.isArray(review.stems) || review.stems.length !== baseline.stems.length) {
    throw new Error('listening stem review is incomplete');
  }
  const stemHashes = review.stems.map((candidate, index) => {
    const stem = object(
      candidate,
      ['name', 'bytes', 'sha256', 'verdict', 'notes'],
      `listening stem ${index}`
    );
    const expected = baseline.stems[index];
    if (
      stem.name !== expected.name ||
      stem.bytes !== expected.bytes ||
      stem.sha256 !== expected.sha256
    ) {
      throw new Error(`listening stem ${index} drifted from the frozen bytes`);
    }
    if (stem.verdict !== 'accepted') {
      throw new Error(`listening stem ${expected.name} is not accepted`);
    }
    boundedText(stem.notes, `listening stem ${expected.name} notes`, 0, 1_000);
    return expected.sha256;
  });

  return {
    schema: AUDIO_PIPELINE_LISTENING_SCHEMA,
    releaseId: RELEASE_ID,
    reviewedAt,
    reviewedBy,
    reviewerRole,
    decision: 'accepted',
    baselineArtifactSha256: RAILWAY_ROLLBACK_BASELINE_SHA256,
    jobId: baseline.jobId,
    sourceSha256: baseline.sourceSha256,
    model: baseline.model,
    stemHashes,
  };
}

export function loadAudioPipelineListeningEvidence(
  repositoryRoot: string,
  evidencePath: string = AUDIO_PIPELINE_LISTENING_EVIDENCE_PATH
): AudioPipelineListeningEvidenceSummary {
  const baseline = loadRailwayRollbackBaselineEvidence(repositoryRoot);
  const value = JSON.parse(readFileSync(resolve(repositoryRoot, evidencePath), 'utf8')) as unknown;
  return validateAudioPipelineListeningEvidence(value, baseline);
}
