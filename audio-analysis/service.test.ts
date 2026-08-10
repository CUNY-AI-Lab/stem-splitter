import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INSTRUMENT_DISCOVERY_SCHEMA_VERSION,
  PINNED_INSTRUMENT_CLASSIFIER_VERSION,
  PINNED_INSTRUMENT_MODEL_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
} from '../src/analysis/types.ts';
import { createAudioAnalysisService, type SafeLogger } from './app.ts';
import {
  ANALYSIS_SAMPLE_RATE,
  audioAnalysisConfigFromEnv,
  type AudioAnalysisServiceConfig,
} from './config.ts';
import { analysisWindowPlan, decodeAnalysisWindows, DecoderError, probeDecoder } from './decoder.ts';
import { InstrumentDiscoveryError } from './discovery.ts';
import { fetchSourceToTemp, SourcePolicyError, validateSourceUrl } from './source.ts';

const TOKEN = 'analysis-test-token-that-is-at-least-32-characters';
const SOURCE_SHA256 = '1'.repeat(64);
const sourceExpiry = Math.floor(Date.now() / 1000) + 10 * 60;
const SOURCE_URL = `https://app.example/api/local-sources/uploads/test/source.wav?expires=${sourceExpiry}&signature=${'a'.repeat(43)}`;
const CORE_MODELS = [
  { id: 'vocals_instrumental', stems: ['vocals', 'instrumental'] },
  { id: 'htdemucs_ft', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] },
];

function config(overrides: Partial<AudioAnalysisServiceConfig> = {}): AudioAnalysisServiceConfig {
  return {
    token: TOKEN,
    allowedSourceOrigins: new Set(['https://app.example']),
    allowHttpSources: false,
    maxSourceBytes: 100 * 1024 * 1024,
    maxSourceDurationSeconds: 900,
    sourceFetchTimeoutMs: 5_000,
    decoderTimeoutMs: 8_000,
    maxConcurrency: 1,
    expectedFfmpegVersion: '8.0.3',
    instrumentDiscovery: null,
    instrumentDiscoveryState: 'unconfigured',
    port: 8080,
    errors: [],
    ...overrides,
  };
}

function body(sourceType: 'upload' | 'youtube' | 'archive' = 'upload') {
  return {
    schemaVersion: '1',
    sourceUrl: SOURCE_URL,
    sourceType,
    coreModels: CORE_MODELS,
    fallbackModel: 'htdemucs_ft',
    instrumentDiscovery: false,
  };
}

