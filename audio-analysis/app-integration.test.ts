import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { createTestHarness } from 'wrangler';

import type { AudioAnalysisRequestV1 } from '../src/analysis/types.ts';
import { AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION } from '../src/analysis/source-scope.ts';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { createAudioAnalysisService, type SafeLogger } from './app.ts';
import { audioAnalysisConfigFromEnv } from './config.ts';
import { fetchSourceToTemp } from './source.ts';

const CLASS_CODE = 'real-analyzer-integration-class-code';
const E2E_SECRET = 'local-hosting-e2e-only';
const ANALYSIS_TOKEN = 'real-analyzer-integration-token-000000000000';
const ANALYSIS_URL = 'https://analysis.test';
const APP_ORIGIN = 'http://stem-splitter.test';
const YOUTUBE_VERSION = 'b'.repeat(64);
const CONFIG_PATH = fileURLToPath(new URL('../tests/e2e/wrangler.jsonc', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../tests/fixtures/audio/source.wav', import.meta.url));

const quietLogger: SafeLogger = {
  info() {},
  warn() {},
};

function localFfmpegVersion(): string {
  const firstLine = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/, 1)[0];
  const version = firstLine.match(/^ffmpeg version ([^ ]+)/)?.[1];
  assert.ok(version, 'local FFmpeg version could not be resolved');
  return version;
}

function transcodeSourceToM4a(): Buffer {
  return execFileSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      SOURCE_PATH,
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  );
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function appRequest(
  harness: ReturnType<typeof createTestHarness>,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
  } = {}
) {
  return harness.fetch(path, {
    ...init,
    headers: { 'x-e2e-secret': E2E_SECRET, ...(init.headers ?? {}) },
  });
}

