import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { createTestHarness } from 'wrangler';

const CLASS_CODE = 'server-auto-e2e-class-code';
const E2E_SECRET = 'local-hosting-e2e-only';
const TEST_PUBLIC_BASE_URL = 'http://stem-splitter.test';
const CONFIG_PATH = fileURLToPath(new URL('./wrangler.jsonc', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../../schema.sql', import.meta.url));
const SOURCE_AUDIO_PATH = fileURLToPath(new URL('../fixtures/audio/source.wav', import.meta.url));
const sourceAudio = await readFile(SOURCE_AUDIO_PATH);

const test = base.extend({
  network: [
    async ({}, use) => {
      const network = setupServer();
      network.listen({ onUnhandledRequest: 'error' });
      await use(network);
      network.close();
    },
    { scope: 'worker' },
  ],
  server: [
    async ({}, use) => {
      const server = createTestHarness({
        workers: [
          {
            configPath: CONFIG_PATH,
            vars: {
              LOCAL_HOSTING: 'true',
              PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL,
              SEPARATION_BACKEND: 'replicate',
              REPLICATE_YT_MODEL: 'test/yt-audio',
              REPLICATE_YT_MODEL_VERSION: 'e2e-youtube-version',
              YOUTUBE_FETCH_ORDER: 'replicate-first',
              SERVER_AUTO_ENABLED: 'true',
              SERVER_AUTO_MODE: 'authoritative',
              AUDIO_ANALYSIS_URL: 'https://analysis.test',
              AUDIO_ANALYSIS_TIMEOUT_MS: '3000',
            },
            secrets: {
              R2_ACCESS_KEY_ID: 'e2e-r2-access-key',
              R2_SECRET_ACCESS_KEY: 'e2e-r2-secret-key',
              REPLICATE_API_TOKEN: 'e2e-replicate-token',
              REPLICATE_MODEL_VERSION: 'e2e-model-version',
              WEBHOOK_SECRET: 'e2e-webhook-secret',
              CLASS_CODE,
              AUDIO_ANALYSIS_TOKEN: 'e2e-analysis-token-0000000000000000',
            },
          },
        ],
      });
      await server.listen();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ server }, use) => {
    const { url } = await server.listen();
    await use(url.href);
  },
  reset: [
    async ({ network, server }, use, testInfo) => {
      const schema = (await readFile(SCHEMA_PATH, 'utf8'))
        .replace(/--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      const setup = await e2eFetch(server, '/__e2e/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(schema),
      });
      expect(setup.status).toBe(200);
      await use();
      if (testInfo.status !== testInfo.expectedStatus) server.debug();
      network.resetHandlers();
      await server.reset();
    },
    { auto: true },
  ],
});

function analysisFixture(model = 'htdemucs_6s') {
  return {
    schemaVersion: '1',
    roleClassifier: { version: 'autosplit-role-v3' },
    decision: {
      choice: model === 'htdemucs_6s' ? 'six' : 'four',
      resolvedCoreModel: model,
      confidence: null,
      features: {
        onsetsPerSecond: 2.2,
        pitchedAttacksPerSecond: 1.1,
        sustainedLow: 0.16,
        percussiveHigh: 0.06,
        silent: false,
      },
      reason: 'plucked or hammered pitched layers — 6 parts can pull them out',
    },
    detectedInstruments: [],
    timing: { totalMs: 91, analyzedSeconds: 45 },
    degraded: { active: false, code: null },
  };
}

function makeM4a(size = 2048) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  return bytes;
}

function sourceHandlers({ network, server, analysisStatus = 200 }) {
  const youtubeAudio = makeM4a();
  const archiveId = 'server-auto-open-audio';
  const archiveFile = 'fixture.wav';
  const analysisCalls = [];
  const separatorInputs = [];
  let predictionCounter = 0;

  network.use(
    http.post('https://analysis.test/v1/analyze', async ({ request }) => {
      const payload = await request.json();
      const stored = await server.fetch(payload.sourceUrl);
      expect(stored.status).toBe(200);
      const bytes = Buffer.from(await stored.arrayBuffer());
      const expected = payload.sourceType === 'youtube' ? Buffer.from(youtubeAudio) : sourceAudio;
      expect(bytes.equals(expected)).toBe(true);
      const signed = new URL(payload.sourceUrl);
      const ttl = Number(signed.searchParams.get('expires')) - Math.floor(Date.now() / 1000);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10 * 60 + 2);
      analysisCalls.push(payload);
      return analysisStatus === 200
        ? HttpResponse.json(analysisFixture())
        : HttpResponse.json({ error: 'offline' }, { status: analysisStatus });
    }),
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      if (payload.version === 'e2e-youtube-version') {
        return HttpResponse.json({
          id: 'e2e-youtube-fetch',
          status: 'succeeded',
          output: {
            audio: 'https://replicate.delivery/server-auto-youtube.m4a',
            title: 'Server Auto YouTube Fixture',
            duration: 30,
          },
        });
      }
      expect(payload.version).toBe('e2e-model-version');
      separatorInputs.push(payload.input);
      predictionCounter += 1;
      return HttpResponse.json({ id: `e2e-separation-${predictionCounter}`, status: 'starting' });
    }),
    http.get('https://replicate.delivery/server-auto-youtube.m4a', ({ request }) => {
      return new HttpResponse(youtubeAudio, {
        headers: { 'Content-Type': 'audio/mp4', 'Content-Length': String(youtubeAudio.length) },
      });
    }),
    http.get(`https://archive.org/metadata/${archiveId}`, () =>
      HttpResponse.json({
        metadata: {
          identifier: archiveId,
          title: 'Server Auto Archive Fixture',
          creator: 'Fixture Collective',
          licenseurl: 'https://creativecommons.org/licenses/by/4.0/',
        },
        files: [
          {
            name: archiveFile,
            title: 'Fixture',
            format: 'WAVE',
            size: String(sourceAudio.length),
            length: '30',
          },
        ],
      })
    ),
    http.get(`https://archive.org/download/${archiveId}/${archiveFile}`, () =>
      new HttpResponse(sourceAudio, {
        headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(sourceAudio.length) },
      })
    ),
    http.get('https://api.replicate.com/v1/predictions/:id', () =>
      HttpResponse.json({ status: 'processing' })
    )
  );

  return { youtubeAudio, archiveId, archiveFile, analysisCalls, separatorInputs };
}