function analyzeRequest(payload: unknown = body(), token = TOKEN): Request {
  return new Request('http://analysis.test/v1/analyze', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function fingerprintBody(sourceType: 'upload' | 'youtube' | 'archive' = 'upload') {
  return { schemaVersion: '1', sourceUrl: SOURCE_URL, sourceType };
}

function fingerprintRequest(payload: unknown = fingerprintBody(), token = TOKEN): Request {
  return new Request('http://analysis.test/v1/fingerprint', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function decoded(samples = new Float32Array(ANALYSIS_SAMPLE_RATE)) {
  return {
    samples,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    sourceDurationSeconds: samples.length / ANALYSIS_SAMPLE_RATE,
    analyzedSeconds: samples.length / ANALYSIS_SAMPLE_RATE,
    windowSampleCounts: [samples.length],
  } as const;
}

function readyProbe(expectedVersion: string) {
  return Promise.resolve({ ffmpegVersion: expectedVersion, ffprobeVersion: expectedVersion });
}

test('configuration fails closed unless token and exact source origins are valid', () => {
  const missing = audioAnalysisConfigFromEnv({});
  assert.ok(missing.errors.some((error) => error.includes('AUDIO_ANALYSIS_TOKEN')));
  assert.ok(missing.errors.some((error) => error.includes('AUDIO_ANALYSIS_SOURCE_ORIGINS')));

  const valid = audioAnalysisConfigFromEnv({
    AUDIO_ANALYSIS_TOKEN: TOKEN,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://app.example,https://r2.example',
  });
  assert.deepEqual(valid.errors, []);
  assert.deepEqual([...valid.allowedSourceOrigins], ['https://app.example', 'https://r2.example']);
  assert.equal(valid.allowHttpSources, false);
  assert.equal(valid.instrumentDiscoveryState, 'unconfigured');

  for (const unsafeToken of [`${TOKEN} `, `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`]) {
    const unsafe = audioAnalysisConfigFromEnv({
      AUDIO_ANALYSIS_TOKEN: unsafeToken,
      AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://app.example',
    });
    assert.ok(unsafe.errors.some((error) => error.includes('AUDIO_ANALYSIS_TOKEN')));
  }

  const discovery = audioAnalysisConfigFromEnv({
    AUDIO_ANALYSIS_TOKEN: TOKEN,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://app.example',
    INSTRUMENT_DISCOVERY_URL: 'http://instrument-discovery.railway.internal',
    INSTRUMENT_DISCOVERY_TOKEN: 'discovery-test-token-that-is-at-least-32-characters',
  });
  assert.equal(discovery.instrumentDiscoveryState, 'configured');
  assert.equal(discovery.instrumentDiscovery?.timeoutMs, 12_000);

  const discoveryOverBudget = audioAnalysisConfigFromEnv({
    AUDIO_ANALYSIS_TOKEN: TOKEN,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://app.example',
    AUDIO_ANALYSIS_FETCH_TIMEOUT_MS: '10000',
    AUDIO_ANALYSIS_DECODER_TIMEOUT_MS: '10000',
    INSTRUMENT_DISCOVERY_URL: 'http://instrument-discovery.railway.internal',
    INSTRUMENT_DISCOVERY_TOKEN: 'discovery-test-token-that-is-at-least-32-characters',
    INSTRUMENT_DISCOVERY_TIMEOUT_MS: '12000',
  });
  assert.equal(discoveryOverBudget.instrumentDiscoveryState, 'invalid');
  assert.equal(discoveryOverBudget.instrumentDiscovery, null);
  assert.deepEqual(
    discoveryOverBudget.errors,
    [],
    'an optional discovery budget error must not take down core analysis'
  );

  for (const candidate of [
    {
      INSTRUMENT_DISCOVERY_URL: 'https://public-discovery.example',
      INSTRUMENT_DISCOVERY_TOKEN: 'discovery-test-token-that-is-at-least-32-characters',
    },
    {
      INSTRUMENT_DISCOVERY_URL: 'http://instrument-discovery.railway.internal',
      INSTRUMENT_DISCOVERY_TOKEN: 'discovery-test-token-that-is-at-least-32-characters\n',
    },
    {
      INSTRUMENT_DISCOVERY_URL: 'http://instrument-discovery.railway.internal',
      INSTRUMENT_DISCOVERY_TOKEN: 'discovery-test-token-with an-interior-space-000000',
    },
    {
      INSTRUMENT_DISCOVERY_URL: ' http://instrument-discovery.railway.internal',
      INSTRUMENT_DISCOVERY_TOKEN: 'discovery-test-token-that-is-at-least-32-characters',
    },
  ]) {
    const unsafeDiscovery = audioAnalysisConfigFromEnv({
      AUDIO_ANALYSIS_TOKEN: TOKEN,
      AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://app.example',
      ...candidate,
    });
    assert.equal(unsafeDiscovery.instrumentDiscoveryState, 'invalid');
    assert.equal(unsafeDiscovery.instrumentDiscovery, null);
  }

  const invalidDiscovery = audioAnalysisConfigFromEnv({
    AUDIO_ANALYSIS_TOKEN: TOKEN,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://app.example',
    INSTRUMENT_DISCOVERY_URL: 'http://metadata.internal',
    INSTRUMENT_DISCOVERY_TOKEN: 'short',
  });
  assert.equal(invalidDiscovery.instrumentDiscoveryState, 'invalid');
  assert.deepEqual(invalidDiscovery.errors, [], 'optional discovery must remain fail-lazy');

  const overBudget = audioAnalysisConfigFromEnv({
    AUDIO_ANALYSIS_TOKEN: TOKEN,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://app.example',
    AUDIO_ANALYSIS_FETCH_TIMEOUT_MS: '15000',
    AUDIO_ANALYSIS_DECODER_TIMEOUT_MS: '30000',
  });
  assert.ok(overBudget.errors.some((error) => error.includes('request budget')));
});

test('liveness is separate from decoder readiness and analysis requires bearer auth', async () => {
  const service = createAudioAnalysisService(config(), { probe: readyProbe });
  const health = await service.fetch(new Request('http://analysis.test/healthz'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'audio-analysis',
    schemaVersion: '1',
  });

  const readiness = await service.fetch(new Request('http://analysis.test/readyz'));
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json() as { ready: boolean }).ready, true);

  const denied = await service.fetch(analyzeRequest(body(), 'wrong-token'));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer');
  const fingerprintDenied = await service.fetch(fingerprintRequest(fingerprintBody(), 'wrong-token'));
  assert.equal(fingerprintDenied.status, 401);
  assert.equal(fingerprintDenied.headers.get('www-authenticate'), 'Bearer');
});

test('invalid decoder pin leaves readiness false without taking down liveness', async () => {
  const service = createAudioAnalysisService(config(), {
    probe: async () => {
      throw new DecoderError('decoder_version_mismatch');
    },
  });
  const ready = await service.fetch(new Request('http://analysis.test/readyz'));
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ready: false, reason: 'decoder' });
  assert.equal((await service.fetch(new Request('http://analysis.test/healthz'))).status, 200);
  assert.equal((await service.fetch(analyzeRequest())).status, 503);
});

