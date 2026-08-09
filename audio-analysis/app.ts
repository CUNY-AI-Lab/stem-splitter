import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { AudioAnalysisRequestV1 } from '../src/analysis/types.ts';
import type { AudioAnalysisServiceConfig } from './config.ts';
import { analyzePcm, roleClassifierVersion } from './classifier.ts';
import {
  decodeAnalysisWindows,
  DecoderError,
  probeDecoder,
  type DecodedAnalysisAudio,
  type DecoderReadiness,
} from './decoder.ts';
import { AnalysisRequestError, parseAnalysisRequest, readBoundedJson } from './request.ts';
import { fetchSourceToTemp, SourcePolicyError, type TemporarySource } from './source.ts';

export interface SafeLogger {
  info(event: string, fields: Record<string, string | number | boolean>): void;
  warn(event: string, fields: Record<string, string | number | boolean>): void;
}

const consoleLogger: SafeLogger = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'info', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'warn', event, ...fields })),
};

export interface AudioAnalysisDependencies {
  fetchSource(
    sourceUrl: string,
    config: AudioAnalysisServiceConfig,
    signal?: AbortSignal
  ): Promise<TemporarySource>;
  decode(
    path: string,
    options: { timeoutMs: number; maxSourceDurationSeconds: number; signal?: AbortSignal }
  ): Promise<DecodedAnalysisAudio>;
  probe(expectedVersion: string): Promise<DecoderReadiness>;
  classify(input: {
    decoded: DecodedAnalysisAudio;
    request: AudioAnalysisRequestV1;
    totalMs: number;
  }): ReturnType<typeof analyzePcm>;
  classifierVersion(): string;
  now(): number;
  logger: SafeLogger;
}

const defaultDependencies: AudioAnalysisDependencies = {
  fetchSource: fetchSourceToTemp,
  decode: decodeAnalysisWindows,
  probe: probeDecoder,
  classify: ({ decoded, request, totalMs }) =>
    analyzePcm({
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      analyzedSeconds: decoded.analyzedSeconds,
      coreModels: request.coreModels,
      fallbackModel: request.fallbackModel,
      totalMs,
    }),
  classifierVersion: roleClassifierVersion,
  now: Date.now,
  logger: consoleLogger,
};

function authorized(header: string | undefined, expected: string): boolean {
  const candidate = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const actualHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return candidate.length > 0 && timingSafeEqual(actualHash, expectedHash);
}

export function createAudioAnalysisService(
  config: AudioAnalysisServiceConfig,
  overrides: Partial<AudioAnalysisDependencies> = {}
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const app = new Hono();
  let active = 0;
  let readiness: {
    ready: boolean;
    decoder?: DecoderReadiness;
    classifierVersion?: string;
    reason?: 'configuration' | 'decoder' | 'classifier';
  } = { ready: false };

  // Readiness must settle to a value rather than reject: a broken decoder or
  // classifier is a clean 503, not an uncaught 500 from /readyz or /v1/analyze.
  const readinessCheck = (async () => {
    if (config.errors.length) {
      readiness = { ready: false, reason: 'configuration' };
      return;
    }
    let decoder: DecoderReadiness;
    try {
      decoder = await dependencies.probe(config.expectedFfmpegVersion);
    } catch {
      readiness = { ready: false, reason: 'decoder' };
      return;
    }
    try {
      const classifierVersion = dependencies.classifierVersion();
      readiness = { ready: true, decoder, classifierVersion };
    } catch {
      readiness = { ready: false, reason: 'classifier' };
    }
  })();

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'audio-analysis',
      schemaVersion: '1',
    })
  );
  app.get('/readyz', async (c) => {
    await readinessCheck;
    return c.json(
      {
        ready: readiness.ready,
        ...(readiness.decoder
          ? {
              ffmpegVersion: readiness.decoder.ffmpegVersion,
              classifierVersion: readiness.classifierVersion,
            }
          : {}),
        ...(!readiness.ready && readiness.reason ? { reason: readiness.reason } : {}),
      },
      readiness.ready ? 200 : 503
    );
  });

  app.post('/v1/analyze', async (c) => {
    if (!authorized(c.req.header('authorization'), config.token)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized' }, 401);
    }
    await readinessCheck;
    if (!readiness.ready) return c.json({ error: 'service_not_ready' }, 503);
    if (active >= config.maxConcurrency) {
      c.header('Retry-After', '1');
      return c.json({ error: 'analysis_busy' }, 503);
    }

    active += 1;
    const requestId = randomUUID();
    const startedAt = dependencies.now();
    let source: TemporarySource | undefined;
    let request: AudioAnalysisRequestV1 | undefined;
    try {
      request = parseAnalysisRequest(await readBoundedJson(c.req.raw));
      source = await dependencies.fetchSource(request.sourceUrl, config, c.req.raw.signal);
      const decoded = await dependencies.decode(source.path, {
        timeoutMs: config.decoderTimeoutMs,
        maxSourceDurationSeconds: config.maxSourceDurationSeconds,
        signal: c.req.raw.signal,
      });
      const totalMs = Math.max(0, dependencies.now() - startedAt);
      if (totalMs > 60_000) throw new DecoderError('analysis_time_limit_exceeded');
      const result = dependencies.classify({ decoded, request, totalMs });
      dependencies.logger.info('analysis_complete', {
        requestId,
        schemaVersion: result.schemaVersion,
        roleClassifierVersion: result.roleClassifier.version,
        ffmpegVersion: readiness.decoder!.ffmpegVersion,
        sourceType: request.sourceType,
        analyzedSeconds: Number(decoded.analyzedSeconds.toFixed(3)),
        totalMs,
        resolvedCoreModel: result.decision.resolvedCoreModel,
        degraded: result.degraded.active,
      });
      c.header('Cache-Control', 'no-store');
      return c.json(result);
    } catch (error) {
      const status =
        error instanceof AnalysisRequestError || error instanceof SourcePolicyError
          ? error.status
          : error instanceof DecoderError
            ? 422
            : 500;
      const code =
        error instanceof AnalysisRequestError
          ? 'invalid_request'
          : error instanceof SourcePolicyError || error instanceof DecoderError
            ? error.code
            : 'analysis_failed';
      dependencies.logger.warn('analysis_failed', {
        requestId,
        ...(request ? { sourceType: request.sourceType } : {}),
        code,
        totalMs: Math.max(0, dependencies.now() - startedAt),
      });
      return c.json({ error: code }, status as 400 | 413 | 415 | 422 | 500 | 502);
    } finally {
      active -= 1;
      await source?.cleanup().catch(() => undefined);
    }
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((_error, c) => c.json({ error: 'analysis_failed' }, 500));

  return {
    fetch: app.fetch,
    waitUntilReady: () => readinessCheck,
    readiness: () => ({ ...readiness }),
  };
}
