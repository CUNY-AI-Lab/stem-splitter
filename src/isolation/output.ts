import type { Env } from '../env.ts';
import { readBoundedResponse, responseMediaType } from '../http/bounded-response.ts';

export const QUERY_ISOLATION_OUTPUT_MAX_BYTES = 100 * 1024 * 1024;
export const QUERY_ISOLATION_OUTPUT_TIMEOUT_MS = 60_000;
export const QUERY_ISOLATION_OUTPUT_MAX_DOWNLOAD_ATTEMPTS = 3;
export const QUERY_ISOLATION_OUTPUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OUTPUT_KEY_PATTERN =
  /^isolations\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(target|residual)\.wav$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_WAV_MEDIA_TYPES = new Set([
  '',
  'application/octet-stream',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
]);

export type QueryIsolationOutputKind = 'target' | 'residual';
export type QueryIsolationOutputErrorCode =
  | 'invalid_request'
  | 'unsafe_output_url'
  | 'download_failed'
  | 'output_too_large'
  | 'invalid_output_audio'
  | 'storage_failed';

export class QueryIsolationOutputError extends Error {
  readonly code: QueryIsolationOutputErrorCode;
  readonly retryable: boolean;

  constructor(
    code: QueryIsolationOutputErrorCode,
    retryable: boolean,
    message: string
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface StoredQueryIsolationOutputV1 {
  isolationId: string;
  kind: QueryIsolationOutputKind;
  storageKey: string;
  sha256: string;
  bytes: number;
  contentType: 'audio/wav';
  retainedUntil: string;
  createdAt: string;
}

interface HydrationOptions {
  fetchImpl?: typeof fetch;
  maximumBytes?: number;
  timeoutMs?: number;
  maximumAttempts?: number;
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  );
}

/**
 * Validate enough of a RIFF/WAVE container to reject HTML, truncation, empty
 * output, and unrelated RIFF payloads before the bytes become classroom data.
 */
export function isSupportedQueryIsolationWav(audio: ArrayBuffer): boolean {
  const bytes = new Uint8Array(audio);
  if (bytes.byteLength < 44 || fourCc(bytes, 0) !== 'RIFF' || fourCc(bytes, 8) !== 'WAVE') {
    return false;
  }
  const view = new DataView(audio);
  const declaredRiffBytes = view.getUint32(4, true) + 8;
  if (declaredRiffBytes < 44 || declaredRiffBytes !== bytes.byteLength) return false;

  let hasSupportedFormat = false;
  let supportedBlockAlign = 0;
  let audioDataBytes = 0;
  let offset = 12;
  for (; offset + 8 <= declaredRiffBytes;) {
    const chunkId = fourCc(bytes, offset);
    const chunkBytes = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkBytes;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > declaredRiffBytes) return false;

    if (chunkId === 'fmt ') {
      if (chunkBytes < 16) return false;
      const encoding = view.getUint16(dataOffset, true);
      const channels = view.getUint16(dataOffset + 2, true);
      const sampleRate = view.getUint32(dataOffset + 4, true);
      const byteRate = view.getUint32(dataOffset + 8, true);
      const blockAlign = view.getUint16(dataOffset + 12, true);
      const bitsPerSample = view.getUint16(dataOffset + 14, true);
      const supportedEncoding =
        (encoding === 1 && [8, 16, 24, 32].includes(bitsPerSample)) ||
        (encoding === 3 && [32, 64].includes(bitsPerSample));
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      hasSupportedFormat =
        supportedEncoding &&
        channels >= 1 &&
        channels <= 8 &&
        sampleRate >= 8_000 &&
        sampleRate <= 192_000 &&
        Number.isSafeInteger(expectedBlockAlign) &&
        blockAlign === expectedBlockAlign &&
        byteRate === sampleRate * blockAlign;
      if (!hasSupportedFormat) return false;
      supportedBlockAlign = blockAlign;
    } else if (chunkId === 'data') {
      audioDataBytes += chunkBytes;
    }

    const paddedBytes = chunkBytes + (chunkBytes % 2);
    if (dataOffset + paddedBytes > declaredRiffBytes) return false;
    offset = dataOffset + paddedBytes;
  }
  if (offset !== declaredRiffBytes) return false;
  return (
    hasSupportedFormat &&
    supportedBlockAlign > 0 &&
    audioDataBytes > 0 &&
    audioDataBytes % supportedBlockAlign === 0
  );
}

export function validatedQueryIsolationOutputUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QueryIsolationOutputError(
      'unsafe_output_url',
      false,
      'The optional isolation provider returned an unsafe output location.'
    );
  }
  const hostAllowed =
    url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !hostAllowed
  ) {
    throw new QueryIsolationOutputError(
      'unsafe_output_url',
      false,
      'The optional isolation provider returned an unsafe output location.'
    );
  }
  return url.toString();
}

function validateHydrationInput(input: {
  isolationId: string;
  kind: QueryIsolationOutputKind;
  outputUrl: string;
}): string {
  if (!SAFE_ID_PATTERN.test(input.isolationId)) {
    throw new QueryIsolationOutputError('invalid_request', false, 'Invalid isolation id');
  }
  if (input.kind !== 'target' && input.kind !== 'residual') {
    throw new QueryIsolationOutputError('invalid_request', false, 'Invalid isolation output kind');
  }
  return validatedQueryIsolationOutputUrl(input.outputUrl);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new QueryIsolationOutputError('invalid_request', false, `Invalid ${field}`);
  }
  return selected;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

async function fetchOutputAttempt(
  fetchImpl: typeof fetch,
  outputUrl: string,
  maximumBytes: number,
  timeoutMs: number
): Promise<ArrayBuffer> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(outputUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'audio/wav, application/octet-stream;q=0.5' },
    });
  } catch {
    throw new QueryIsolationOutputError(
      'download_failed',
      true,
      'The optional isolation output could not be downloaded.'
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new QueryIsolationOutputError(
      'unsafe_output_url',
      false,
      'The optional isolation provider redirected its output.'
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new QueryIsolationOutputError(
      'download_failed',
      response.status === 429 || response.status >= 500,
      'The optional isolation output could not be downloaded.'
    );
  }
  if (!SAFE_WAV_MEDIA_TYPES.has(responseMediaType(response))) {
    await response.body?.cancel().catch(() => undefined);
    throw new QueryIsolationOutputError(
      'invalid_output_audio',
      false,
      'The optional isolation provider returned an unsupported audio format.'
    );
  }

  const bodyTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  return readBoundedResponse(response, {
    maximumBytes,
    timeoutMs: bodyTimeoutMs,
    errors: {
      tooLarge: () =>
        new QueryIsolationOutputError(
          'output_too_large',
          false,
          'The optional isolation output exceeded the storage boundary.'
        ),
      timedOut: () =>
        new QueryIsolationOutputError(
          'download_failed',
          true,
          'The optional isolation output did not finish downloading in time.'
        ),
      unreadable: () =>
        new QueryIsolationOutputError(
          'download_failed',
          true,
          'The optional isolation output could not be read.'
        ),
    },
  });
}

async function downloadOutput(
  outputUrl: string,
  options: Required<Pick<HydrationOptions, 'fetchImpl'>> & {
    maximumBytes: number;
    timeoutMs: number;
    maximumAttempts: number;
  }
): Promise<ArrayBuffer> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: QueryIsolationOutputError | null = null;
  for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 1) break;
    try {
      return await fetchOutputAttempt(
        options.fetchImpl,
        outputUrl,
        options.maximumBytes,
        remaining
      );
    } catch (error) {
      if (!(error instanceof QueryIsolationOutputError)) {
        throw new QueryIsolationOutputError(
          'download_failed',
          true,
          'The optional isolation output could not be downloaded.'
        );
      }
      lastError = error;
      if (!error.retryable) throw error;
    }
  }
  throw (
    lastError ??
    new QueryIsolationOutputError(
      'download_failed',
      true,
      'The optional isolation output did not finish downloading in time.'
    )
  );
}