test('classifier startup failure is a clean readiness failure, not a rejected request', async () => {
  const service = createAudioAnalysisService(config(), {
    probe: readyProbe,
    classifierVersion: () => {
      throw new Error('classifier failed to load');
    },
  });
  const ready = await service.fetch(new Request('http://analysis.test/readyz'));
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ready: false, reason: 'classifier' });
  assert.equal((await service.fetch(new Request('http://analysis.test/healthz'))).status, 200);
  assert.equal((await service.fetch(analyzeRequest())).status, 503);
});

test('all source types are fetched, decoded, classified, cleaned, and logged without source URLs', async () => {
  const logRecords: unknown[] = [];
  const logger: SafeLogger = {
    info: (event, fields) => logRecords.push({ event, ...fields }),
    warn: (event, fields) => logRecords.push({ event, ...fields }),
  };
  const fetchedTypes: string[] = [];
  let cleanupCount = 0;
  let currentType = '';
  const service = createAudioAnalysisService(config(), {
    probe: readyProbe,
    logger,
    fetchSource: async (url) => {
      assert.equal(url, SOURCE_URL);
      fetchedTypes.push(currentType);
      return {
        path: '/ephemeral/source',
        bytes: 1234,
        sha256: SOURCE_SHA256,
        cleanup: async () => {
          cleanupCount += 1;
        },
      };
    },
    decode: async () => decoded(),
  });

  for (const sourceType of ['upload', 'youtube', 'archive'] as const) {
    currentType = sourceType;
    const response = await service.fetch(analyzeRequest(body(sourceType)));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json() as any;
    assert.equal(result.schemaVersion, '1');
    assert.deepEqual(result.source, {
      schemaVersion: '1',
      sha256: SOURCE_SHA256,
      bytes: 1234,
    });
    assert.equal(result.decision.resolvedCoreModel, 'htdemucs_ft');
    assert.equal(result.degraded.active, false);
  }
  assert.deepEqual(fetchedTypes, ['upload', 'youtube', 'archive']);
  assert.equal(cleanupCount, 3);
  const logs = JSON.stringify(logRecords);
  assert.doesNotMatch(logs, /local-sources|signature|redacted|analysis-test-token/);
  assert.doesNotMatch(logs, /sourceBytes|sourceDurationSeconds/);
  assert.match(logs, /autosplit-role-v3|analysis_complete|htdemucs_ft|8\.0\.3/);
});

