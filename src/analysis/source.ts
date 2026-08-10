import type { Env } from '../env.ts';
import { getRetainedAudio, isAuthoritativeAutoSourceKey } from '../r2.ts';
import { MAX_AUDIO_SOURCE_BYTES } from './types.ts';

const SOURCE_COPY_TIMEOUT_MS = 60_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type AuthoritativeAutoSourceErrorCode =
  | 'invalid_request'
  | 'source_unavailable'
  | 'source_too_large'
  | 'snapshot_conflict'
  | 'snapshot_failed';

export class AuthoritativeAutoSourceError extends Error {
  readonly code: AuthoritativeAutoSourceErrorCode;

  constructor(code: AuthoritativeAutoSourceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AuthoritativeAutoSourceSnapshot {
  /** Internal app-owned locator. Never include it in student JSON. */
  snapshotKey: string;
  bytes: number;
}

function validateInput(input: {
  jobId: string;
  sourceKey: string;
  nowMs?: number;
}): void {
  if (!SAFE_ID_PATTERN.test(input.jobId)) {
    throw new AuthoritativeAutoSourceError('invalid_request', 'Invalid Auto job id');
  }
  if (
    !input.sourceKey.startsWith('uploads/') ||
    input.sourceKey.length > 512 ||
    /[\0\r\n]/.test(input.sourceKey)
  ) {
    throw new AuthoritativeAutoSourceError('invalid_request', 'Invalid stored upload key');
  }
  if (
    input.nowMs !== undefined &&
    (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
  ) {
    throw new AuthoritativeAutoSourceError('invalid_request', 'Invalid Auto source timestamp');
  }
}

interface BoundedCopyState {
  stream: ReadableStream<Uint8Array>;
  completed(): boolean;
  failure(): AuthoritativeAutoSourceError | null;
  cancel(): Promise<void>;
}

interface FixedLengthStreamPair {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

type FixedLengthStreamConstructor = new (expectedLength: number) => FixedLengthStreamPair;

/**
 * Enforce the stored byte count and one total deadline without materializing
 * the source in application memory. The object store consumes this stream
 * directly into the app-owned snapshot.
 */
function boundedCopyStream(
  source: ReadableStream,
  expectedBytes: number,
  startedAt = Date.now()
): BoundedCopyState {
  const reader = source.getReader();
  let received = 0;
  let finished = false;
  let copyFailure: AuthoritativeAutoSourceError | null = null;

  async function cancelReader(reason?: unknown): Promise<void> {
    try {
      await reader.cancel(reason);
    } catch {
      // The fixed app-owned error below is authoritative; never reflect a
      // storage-stream cancellation error to the caller.
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const remainingMs = SOURCE_COPY_TIMEOUT_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        copyFailure = new AuthoritativeAutoSourceError(
          'source_unavailable',
          'The uploaded source did not finish snapshotting in time'
        );
        finished = true;
        await cancelReader(copyFailure);
        controller.error(copyFailure);
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('authoritative Auto source copy timed out')),
              remainingMs
            );
          }),
        ]);
        if (result.done) {
          finished = true;
          if (received !== expectedBytes) {
            copyFailure = new AuthoritativeAutoSourceError(
              'source_unavailable',
              'The uploaded source changed while it was being snapshotted'
            );
            controller.error(copyFailure);
          } else {
            controller.close();
          }
          return;
        }

        received += result.value.byteLength;
        if (received > expectedBytes) {
          copyFailure = new AuthoritativeAutoSourceError(
            'source_unavailable',
            'The uploaded source exceeded its stored size while being snapshotted'
          );
          finished = true;
          await cancelReader(copyFailure);
          controller.error(copyFailure);
          return;
        }
        controller.enqueue(result.value);
      } catch {
        copyFailure = new AuthoritativeAutoSourceError(
          'source_unavailable',
          'The uploaded source could not be snapshotted'
        );
        finished = true;
        await cancelReader(copyFailure);
        controller.error(copyFailure);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async cancel(reason) {
      finished = true;
      await cancelReader(reason);
    },
  });

  return {
    stream,
    completed: () => finished && !copyFailure && received === expectedBytes,
    failure: () => copyFailure,
    cancel: () => cancelReader('authoritative Auto snapshot preparation ended'),
  };
}

/** Workerd requires a known-length stream for R2 puts; Node's adapter does not. */
function fixedLengthUpload(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number
): {
  body: ReadableStream<Uint8Array>;
  pump: Promise<void> | null;
} {
  const FixedLength = (
    globalThis as typeof globalThis & {
      FixedLengthStream?: FixedLengthStreamConstructor;
    }
  ).FixedLengthStream;
  if (!FixedLength) return { body: stream, pump: null };

  const fixed = new FixedLength(expectedBytes);
  return {
    body: fixed.readable,
    pump: stream.pipeTo(fixed.writable),
  };
}

