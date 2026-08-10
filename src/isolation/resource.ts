import type { Env } from '../env.ts';
import {
  normalizeIsolationTarget,
  queryIsolationCacheKeyForMaterial,
  validateQueryIsolationCacheMaterial,
  validateQueryIsolationProviderIdentity,
} from './contract.ts';
import {
  QUERY_ISOLATION_SCHEMA_VERSION,
  type QueryIsolationFailureCode,
  type QueryIsolationProviderIdentityV1,
  type QueryIsolationSourceType,
} from './types.ts';

export const MAX_QUERY_ISOLATIONS_PER_JOB = 2;
export const MAX_QUERY_ISOLATION_ATTEMPTS = 2;
export const QUERY_ISOLATION_ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;

export type InstrumentIsolationStatus = 'queued' | 'processing' | 'succeeded' | 'failed';
export type InstrumentIsolationRolloutStage = 'shadow' | 'teacher_beta';
export type InstrumentIsolationSummaryStatus = InstrumentIsolationStatus | 'shadowed';
export type InstrumentIsolationFailureCode = QueryIsolationFailureCode | 'timed_out';

export interface InstrumentIsolationRecordV1 {
  schemaVersion: typeof QUERY_ISOLATION_SCHEMA_VERSION;
  id: string;
  jobId: string;
  requestedBy: string;
  sourceHash: string;
  sourceType: QueryIsolationSourceType;
  normalizedTarget: string;
  analysisVocabularyVersion: string | null;
  identity: QueryIsolationProviderIdentityV1;
  cacheKey: string;
  rolloutStage: InstrumentIsolationRolloutStage;
  status: InstrumentIsolationStatus;
  externalId: string | null;
  targetKey: string | null;
  residualKey: string | null;
  failure: { code: InstrumentIsolationFailureCode; retryable: boolean } | null;
  attempts: number;
  maxAttempts: number;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstrumentIsolationSummaryV1 {
  schemaVersion: typeof QUERY_ISOLATION_SCHEMA_VERSION;
  kind: 'optional_instrument_isolation';
  label: 'Optional instrument isolation';
  id: string;
  jobId: string;
  requestedBy: string;
  target: string;
  analysisVocabularyVersion: string | null;
  identity: QueryIsolationProviderIdentityV1;
  rolloutStage: InstrumentIsolationRolloutStage;
  status: InstrumentIsolationSummaryStatus;
  output: { targetAvailable: boolean; residualAvailable: boolean };
  failure: { code: InstrumentIsolationFailureCode; retryable: boolean } | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  limitations: readonly string[];
}

export interface CreateInstrumentIsolationInputV1 {
  id?: string;
  jobId: string;
  requestedBy: string;
  sourceHash: string;
  sourceType: QueryIsolationSourceType;
  normalizedTarget: string;
  analysisVocabularyVersion: string | null;
  identity: QueryIsolationProviderIdentityV1;
  rolloutStage?: InstrumentIsolationRolloutStage;
  now?: Date;
}

export type InstrumentIsolationResourceErrorCode =
  | 'invalid_request'
  | 'job_not_found'
  | 'core_split_incomplete'
  | 'source_type_mismatch'
  | 'maximum_reached'
  | 'isolation_not_found'
  | 'invalid_transition';

export class InstrumentIsolationResourceError extends Error {
  constructor(
    readonly code: InstrumentIsolationResourceErrorCode,
    message: string
  ) {
    super(message);
  }
}

interface InstrumentIsolationRow {
  id: string;
  schema_version: string;
  job_id: string;
  requested_by: string;
  source_hash: string;
  source_type: QueryIsolationSourceType;
  normalized_target: string;
  analysis_vocabulary_version: string;
  provider: string;
  provider_model: string;
  provider_version: string;
  provider_contract_version: string;
  cache_key: string;
  rollout_stage: InstrumentIsolationRolloutStage;
  status: InstrumentIsolationStatus;
  external_id: string | null;
  target_key: string | null;
  residual_key: string | null;
  failure_code: InstrumentIsolationFailureCode | null;
  failure_retryable: number | null;
  attempts: number;
  max_attempts: number;
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CoreJobRow {
  id: string;
  status: string;
  source_type: string | null;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_USERNAME_PATTERN = /^[a-z0-9._-]{1,64}$/i;
const SAFE_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_STORAGE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const LIMITATIONS = Object.freeze([
  'This output was independently queried and is not part of the core stem set.',
  'It may overlap other outputs and is not guaranteed to reconstruct the original mixture.',
]);

function validIsoDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid isolation timestamp');
  }
  return value.toISOString();
}

function validateId(value: string, field: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new InstrumentIsolationResourceError('invalid_request', `Invalid ${field}`);
  }
}