export async function hydrateQueryIsolationOutput(
  env: Pick<Env, 'AUDIO'>,
  input: {
    isolationId: string;
    kind: QueryIsolationOutputKind;
    outputUrl: string;
  },
  options: HydrationOptions = {}
): Promise<StoredQueryIsolationOutputV1> {
  const outputUrl = validateHydrationInput(input);
  const maximumBytes = boundedInteger(
    options.maximumBytes,
    QUERY_ISOLATION_OUTPUT_MAX_BYTES,
    QUERY_ISOLATION_OUTPUT_MAX_BYTES,
    'isolation output byte limit'
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    QUERY_ISOLATION_OUTPUT_TIMEOUT_MS,
    QUERY_ISOLATION_OUTPUT_TIMEOUT_MS,
    'isolation output timeout'
  );
  const maximumAttempts = boundedInteger(
    options.maximumAttempts,
    QUERY_ISOLATION_OUTPUT_MAX_DOWNLOAD_ATTEMPTS,
    QUERY_ISOLATION_OUTPUT_MAX_DOWNLOAD_ATTEMPTS,
    'isolation output attempt limit'
  );
  const audio = await downloadOutput(outputUrl, {
    fetchImpl: options.fetchImpl ?? fetch,
    maximumBytes,
    timeoutMs,
    maximumAttempts,
  });
  if (!isSupportedQueryIsolationWav(audio)) {
    throw new QueryIsolationOutputError(
      'invalid_output_audio',
      false,
      'The optional isolation provider returned invalid WAV audio.'
    );
  }

  const storageKey = `isolations/${input.isolationId}/${input.kind}.wav`;
  const sha256 = await sha256Hex(audio);
  const existed = Boolean(await env.AUDIO.head(storageKey));
  let stored: R2Object;
  try {
    stored = await env.AUDIO.put(storageKey, audio, {
      httpMetadata: { contentType: 'audio/wav' },
      customMetadata: {
        purpose: `query-isolation-${input.kind}-v1`,
        sha256,
      },
    });
    if (!stored || stored.size !== audio.byteLength) {
      throw new QueryIsolationOutputError(
        'storage_failed',
        true,
        'The optional isolation output could not be stored.'
      );
    }
  } catch (error) {
    if (!existed) await env.AUDIO.delete(storageKey).catch(() => undefined);
    if (error instanceof QueryIsolationOutputError) throw error;
    throw new QueryIsolationOutputError(
      'storage_failed',
      true,
      'The optional isolation output could not be stored.'
    );
  }

  const createdAt = stored.uploaded.toISOString();
  const retainedUntil = new Date(
    stored.uploaded.getTime() + QUERY_ISOLATION_OUTPUT_RETENTION_MS
  ).toISOString();
  return {
    isolationId: input.isolationId,
    kind: input.kind,
    storageKey,
    sha256,
    bytes: audio.byteLength,
    contentType: 'audio/wav',
    retainedUntil,
    createdAt,
  };
}

export function validateStoredQueryIsolationOutput(
  output: StoredQueryIsolationOutputV1,
  isolationId: string,
  kind: QueryIsolationOutputKind
): StoredQueryIsolationOutputV1 {
  const createdAt = Date.parse(output.createdAt);
  const retainedUntil = Date.parse(output.retainedUntil);
  if (
    !SAFE_ID_PATTERN.test(isolationId) ||
    output.isolationId !== isolationId ||
    output.kind !== kind ||
    output.storageKey !== `isolations/${isolationId}/${kind}.wav` ||
    !SHA256_PATTERN.test(output.sha256) ||
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 44 ||
    output.bytes > QUERY_ISOLATION_OUTPUT_MAX_BYTES ||
    output.contentType !== 'audio/wav' ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(retainedUntil) ||
    new Date(createdAt).toISOString() !== output.createdAt ||
    new Date(retainedUntil).toISOString() !== output.retainedUntil ||
    retainedUntil - createdAt !== QUERY_ISOLATION_OUTPUT_RETENTION_MS
  ) {
    throw new QueryIsolationOutputError(
      'invalid_request',
      false,
      'Invalid stored isolation output identity'
    );
  }
  return output;
}

export async function discardQueryIsolationOutput(
  env: Pick<Env, 'AUDIO'>,
  storageKey: string
): Promise<void> {
  const match = OUTPUT_KEY_PATTERN.exec(storageKey);
  if (!match) {
    throw new QueryIsolationOutputError('invalid_request', false, 'Invalid isolation output key');
  }
  await env.AUDIO.delete(storageKey);
}
