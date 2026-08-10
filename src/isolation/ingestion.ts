import type { Env } from '../env.ts';
import {
  QUERY_ISOLATION_ATTEMPT_TIMEOUT_MS,
  getInstrumentIsolation,
  InstrumentIsolationResourceError,
  type InstrumentIsolationFailureCode,
  type InstrumentIsolationRecordV1,
} from './resource.ts';
import {
  validateStoredQueryIsolationOutput,
  type QueryIsolationOutputKind,
  type StoredQueryIsolationOutputV1,
} from './output.ts';

export const QUERY_ISOLATION_INGESTION_LEASE_MS = 5 * 60 * 1000;
export const MAX_QUERY_ISOLATION_INGESTION_ATTEMPTS = 3;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface InstrumentIsolationIngestionLeaseV1 {
  isolationId: string;
  externalId: string;
  leaseId: string;
  leaseExpiresAt: string;
  attempts: number;
  maxAttempts: typeof MAX_QUERY_ISOLATION_INGESTION_ATTEMPTS;
}

interface IngestionLeaseRow {
  isolation_id: string;
  external_id: string;
  lease_id: string | null;
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
}

interface OutputRow {
  isolation_id: string;
  kind: QueryIsolationOutputKind;
  storage_key: string;
  sha256: string;
  bytes: number;
  content_type: 'audio/wav';
  retained_until: string;
  created_at: string;
}

function validIsoDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid ingestion timestamp');
  }
  return value.toISOString();
}

function validateIdentity(id: string, externalId: string, leaseId?: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid isolation id');
  }
  if (!SAFE_EXTERNAL_ID_PATTERN.test(externalId)) {
    throw new InstrumentIsolationResourceError(
      'invalid_request',
      'Invalid provider prediction id'
    );
  }
  if (leaseId !== undefined && !SAFE_EXTERNAL_ID_PATTERN.test(leaseId)) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid ingestion lease id');
  }
}

function leaseFromRow(row: IngestionLeaseRow): InstrumentIsolationIngestionLeaseV1 {
  const leaseExpiresAt = Date.parse(row.lease_expires_at ?? '');
  if (
    !SAFE_ID_PATTERN.test(row.isolation_id) ||
    !SAFE_EXTERNAL_ID_PATTERN.test(row.external_id) ||
    !row.lease_id ||
    !SAFE_EXTERNAL_ID_PATTERN.test(row.lease_id) ||
    !row.lease_expires_at ||
    !Number.isFinite(leaseExpiresAt) ||
    new Date(leaseExpiresAt).toISOString() !== row.lease_expires_at ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 1 ||
    row.attempts > MAX_QUERY_ISOLATION_INGESTION_ATTEMPTS ||
    row.max_attempts !== MAX_QUERY_ISOLATION_INGESTION_ATTEMPTS
  ) {
    throw new InstrumentIsolationResourceError(
      'invalid_transition',
      'Stored isolation ingestion lease is invalid'
    );
  }
  return {
    isolationId: row.isolation_id,
    externalId: row.external_id,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    maxAttempts: MAX_QUERY_ISOLATION_INGESTION_ATTEMPTS,
  };
}

async function readLease(
  env: Pick<Env, 'DB'>,
  isolationId: string
): Promise<IngestionLeaseRow | null> {
  return env.DB.prepare(
    'SELECT * FROM instrument_isolation_ingestion_leases WHERE isolation_id = ?'
  )
    .bind(isolationId)
    .first<IngestionLeaseRow>();
}