test('the real analyzer routes stored upload, YouTube, and Archive bytes before separation', async () => {
  const sourceAudio = await readFile(SOURCE_PATH);
  const youtubeAudio = transcodeSourceToM4a();
  const archiveId = 'real-analyzer-open-audio';
  const archiveFile = 'fixture.wav';
  const harness = createTestHarness({
    workers: [
      {
        configPath: CONFIG_PATH,
        vars: {
          LOCAL_HOSTING: 'true',
          PUBLIC_BASE_URL: APP_ORIGIN,
          SEPARATION_BACKEND: 'replicate',
          REPLICATE_YT_MODEL: 'test/yt-audio',
          REPLICATE_YT_MODEL_VERSION: YOUTUBE_VERSION,
          YOUTUBE_FETCH_ORDER: 'replicate-first',
          SERVER_AUTO_ENABLED: 'true',
          SERVER_AUTO_MODE: 'authoritative',
          AUDIO_ANALYSIS_URL: ANALYSIS_URL,
          AUDIO_ANALYSIS_TIMEOUT_MS: '10000',
        },
        secrets: {
          R2_ACCESS_KEY_ID: 'e2e-r2-access-key',
          R2_SECRET_ACCESS_KEY: 'e2e-r2-secret-key',
          REPLICATE_API_TOKEN: 'e2e-replicate-token-1',
          REPLICATE_MODEL_VERSION: 'e2e-model-version',
          WEBHOOK_SECRET: 'e2e-webhook-secret',
          CLASS_CODE,
          AUDIO_ANALYSIS_TOKEN: ANALYSIS_TOKEN,
        },
      },
    ],
  });
  await harness.listen();

  const config = audioAnalysisConfigFromEnv({
    AUDIO_ANALYSIS_TOKEN: ANALYSIS_TOKEN,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: APP_ORIGIN,
    AUDIO_ANALYSIS_ALLOW_HTTP: 'true',
    AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION: localFfmpegVersion(),
    AUDIO_ANALYSIS_FETCH_TIMEOUT_MS: '5000',
    AUDIO_ANALYSIS_DECODER_TIMEOUT_MS: '10000',
    AUDIO_ANALYSIS_MAX_CONCURRENCY: '1',
    AUDIO_ANALYSIS_MAX_SOURCE_BYTES: String(100 * 1024 * 1024),
    AUDIO_ANALYSIS_MAX_SOURCE_SECONDS: '900',
    PORT: '8080',
  });
  assert.deepEqual(config.errors, []);

  const harnessFetch: typeof fetch = async (input) => {
    const sourceUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const response = await harness.fetch(sourceUrl);
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
  };
  const analysisService = createAudioAnalysisService(config, {
    fetchSource: (sourceUrl, serviceConfig, sourceType, signal) =>
      fetchSourceToTemp(
        sourceUrl,
        serviceConfig,
        sourceType,
        signal,
        harnessFetch
      ),
    logger: quietLogger,
  });
  const ready = await analysisService.fetch(new Request(`${ANALYSIS_URL}/readyz`));
  assert.equal(ready.status, 200);
  assert.equal(
    (await ready.json() as { sourceScopeVersion: string }).sourceScopeVersion,
    AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION
  );

  const analysisCalls: AudioAnalysisRequestV1[] = [];
  const analysisResponses: Array<{ status: number; body: string }> = [];
  const separatorInputs: Array<{ audio: string; model: string; stem?: string }> = [];
  const lifecycleEvents: string[] = [];
  const network = setupServer(
    http.post(`${ANALYSIS_URL}/v1/analyze`, async ({ request }) => {
      analysisCalls.push(await request.clone().json() as AudioAnalysisRequestV1);
      // Wrangler's external-service proxy redacts Authorization before the
      // request reaches MSW. The HTTP-adapter unit test separately proves the
      // app emits the bearer token; restore it only at this in-process seam so
      // the real analyzer can exercise the rest of the composed contract.
      const serviceResponse = await analysisService.fetch(
        new Request(request.url, {
          method: request.method,
          headers: {
            ...Object.fromEntries(request.headers.entries()),
            authorization: `Bearer ${ANALYSIS_TOKEN}`,
            'content-type': 'application/json',
          },
          body: await request.arrayBuffer(),
        })
      );
      const responseBody = await serviceResponse.text();
      analysisResponses.push({ status: serviceResponse.status, body: responseBody });
      lifecycleEvents.push(`analysis:${analysisCalls.at(-1)?.sourceType}`);
      return new HttpResponse(responseBody, {
        status: serviceResponse.status,
        headers: Object.fromEntries(serviceResponse.headers.entries()),
      });
    }),
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json() as {
        version: string;
        input?: { audio?: string; model?: string; stem?: string };
      };
      if (payload.version === YOUTUBE_VERSION) {
        return HttpResponse.json({
          id: 'real-analyzer-youtube-fetch',
          status: 'succeeded',
          output: {
            audio: 'https://replicate.delivery/real-analyzer-youtube.m4a',
            title: 'Real Analyzer YouTube Fixture',
            duration: 2,
          },
        });
      }
      assert.equal(payload.version, 'e2e-model-version');
      assert.ok(payload.input?.audio);
      assert.ok(payload.input?.model);
      separatorInputs.push({
        audio: payload.input.audio,
        model: payload.input.model,
        ...(payload.input.stem ? { stem: payload.input.stem } : {}),
      });
      lifecycleEvents.push(`separation:${separatorInputs.length}`);
      return HttpResponse.json({
        id: `real-analyzer-separation-${separatorInputs.length}`,
        status: 'starting',
      });
    }),
    http.get('https://replicate.delivery/real-analyzer-youtube.m4a', () =>
      new HttpResponse(youtubeAudio, {
        headers: {
          'Content-Type': 'audio/mp4',
          'Content-Length': String(youtubeAudio.byteLength),
        },
      })
    ),
    http.get(`https://archive.org/metadata/${archiveId}`, () =>
      HttpResponse.json({
        metadata: {
          identifier: archiveId,
          title: 'Real Analyzer Archive Fixture',
          creator: 'Fixture Collective',
          licenseurl: 'https://creativecommons.org/licenses/by/4.0/',
        },
        files: [
          {
            name: archiveFile,
            title: 'Fixture',
            format: 'WAVE',
            size: String(sourceAudio.byteLength),
            length: '2',
          },
        ],
      })
    ),
    http.get(`https://archive.org/download/${archiveId}/${archiveFile}`, () =>
      new HttpResponse(sourceAudio, {
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': String(sourceAudio.byteLength),
        },
      })
    ),
    http.get('https://api.replicate.com/v1/predictions/:id', () =>
      HttpResponse.json({ status: 'processing' })
    )
  );
  network.listen({ onUnhandledRequest: 'error' });

  try {
    const schema = schemaStatements(await readFile(SCHEMA_PATH, 'utf8'));
    const schemaResponse = await appRequest(harness, '/__e2e/schema', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schema),
    });
    assert.equal(schemaResponse.status, 200);

    const uploadKey = 'uploads/real-analyzer/source.wav';
    const upload = await appRequest(
      harness,
      `/__e2e/audio?key=${encodeURIComponent(uploadKey)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'audio/wav' },
        body: arrayBuffer(sourceAudio),
      }
    );
    assert.equal(upload.status, 204);

    const requests = [
      { key: uploadKey, filename: 'source.wav', model: 'auto' },
      { youtubeUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', model: 'auto' },
      { archiveId, archiveFile, model: 'auto' },
    ];
    const jobs = [];
    for (const body of requests) {
      const response = await harness.fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-class-code': CLASS_CODE,
        },
        body: JSON.stringify(body),
      });
      const responseBody = await response.json() as {
        model: string;
        sourceType: string;
        routingRequest: string;
        autoRouting: {
          analysis: {
            roleClassifier: { version: string };
            degraded: { active: boolean; code: string | null };
          };
        };
        error?: string;
      };
      assert.equal(response.status, 200, JSON.stringify(responseBody));
      jobs.push(responseBody);
    }

    assert.deepEqual(
      analysisCalls.map((call) => call.sourceType),
      ['upload', 'youtube', 'archive']
    );
    assert.deepEqual(
      analysisResponses.map((response) => response.status),
      [200, 200, 200]
    );
    assert.deepEqual(lifecycleEvents, [
      'analysis:upload',
      'separation:1',
      'analysis:youtube',
      'separation:2',
      'analysis:archive',
      'separation:3',
    ]);
    assert.match(
      new URL(analysisCalls[0].sourceUrl).pathname,
      /^\/api\/local-sources\/auto-inputs\/v1\//
    );
    assert.match(
      new URL(analysisCalls[1].sourceUrl).pathname,
      /^\/api\/local-sources\/uploads\/[^/]+\/source\.m4a$/
    );
    assert.match(
      new URL(analysisCalls[2].sourceUrl).pathname,
      /^\/api\/local-sources\/uploads\/[^/]+\/source\.wav$/
    );
    assert.equal(separatorInputs.length, 3);
    assert.deepEqual(
      separatorInputs.map((input) => ({ model: input.model, stem: input.stem })),
      [
        { model: 'htdemucs_ft', stem: 'vocals' },
        { model: 'htdemucs_ft', stem: 'vocals' },
        { model: 'htdemucs_ft', stem: 'vocals' },
      ],
      JSON.stringify({ jobs, analysisResponses })
    );
    assert.ok(separatorInputs.every((input) => input.model !== 'auto'));
    assert.deepEqual(
      jobs.map((job) => ({
        model: job.model,
        sourceType: job.sourceType,
        routingRequest: job.routingRequest,
        classifier: job.autoRouting.analysis.roleClassifier.version,
        degraded: job.autoRouting.analysis.degraded,
      })),
      [
        {
          model: 'vocals_instrumental',
          sourceType: 'upload',
          routingRequest: 'auto',
          classifier: 'autosplit-role-v4',
          degraded: { active: false, code: null },
        },
        {
          model: 'vocals_instrumental',
          sourceType: 'youtube',
          routingRequest: 'auto',
          classifier: 'autosplit-role-v4',
          degraded: { active: false, code: null },
        },
        {
          model: 'vocals_instrumental',
          sourceType: 'archive',
          routingRequest: 'auto',
          classifier: 'autosplit-role-v4',
          degraded: { active: false, code: null },
        },
      ]
    );
  } finally {
    network.close();
    await harness.close();
  }
});
