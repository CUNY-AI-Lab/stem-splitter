import type { Env } from '../env.ts';
import {
  claimInstrumentIsolationIngestion,
  completeInstrumentIsolationIngestion,
  failInstrumentIsolationIngestion,
  releaseInstrumentIsolationIngestion,
} from './ingestion.ts';
import {
  discardQueryIsolationOutput,
  hydrateQueryIsolationOutput,
  QueryIsolationOutputError,
  type StoredQueryIsolationOutputV1,
} from './output.ts';
import {
  getInstrumentIsolation,
  InstrumentIsolationResourceError,
  type InstrumentIsolationRecordV1,
} from './resource.ts';
import { discardQueryIsolationSpendSource } from './source.ts';
import {
  QUERY_ISOLATION_SCHEMA_VERSION,
  type QueryIsolationResultV1,
} from './types.ts';

export class QueryIsolationTerminalIngestionError extends Error {
  readonly retryable: boolean;

  constructor(
    retryable: boolean,
    message: string
  ) {
    super(message);
    this.retryable = retryable;
  }
}

export interface QueryIsolationTerminalIngestionOutcomeV1 {
  record: InstrumentIsolationRecordV1;
  ingested: boolean;
  sourceCleanupPending: boolean;
}

function validateResult(result: QueryIsolationResultV1): void {
  if (result.schemaVersion !== QUERY_ISOLATION_SCHEMA_VERSION) {
    throw new InstrumentIsolationResourceError(
      'invalid_request',
      'Unsupported query-isolation result version'
    );
  }
  if (result.status === 'processing') {
    if (
      result.targetUrl !== undefined ||
      result.residualUrl !== undefined ||
      result.failure !== undefined
    ) {
      throw new InstrumentIsolationResourceError(
        'invalid_request',
        'Processing isolation result contains terminal fields'
      );
    }
    return;
  }
  if (result.status === 'succeeded') {
    if (typeof result.targetUrl !== 'string' || result.failure !== undefined) {
      throw new InstrumentIsolationResourceError(
        'invalid_request',
        'Successful isolation result is incomplete'
      );
    }
    if (result.residualUrl !== undefined && typeof result.residualUrl !== 'string') {
      throw new InstrumentIsolationResourceError(
        'invalid_request',
        'Successful isolation residual is invalid'
      );
    }
    return;
  }
  if (
    result.status !== 'failed' ||
    result.targetUrl !== undefined ||
    result.residualUrl !== undefined ||
    !result.failure ||
    ![
      'provider_failed',
      'provider_canceled',
      'invalid_provider_response',
    ].includes(result.failure.code) ||
    typeof result.failure.retryable !== 'boolean'
  ) {
    throw new InstrumentIsolationResourceError(
      'invalid_request',
      'Failed isolation result is invalid'
    );
  }
}

async function discardOutputs(
  env: Pick<Env, 'AUDIO'>,
  outputs: StoredQueryIsolationOutputV1[]
): Promise<void> {
  await Promise.allSettled(
    outputs.map((output) => discardQueryIsolationOutput(env, output.storageKey))
  );
}

async function discardSourceSnapshot(
  env: Pick<Env, 'AUDIO'>,
  record: InstrumentIsolationRecordV1
): Promise<boolean> {
  try {
    await discardQueryIsolationSpendSource(
      env,
      `isolation-inputs/v1/${record.id}/${record.sourceHash}`
    );
    return false;
  } catch {
    return true;
  }
}

/**
 * Compose a parsed terminal provider result into durable app-owned state.
 * No app route imports this module while query isolation remains shadow-only.
 */