test('fingerprinting verifies stored bytes without decoder or classifier work', async () => {
  let cleaned = false;
  let decoded = false;
  const logs: unknown[] = [];
  const service = createAudioAnalysisService(config(), {
    probe: async () => {
      throw new DecoderError('decoder_unavailable');
    },
    fetchSource: async (url) => {
      assert.equal(url, SOURCE_URL);
      return {
        path: '/ephemeral/source',
        bytes: 4321,
        sha256: SOURCE_SHA256,
        cleanup: async () => {
          cleaned = true;
        },
      };
    },
    decode: async () => {
      decoded = true;
      throw new Error('fingerprint route must not decode');
    },
    logger: {
      info: (event, fields) => logs.push({ event, ...fields }),
      warn: (event, fields) => logs.push({ event, ...fields }),
    },
  });
  assert.equal((await service.fetch(new Request('http://analysis.test/readyz'))).status, 503);

  const response = await service.fetch(fingerprintRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    schemaVersion: '1',
    source: { schemaVersion: '1', sha256: SOURCE_SHA256, bytes: 4321 },
    timing: { totalMs: 0 },
  });
  assert.equal(decoded, false);
  assert.equal(cleaned, true);
  const serializedLogs = JSON.stringify(logs);
  assert.match(serializedLogs, /fingerprint_complete/);
  assert.doesNotMatch(serializedLogs, new RegExp(SOURCE_SHA256));
  assert.doesNotMatch(serializedLogs, /4321|local-sources|signature/);

  const drifted = await service.fetch(
    fingerprintRequest({ ...fingerprintBody(), unexpected: true })
  );
  assert.equal(drifted.status, 400);
});

test('reported total time includes synchronous role classification', async () => {
  const times = [1_000, 1_010, 1_050];
  const service = createAudioAnalysisService(config(), {
    probe: readyProbe,
    now: () => {
      const next = times.shift();
      assert.notEqual(next, undefined, 'the request read the clock more often than expected');
      return next!;
    },
    fetchSource: async () => ({
      path: '/ephemeral/source',
      bytes: 1,
      sha256: SOURCE_SHA256,
      cleanup: async () => undefined,
    }),
    decode: async () => decoded(),
    logger: { info: () => undefined, warn: () => undefined },
  });
  const response = await service.fetch(analyzeRequest());
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).timing.totalMs, 50);
  assert.deepEqual(times, []);
});

