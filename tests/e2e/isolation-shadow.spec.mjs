import { test as base, expect } from '@playwright/test';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { createTestHarness } from 'wrangler';
import { schemaStatements } from './schema-statements.mjs';

const CLASS_CODE = 'isolation-shadow-e2e-class-code';
const TEACHER_PASSWORD = 'isolation-shadow-teacher-password';
const TEACHER_SEED = JSON.stringify([
  {
    username: 'shadowteacher',
    name: 'Shadow Teacher',
    salt: '00112233445566778899aabbccddeeff',
    hash: pbkdf2Sync(
      TEACHER_PASSWORD,
      Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      210_000,
      32,
      'sha256'
    ).toString('hex'),
    iterations: 210_000,
  },
]);
const E2E_SECRET = 'local-hosting-e2e-only';
const TEST_PUBLIC_BASE_URL = 'http://stem-splitter.test';
const AUDIOSEP_PIN = 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8';
const ANALYSIS_TOKEN = 'isolation-shadow-analysis-token-000000000000';
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
              QUERY_ISOLATION_ENABLED: 'true',
              QUERY_ISOLATION_MODE: 'shadow',
              REPLICATE_AUDIOSEP_VERSION: AUDIOSEP_PIN,
              AUDIO_ANALYSIS_URL: 'https://analysis.test',
              AUDIO_ANALYSIS_TIMEOUT_MS: '3000',
            },
            secrets: {
              R2_ACCESS_KEY_ID: 'e2e-r2-access-key',
              R2_SECRET_ACCESS_KEY: 'e2e-r2-secret-key',
              REPLICATE_API_TOKEN: 'provider-start-must-not-use-this-token',
              REPLICATE_MODEL_VERSION: 'e2e-model-version',
              WEBHOOK_SECRET: 'e2e-webhook-secret',
              CLASS_CODE,
              TEACHER_SEED,
              AUDIO_ANALYSIS_TOKEN: ANALYSIS_TOKEN,
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
  reset: [
    async ({ network, server }, use, testInfo) => {
      const schema = schemaStatements(await readFile(SCHEMA_PATH, 'utf8'));
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

const privateAutoRouting = {
  schemaVersion: '1',
  routingRequest: 'auto',
  sourceType: 'upload',
  mode: 'authoritative',
  applied: true,
  fallbackModel: 'htdemucs_ft',
  resolvedCoreModel: 'htdemucs_6s',
  analysis: {
    schemaVersion: '1',
    roleClassifier: { version: 'autosplit-role-v3' },
    vocabularyClassifier: {
      version: 'laion-larger-clap-music-pairwise-presence-rand-trunc-v1@a0b4534a14f58e20944452dff00a22a06ce629d1',
      weightsSha256: '5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1',
      vocabularyVersion: 'classroom-instruments-v1',
      vocabularySha256: '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140',
    },
    instrumentDiscovery: { status: 'complete', code: null, totalMs: 120, windowsAnalyzed: 3 },
    decision: {
      choice: 'six',
      resolvedCoreModel: 'htdemucs_6s',
      confidence: null,
      features: null,
      reason: 'reviewed core route',
    },
    detectedInstruments: [],
    timing: { totalMs: 200, analyzedSeconds: 45 },
    degraded: { active: false, code: null },
  },
  comparison: 'unavailable',
};

test('teacher isolation shadow fingerprints once, never starts a provider, and stays private', async ({
  network,
  server,
}) => {
  const jobId = 'isolation-shadow-job';
  const sourceKey = 'uploads/e2e/discovery.wav';
  const expectedHash = createHash('sha256').update(sourceAudio).digest('hex');
  const fingerprintCalls = [];

  network.use(
    http.post('https://analysis.test/v1/fingerprint', async ({ request }) => {
      // Miniflare's external-service loopback strips Authorization before MSW.
      // The HTTP-adapter unit test asserts the exact bearer header; this E2E
      // keeps its responsibility to stored-byte ordering and route behavior.
      const payload = await request.json();
      expect(payload).toEqual({
        schemaVersion: '1',
        sourceUrl: expect.any(String),
        sourceType: 'upload',
      });
      const signed = new URL(payload.sourceUrl);
      const ttl = Number(signed.searchParams.get('expires')) - Math.floor(Date.now() / 1000);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10 * 60 + 2);
      const stored = await server.fetch(payload.sourceUrl);
      expect(stored.status).toBe(200);
      const bytes = Buffer.from(await stored.arrayBuffer());
      expect(bytes.equals(sourceAudio)).toBe(true);
      fingerprintCalls.push(payload);
      return HttpResponse.json({
        schemaVersion: '1',
        source: { schemaVersion: '1', sha256: expectedHash, bytes: bytes.byteLength },
        timing: { totalMs: 12 },
      });
    })
  );

  const put = await e2eFetch(server, `/__e2e/audio?key=${encodeURIComponent(sourceKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/wav' },
    body: sourceAudio,
  });
  expect(put.status).toBe(204);
  const seeded = await e2eFetch(server, '/__e2e/job-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: jobId, analysis: privateAutoRouting }),
  });
  expect(seeded.status).toBe(200);

  const classCodeAttempt = await server.fetch(`/api/teacher/jobs/${jobId}/isolations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-class-code': CLASS_CODE },
    body: JSON.stringify({ target: 'bass clarinet' }),
  });
  expect(classCodeAttempt.status).toBe(401);
  expect(fingerprintCalls).toHaveLength(0);

  const login = await server.fetch('/api/teacher/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'shadowteacher', password: TEACHER_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  expect(cookie).toBeTruthy();
  const teacherHeaders = {
    'Content-Type': 'application/json',
    Cookie: cookie,
  };

  const invalid = await server.fetch(`/api/teacher/jobs/${jobId}/isolations`, {
    method: 'POST',
    headers: teacherHeaders,
    body: JSON.stringify({ target: 'x', surprise: true }),
  });
  expect(invalid.status).toBe(400);
  expect(fingerprintCalls).toHaveLength(0);

  const first = await server.fetch(`/api/teacher/jobs/${jobId}/isolations`, {
    method: 'POST',
    headers: teacherHeaders,
    body: JSON.stringify({ target: '  Bass   Clarinet ' }),
  });
  expect(first.status).toBe(201);
  const firstBody = await first.json();
  expect(firstBody).toMatchObject({
    jobId,
    created: true,
    rollout: 'shadow',
    providerStarted: false,
    isolation: {
      requestedBy: 'shadowteacher',
      target: 'bass clarinet',
      analysisVocabularyVersion: 'classroom-instruments-v1',
      rolloutStage: 'shadow',
      status: 'shadowed',
      attempts: 0,
      identity: {
        provider: 'replicate',
        model: 'cjwbw/audiosep',
        version: AUDIOSEP_PIN,
        contractVersion: 'audiosep-replicate-v1',
      },
    },
  });
  expect(JSON.stringify(firstBody)).not.toContain(expectedHash);
  expect(fingerprintCalls).toHaveLength(1);

  const duplicate = await server.fetch(`/api/teacher/jobs/${jobId}/isolations`, {
    method: 'POST',
    headers: teacherHeaders,
    body: JSON.stringify({ target: 'bass clarinet' }),
  });
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ created: false, providerStarted: false });
  expect(fingerprintCalls).toHaveLength(1);

  const second = await server.fetch(`/api/teacher/jobs/${jobId}/isolations`, {
    method: 'POST',
    headers: teacherHeaders,
    body: JSON.stringify({ target: 'santur' }),
  });
  expect(second.status).toBe(201);
  expect(await second.json()).toMatchObject({ created: true, providerStarted: false });
  expect(fingerprintCalls).toHaveLength(1);

  const overBudget = await server.fetch(`/api/teacher/jobs/${jobId}/isolations`, {
    method: 'POST',
    headers: teacherHeaders,
    body: JSON.stringify({ target: 'shekere' }),
  });
  expect(overBudget.status).toBe(409);
  expect(fingerprintCalls).toHaveLength(1);

  const history = await server.fetch(`/api/teacher/jobs/${jobId}/isolations`, {
    headers: { Cookie: cookie },
  });
  expect(history.status).toBe(200);
  const historyBody = await history.json();
  expect(historyBody.isolations).toHaveLength(2);
  expect(historyBody.isolations.every((item) => item.status === 'shadowed')).toBe(true);
  expect(JSON.stringify(historyBody)).not.toContain(expectedHash);

  const studentReadback = await server.fetch(`/api/jobs/${jobId}`);
  expect(studentReadback.status).toBe(200);
  const studentBody = await studentReadback.json();
  expect(studentBody.isolations).toBeUndefined();
  expect(JSON.stringify(studentBody)).not.toContain(expectedHash);

  const privateHash = await e2eFetch(
    server,
    `/__e2e/job-source-hash?job=${encodeURIComponent(jobId)}`
  );
  expect(privateHash.status).toBe(200);
  expect(await privateHash.json()).toEqual({ sourceHash: expectedHash });
});

function e2eFetch(server, path, init = {}) {
  return server.fetch(path, {
    ...init,
    headers: { 'x-e2e-secret': E2E_SECRET, ...(init.headers ?? {}) },
  });
}
