import type { Env } from '../env.ts';
import {
  INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
  INSTRUMENT_REVIEW_OPTIONS_BY_ID,
} from './instrument-review.ts';

export const INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION = '1' as const;
export const INSTRUMENT_DISCOVERY_FEEDBACK_STATUS = 'unreviewed-candidate' as const;

export const INSTRUMENT_FEEDBACK_GENRE_FAMILIES = Object.freeze([
  'unknown',
  'rock',
  'jazz',
  'orchestral-chamber',
  'electronic',
  'hip-hop',
  'folk-traditional',
  'sparse-acoustic',
  'other',
] as const);

export type InstrumentFeedbackGenreFamily =
  (typeof INSTRUMENT_FEEDBACK_GENRE_FAMILIES)[number];
export type InstrumentFeedbackVerdict = 'confirmed' | 'absent' | 'missed';

export interface InstrumentFeedbackObservationV1 {
  instrumentId: string;
  verdict: InstrumentFeedbackVerdict;
}

export interface InstrumentDiscoveryFeedbackRecordV1 {
  schemaVersion: typeof INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION;
  id: string;
  jobId: string;
  reviewer: string;
  revision: number;
  analysisSha256: string;
  sourceSha256: string;
  classifierVersion: string;
  vocabularyVersion: string;
  vocabularySha256: string;
  reviewOntologyVersion: typeof INSTRUMENT_REVIEW_ONTOLOGY_VERSION;
  genreFamily: InstrumentFeedbackGenreFamily;
  observations: InstrumentFeedbackObservationV1[];
  evidenceStatus: typeof INSTRUMENT_DISCOVERY_FEEDBACK_STATUS;
  deidentified: false;
  trainingEligible: false;
  createdAt: string;
}

export interface InstrumentDiscoveryFeedbackSummaryV1 {
  schemaVersion: typeof INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION;
  revision: number;
  genreFamily: InstrumentFeedbackGenreFamily;
  observations: InstrumentFeedbackObservationV1[];
  evidenceStatus: typeof INSTRUMENT_DISCOVERY_FEEDBACK_STATUS;
  deidentified: false;
  trainingEligible: false;
  createdAt: string;
}

export interface InstrumentDiscoveryFeedbackTargetV1 {
  jobId: string;
  reviewer: string;
  rawAnalysis: string;
  analysisSha256: string;
  sourceSha256: string;
  classifierVersion: string;
  vocabularyVersion: string;
  vocabularySha256: string;
  detectedInstrumentIds: readonly string[];
}

export interface RecordInstrumentDiscoveryFeedbackInputV1
  extends InstrumentDiscoveryFeedbackTargetV1 {
  expectedRevision: number;
  genreFamily: InstrumentFeedbackGenreFamily;
  observations: InstrumentFeedbackObservationV1[];
  now?: Date;
  id?: string;
}

export type InstrumentDiscoveryFeedbackErrorCode =
  | 'invalid_request'
  | 'job_not_found'
  | 'analysis_changed'
  | 'conflict'
  | 'stored_invalid';

export class InstrumentDiscoveryFeedbackError extends Error {
  readonly code: InstrumentDiscoveryFeedbackErrorCode;

  constructor(code: InstrumentDiscoveryFeedbackErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface InstrumentDiscoveryFeedbackRow {
  id: string;
  schema_version: string;
  job_id: string;
  reviewer: string;
  revision: number;
  analysis_sha256: string;
  source_sha256: string;
  classifier_version: string;
  vocabulary_version: string;
  vocabulary_sha256: string;
  review_ontology_version: string;
  genre_family: string;
  observations: string;
  evidence_status: string;
  deidentified: number;
  training_eligible: number;
  created_at: string;
}

const SAFE_USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERDICTS = new Set<InstrumentFeedbackVerdict>(['confirmed', 'absent', 'missed']);
const GENRES = new Set<string>(INSTRUMENT_FEEDBACK_GENRE_FAMILIES);

function validDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new InstrumentDiscoveryFeedbackError('invalid_request', 'Invalid feedback timestamp.');
  }
  return value.toISOString();
}

