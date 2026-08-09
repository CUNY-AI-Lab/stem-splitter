import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioAnalysisService, type SafeLogger } from './app.ts';
import {
  ANALYSIS_SAMPLE_RATE,
  audioAnalysisConfigFromEnv,
  type AudioAnalysisServiceConfig,
} from './config.ts';
import { analysisWindowPlan, decodeAnalysisWindows, DecoderError, probeDecoder } from './decoder.ts';
import { fetchSourceToTemp, SourcePolicyError, validateSourceUrl } from './source.ts';

const TOKEN = 'analysis-test-token-that-is-at-least-32-characters';
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

function decoded(samples = new Float32Array(ANALYSIS_SAMPLE_RATE)) {
  return {
    samples,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    sourceDurationSeconds: samples.length / ANALYSIS_SAMPLE_RATE,
    analyzedSeconds: samples.length / ANALYSIS_SAMPLE_RATE,
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
      return { path: '/tmp/source', bytes: 1, cleanup: async () => undefined };
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
});

test('container and build context freeze the runtime without shipping local audio or secrets', () => {
  const dockerfile = readFileSync(resolve('audio-analysis/Dockerfile'), 'utf8');
  const dockerignore = readFileSync(resolve('.dockerignore'), 'utf8');

  assert.match(dockerfile, /FROM node:22\.23\.1-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /FROM oven\/bun:1\.3\.14-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /ARG FFMPEG_VERSION=8\.0\.3/);
  assert.match(
    dockerfile,
    /ARG FFMPEG_SHA256=6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818/
  );
  assert.doesNotMatch(dockerfile, /(?:^|[:=])latest(?:\s|$)/im);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK[^]*\/readyz/);
  assert.match(dockerignore, /^\.dev\.vars\*$/m);
  assert.match(dockerignore, /^audio-analysis\/\.env\*$/m);
  assert.match(dockerignore, /^tests\/corpus\/audio$/m);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node audio-analysis \.\/audio-analysis/);
});