test('advisory discovery success and failure cannot change the core Auto decision', async () => {
  const discoveryLogs: unknown[] = [];
  const discoveryConfig = config({
    instrumentDiscovery: {
      baseUrl: 'http://instrument-discovery.railway.internal',
      token: 'instrument-discovery-test-token-000000000000',
      timeoutMs: 5_000,
    },
    instrumentDiscoveryState: 'configured',
  });
  const common = {
    probe: readyProbe,
    fetchSource: async () => ({
      path: '/tmp/source',
      bytes: 1,
      sha256: SOURCE_SHA256,
      cleanup: async () => undefined,
    }),
    decode: async () => decoded(new Float32Array(45 * ANALYSIS_SAMPLE_RATE)),
    logger: { info: () => undefined, warn: () => undefined },
  };
  const complete = createAudioAnalysisService(discoveryConfig, {
    ...common,
    logger: {
      info: (event, fields) => discoveryLogs.push({ event, ...fields }),
      warn: (event, fields) => discoveryLogs.push({ event, ...fields }),
    },
    discover: async () => ({
      schemaVersion: INSTRUMENT_DISCOVERY_SCHEMA_VERSION,
      classifier: {
        version: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
        weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
      },
      vocabularyVersion: PINNED_INSTRUMENT_VOCABULARY_VERSION,
      vocabularySha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
      detections: [
        {
          id: 'saxophone',
          label: 'Saxophone',
          confidence: 0.82,
          state: 'possible',
          windowSupport: 2,
          windowsAnalyzed: 3,
        },
      ],
      windowsAnalyzed: 3,
      timingMs: 120,
    }),
  });
  const completeResponse = await complete.fetch(
    analyzeRequest({ ...body(), instrumentDiscovery: true })
  );
  assert.equal(completeResponse.status, 200);
  const completeResult = await completeResponse.json() as any;
  assert.equal(completeResult.decision.resolvedCoreModel, 'htdemucs_ft');
  assert.equal(completeResult.degraded.active, false);
  assert.equal(completeResult.instrumentDiscovery.status, 'complete');
  assert.equal(completeResult.detectedInstruments[0].id, 'saxophone');
  assert.match(
    JSON.stringify(discoveryLogs),
    /laion-larger-clap-music-pairwise-presence-rand-trunc-v1@a0b4534a14f58e20944452dff00a22a06ce629d1/
  );
  assert.match(JSON.stringify(discoveryLogs), /classroom-instruments-v1/);

  const unavailable = createAudioAnalysisService(discoveryConfig, {
    ...common,
    discover: async () => {
      throw new InstrumentDiscoveryError('discovery_timeout');
    },
  });
  const unavailableResponse = await unavailable.fetch(
    analyzeRequest({ ...body(), instrumentDiscovery: true })
  );
  assert.equal(unavailableResponse.status, 200);
  const unavailableResult = await unavailableResponse.json() as any;
  assert.equal(unavailableResult.decision.resolvedCoreModel, 'htdemucs_ft');
  assert.equal(unavailableResult.degraded.active, false);
  assert.equal(unavailableResult.instrumentDiscovery.status, 'unavailable');
  assert.equal(unavailableResult.instrumentDiscovery.code, 'discovery_timeout');
  assert.deepEqual(unavailableResult.detectedInstruments, []);
});

test('concurrency limit rejects overlapping work instead of building an unbounded queue', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const started = new Promise<void>((resolveStarted) => {
    entered = resolveStarted;
  });
  const service = createAudioAnalysisService(config({ maxConcurrency: 1 }), {
    probe: readyProbe,
    fetchSource: async () => {
      entered();
      await gate;
      return {
        path: '/tmp/source',
        bytes: 1,
        sha256: SOURCE_SHA256,
        cleanup: async () => undefined,
      };
    },
    decode: async () => decoded(),
    logger: { info: () => undefined, warn: () => undefined },
  });

  const first = service.fetch(analyzeRequest());
  await started;
  const second = await service.fetch(analyzeRequest());
  assert.equal(second.status, 503);
  assert.equal(second.headers.get('retry-after'), '1');
  assert.deepEqual(await second.json(), { error: 'analysis_busy' });
  release();
  assert.equal((await first).status, 200);
});

test('request drift is rejected and ephemeral sources are cleaned after decode failure', async () => {
  let cleaned = false;
  const service = createAudioAnalysisService(config(), {
    probe: readyProbe,
    fetchSource: async () => ({
      path: '/tmp/source',
      bytes: 1,
      sha256: SOURCE_SHA256,
      cleanup: async () => {
        cleaned = true;
      },
    }),
    decode: async () => {
      throw new DecoderError('audio_unsupported');
    },
    logger: { info: () => undefined, warn: () => undefined },
  });

  const drifted = await service.fetch(analyzeRequest({ ...body(), unexpected: true }));
  assert.equal(drifted.status, 400);
  assert.equal(cleaned, false);

  const failed = await service.fetch(analyzeRequest());
  assert.equal(failed.status, 422);
  assert.deepEqual(await failed.json(), { error: 'audio_unsupported' });
  assert.equal(cleaned, true);
});