function parseStoredObservations(value: string): InstrumentFeedbackObservationV1[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InstrumentDiscoveryFeedbackError(
      'stored_invalid',
      'Stored instrument feedback is invalid.'
    );
  }
  if (!Array.isArray(parsed)) {
    throw new InstrumentDiscoveryFeedbackError(
      'stored_invalid',
      'Stored instrument feedback is invalid.'
    );
  }
  return normalizeInstrumentFeedbackObservations(parsed, [], false, false);
}

function recordFromRow(row: InstrumentDiscoveryFeedbackRow): InstrumentDiscoveryFeedbackRecordV1 {
  if (
    row.schema_version !== INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION ||
    row.evidence_status !== INSTRUMENT_DISCOVERY_FEEDBACK_STATUS ||
    row.review_ontology_version !== INSTRUMENT_REVIEW_ONTOLOGY_VERSION ||
    row.deidentified !== 0 ||
    row.training_eligible !== 0 ||
    !GENRES.has(row.genre_family) ||
    !SHA256_PATTERN.test(row.analysis_sha256) ||
    !SHA256_PATTERN.test(row.source_sha256) ||
    !SHA256_PATTERN.test(row.vocabulary_sha256)
  ) {
    throw new InstrumentDiscoveryFeedbackError(
      'stored_invalid',
      'Stored instrument feedback has an unsupported provenance shape.'
    );
  }
  return {
    schemaVersion: INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION,
    id: row.id,
    jobId: row.job_id,
    reviewer: row.reviewer,
    revision: row.revision,
    analysisSha256: row.analysis_sha256,
    sourceSha256: row.source_sha256,
    classifierVersion: row.classifier_version,
    vocabularyVersion: row.vocabulary_version,
    vocabularySha256: row.vocabulary_sha256,
    reviewOntologyVersion: INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
    genreFamily: row.genre_family as InstrumentFeedbackGenreFamily,
    observations: parseStoredObservations(row.observations),
    evidenceStatus: INSTRUMENT_DISCOVERY_FEEDBACK_STATUS,
    deidentified: false,
    trainingEligible: false,
    createdAt: row.created_at,
  };
}

export function summarizeInstrumentDiscoveryFeedback(
  record: InstrumentDiscoveryFeedbackRecordV1
): InstrumentDiscoveryFeedbackSummaryV1 {
  return {
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    genreFamily: record.genreFamily,
    observations: record.observations,
    evidenceStatus: record.evidenceStatus,
    deidentified: false,
    trainingEligible: false,
    createdAt: record.createdAt,
  };
}

export function normalizeInstrumentFeedbackObservations(
  value: unknown,
  detectedInstrumentIds: readonly string[],
  requireCompleteDetectedReview = true,
  enforceDetectionRelation = true
): InstrumentFeedbackObservationV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > INSTRUMENT_REVIEW_OPTIONS_BY_ID.size) {
    throw new InstrumentDiscoveryFeedbackError(
      'invalid_request',
      'Record at least one bounded instrument observation.'
    );
  }
  const detected = new Set(detectedInstrumentIds);
  const seen = new Set<string>();
  const normalized: InstrumentFeedbackObservationV1[] = [];
  for (const observation of value) {
    if (
      !observation ||
      typeof observation !== 'object' ||
      Array.isArray(observation) ||
      Object.keys(observation).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(observation, 'instrumentId') ||
      !Object.prototype.hasOwnProperty.call(observation, 'verdict')
    ) {
      throw new InstrumentDiscoveryFeedbackError(
        'invalid_request',
        'Every instrument observation must contain only instrumentId and verdict.'
      );
    }
    const instrumentId = (observation as { instrumentId?: unknown }).instrumentId;
    const verdict = (observation as { verdict?: unknown }).verdict;
    if (
      typeof instrumentId !== 'string' ||
      !INSTRUMENT_REVIEW_OPTIONS_BY_ID.has(instrumentId) ||
      typeof verdict !== 'string' ||
      !VERDICTS.has(verdict as InstrumentFeedbackVerdict) ||
      seen.has(instrumentId)
    ) {
      throw new InstrumentDiscoveryFeedbackError(
        'invalid_request',
        'Instrument feedback contains an unknown, duplicated, or invalid observation.'
      );
    }
    if (enforceDetectionRelation && detected.has(instrumentId) !== (verdict !== 'missed')) {
      throw new InstrumentDiscoveryFeedbackError(
        'invalid_request',
        detected.has(instrumentId)
          ? 'A surfaced detection must be marked confirmed or absent.'
          : 'Only an instrument omitted by the candidate may be marked missed.'
      );
    }
    seen.add(instrumentId);
    normalized.push({ instrumentId, verdict: verdict as InstrumentFeedbackVerdict });
  }
  if (requireCompleteDetectedReview) {
    for (const instrumentId of detected) {
      if (!seen.has(instrumentId)) {
        throw new InstrumentDiscoveryFeedbackError(
          'invalid_request',
          'Mark every surfaced detection confirmed or absent before recording feedback.'
        );
      }
    }
  }
  return normalized.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId));
}