export async function ingestQueryIsolationProviderResult(
  env: Pick<Env, 'DB' | 'AUDIO'>,
  isolationId: string,
  externalId: string,
  result: QueryIsolationResultV1,
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    outputMaximumBytes?: number;
    outputTimeoutMs?: number;
    outputMaximumAttempts?: number;
  } = {}
): Promise<QueryIsolationTerminalIngestionOutcomeV1> {
  validateResult(result);
  const existing = await getInstrumentIsolation(env, isolationId);
  if (!existing) {
    throw new InstrumentIsolationResourceError('isolation_not_found', 'Isolation not found');
  }
  if (existing.externalId !== externalId) {
    throw new InstrumentIsolationResourceError(
      'provider_identity_mismatch',
      'Provider prediction does not match this isolation'
    );
  }
  if (existing.status === 'succeeded' || existing.status === 'failed') {
    return {
      record: existing,
      ingested: false,
      sourceCleanupPending: await discardSourceSnapshot(env, existing),
    };
  }
  if (result.status === 'processing') {
    return { record: existing, ingested: false, sourceCleanupPending: false };
  }

  let lease: Awaited<ReturnType<typeof claimInstrumentIsolationIngestion>>;
  try {
    lease = await claimInstrumentIsolationIngestion(env, isolationId, externalId, {
      now: options.now,
    });
  } catch (error) {
    if (
      error instanceof InstrumentIsolationResourceError &&
      error.code === 'ingestion_attempts_exhausted'
    ) {
      const exhausted = await getInstrumentIsolation(env, isolationId);
      if (
        exhausted?.status === 'failed' &&
        exhausted.failure?.code === 'output_ingestion_failed'
      ) {
        return {
          record: exhausted,
          ingested: true,
          sourceCleanupPending: await discardSourceSnapshot(env, exhausted),
        };
      }
    }
    throw error;
  }
  if (result.status === 'failed') {
    const record = await failInstrumentIsolationIngestion(
      env,
      lease,
      {
        code: result.failure!.code,
        retryable: result.failure!.retryable,
      },
      options.now
    );
    return {
      record,
      ingested: true,
      sourceCleanupPending: await discardSourceSnapshot(env, record),
    };
  }

  const stored: StoredQueryIsolationOutputV1[] = [];
  try {
    stored.push(
      await hydrateQueryIsolationOutput(
        env,
        { isolationId, kind: 'target', outputUrl: result.targetUrl! },
        {
          fetchImpl: options.fetchImpl,
          maximumBytes: options.outputMaximumBytes,
          timeoutMs: options.outputTimeoutMs,
          maximumAttempts: options.outputMaximumAttempts,
        }
      )
    );
    if (result.residualUrl) {
      stored.push(
        await hydrateQueryIsolationOutput(
          env,
          { isolationId, kind: 'residual', outputUrl: result.residualUrl },
          {
            fetchImpl: options.fetchImpl,
            maximumBytes: options.outputMaximumBytes,
            timeoutMs: options.outputTimeoutMs,
            maximumAttempts: options.outputMaximumAttempts,
          }
        )
      );
    }
    const record = await completeInstrumentIsolationIngestion(
      env,
      lease,
      { target: stored[0], residual: stored[1] ?? null },
      options.now
    );
    return {
      record,
      ingested: true,
      sourceCleanupPending: await discardSourceSnapshot(env, record),
    };
  } catch (error) {
    const current = await getInstrumentIsolation(env, isolationId);
    if (current?.status === 'succeeded') {
      return {
        record: current,
        ingested: false,
        sourceCleanupPending: await discardSourceSnapshot(env, current),
      };
    }
    await discardOutputs(env, stored);
    if (error instanceof QueryIsolationOutputError && !error.retryable) {
      const record = await failInstrumentIsolationIngestion(
        env,
        lease,
        { code: 'output_ingestion_failed', retryable: false },
        options.now
      );
      return {
        record,
        ingested: true,
        sourceCleanupPending: await discardSourceSnapshot(env, record),
      };
    }
    try {
      await releaseInstrumentIsolationIngestion(env, lease, options.now);
    } catch {
      // Preserve the original app-owned failure. The bounded lease can expire
      // and be reclaimed even if this best-effort release loses a DB outage.
    }
    throw new QueryIsolationTerminalIngestionError(
      true,
      'The optional isolation output could not be ingested.'
    );
  }
}