test('source policy rejects credentials, unlisted origins, redirects, and oversized bodies', async () => {
  const limits = config({ maxSourceBytes: 4 });
  assert.throws(
    () => validateSourceUrl('https://user:secret@app.example/source', limits),
    SourcePolicyError
  );
  assert.throws(() => validateSourceUrl('https://metadata.internal/source', limits), SourcePolicyError);
  assert.throws(
    () =>
      validateSourceUrl(
        `https://app.example/healthz?expires=${sourceExpiry}&signature=${'a'.repeat(43)}`,
        limits
      ),
    (error: unknown) => error instanceof SourcePolicyError && error.code === 'source_url_not_scoped'
  );
  assert.throws(
    () =>
      validateSourceUrl(
        `https://app.example/api/local-sources/uploads/test/source.wav?expires=${sourceExpiry + 3600}&signature=${'a'.repeat(43)}`,
        limits
      ),
    (error: unknown) => error instanceof SourcePolicyError && error.code === 'source_url_not_scoped'
  );
  assert.equal(validateSourceUrl(SOURCE_URL, limits).origin, 'https://app.example');

  await assert.rejects(
    fetchSourceToTemp(
      SOURCE_URL,
      limits,
      undefined,
      async () => new Response(null, { status: 302, headers: { Location: 'https://other.test' } })
    ),
    (error: unknown) => error instanceof SourcePolicyError && error.code === 'source_redirect_rejected'
  );
  await assert.rejects(
    fetchSourceToTemp(
      SOURCE_URL,
      limits,
      undefined,
      async () =>
        new Response(new Uint8Array(5), {
          status: 200,
          headers: { 'Content-Length': '5' },
        })
    ),
    (error: unknown) => error instanceof SourcePolicyError && error.code === 'source_too_large'
  );

  const bytes = new Uint8Array([1, 2, 3, 4]);
  const source = await fetchSourceToTemp(
    SOURCE_URL,
    limits,
    undefined,
    async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'Content-Length': String(bytes.byteLength) },
      })
  );
  try {
    assert.equal(source.bytes, bytes.byteLength);
    assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex'));
  } finally {
    await source.cleanup();
  }
});

test('window plan is bounded and the real decoder produces fixed-rate PCM', async () => {
  assert.deepEqual(analysisWindowPlan(30), [{ start: 0, seconds: 30 }]);
  assert.deepEqual(analysisWindowPlan(90), [
    { start: 0, seconds: 15 },
    { start: 37.5, seconds: 15 },
    { start: 75, seconds: 15 },
  ]);

  const versionLine = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/, 1)[0];
  const version = versionLine.match(/^ffmpeg version ([^ ]+)/)?.[1];
  assert.ok(version);
  const readiness = await probeDecoder(version);
  assert.equal(readiness.ffmpegVersion, version);
  await assert.rejects(probeDecoder('0.0.0'), (error: unknown) =>
    error instanceof DecoderError && error.code === 'decoder_version_mismatch'
  );

  const output = await decodeAnalysisWindows(resolve('tests/fixtures/audio/source.wav'), {
    timeoutMs: 8_000,
    maxSourceDurationSeconds: 900,
  });
  assert.equal(output.sampleRate, ANALYSIS_SAMPLE_RATE);
  assert.ok(output.samples.length > 0);
  assert.ok(output.analyzedSeconds > 0 && output.analyzedSeconds <= 45);
  assert.ok(output.sourceDurationSeconds > 0 && output.sourceDurationSeconds < 5);
  assert.deepEqual(output.windowSampleCounts, [output.samples.length]);
});

