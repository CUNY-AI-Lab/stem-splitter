import type { Env } from '../env';
import { readBoundedResponse } from '../http/bounded-response.ts';
import {
  getRetainedAudio,
  isAuthoritativeAutoSourceKey,
  presignIsolationDownload,
} from '../r2.ts';

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const SOURCE_READ_TIMEOUT_MS = 60_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SNAPSHOT_KEY_PATTERN =
  /^isolation-inputs\/v1\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[0-9a-f]{64}$/;

export type QueryIsolationSourceErrorCode =
  | 'invalid_request'
  | 'source_unavailable'
  | 'source_too_large'
  | 'source_identity_mismatch'
  | 'snapshot_failed';

export class QueryIsolationSourceError extends Error {
  readonly code: QueryIsolationSourceErrorCode;

  constructor(
    code: QueryIsolationSourceErrorCode,
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

export interface QueryIsolationSpendSource {
  /** Internal storage locator. Never include it in teacher or student JSON. */
  snapshotKey: string;
  /** Fresh, short-lived URL for the provider's next request only. */
  sourceUrl: string;
  sourceHash: string;
  bytes: number;
  replacedExistingSnapshot: boolean;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function validateInput(input: {
  isolationId: string;
  sourceKey: string;
  expectedSourceHash: string;
  nowMs?: number;
}): void {
  if (!SAFE_ID_PATTERN.test(input.isolationId)) {
    throw new QueryIsolationSourceError('invalid_request', 'Invalid isolation id');
  }
  if (
    (!input.sourceKey.startsWith('uploads/') &&
      !isAuthoritativeAutoSourceKey(input.sourceKey)) ||
    input.sourceKey.length > 512 ||
    /[\0\r\n]/.test(input.sourceKey)
  ) {
    throw new QueryIsolationSourceError('invalid_request', 'Invalid stored source key');
  }
  if (!SOURCE_HASH_PATTERN.test(input.expectedSourceHash)) {
    throw new QueryIsolationSourceError(
      'invalid_request',
      'Expected source identity must be a lowercase SHA-256 digest'
    );
  }
  if (
    input.nowMs !== undefined &&
    (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
  ) {
    throw new QueryIsolationSourceError('invalid_request', 'Invalid isolation source timestamp');
  }
}

/**
 * Build the only source URL a paid isolation provider may consume.
 *
 * The source object is read and fingerprinted again at this boundary. The
 * exact verified bytes are then copied to an app-owned key that browser upload
 * routes cannot address. A still-live PUT can therefore alter an ordinary
 * upload either before or after this function, but it cannot substitute
 * different bytes for the provider: an earlier change fails the digest
 * comparison, while a later change is isolated from the snapshot. An
 * authoritative Auto source is already app-owned, but still crosses this
 * independent hash-and-copy boundary before optional spend.
 *
 * Call this immediately before `provider.start()`. Preparing a URL earlier and
 * retaining it for later spend defeats the short-lived transport boundary.
 */
export async function prepareQueryIsolationSpendSource(
  env: Env,
  input: {
    isolationId: string;
    sourceKey: string;
    expectedSourceHash: string;
    /** Test seam for the local 30-day retention boundary. */
    nowMs?: number;
  }
): Promise<QueryIsolationSpendSource> {
  validateInput(input);

  let source: R2ObjectBody | null;
  try {
    source = await getRetainedAudio(env, input.sourceKey, input.nowMs);
  } catch {
    throw new QueryIsolationSourceError(
      'source_unavailable',
      'The stored source could not be read'
    );
  }
  if (!source) {
    throw new QueryIsolationSourceError(
      'source_unavailable',
      'The stored source is missing or has expired'
    );
  }
  if (source.size <= 0 || source.size > MAX_SOURCE_BYTES) {
    throw new QueryIsolationSourceError(
      'source_too_large',
      'The stored source is outside the supported size boundary'
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await readBoundedResponse(
      new Response(source.body, {
        headers: { 'Content-Length': String(source.size) },
      }),
      {
        maximumBytes: source.size,
        timeoutMs: SOURCE_READ_TIMEOUT_MS,
        errors: {
          tooLarge: () =>
            new QueryIsolationSourceError(
              'source_unavailable',
              'The stored source exceeded its recorded size while being read'
            ),
          timedOut: () =>
            new QueryIsolationSourceError(
              'source_unavailable',
              'The stored source did not finish reading in time'
            ),
          unreadable: () =>
            new QueryIsolationSourceError(
              'source_unavailable',
              'The stored source could not be read'
            ),
        },
      }
    );
  } catch (error) {
    if (error instanceof QueryIsolationSourceError) throw error;
    throw new QueryIsolationSourceError(
      'source_unavailable',
      'The stored source could not be read'
    );
  }
  if (bytes.byteLength !== source.size) {
    throw new QueryIsolationSourceError(
      'source_unavailable',
      'The stored source changed while it was being read'
    );
  }

  const actualSourceHash = await sha256Hex(bytes);
  if (actualSourceHash !== input.expectedSourceHash) {
    throw new QueryIsolationSourceError(
      'source_identity_mismatch',
      'The stored source no longer matches the completed core split'
    );
  }

  const snapshotKey =
    `isolation-inputs/v1/${input.isolationId}/${input.expectedSourceHash}`;
  let replacedExistingSnapshot: boolean;
  try {
    replacedExistingSnapshot = Boolean(await env.AUDIO.head(snapshotKey));
  } catch {
    throw new QueryIsolationSourceError(
      'snapshot_failed',
      'The verified isolation source snapshot could not be inspected'
    );
  }
  try {
    const stored = await env.AUDIO.put(snapshotKey, bytes, {
      httpMetadata: {
        contentType: source.httpMetadata?.contentType ?? 'application/octet-stream',
      },
      customMetadata: {
        purpose: 'query-isolation-input-v1',
        sourceSha256: input.expectedSourceHash,
      },
    });
    if (!stored || stored.size !== bytes.byteLength) {
      if (!replacedExistingSnapshot) await env.AUDIO.delete(snapshotKey);
      throw new QueryIsolationSourceError(
        'snapshot_failed',
        'The verified isolation source snapshot could not be stored'
      );
    }
  } catch (error) {
    if (error instanceof QueryIsolationSourceError) throw error;
    throw new QueryIsolationSourceError(
      'snapshot_failed',
      'The verified isolation source snapshot could not be stored'
    );
  }

  let sourceUrl: string;
  try {
    sourceUrl = await presignIsolationDownload(env, snapshotKey);
  } catch {
    throw new QueryIsolationSourceError(
      'snapshot_failed',
      'The verified isolation source snapshot could not be signed'
    );
  }

  return {
    snapshotKey,
    sourceUrl,
    sourceHash: actualSourceHash,
    bytes: bytes.byteLength,
    replacedExistingSnapshot,
  };
}

/** Remove a provider input after a failed start or terminal provider result. */
export async function discardQueryIsolationSpendSource(
  env: Pick<Env, 'AUDIO'>,
  snapshotKey: string
): Promise<void> {
  if (!SNAPSHOT_KEY_PATTERN.test(snapshotKey)) {
    throw new QueryIsolationSourceError('invalid_request', 'Invalid isolation source snapshot key');
  }
  await env.AUDIO.delete(snapshotKey);
}