function validateStorageKey(id: string, value: string, field: string): void {
  const requiredPrefix = `isolations/${id}/`;
  if (
    value.length < 1 ||
    value.length > 512 ||
    !value.startsWith(requiredPrefix) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    SAFE_STORAGE_CONTROL_PATTERN.test(value)
  ) {
    throw new InstrumentIsolationResourceError('invalid_request', `Invalid ${field}`);
  }
}

function recordFromRow(row: InstrumentIsolationRow): InstrumentIsolationRecordV1 {
  if (row.schema_version !== QUERY_ISOLATION_SCHEMA_VERSION) {
    throw new InstrumentIsolationResourceError(
      'invalid_request',
      'Unsupported stored query-isolation schema version'
    );
  }
  return {
    schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
    id: row.id,
    jobId: row.job_id,
    requestedBy: row.requested_by,
    sourceHash: row.source_hash,
    sourceType: row.source_type,
    normalizedTarget: row.normalized_target,
    analysisVocabularyVersion: row.analysis_vocabulary_version || null,
    identity: {
      provider: row.provider,
      model: row.provider_model,
      version: row.provider_version,
      contractVersion: row.provider_contract_version,
    },
    cacheKey: row.cache_key,
    rolloutStage: row.rollout_stage,
    status: row.status,
    externalId: row.external_id,
    targetKey: row.target_key,
    residualKey: row.residual_key,
    failure: row.failure_code
      ? { code: row.failure_code, retryable: row.failure_retryable === 1 }
      : null,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function summarizeInstrumentIsolation(
  record: InstrumentIsolationRecordV1
): InstrumentIsolationSummaryV1 {
  return {
    schemaVersion: record.schemaVersion,
    kind: 'optional_instrument_isolation',
    label: 'Optional instrument isolation',
    id: record.id,
    jobId: record.jobId,
    requestedBy: record.requestedBy,
    target: record.normalizedTarget,
    analysisVocabularyVersion: record.analysisVocabularyVersion,
    identity: record.identity,
    rolloutStage: record.rolloutStage,
    status: record.rolloutStage === 'shadow' ? 'shadowed' : record.status,
    output: {
      targetAvailable: record.targetKey !== null,
      residualAvailable: record.residualKey !== null,
    },
    failure: record.failure,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    limitations: LIMITATIONS,
  };
}

export async function getInstrumentIsolation(
  env: Pick<Env, 'DB'>,
  id: string
): Promise<InstrumentIsolationRecordV1 | null> {
  const row = await env.DB.prepare('SELECT * FROM instrument_isolations WHERE id = ?')
    .bind(id)
    .first<InstrumentIsolationRow>();
  return row ? recordFromRow(row) : null;
}

export async function listInstrumentIsolations(
  env: Pick<Env, 'DB'>,
  jobId: string
): Promise<InstrumentIsolationRecordV1[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM instrument_isolations
     WHERE job_id = ? ORDER BY created_at DESC, id DESC`
  )
    .bind(jobId)
    .all<InstrumentIsolationRow>();
  return (results ?? []).map(recordFromRow);
}

export async function createInstrumentIsolation(
  env: Pick<Env, 'DB'>,
  input: CreateInstrumentIsolationInputV1
): Promise<{ record: InstrumentIsolationRecordV1; created: boolean }> {
  const id = input.id ?? crypto.randomUUID();
  validateId(id, 'isolation id');
  validateId(input.jobId, 'job id');
  if (!SAFE_USERNAME_PATTERN.test(input.requestedBy)) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid requesting teacher');
  }
  if (!['upload', 'youtube', 'archive'].includes(input.sourceType)) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid source type');
  }
  if (normalizeIsolationTarget(input.normalizedTarget) !== input.normalizedTarget) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Isolation target is not canonical');
  }
  validateQueryIsolationCacheMaterial(input);
  validateQueryIsolationProviderIdentity(input.identity);
  const rolloutStage = input.rolloutStage ?? 'shadow';
  if (rolloutStage !== 'shadow' && rolloutStage !== 'teacher_beta') {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid isolation rollout stage');
  }
  const now = validIsoDate(input.now ?? new Date());
  const cacheKey = await queryIsolationCacheKeyForMaterial(input, input.identity);

  const inserted = await env.DB.prepare(
    `INSERT INTO instrument_isolations
      (id, job_id, requested_by, source_hash, source_type, normalized_target,
       analysis_vocabulary_version, provider, provider_model, provider_version,
       provider_contract_version, cache_key, rollout_stage, status, max_attempts,
       created_at, updated_at)
     SELECT ?, jobs.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?
     FROM jobs
     WHERE jobs.id = ?
       AND jobs.status = 'done'
       AND (jobs.source_type IS NULL OR jobs.source_type = ?)
       AND (
         SELECT COUNT(*) FROM instrument_isolations existing
         WHERE existing.job_id = jobs.id
       ) < ?
     ON CONFLICT(job_id, cache_key) DO NOTHING`
  )
    .bind(
      id,
      input.requestedBy,
      input.sourceHash,
      input.sourceType,
      input.normalizedTarget,
      input.analysisVocabularyVersion ?? '',
      input.identity.provider,
      input.identity.model,
      input.identity.version,
      input.identity.contractVersion,
      cacheKey,
      rolloutStage,
      MAX_QUERY_ISOLATION_ATTEMPTS,
      now,
      now,
      input.jobId,
      input.sourceType,
      MAX_QUERY_ISOLATIONS_PER_JOB
    )
    .run();

  const existing = await env.DB.prepare(
    'SELECT * FROM instrument_isolations WHERE job_id = ? AND cache_key = ?'
  )
    .bind(input.jobId, cacheKey)
    .first<InstrumentIsolationRow>();
  if (existing) return { record: recordFromRow(existing), created: inserted.meta.changes === 1 };

  const job = await env.DB.prepare('SELECT id, status, source_type FROM jobs WHERE id = ?')
    .bind(input.jobId)
    .first<CoreJobRow>();
  if (!job) {
    throw new InstrumentIsolationResourceError('job_not_found', 'Core split job not found');
  }
  if (job.status !== 'done') {
    throw new InstrumentIsolationResourceError(
      'core_split_incomplete',
      'The core split must finish before optional isolation'
    );
  }
  if (job.source_type && job.source_type !== input.sourceType) {
    throw new InstrumentIsolationResourceError(
      'source_type_mismatch',
      'Isolation source type does not match the core job'
    );
  }
  throw new InstrumentIsolationResourceError(
    'maximum_reached',
    `This track already has ${MAX_QUERY_ISOLATIONS_PER_JOB} optional isolations`
  );
}

async function requireIsolation(
  env: Pick<Env, 'DB'>,
  id: string,
  message: string
): Promise<InstrumentIsolationRecordV1> {
  const record = await getInstrumentIsolation(env, id);
  if (!record) {
    throw new InstrumentIsolationResourceError('isolation_not_found', 'Isolation not found');
  }
  throw new InstrumentIsolationResourceError('invalid_transition', message);
}

export async function claimInstrumentIsolation(
  env: Pick<Env, 'DB'>,
  id: string,
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  const startedAt = validIsoDate(now);
  const deadlineAt = validIsoDate(new Date(now.getTime() + QUERY_ISOLATION_ATTEMPT_TIMEOUT_MS));
  const result = await env.DB.prepare(
    `UPDATE instrument_isolations
     SET status = 'processing', attempts = attempts + 1, deadline_at = ?,
         failure_code = NULL, failure_retryable = NULL, updated_at = ?
     WHERE id = ? AND rollout_stage = 'teacher_beta'
       AND status = 'queued' AND attempts < max_attempts
       AND NOT EXISTS (
         SELECT 1 FROM instrument_isolations active
         WHERE active.job_id = instrument_isolations.job_id
           AND active.status = 'processing' AND active.id <> instrument_isolations.id
       )`
  )
    .bind(deadlineAt, startedAt, id)
    .run();
  if (result.meta.changes !== 1) {
    return requireIsolation(env, id, 'Isolation is not claimable or this track is already active');
  }
  return (await getInstrumentIsolation(env, id))!;
}

export async function attachInstrumentIsolationExternalId(
  env: Pick<Env, 'DB'>,
  id: string,
  externalId: string,
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  if (!SAFE_EXTERNAL_ID_PATTERN.test(externalId)) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid provider prediction id');
  }
  const result = await env.DB.prepare(
    `UPDATE instrument_isolations SET external_id = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'
       AND (external_id IS NULL OR external_id = ?)`
  )
    .bind(externalId, validIsoDate(now), id, externalId)
    .run();
  if (result.meta.changes !== 1) {
    return requireIsolation(env, id, 'Isolation cannot accept this provider prediction id');
  }
  return (await getInstrumentIsolation(env, id))!;
}

export async function completeInstrumentIsolation(
  env: Pick<Env, 'DB'>,
  id: string,
  targetKey: string,
  residualKey: string | null = null,
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  validateStorageKey(id, targetKey, 'target storage key');
  if (residualKey !== null) validateStorageKey(id, residualKey, 'residual storage key');
  const result = await env.DB.prepare(
    `UPDATE instrument_isolations
     SET status = 'succeeded', target_key = ?, residual_key = ?, deadline_at = NULL,
         failure_code = NULL, failure_retryable = NULL, updated_at = ?
     WHERE id = ? AND status = 'processing'`
  )
    .bind(targetKey, residualKey, validIsoDate(now), id)
    .run();
  if (result.meta.changes !== 1) {
    return requireIsolation(env, id, 'Isolation is not processing');
  }
  return (await getInstrumentIsolation(env, id))!;
}

export async function failInstrumentIsolation(
  env: Pick<Env, 'DB'>,
  id: string,
  failure: { code: InstrumentIsolationFailureCode; retryable: boolean },
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  const allowed: InstrumentIsolationFailureCode[] = [
    'provider_failed',
    'provider_canceled',
    'invalid_provider_response',
    'timed_out',
  ];
  if (!allowed.includes(failure.code)) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid isolation failure code');
  }
  const result = await env.DB.prepare(
    `UPDATE instrument_isolations
     SET status = 'failed', failure_code = ?, failure_retryable = ?, deadline_at = NULL,
         updated_at = ?
     WHERE id = ? AND status = 'processing'`
  )
    .bind(failure.code, failure.retryable ? 1 : 0, validIsoDate(now), id)
    .run();
  if (result.meta.changes !== 1) {
    return requireIsolation(env, id, 'Isolation is not processing');
  }
  return (await getInstrumentIsolation(env, id))!;
}

export async function requeueInstrumentIsolation(
  env: Pick<Env, 'DB'>,
  id: string,
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  const result = await env.DB.prepare(
    `UPDATE instrument_isolations
     SET status = 'queued', external_id = NULL, failure_code = NULL,
         failure_retryable = NULL, deadline_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'failed' AND failure_retryable = 1
       AND attempts < max_attempts`
  )
    .bind(validIsoDate(now), id)
    .run();
  if (result.meta.changes !== 1) {
    return requireIsolation(env, id, 'Isolation cannot be retried');
  }
  return (await getInstrumentIsolation(env, id))!;
}

export async function expireTimedOutInstrumentIsolations(
  env: Pick<Env, 'DB'>,
  now = new Date()
): Promise<number> {
  const timestamp = validIsoDate(now);
  const result = await env.DB.prepare(
    `UPDATE instrument_isolations
     SET status = 'failed', failure_code = 'timed_out', failure_retryable = 1,
         deadline_at = NULL, updated_at = ?
     WHERE status = 'processing' AND deadline_at <= ?`
  )
    .bind(timestamp, timestamp)
    .run();
  return result.meta.changes;
}