async function rollbackSnapshot(env: Pick<Env, 'AUDIO'>, snapshotKey: string): Promise<void> {
  try {
    await env.AUDIO.delete(snapshotKey);
  } catch {
    throw new AuthoritativeAutoSourceError(
      'snapshot_failed',
      'The immutable Auto source snapshot could not be rolled back'
    );
  }
}

/**
 * Freeze a browser upload before authoritative analysis or provider spend.
 *
 * The browser can keep using its original presigned PUT, but that URL cannot
 * address `auto-inputs/`. Both the analyzer and separator therefore consume
 * this single immutable object, even if the upload locator is reused before,
 * during, or after analysis.
 */
export async function prepareAuthoritativeAutoSource(
  env: Env,
  input: {
    jobId: string;
    sourceKey: string;
    /** Test seam for the local 30-day retention boundary. */
    nowMs?: number;
  }
): Promise<AuthoritativeAutoSourceSnapshot> {
  validateInput(input);
  const snapshotKey = `auto-inputs/v1/${input.jobId}`;

  let source: R2ObjectBody | null;
  try {
    source = await getRetainedAudio(env, input.sourceKey, input.nowMs);
  } catch {
    throw new AuthoritativeAutoSourceError(
      'source_unavailable',
      'The uploaded source could not be read'
    );
  }
  if (!source) {
    throw new AuthoritativeAutoSourceError(
      'source_unavailable',
      'The uploaded source is missing or has expired'
    );
  }
  if (source.size <= 0 || source.size > MAX_AUDIO_SOURCE_BYTES) {
    throw new AuthoritativeAutoSourceError(
      'source_too_large',
      'The uploaded source is outside the supported size boundary'
    );
  }

  try {
    if (await env.AUDIO.head(snapshotKey)) {
      throw new AuthoritativeAutoSourceError(
        'snapshot_conflict',
        'The immutable Auto source snapshot already exists'
      );
    }
  } catch (error) {
    if (error instanceof AuthoritativeAutoSourceError) throw error;
    throw new AuthoritativeAutoSourceError(
      'snapshot_failed',
      'The immutable Auto source snapshot could not be inspected'
    );
  }

  const bounded = boundedCopyStream(source.body, source.size);
  const upload = fixedLengthUpload(bounded.stream, source.size);
  let stored: R2Object | null = null;
  try {
    const put = env.AUDIO.put(snapshotKey, upload.body, {
      httpMetadata: {
        contentType: source.httpMetadata?.contentType ?? 'application/octet-stream',
      },
      customMetadata: {
        purpose: 'authoritative-auto-input-v1',
        sourceBytes: String(source.size),
      },
    });
    stored = upload.pump
      ? (await Promise.all([put, upload.pump]))[0]
      : await put;
  } catch {
    await bounded.cancel();
    if (upload.pump) await Promise.allSettled([upload.pump]);
    await rollbackSnapshot(env, snapshotKey);
    throw bounded.failure() ?? new AuthoritativeAutoSourceError(
      'snapshot_failed',
      'The immutable Auto source snapshot could not be stored'
    );
  }

  if (!stored || stored.size !== source.size || !bounded.completed()) {
    await bounded.cancel();
    await rollbackSnapshot(env, snapshotKey);
    throw bounded.failure() ?? new AuthoritativeAutoSourceError(
      'snapshot_failed',
      'The immutable Auto source snapshot did not match the uploaded source size'
    );
  }

  let committed: R2Object | null;
  try {
    committed = await env.AUDIO.head(snapshotKey);
  } catch {
    await rollbackSnapshot(env, snapshotKey);
    throw new AuthoritativeAutoSourceError(
      'snapshot_failed',
      'The immutable Auto source snapshot could not be verified'
    );
  }
  if (!committed || committed.size !== source.size) {
    await rollbackSnapshot(env, snapshotKey);
    throw new AuthoritativeAutoSourceError(
      'snapshot_failed',
      'The immutable Auto source snapshot could not be verified'
    );
  }

  return { snapshotKey, bytes: source.size };
}

/** Delete only an app-owned Auto snapshot after a pre-job rollback. */
export async function discardAuthoritativeAutoSource(
  env: Pick<Env, 'AUDIO'>,
  snapshotKey: string
): Promise<void> {
  if (!isAuthoritativeAutoSourceKey(snapshotKey)) {
    throw new AuthoritativeAutoSourceError('invalid_request', 'Invalid Auto source snapshot key');
  }
  await env.AUDIO.delete(snapshotKey);
}