export async function claimInstrumentIsolationIngestion(
  env: Pick<Env, 'DB'>,
  isolationId: string,
  externalId: string,
  options: { leaseId?: string; now?: Date } = {}
): Promise<InstrumentIsolationIngestionLeaseV1> {
  const leaseId = options.leaseId ?? crypto.randomUUID();
  validateIdentity(isolationId, externalId, leaseId);
  const now = options.now ?? new Date();
  const nowIso = validIsoDate(now);
  const leaseExpiresAt = validIsoDate(
    new Date(now.getTime() + QUERY_ISOLATION_INGESTION_LEASE_MS)
  );
  const results = (await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instrument_isolation_ingestion_leases
        (isolation_id, external_id, lease_id, lease_expires_at, attempts,
         max_attempts, created_at, updated_at)
       SELECT candidate.id, candidate.external_id, ?, ?, 1, ?, ?, ?
       FROM instrument_isolations candidate
       WHERE candidate.id = ?
         AND candidate.rollout_stage = 'teacher_beta'
         AND candidate.status = 'processing'
         AND candidate.external_id = ?
       ON CONFLICT(isolation_id) DO UPDATE SET
         external_id = excluded.external_id,
         lease_id = excluded.lease_id,
         lease_expires_at = excluded.lease_expires_at,
         attempts = instrument_isolation_ingestion_leases.attempts + 1,
         updated_at = excluded.updated_at
       WHERE instrument_isolation_ingestion_leases.external_id = excluded.external_id
         AND instrument_isolation_ingestion_leases.attempts <
             instrument_isolation_ingestion_leases.max_attempts
         AND (
           instrument_isolation_ingestion_leases.lease_id IS NULL
           OR instrument_isolation_ingestion_leases.lease_expires_at <= excluded.updated_at
         )`
    ).bind(
      leaseId,
      leaseExpiresAt,
      MAX_QUERY_ISOLATION_INGESTION_ATTEMPTS,
      nowIso,
      nowIso,
      isolationId,
      externalId
    ),
    env.DB.prepare(
      `UPDATE instrument_isolations
       SET status = 'failed', failure_code = 'output_ingestion_failed',
           failure_retryable = 0, deadline_at = NULL, updated_at = ?
       WHERE id = ? AND rollout_stage = 'teacher_beta'
         AND status = 'processing' AND external_id = ?
         AND EXISTS (
           SELECT 1 FROM instrument_isolation_ingestion_leases exhausted
           WHERE exhausted.isolation_id = instrument_isolations.id
             AND exhausted.external_id = instrument_isolations.external_id
             AND exhausted.attempts >= exhausted.max_attempts
             AND (
               exhausted.lease_id IS NULL
               OR exhausted.lease_expires_at <= ?
             )
         )`
    ).bind(nowIso, isolationId, externalId, nowIso),
    env.DB.prepare(
      `DELETE FROM instrument_isolation_ingestion_leases
       WHERE isolation_id = ? AND external_id = ?
         AND EXISTS (
           SELECT 1 FROM instrument_isolations terminal
           WHERE terminal.id = instrument_isolation_ingestion_leases.isolation_id
             AND terminal.status = 'failed'
             AND terminal.failure_code = 'output_ingestion_failed'
         )`
    ).bind(isolationId, externalId),
  ])) as Array<{ meta: { changes: number } }>;

  if (results[0]?.meta.changes === 1) {
    const row = await readLease(env, isolationId);
    if (row?.lease_id !== leaseId) {
      throw new InstrumentIsolationResourceError(
        'invalid_transition',
        'Isolation ingestion lease could not be read back'
      );
    }
    return leaseFromRow(row);
  }
  if (results[1]?.meta.changes === 1) {
    throw new InstrumentIsolationResourceError(
      'ingestion_attempts_exhausted',
      'The optional isolation output could not be ingested after three attempts'
    );
  }

  const record = await getInstrumentIsolation(env, isolationId);
  if (!record) {
    throw new InstrumentIsolationResourceError('isolation_not_found', 'Isolation not found');
  }
  if (record.externalId !== externalId) {
    throw new InstrumentIsolationResourceError(
      'provider_identity_mismatch',
      'Provider prediction does not match this isolation'
    );
  }
  const existing = await readLease(env, isolationId);
  if (existing?.lease_id && Date.parse(existing.lease_expires_at ?? '') > now.getTime()) {
    throw new InstrumentIsolationResourceError(
      'ingestion_busy',
      'This optional isolation output is already being ingested'
    );
  }
  throw new InstrumentIsolationResourceError(
    'invalid_transition',
    'Isolation cannot accept this provider result'
  );
}

export async function releaseInstrumentIsolationIngestion(
  env: Pick<Env, 'DB'>,
  lease: InstrumentIsolationIngestionLeaseV1,
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  validateIdentity(lease.isolationId, lease.externalId, lease.leaseId);
  const nowIso = validIsoDate(now);
  const retryDeadline = validIsoDate(
    new Date(now.getTime() + QUERY_ISOLATION_ATTEMPT_TIMEOUT_MS)
  );
  const results = (await env.DB.batch([
    env.DB.prepare(
      `UPDATE instrument_isolation_ingestion_leases
       SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE isolation_id = ? AND external_id = ? AND lease_id = ?`
    ).bind(nowIso, lease.isolationId, lease.externalId, lease.leaseId),
    env.DB.prepare(
      `UPDATE instrument_isolations SET deadline_at = ?, updated_at = ?
       WHERE id = ? AND status = 'processing' AND external_id = ?
         AND EXISTS (
           SELECT 1 FROM instrument_isolation_ingestion_leases released
           WHERE released.isolation_id = instrument_isolations.id
             AND released.external_id = instrument_isolations.external_id
             AND released.lease_id IS NULL
         )`
    ).bind(retryDeadline, nowIso, lease.isolationId, lease.externalId),
  ])) as Array<{ meta: { changes: number } }>;
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new InstrumentIsolationResourceError(
      'invalid_transition',
      'Isolation ingestion lease cannot be released'
    );
  }
  return (await getInstrumentIsolation(env, lease.isolationId))!;
}

function validateTerminalFailure(failure: {
  code: InstrumentIsolationFailureCode;
  retryable: boolean;
}): void {
  if (
    ![
      'provider_failed',
      'provider_canceled',
      'invalid_provider_response',
      'output_ingestion_failed',
    ].includes(failure.code)
  ) {
    throw new InstrumentIsolationResourceError(
      'invalid_request',
      'Invalid terminal isolation failure'
    );
  }
}

export async function failInstrumentIsolationIngestion(
  env: Pick<Env, 'DB'>,
  lease: InstrumentIsolationIngestionLeaseV1,
  failure: { code: InstrumentIsolationFailureCode; retryable: boolean },
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  validateIdentity(lease.isolationId, lease.externalId, lease.leaseId);
  validateTerminalFailure(failure);
  const nowIso = validIsoDate(now);
  const results = (await env.DB.batch([
    env.DB.prepare(
      `UPDATE instrument_isolations
       SET status = 'failed', failure_code = ?, failure_retryable = ?,
           deadline_at = NULL, updated_at = ?
       WHERE id = ? AND rollout_stage = 'teacher_beta'
         AND status = 'processing' AND external_id = ?
         AND EXISTS (
           SELECT 1 FROM instrument_isolation_ingestion_leases ingestion
           WHERE ingestion.isolation_id = instrument_isolations.id
             AND ingestion.external_id = instrument_isolations.external_id
             AND ingestion.lease_id = ?
         )`
    ).bind(
      failure.code,
      failure.retryable ? 1 : 0,
      nowIso,
      lease.isolationId,
      lease.externalId,
      lease.leaseId
    ),
    env.DB.prepare(
      `DELETE FROM instrument_isolation_ingestion_leases
       WHERE isolation_id = ? AND external_id = ? AND lease_id = ?
         AND EXISTS (
           SELECT 1 FROM instrument_isolations terminal
           WHERE terminal.id = instrument_isolation_ingestion_leases.isolation_id
             AND terminal.status = 'failed'
         )`
    ).bind(lease.isolationId, lease.externalId, lease.leaseId),
  ])) as Array<{ meta: { changes: number } }>;
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new InstrumentIsolationResourceError(
      'invalid_transition',
      'Isolation cannot accept this terminal provider failure'
    );
  }
  return (await getInstrumentIsolation(env, lease.isolationId))!;
}

function outputInsertStatement(
  env: Pick<Env, 'DB'>,
  lease: InstrumentIsolationIngestionLeaseV1,
  output: StoredQueryIsolationOutputV1
) {
  return env.DB.prepare(
    `INSERT INTO instrument_isolation_outputs
      (isolation_id, kind, storage_key, sha256, bytes, content_type,
       retained_until, created_at)
     SELECT candidate.id, ?, ?, ?, ?, ?, ?, ?
     FROM instrument_isolations candidate
     JOIN instrument_isolation_ingestion_leases ingestion
       ON ingestion.isolation_id = candidate.id
     WHERE candidate.id = ? AND candidate.rollout_stage = 'teacher_beta'
       AND candidate.status = 'processing' AND candidate.external_id = ?
       AND ingestion.external_id = candidate.external_id
       AND ingestion.lease_id = ?`
  ).bind(
    output.kind,
    output.storageKey,
    output.sha256,
    output.bytes,
    output.contentType,
    output.retainedUntil,
    output.createdAt,
    lease.isolationId,
    lease.externalId,
    lease.leaseId
  );
}

function outputExistsSql(kind: QueryIsolationOutputKind): string {
  return `EXISTS (
    SELECT 1 FROM instrument_isolation_outputs ${kind}_output
    WHERE ${kind}_output.isolation_id = instrument_isolations.id
      AND ${kind}_output.kind = '${kind}'
      AND ${kind}_output.storage_key = ?
      AND ${kind}_output.sha256 = ?
      AND ${kind}_output.bytes = ?
      AND ${kind}_output.content_type = ?
      AND ${kind}_output.retained_until = ?
      AND ${kind}_output.created_at = ?
  )`;
}

function outputIdentityBindings(output: StoredQueryIsolationOutputV1): unknown[] {
  return [
    output.storageKey,
    output.sha256,
    output.bytes,
    output.contentType,
    output.retainedUntil,
    output.createdAt,
  ];
}

export async function completeInstrumentIsolationIngestion(
  env: Pick<Env, 'DB'>,
  lease: InstrumentIsolationIngestionLeaseV1,
  outputs: {
    target: StoredQueryIsolationOutputV1;
    residual?: StoredQueryIsolationOutputV1 | null;
  },
  now = new Date()
): Promise<InstrumentIsolationRecordV1> {
  validateIdentity(lease.isolationId, lease.externalId, lease.leaseId);
  const target = validateStoredQueryIsolationOutput(
    outputs.target,
    lease.isolationId,
    'target'
  );
  const residual = outputs.residual
    ? validateStoredQueryIsolationOutput(outputs.residual, lease.isolationId, 'residual')
    : null;
  const nowIso = validIsoDate(now);
  const statements = [outputInsertStatement(env, lease, target)];
  if (residual) statements.push(outputInsertStatement(env, lease, residual));

  const completionConditions = [outputExistsSql('target')];
  const completionBindings: unknown[] = outputIdentityBindings(target);
  if (residual) {
    completionConditions.push(outputExistsSql('residual'));
    completionBindings.push(...outputIdentityBindings(residual));
  }
  statements.push(
    env.DB.prepare(
      `UPDATE instrument_isolations
       SET status = 'succeeded', target_key = ?, residual_key = ?,
           deadline_at = NULL, failure_code = NULL, failure_retryable = NULL,
           updated_at = ?
       WHERE id = ? AND rollout_stage = 'teacher_beta'
         AND status = 'processing' AND external_id = ?
         AND EXISTS (
           SELECT 1 FROM instrument_isolation_ingestion_leases ingestion
           WHERE ingestion.isolation_id = instrument_isolations.id
             AND ingestion.external_id = instrument_isolations.external_id
             AND ingestion.lease_id = ?
         )
         AND ${completionConditions.join('\n         AND ')}`
    ).bind(
      target.storageKey,
      residual?.storageKey ?? null,
      nowIso,
      lease.isolationId,
      lease.externalId,
      lease.leaseId,
      ...completionBindings
    ),
    env.DB.prepare(
      `DELETE FROM instrument_isolation_ingestion_leases
       WHERE isolation_id = ? AND external_id = ? AND lease_id = ?
         AND EXISTS (
           SELECT 1 FROM instrument_isolations terminal
           WHERE terminal.id = instrument_isolation_ingestion_leases.isolation_id
             AND terminal.status = 'succeeded'
             AND terminal.target_key = ?
         )`
    ).bind(lease.isolationId, lease.externalId, lease.leaseId, target.storageKey)
  );

  const results = (await env.DB.batch(statements)) as Array<{ meta: { changes: number } }>;
  const completionIndex = residual ? 2 : 1;
  const cleanupIndex = completionIndex + 1;
  if (
    results[completionIndex]?.meta.changes !== 1 ||
    results[cleanupIndex]?.meta.changes !== 1
  ) {
    throw new InstrumentIsolationResourceError(
      'invalid_transition',
      'Isolation output identity could not be finalized'
    );
  }
  return (await getInstrumentIsolation(env, lease.isolationId))!;
}

export async function getInstrumentIsolationOutputs(
  env: Pick<Env, 'DB'>,
  isolationId: string
): Promise<StoredQueryIsolationOutputV1[]> {
  if (!SAFE_ID_PATTERN.test(isolationId)) {
    throw new InstrumentIsolationResourceError('invalid_request', 'Invalid isolation id');
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM instrument_isolation_outputs
     WHERE isolation_id = ? ORDER BY kind`
  )
    .bind(isolationId)
    .all<OutputRow>();
  return (results ?? []).map((row) =>
    validateStoredQueryIsolationOutput(
      {
        isolationId: row.isolation_id,
        kind: row.kind,
        storageKey: row.storage_key,
        sha256: row.sha256,
        bytes: row.bytes,
        contentType: row.content_type,
        retainedUntil: row.retained_until,
        createdAt: row.created_at,
      },
      isolationId,
      row.kind
    )
  );
}