async function createAllSourceJobs(server) {
  const uploadKey = 'uploads/server-auto/source.wav';
  const put = await e2eFetch(server, `/__e2e/audio?key=${encodeURIComponent(uploadKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/wav' },
    body: sourceAudio,
  });
  expect(put.status).toBe(204);

  const requests = [
    { key: uploadKey, filename: 'source.wav', model: 'auto' },
    { youtubeUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', model: 'auto' },
    { archiveId: 'server-auto-open-audio', archiveFile: 'fixture.wav', model: 'auto' },
  ];
  const jobs = [];
  for (const body of requests) {
    const response = await server.fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-class-code': CLASS_CODE },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    jobs.push(await response.json());
  }
  return jobs;
}

test('authoritative server Auto analyzes stored upload, YouTube, and Archive audio', async ({
  network,
  server,
}) => {
  const state = sourceHandlers({ network, server });
  const jobs = await createAllSourceJobs(server);

  expect(state.analysisCalls.map((call) => call.sourceType)).toEqual(['upload', 'youtube', 'archive']);
  for (const call of state.analysisCalls) {
    expect(call.schemaVersion).toBe('1');
    expect(call.fallbackModel).toBe('htdemucs_ft');
    expect(call.coreModels.map((model) => model.id)).toEqual([
      'vocals_instrumental',
      'htdemucs_ft',
      'htdemucs_6s',
    ]);
  }
  expect(state.separatorInputs).toHaveLength(3);
  expect(state.separatorInputs.every((input) => input.model === 'htdemucs_6s')).toBe(true);
  expect(state.separatorInputs.some((input) => input.model === 'auto')).toBe(false);

  for (const [index, job] of jobs.entries()) {
    expect(job.model).toBe('htdemucs_6s');
    expect(job.expectedStems).toEqual(['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']);
    expect(job.routingRequest).toBe('auto');
    expect(job.sourceType).toBe(['upload', 'youtube', 'archive'][index]);
    expect(job.autoRouting.schemaVersion).toBe('1');
    expect(job.autoRouting.resolvedCoreModel).toBe('htdemucs_6s');
    expect(job.autoRouting.analysis.roleClassifier.version).toBe('autosplit-role-v3');

    const readback = await server.fetch(`/api/jobs/${job.id}`);
    expect(readback.status).toBe(200);
    const stored = await readback.json();
    expect(stored.autoRouting).toEqual(job.autoRouting);
    expect(stored.model).toBe('htdemucs_6s');
  }
});

test('authoritative Auto UI keeps auto unresolved until the server returns its decision', async ({
  network,
  page,
  server,
}) => {
  const state = sourceHandlers({ network, server });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.addInitScript((classCode) => localStorage.setItem('classCode', classCode), CLASS_CODE);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      get() {
        throw new Error('authoritative Auto must not predecode the source in the browser');
      },
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const auto = page.getByRole('radio', {
    name: 'Auto: listen after import and choose 2, 4, or 6 parts',
  });
  await expect(auto).toBeVisible();
  await auto.check();
  await expect(page.locator('#split-legend')).toHaveText(
    'listens after import, then picks 2, 4, or 6 parts'
  );

  await page.locator('#file-input').setInputFiles(SOURCE_AUDIO_PATH);
  await expect(page.locator('.console')).toHaveCount(1);
  await expect(page.locator('#upload-message')).toContainText('AUTO CHOSE 6 PARTS');
  const [created] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  expect(created.model).toBe('htdemucs_6s');
  expect(created.autoRouting.routingRequest).toBe('auto');
  expect(state.analysisCalls).toHaveLength(1);
  expect(state.separatorInputs[0].model).toBe('htdemucs_6s');
  expect(browserErrors).toEqual([]);
});

test('analyzer outage degrades every source to the frozen default without losing jobs', async ({
  network,
  server,
}) => {
  const state = sourceHandlers({ network, server, analysisStatus: 503 });
  const jobs = await createAllSourceJobs(server);

  expect(state.analysisCalls.map((call) => call.sourceType)).toEqual(['upload', 'youtube', 'archive']);
  expect(state.separatorInputs).toHaveLength(3);
  expect(state.separatorInputs.every((input) => input.model === 'htdemucs_ft')).toBe(true);
  for (const job of jobs) {
    expect(job.model).toBe('htdemucs_ft');
    expect(job.expectedStems).toEqual(['vocals', 'drums', 'bass', 'other']);
    expect(job.autoRouting.applied).toBe(false);
    expect(job.autoRouting.analysis.degraded).toEqual({
      active: true,
      code: 'analysis_unavailable',
    });
  }

  const analysisCount = state.analysisCalls.length;
  const explicitKey = 'uploads/explicit/source.wav';
  await e2eFetch(server, `/__e2e/audio?key=${encodeURIComponent(explicitKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/wav' },
    body: sourceAudio,
  });
  const explicit = await server.fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-class-code': CLASS_CODE },
    body: JSON.stringify({ key: explicitKey, filename: 'source.wav', model: 'vocals_instrumental' }),
  });
  expect(explicit.status).toBe(200);
  expect((await explicit.json()).model).toBe('vocals_instrumental');
  expect(state.analysisCalls).toHaveLength(analysisCount);
});

function e2eFetch(server, path, init = {}) {
  return server.fetch(path, {
    ...init,
    headers: { 'x-e2e-secret': E2E_SECRET, ...(init.headers ?? {}) },
  });
}