export async function getLatestInstrumentDiscoveryFeedback(
  env: Pick<Env, 'DB'>,
  target: InstrumentDiscoveryFeedbackTargetV1
): Promise<InstrumentDiscoveryFeedbackRecordV1 | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM instrument_discovery_feedback
     WHERE job_id = ? AND reviewer = ? AND analysis_sha256 = ?
     ORDER BY revision DESC LIMIT 1`
  )
    .bind(target.jobId, target.reviewer, target.analysisSha256)
    .first<InstrumentDiscoveryFeedbackRow>();
  if (!row) return null;
  const record = recordFromRow(row);
  if (
    record.sourceSha256 !== target.sourceSha256 ||
    record.classifierVersion !== target.classifierVersion ||
    record.vocabularyVersion !== target.vocabularyVersion ||
    record.vocabularySha256 !== target.vocabularySha256
  ) {
    throw new InstrumentDiscoveryFeedbackError(
      'stored_invalid',
      'Stored instrument feedback does not match the reviewed analysis provenance.'
    );
  }
  try {
    record.observations = normalizeInstrumentFeedbackObservations(
      record.observations,
      target.detectedInstrumentIds
    );
  } catch {
    throw new InstrumentDiscoveryFeedbackError(
      'stored_invalid',
      'Stored instrument feedback does not match the reviewed detections.'
    );
  }
  return record;
}

function sameFeedback(
  record: InstrumentDiscoveryFeedbackRecordV1,
  genreFamily: InstrumentFeedbackGenreFamily,
  observations: InstrumentFeedbackObservationV1[]
): boolean {
  return (
    record.genreFamily === genreFamily &&
    JSON.stringify(record.observations) === JSON.stringify(observations)
  );
}

async function targetStillMatches(
  env: Pick<Env, 'DB'>,
  target: InstrumentDiscoveryFeedbackTargetV1
): Promise<'missing' | 'changed' | 'match'> {
  const row = await env.DB.prepare(
    'SELECT source_hash, analysis FROM jobs WHERE id = ? AND routing_request = ?'
  )
    .bind(target.jobId, 'auto')
    .first<{ source_hash: string | null; analysis: string | null }>();
  if (!row) return 'missing';
  return row.source_hash === target.sourceSha256 && row.analysis === target.rawAnalysis
    ? 'match'
    : 'changed';
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function recordInstrumentDiscoveryFeedback(
  env: Pick<Env, 'DB'>,
  input: RecordInstrumentDiscoveryFeedbackInputV1
): Promise<{ record: InstrumentDiscoveryFeedbackRecordV1; changed: boolean }> {
  if (
    !SAFE_ID_PATTERN.test(input.jobId) ||
    !SAFE_USERNAME_PATTERN.test(input.reviewer) ||
    !SHA256_PATTERN.test(input.analysisSha256) ||
    !SHA256_PATTERN.test(input.sourceSha256) ||
    !SHA256_PATTERN.test(input.vocabularySha256) ||
    !input.classifierVersion ||
    input.classifierVersion.length > 200 ||
    !input.vocabularyVersion ||
    input.vocabularyVersion.length > 100 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= 1_000_000 ||
    !GENRES.has(input.genreFamily)
  ) {
    throw new InstrumentDiscoveryFeedbackError('invalid_request', 'Instrument feedback is invalid.');
  }
  if ((await sha256Utf8(input.rawAnalysis)) !== input.analysisSha256) {
    throw new InstrumentDiscoveryFeedbackError(
      'invalid_request',
      'Instrument feedback analysis fingerprint is invalid.'
    );
  }
  const observations = normalizeInstrumentFeedbackObservations(
    input.observations,
    input.detectedInstrumentIds
  );
  const current = await getLatestInstrumentDiscoveryFeedback(env, input);
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throw new InstrumentDiscoveryFeedbackError(
      'conflict',
      'Instrument feedback changed after you opened it. Reload the analysis and try again.'
    );
  }
  const targetState = await targetStillMatches(env, input);
  if (targetState === 'missing') {
    throw new InstrumentDiscoveryFeedbackError('job_not_found', 'Job not found.');
  }
  if (targetState === 'changed') {
    throw new InstrumentDiscoveryFeedbackError(
      'analysis_changed',
      'The stored analysis changed. Reload it before recording feedback.'
    );
  }
  if (current && sameFeedback(current, input.genreFamily, observations)) {
    return { record: current, changed: false };
  }

  const id = input.id ?? `feedback_${crypto.randomUUID().replaceAll('-', '')}`;
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new InstrumentDiscoveryFeedbackError('invalid_request', 'Instrument feedback ID is invalid.');
  }
  const revision = currentRevision + 1;
  const createdAt = validDate(input.now ?? new Date());
  let inserted;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO instrument_discovery_feedback
        (id, schema_version, job_id, reviewer, revision, analysis_sha256, source_sha256,
         classifier_version, vocabulary_version, vocabulary_sha256, review_ontology_version,
         genre_family, observations, evidence_status, deidentified, training_eligible, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?
       WHERE EXISTS (
         SELECT 1 FROM jobs
         WHERE id = ? AND routing_request = 'auto' AND source_hash = ? AND analysis = ?
       )
       AND ? = COALESCE((
         SELECT MAX(revision) FROM instrument_discovery_feedback
         WHERE job_id = ? AND reviewer = ? AND analysis_sha256 = ?
       ), 0)`
    )
      .bind(
        id,
        INSTRUMENT_DISCOVERY_FEEDBACK_SCHEMA_VERSION,
        input.jobId,
        input.reviewer,
        revision,
        input.analysisSha256,
        input.sourceSha256,
        input.classifierVersion,
        input.vocabularyVersion,
        input.vocabularySha256,
        INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
        input.genreFamily,
        JSON.stringify(observations),
        INSTRUMENT_DISCOVERY_FEEDBACK_STATUS,
        createdAt,
        input.jobId,
        input.sourceSha256,
        input.rawAnalysis,
        input.expectedRevision,
        input.jobId,
        input.reviewer,
        input.analysisSha256
      )
      .run();
  } catch (error) {
    let latest: InstrumentDiscoveryFeedbackRecordV1 | null;
    try {
      latest = await getLatestInstrumentDiscoveryFeedback(env, input);
    } catch {
      throw error;
    }
    if ((latest?.revision ?? 0) !== input.expectedRevision) {
      throw new InstrumentDiscoveryFeedbackError(
        'conflict',
        'Instrument feedback changed after you opened it. Reload the analysis and try again.'
      );
    }
    throw error;
  }
  if (inserted.meta.changes !== 1) {
    const state = await targetStillMatches(env, input);
    if (state === 'missing') {
      throw new InstrumentDiscoveryFeedbackError('job_not_found', 'Job not found.');
    }
    if (state === 'changed') {
      throw new InstrumentDiscoveryFeedbackError(
        'analysis_changed',
        'The stored analysis changed. Reload it before recording feedback.'
      );
    }
    throw new InstrumentDiscoveryFeedbackError(
      'conflict',
      'Instrument feedback changed after you opened it. Reload the analysis and try again.'
    );
  }
  const record = await env.DB.prepare('SELECT * FROM instrument_discovery_feedback WHERE id = ?')
    .bind(id)
    .first<InstrumentDiscoveryFeedbackRow>();
  if (!record) {
    throw new InstrumentDiscoveryFeedbackError(
      'invalid_request',
      'Recorded instrument feedback could not be read back.'
    );
  }
  return { record: recordFromRow(record), changed: true };
}
