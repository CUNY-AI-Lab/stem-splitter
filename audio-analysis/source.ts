import { open, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioAnalysisServiceConfig } from './config.ts';

const ANALYSIS_URL_TTL_SECONDS = 10 * 60;
const SOURCE_CLOCK_SKEW_SECONDS = 60;

export class SourcePolicyError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export interface TemporarySource {
  path: string;
  bytes: number;
  sha256: string;
  cleanup(): Promise<void>;
}

export function validateSourceUrl(
  raw: string,
  config: AudioAnalysisServiceConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourcePolicyError('source_url_invalid');
  }
  if (
    (url.protocol !== 'https:' && !(config.allowHttpSources && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash ||
    !config.allowedSourceOrigins.has(url.origin)
  ) {
    throw new SourcePolicyError('source_origin_not_allowed');
  }
  // The active Railway app issues a purpose-specific ten-minute HMAC URL.
  // Origin allowlisting alone would let a bearer-token holder make the
  // analyzer fetch arbitrary app endpoints rather than exactly one audio
  // object, which is broader authority than this service needs.
  const parameters = [...url.searchParams.keys()].sort();
  const expires = Number(url.searchParams.get('expires'));
  if (
    !url.pathname.startsWith('/api/local-sources/uploads/') ||
    parameters.length !== 2 ||
    parameters[0] !== 'expires' ||
    parameters[1] !== 'signature' ||
    !/^\d{10,12}$/.test(url.searchParams.get('expires') ?? '') ||
    !Number.isSafeInteger(expires) ||
    expires < nowSeconds ||
    expires > nowSeconds + ANALYSIS_URL_TTL_SECONDS + SOURCE_CLOCK_SKEW_SECONDS ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('signature') ?? '')
  ) {
    throw new SourcePolicyError('source_url_not_scoped');
  }
  return url;
}

export async function fetchSourceToTemp(
  rawUrl: string,
  config: AudioAnalysisServiceConfig,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<TemporarySource> {
  const url = validateSourceUrl(rawUrl, config);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('source fetch timed out')), config.sourceFetchTimeoutMs);
  const directory = await mkdtemp(join(tmpdir(), 'stem-splitter-analysis-'));
  const path = join(directory, 'source');
  let handle;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'audio/*,application/octet-stream;q=0.8' },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new SourcePolicyError('source_redirect_rejected', 502);
    }
    if (!response.ok || !response.body) {
      throw new SourcePolicyError('source_fetch_failed', 502);
    }
    const declared = response.headers.get('content-length');
    if (declared !== null) {
      const size = Number(declared);
      if (!Number.isSafeInteger(size) || size < 1) {
        throw new SourcePolicyError('source_length_invalid', 422);
      }
      if (size > config.maxSourceBytes) {
        throw new SourcePolicyError('source_too_large', 413);
      }
    }

    handle = await open(path, 'wx', 0o600);
    const reader = response.body.getReader();
    let bytes = 0;
    const sourceHash = createHash('sha256');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > config.maxSourceBytes) {
          await reader.cancel('source is too large');
          throw new SourcePolicyError('source_too_large', 413);
        }
        sourceHash.update(value);
        await handle.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (bytes < 1) throw new SourcePolicyError('source_empty', 422);
    await handle.close();
    handle = undefined;
    return {
      path,
      bytes,
      sha256: sourceHash.digest('hex'),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof SourcePolicyError) throw error;
    throw new SourcePolicyError(
      controller.signal.aborted ? 'source_fetch_timeout' : 'source_fetch_failed',
      502
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
