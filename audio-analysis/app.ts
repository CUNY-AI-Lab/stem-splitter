import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import {
  PINNED_INSTRUMENT_CLASSIFIER_VERSION,
  PINNED_INSTRUMENT_MODEL_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
  SOURCE_FINGERPRINT_SCHEMA_VERSION,
  type AudioSourceType,
  type AudioAnalysisRequestV1,
  type AudioAnalysisResultV1,
  type InstrumentDiscoveryResultV1,
} from '../src/analysis/types.ts';
import { AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION } from '../src/analysis/source-scope.ts';
import type { AudioAnalysisServiceConfig } from './config.ts';
import { analyzePcm, roleClassifierVersion } from './classifier.ts';
import {
  decodeAnalysisWindows,
  DecoderError,
  probeDecoder,
  type DecodedAnalysisAudio,
  type DecoderReadiness,
} from './decoder.ts';
import {
  httpInstrumentDiscoveryProvider,
  InstrumentDiscoveryError,
} from './discovery.ts';
import {
  AnalysisRequestError,
  parseAnalysisRequest,
  parseFingerprintRequest,
  readBoundedJson,
} from './request.ts';
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
    sourceType: AudioSourceType,
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
  discover?(
    decoded: DecodedAnalysisAudio,
    signal?: AbortSignal
  ): Promise<InstrumentDiscoveryResultV1>;
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
  let instrumentDiscoveryState = config.instrumentDiscoveryState;
  let configuredDiscovery: ReturnType<typeof httpInstrumentDiscoveryProvider> | null = null;
  if (config.instrumentDiscovery) {
    try {
      configuredDiscovery = httpInstrumentDiscoveryProvider(config.instrumentDiscovery);
    } catch {
      instrumentDiscoveryState = 'invalid';
    }
  }
  const dependencies: AudioAnalysisDependencies = {
    ...defaultDependencies,
    ...(configuredDiscovery ? { discover: configuredDiscovery.discover } : {}),
    ...overrides,
  };
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
              sourceScopeVersion: AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION,
              instrumentDiscovery: instrumentDiscoveryState,
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
      source = await dependencies.fetchSource(
        request.sourceUrl,
        config,
        request.sourceType,
        c.req.raw.signal
      );
      const decoded = await dependencies.decode(source.path, {
        timeoutMs: config.decoderTimeoutMs,
        maxSourceDurationSeconds: config.maxSourceDurationSeconds,
        signal: c.req.raw.signal,
      });
      const preClassificationMs = Math.max(0, dependencies.now() - startedAt);
      if (preClassificationMs > 60_000) throw new DecoderError('analysis_time_limit_exceeded');
      let result: AudioAnalysisResultV1 = dependencies.classify({
        decoded,
        request,
        totalMs: preClassificationMs,
      });
      if (request.instrumentDiscovery) {
        const discoveryStartedAt = dependencies.now();
        if (!dependencies.discover) {
          result = {
            ...result,
            instrumentDiscovery: {
              status: 'unavailable',
              code: 'discovery_unconfigured',
              totalMs: 0,
              windowsAnalyzed: 0,
            },
          };
        } else {
          try {
            const discovery = await dependencies.discover(decoded, c.req.raw.signal);
            result = {
              ...result,
              vocabularyClassifier: {
                version: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
                weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
                vocabularyVersion: PINNED_INSTRUMENT_VOCABULARY_VERSION,
                vocabularySha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
              },
              instrumentDiscovery: {
                status: 'complete',
                code: null,
                totalMs: discovery.timingMs,
                windowsAnalyzed: discovery.windowsAnalyzed,
              },
              detectedInstruments: discovery.detections,
            };
          } catch (error) {
            result = {
              ...result,
              instrumentDiscovery: {
                status: 'unavailable',
                code:
                  error instanceof InstrumentDiscoveryError
                    ? error.code
                    : 'discovery_unavailable',
                totalMs: Math.max(0, dependencies.now() - discoveryStartedAt),
                windowsAnalyzed: 0,
              },
              detectedInstruments: [],
            };
          }
        }
      }
      const finalTotalMs = Math.max(0, dependencies.now() - startedAt);
      if (finalTotalMs > 60_000) throw new DecoderError('analysis_time_limit_exceeded');
      result = { ...result, timing: { ...result.timing, totalMs: finalTotalMs } };
      dependencies.logger.info('analysis_complete', {
        requestId,
        schemaVersion: result.schemaVersion,
        roleClassifierVersion: result.roleClassifier.version,
        ffmpegVersion: readiness.decoder!.ffmpegVersion,
        sourceType: request.sourceType,
        analyzedSeconds: Number(decoded.analyzedSeconds.toFixed(3)),
        totalMs: result.timing.totalMs,
        resolvedCoreModel: result.decision.resolvedCoreModel,
        degraded: result.degraded.active,
        discoveryStatus: result.instrumentDiscovery?.status ?? 'not_requested',
        discoveryCount: result.detectedInstruments.length,
        ...(result.vocabularyClassifier
          ? {
              discoveryClassifierVersion: result.vocabularyClassifier.version,
              discoveryVocabularyVersion: result.vocabularyClassifier.vocabularyVersion,
            }
          : {}),
      });
      c.header('Cache-Control', 'no-store');
      return c.json({
        ...result,
        source: {
          schemaVersion: SOURCE_FINGERPRINT_SCHEMA_VERSION,
          sha256: source.sha256,
          bytes: source.bytes,
        },
      });
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

  // Exact-byte identity for explicit jobs that did not run Auto. This uses the
  // same scoped source URL, byte cap, timeout, concurrency, and cleanup as the
  // analyzer, but deliberately performs no decode or classifier work.
  app.post('/v1/fingerprint', async (c) => {
    if (!authorized(c.req.header('authorization'), config.token)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (config.errors.length) return c.json({ error: 'service_not_ready' }, 503);
    if (active >= config.maxConcurrency) {
      c.header('Retry-After', '1');
      return c.json({ error: 'analysis_busy' }, 503);
    }

    active += 1;
    const requestId = randomUUID();
    const startedAt = dependencies.now();
    let source: TemporarySource | undefined;
    let sourceType: string | undefined;
    try {
      const request = parseFingerprintRequest(await readBoundedJson(c.req.raw));
      sourceType = request.sourceType;
      source = await dependencies.fetchSource(
        request.sourceUrl,
        config,
        request.sourceType,
        c.req.raw.signal
      );
      const totalMs = Math.max(0, dependencies.now() - startedAt);
      if (totalMs > 60_000) throw new SourcePolicyError('source_fetch_timeout', 502);
      dependencies.logger.info('fingerprint_complete', {
        requestId,
        schemaVersion: SOURCE_FINGERPRINT_SCHEMA_VERSION,
        sourceType,
        totalMs,
      });
      c.header('Cache-Control', 'no-store');
      return c.json({
        schemaVersion: SOURCE_FINGERPRINT_SCHEMA_VERSION,
        source: {
          schemaVersion: SOURCE_FINGERPRINT_SCHEMA_VERSION,
          sha256: source.sha256,
          bytes: source.bytes,
        },
        timing: { totalMs },
      });
    } catch (error) {
      const status =
        error instanceof AnalysisRequestError || error instanceof SourcePolicyError
          ? error.status
          : 500;
      const code =
        error instanceof AnalysisRequestError
          ? 'invalid_request'
          : error instanceof SourcePolicyError
            ? error.code
            : 'fingerprint_failed';
      dependencies.logger.warn('fingerprint_failed', {
        requestId,
        ...(sourceType ? { sourceType } : {}),
        code,
        totalMs: Math.max(0, dependencies.now() - startedAt),
      });
      return c.json({ error: code }, status as 400 | 413 | 415 | 500 | 502 | 503);
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