test('container and build context freeze the runtime without shipping local audio or secrets', () => {
  const dockerfile = readFileSync(resolve('audio-analysis/Dockerfile'), 'utf8');
  const dockerignore = readFileSync(resolve('.dockerignore'), 'utf8');
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const imageSmoke = readFileSync(resolve('scripts/smoke-audio-analysis-image.sh'), 'utf8');

  assert.match(dockerfile, /FROM node:22\.23\.1-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /FROM oven\/bun:1\.3\.14-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /ARG FFMPEG_VERSION=8\.0\.3/);
  assert.match(dockerfile, /ARG MAKE_JOBS=1/);
  assert.match(
    dockerfile,
    /ARG FFMPEG_SHA256=6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818/
  );
  assert.doesNotMatch(dockerfile, /(?:^|[:=])latest(?:\s|$)/im);
  for (const component of [
    'bsfs',
    'decoders',
    'demuxers',
    'encoders',
    'filters',
    'hwaccels',
    'indevs',
    'muxers',
    'outdevs',
    'parsers',
    'protocols',
  ]) {
    assert.match(dockerfile, new RegExp(`--disable-${component}`));
  }
  assert.match(dockerfile, /--disable-network/);
  assert.match(dockerfile, /--enable-protocol=file,pipe/);
  assert.match(dockerfile, /--enable-demuxer=aiff,flac,mov,mp3,ogg,wav/);
  assert.match(dockerfile, /--enable-decoder=[^\n]*aac[^\n]*alac[^\n]*flac[^\n]*opus[^\n]*vorbis/);
  assert.match(dockerfile, /--enable-encoder=pcm_f32le/);
  assert.match(dockerfile, /--enable-muxer=pcm_f32le/);
  assert.match(dockerfile, /--enable-filter=aresample/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK[^]*\/readyz/);
  assert.doesNotMatch(dockerfile, /COPY --from=ffmpeg-build \/opt\/ffmpeg \/opt\/ffmpeg/);
  assert.match(dockerfile, /COPY --from=ffmpeg-build \/opt\/ffmpeg\/bin\/ffmpeg \/opt\/ffmpeg\/bin\/ffmpeg/);
  assert.match(dockerfile, /COPY --from=ffmpeg-build \/opt\/ffmpeg\/bin\/ffprobe \/opt\/ffmpeg\/bin\/ffprobe/);
  assert.match(dockerfile, /RUN bun build audio-analysis\/server\.ts --target=node --format=esm --outfile=dist\/server\.mjs/);
  assert.match(dockerfile, /audio-analysis\/decoder\.ts audio-analysis\/discovery\.ts/);
  assert.match(dockerfile, /COPY --from=application-build --chown=node:node \/app\/dist\/server\.mjs \.\/dist\/server\.mjs/);
  assert.doesNotMatch(dockerfile, /COPY --from=[^\n]+node_modules/);
  assert.match(dockerfile, /CMD \["node", "--max-old-space-size=256", "dist\/server\.mjs"\]/);
  assert.match(dockerignore, /^\.dev\.vars\*$/m);
  assert.match(dockerignore, /^audio-analysis\/\.env\*$/m);
  assert.match(dockerignore, /^tests\/corpus\/audio$/m);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node audio-analysis \.\/audio-analysis/);
  assert.match(workflow, /Exercise the constrained analysis image/);
  assert.match(workflow, /AUDIO_ANALYSIS_EXPECTED_PLATFORM: linux\/amd64/);
  assert.match(workflow, /scripts\/smoke-audio-analysis-image\.sh/);
  assert.match(imageSmoke, /analysis_smoke_image_bytes > analysis_smoke_max_image_bytes/);
  assert.match(imageSmoke, /process\.getuid\(\) === 0/);
  assert.match(imageSmoke, /unexpected \/app runtime surface/);
  assert.match(imageSmoke, /test "\$analysis_smoke_enabled_protocols" = 'file pipe'/);
  assert.match(imageSmoke, /unexpected video or subtitle decoder/);
  assert.match(imageSmoke, /--network create --internal|network create --internal/);
  assert.match(imageSmoke, /--memory 1g/);
  assert.match(imageSmoke, /--cpus 1/);
  assert.match(imageSmoke, /--pids-limit 64/);
  assert.match(imageSmoke, /--read-only/);
  assert.match(imageSmoke, /--cap-drop ALL/);
  assert.match(imageSmoke, /max-duration\.wav/);
  assert.match(imageSmoke, /declared-oversize\.wav/);
  assert.match(imageSmoke, /streamed-oversize\.wav/);
  assert.match(imageSmoke, /source_fetch_timeout/);
  assert.match(imageSmoke, /analysis_busy/);
  assert.match(imageSmoke, /temporary sources remain/);
});
