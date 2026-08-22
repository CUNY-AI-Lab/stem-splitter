import { test as base, expect } from '@playwright/test';
import { pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { createTestHarness } from 'wrangler';
import { schemaStatements } from './schema-statements.mjs';

const CLASS_CODE = 'e2e-class-code';
const E2E_YOUTUBE_VERSION = 'b'.repeat(64);
// Fixture teacher, hashed the same way production credentials are. The
// plaintext exists only here, in a test, for an account that only exists here.
const TEACHER_PASSWORD = 'e2e-teacher-password';
const TEACHER_SEED = JSON.stringify([
  {
    username: 'e2eteacher',
    name: 'Instructor',
    salt: '00112233445566778899aabbccddeeff',
    hash: pbkdf2Sync(TEACHER_PASSWORD, Buffer.from('00112233445566778899aabbccddeeff', 'hex'), 210_000, 32, 'sha256').toString('hex'),
    iterations: 210_000,
  },
]);
const E2E_SECRET = 'local-hosting-e2e-only';
const TEST_PUBLIC_BASE_URL = 'http://stem-splitter.test';
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const CONFIG_PATH = fileURLToPath(new URL('./wrangler.jsonc', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../../schema.sql', import.meta.url));
const SOURCE_AUDIO_PATH = fileURLToPath(new URL('../fixtures/audio/source.wav', import.meta.url));

const sourceAudio = await readFile(SOURCE_AUDIO_PATH);
const stemAudio = new Map(
  await Promise.all(
    ['vocals', 'drums', 'bass', 'other'].map(async (name) => [
      name,
      await readFile(fileURLToPath(new URL(`../fixtures/audio/${name}.mp3`, import.meta.url))),
    ])
  )
);
// A valid MP3 roughly 45 dB below the other fixtures: quiet, but not silence.
const quietAudio = await readFile(
  fileURLToPath(new URL('../fixtures/audio/quiet.mp3', import.meta.url))
);

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
              REPLICATE_YT_MODEL_VERSION: E2E_YOUTUBE_VERSION,
              YOUTUBE_FETCH_ORDER: 'replicate-first',
            },
            secrets: {
              R2_ACCESS_KEY_ID: 'e2e-r2-access-key',
              R2_SECRET_ACCESS_KEY: 'e2e-r2-secret-key',
              REPLICATE_API_TOKEN: 'e2e-replicate-token-1',
              REPLICATE_MODEL_VERSION: 'e2e-model-version',
              WEBHOOK_SECRET: 'e2e-webhook-secret',
              CLASS_CODE,
              TEACHER_SEED,
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
      const schema = schemaStatements(await readFile(SCHEMA_PATH, 'utf8'));
      const setupResponse = await e2eFetch(server, '/__e2e/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(schema),
      });
      expect(setupResponse.status).toBe(200);

      await use();

      if (testInfo.status !== testInfo.expectedStatus) server.debug();
      network.resetHandlers();
      await server.reset();
    },
    { auto: true },
  ],
});

test('uploads and processes a real WAV through local R2 in a browser', async ({
  page,
  network,
  server,
}, testInfo) => {
  let signedSourceUrl = '';

  network.use(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      signedSourceUrl = payload.input.audio;
      expect(payload).toMatchObject({
        version: 'e2e-model-version',
        input: {
          model: 'htdemucs_ft',
          output_format: 'mp3',
          mp3_bitrate: 192,
        },
      });
      return HttpResponse.json({ id: 'e2e-prediction', status: 'starting' });
    }),
    http.get('https://api.replicate.com/v1/predictions/e2e-prediction', () =>
      HttpResponse.json({
        id: 'e2e-prediction',
        status: 'succeeded',
        output: Object.fromEntries(
          [...stemAudio.keys()].map((name) => [name, `https://fixtures.test/${name}.mp3`])
        ),
      })
    ),
    http.get('https://fixtures.test/:stem.mp3', ({ params }) => {
      const audio = stemAudio.get(String(params.stem));
      return audio
        ? new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
        : new HttpResponse(null, { status: 404 });
    })
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
    window.__e2eAudioElements = [];
    window.Audio = new Proxy(window.Audio, {
      construct(NativeAudio, args) {
        const audio = Reflect.construct(NativeAudio, args);
        window.__e2eAudioElements.push(audio);
        return audio;
      },
    });
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle('Stem Splitter');
  await expect(page.getByRole('heading', { name: /STEM SPLITTER/ })).toBeVisible();
  const labLink = page.getByRole('link', { name: 'CUNY AI Lab' });
  await expect(labLink).toBeVisible();
  await expect(labLink).toHaveAttribute('href', 'https://ailab.gc.cuny.edu');
  await expect(labLink.locator('img')).toHaveAttribute('src', '/cuny-ai-lab-logo.png');
  await expect(page.locator('#split-summary')).toHaveText('// 2, 4, or 6 parts per song');
  await expect(page.locator('#engine-summary')).toHaveText('SEPARATION MODEL: DEMUCS');
  await expect(
    page.getByRole('radio', { name: '4 parts: voice, percussion, low end, the rest' })
  ).toBeChecked();

  await page.locator('#file-input').setInputFiles(SOURCE_AUDIO_PATH);

  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('#upload-status')).toBeHidden();
  await expect(page.locator('.console-title')).toHaveText('source.wav');
  await expect(page.locator('.channel')).toHaveCount(4);
  await page.waitForFunction(
    () =>
      window.__e2eAudioElements.length === 4 &&
      window.__e2eAudioElements.every(
        (audio) =>
          audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
          Number.isFinite(audio.duration) &&
          audio.duration > 1.5
      )
  );
  const playButton = page.getByRole('button', { name: 'Play all stems' });
  await playButton.click();
  await expect(playButton).toHaveClass(/playing/);
  await expect
    .poll(() =>
      page.evaluate(() => Math.min(...window.__e2eAudioElements.map((audio) => audio.currentTime)))
    )
    .toBeGreaterThan(0.05);
  await playButton.click();
  await expect(playButton).not.toHaveClass(/playing/);
  expect(
    await page.evaluate(() => window.__e2eAudioElements.every((audio) => audio.paused))
  ).toBe(true);
  await page.getByRole('button', { name: 'Mute vocals' }).click();
  await expect(page.getByRole('button', { name: 'Mute vocals' })).toHaveAttribute('aria-pressed', 'true');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.export-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('source-export.zip');
  const zipBytes = await readFile(await download.path());
  expect(zipBytes.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
  const zipText = zipBytes.toString('latin1');
  for (const entry of [
    'stems/vocals.mp3',
    'stems/drums.mp3',
    'stems/bass.mp3',
    'stems/other.mp3',
    'guide-chat-and-notes.md',
  ]) {
    expect(zipText).toContain(entry);
  }
  expect(zipText).toContain('# source.wav');
  expect(zipText).toContain('listening session export');
  // The handoff to the browser is confirmed on the button itself — a fast
  // export otherwise flashes PACKING… too briefly to read as anything.
  await expect(page.locator('.export-btn')).toHaveText('SAVED ✓');
  await expect(page.locator('.export-btn')).toHaveText('EXPORT');

  await page.locator('.collapse-btn').click();
  await expect(page.locator('.console')).toHaveClass(/collapsed/);
  await expect(page.locator('.transport')).toBeHidden();
  const [{ collapsed }] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  expect(collapsed).toBe(true);
  await page.locator('.collapse-btn').click();
  await expect(page.locator('.transport')).toBeVisible();

  // Opening the + FOLDER popover on a collapsed console must expand it first:
  // a collapsed console hides every child below its head, so without the
  // expand the menu would render invisibly and the click would look dead.
  await page.evaluate(() => {
    instructor = { username: 'e2e', displayName: 'E2E' };
    document.body.classList.add('instructor');
  });
  await page.locator('.collapse-btn').click();
  await expect(page.locator('.console')).toHaveClass(/collapsed/);
  await page.locator('.folder-btn').click();
  await expect(page.locator('.console')).not.toHaveClass(/collapsed/);
  await expect(page.locator('.folder-menu')).toBeVisible();
  await expect(page.locator('.folder-menu')).toContainText('SAVE TO FOLDER');
  const [{ collapsed: collapsedAfterMenu }] = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jobs') || '[]')
  );
  expect(collapsedAfterMenu).toBe(false);
  // Collapsing owns the whole session state: an open folder chooser must be
  // removed, not merely hidden inside the collapsed console. Otherwise the
  // first + FOLDER press after reopening only closes that stale menu.
  await page.locator('.collapse-btn').click();
  await expect(page.locator('.console')).toHaveClass(/collapsed/);
  await expect(page.locator('.folder-menu')).toHaveCount(0);
  await page.locator('.collapse-btn').click();
  await expect(page.locator('.folder-menu')).toHaveCount(0);

  // Class-folder rows use the same explicit open/closed contract. Keep the
  // item list genuinely hidden until its folder heading is expanded, then
  // hide it again on the next press.
  await page.route('**/api/teacher/folders/folder-collapse-e2e', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        folder: { id: 'folder-collapse-e2e', name: 'Week 3', itemCount: 1 },
        items: [
          {
            jobId: 'folder-job-e2e',
            filename: 'folder-track.wav',
            available: true,
          },
        ],
      }),
    })
  );
  await page.evaluate(() => {
    folders = [{ id: 'folder-collapse-e2e', name: 'Week 3', itemCount: 1 }];
    foldersSection.hidden = false;
    renderFolders();
  });
  const folderOpen = page.locator('.folder-open');
  const folderItems = page.locator('.folder-items');
  await expect(folderItems).toBeHidden();
  await folderOpen.click();
  await expect(folderOpen).toHaveAttribute('aria-expanded', 'true');
  await expect(folderItems).toBeVisible();
  await expect(folderItems).toContainText('folder-track.wav');
  await folderOpen.click();
  await expect(folderOpen).toHaveAttribute('aria-expanded', 'false');
  await expect(folderItems).toBeHidden();
  await page.evaluate(() => {
    instructor = null;
    document.body.classList.remove('instructor');
  });

  expect(signedSourceUrl).toMatch(/^http:\/\/stem-splitter\.test\/api\/local-sources\//);
  const signedSourceResponse = await server.fetch(signedSourceUrl);
  expect(signedSourceResponse.status).toBe(200);
  expect(signedSourceResponse.headers.get('content-length')).toBe(String(sourceAudio.length));
  expect(Buffer.from(await signedSourceResponse.arrayBuffer()).equals(sourceAudio)).toBe(true);

  const [{ id: jobId, model: storedModel }] = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jobs') || '[]')
  );
  expect(storedModel).toBe('htdemucs_ft');

  // A terminal SSE event must finish the UI even when an intermediary keeps
  // the HTTP response open. This is the Railway failure mode that previously
  // left a completed, cached guide on “READING THE CHARTS…” until reload.
  await page.evaluate((id) => {
    const nativeFetch = window.fetch.bind(window);
    let intercepted = false;
    window.__e2eGuideStreamCancelled = false;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!intercepted && url.endsWith(`/api/jobs/${id}/guide`)) {
        intercepted = true;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'done',
                  text: 'Start with the other channel and listen for the ensemble texture.',
                  model: 'e2e-guide',
                  createdAt: '2026-08-18T00:00:00.000Z',
                })}\n\n`
              )
            );
          },
          cancel() {
            window.__e2eGuideStreamCancelled = true;
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          })
        );
      }
      return nativeFetch(input, init);
    };
  }, jobId);
  await page.getByRole('button', { name: 'CUE THE LISTENING GUIDE' }).click();
  await expect(page.locator('.coach-guide-text')).toContainText(
    'Start with the other channel and listen for the ensemble texture.'
  );
  await expect(page.getByText('READING THE CHARTS…', { exact: true })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__e2eGuideStreamCancelled))
    .toBe(true);

  // Resetting the Listening Guy conversation takes a two-step confirm and
  // clears the stored per-song archive while the cached guide stays rendered.
  await page.evaluate(
    (id) => localStorage.setItem(`coachChat:${id}`, JSON.stringify([{ kind: 'you', text: 'hello' }])),
    jobId
  );
  const resetBtn = page.locator('.coach-reset');
  await resetBtn.click();
  await expect(resetBtn).toHaveText('SURE?');
  await resetBtn.click();
  await expect(resetBtn).toHaveText('RESET');
  expect(await page.evaluate((id) => localStorage.getItem(`coachChat:${id}`), jobId)).toBeNull();
  await expect(page.locator('.coach-guide-text')).toBeVisible();

  const storedStemResponse = await server.fetch(`/api/files/stems/${jobId}/vocals.mp3`);
  expect(storedStemResponse.status).toBe(200);
  expect(storedStemResponse.headers.get('content-length')).toBe(
    String(stemAudio.get('vocals').length)
  );
  expect(Buffer.from(await storedStemResponse.arrayBuffer()).equals(stemAudio.get('vocals'))).toBe(true);

  const storedKeysResponse = await e2eFetch(server, '/__e2e/audio');
  expect(storedKeysResponse.status).toBe(200);
  const { keys: storedKeys } = await storedKeysResponse.json();
  expect(storedKeys).toEqual([
    `stems/${jobId}/bass.mp3`,
    `stems/${jobId}/drums.mp3`,
    `stems/${jobId}/other.mp3`,
    `stems/${jobId}/vocals.mp3`,
    expect.stringMatching(/^uploads\/[0-9a-f-]+\/source\.wav$/),
  ]);
  expect(browserErrors).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath('local-hosting-ready.png'), fullPage: false });

  await page.route(`**/api/files/stems/${jobId}/vocals.mp3`, (route) =>
    route.fulfill({ status: 404, body: 'Not found' })
  );
  await page.reload();
  await expect(page.locator('.badge.failed')).toHaveText('AUDIO ERROR');
  const unavailableChannel = page.locator('.channel.unavailable');
  await expect(unavailableChannel).toHaveCount(1);
  await expect(unavailableChannel.locator('.ch-name')).toHaveText('vocals');
  await expect(unavailableChannel.locator('.mute-btn')).toHaveText('NO AUDIO');
  await expect(page.getByRole('button', { name: 'Play all stems' })).toBeDisabled();

  // Students never see the instructor save-to-folder control.
  await expect(page.locator('.folder-btn')).toBeHidden();

  // Deleting a split is local and two-step: the rack entry and its stored chat
  // go, while the server copy stays fetchable for the rest of the class.
  const deleteBtn = page.locator('.console .delete-btn');
  await deleteBtn.click();
  await expect(deleteBtn).toHaveText('SURE?');
  await deleteBtn.click();
  await expect(page.locator('.console')).toHaveCount(0);
  await expect(page.locator('#empty-state')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'))).toEqual([]);
  const stillOnServer = await server.fetch(`/api/jobs/${jobId}`);
  expect(stillOnServer.status).toBe(200);
});

test('flags off preserve the catalogue shape and reject auto as a server model', async ({ server }) => {
  const optionsResponse = await server.fetch('/api/separation-options');
  expect(optionsResponse.status).toBe(200);
  expect(await optionsResponse.json()).toEqual({
    backend: 'replicate',
    defaultModel: 'htdemucs_ft',
    models: [
      {
        id: 'vocals_instrumental',
        stems: ['vocals', 'instrumental'],
        label: '2 parts: voice, everything else',
        engine: 'DEMUCS',
      },
      {
        id: 'htdemucs_ft',
        stems: ['vocals', 'drums', 'bass', 'other'],
        label: '4 parts: voice, percussion, low end, the rest',
        engine: 'DEMUCS',
      },
      {
        id: 'htdemucs_6s',
        stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
        label: '6 parts: adds plucked strings and keys',
        engine: 'DEMUCS',
      },
    ],
  });

  const autoResponse = await server.fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-class-code': CLASS_CODE },
    body: JSON.stringify({ model: 'auto', key: 'uploads/not-used/source.wav', filename: 'source.wav' }),
  });
  expect(autoResponse.status).toBe(400);
  expect(await autoResponse.json()).toEqual({
    error: 'Unknown model. Allowed: vocals_instrumental, htdemucs_ft, htdemucs_6s',
  });
});

test('renames Demucs no_vocals to instrumental for the two-track split', async ({
  page,
  network,
  server,
}, testInfo) => {
  const predictionId = 'e2e-two-track';

  network.use(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      // The catalogue drives the payload: karaoke mode on the same pinned version.
      expect(payload).toMatchObject({
        version: 'e2e-model-version',
        input: {
          model: 'htdemucs_ft',
          stem: 'vocals',
          output_format: 'mp3',
          mp3_bitrate: 192,
        },
      });
      return HttpResponse.json({ id: predictionId, status: 'starting' });
    }),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({
        id: predictionId,
        status: 'succeeded',
        // Demucs names the summed remainder no_vocals, not instrumental.
        output: {
          vocals: 'https://fixtures.test/vocals.mp3',
          no_vocals: 'https://fixtures.test/other.mp3',
        },
      })
    ),
    http.get('https://fixtures.test/:stem.mp3', ({ params }) => {
      const audio = stemAudio.get(String(params.stem));
      return audio
        ? new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
        : new HttpResponse(null, { status: 404 });
    })
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const twoTrackChoice = page.getByRole('radio', {
    name: '2 parts: voice, everything else',
  });
  await expect(twoTrackChoice).toBeVisible();
  await twoTrackChoice.check();
  await page.locator('#file-input').setInputFiles(SOURCE_AUDIO_PATH);

  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('.channel')).toHaveCount(2);
  await expect(page.locator('.ch-name')).toHaveText(['vocals', 'instrumental']);
  await page.screenshot({
    path: testInfo.outputPath('two-track-ready.png'),
    fullPage: true,
  });

  const [created] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  expect(created.model).toBe('vocals_instrumental');
  expect(created.expectedStems).toEqual(['vocals', 'instrumental']);

  const resultResponse = await server.fetch(`/api/jobs/${created.id}`);
  expect(resultResponse.status).toBe(200);
  const result = await resultResponse.json();
  expect(result.status).toBe('done');
  expect(result.stems.map((stem) => stem.name)).toEqual(['vocals', 'instrumental']);

  const storedKeysResponse = await e2eFetch(server, '/__e2e/audio');
  const storedKeys = (await storedKeysResponse.json()).keys;
  // Stored under the contract name, so /api/files and the mixer agree.
  expect(storedKeys).toContain(`stems/${created.id}/instrumental.mp3`);
  expect(storedKeys).not.toContain(`stems/${created.id}/no_vocals.mp3`);
  expect(browserErrors).toEqual([]);
});

// Classifier accuracy lives in tests/autosplit.test.mts. This covers the
// browser wiring, worker boundary, and the invariant that the paid API never
// receives the UI-only model id "auto".
test('AUTO listens to a local upload and resolves to a real split', async ({ page, network }) => {
  const predictionId = 'e2e-auto';
  let requestedInput = null;

  const outputFor = (input) => {
    if (input.stem === 'vocals') {
      return {
        vocals: 'https://auto-fixtures.test/vocals.mp3',
        no_vocals: 'https://auto-fixtures.test/other.mp3',
      };
    }
    const names = input.model === 'htdemucs_6s'
      ? ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']
      : ['vocals', 'drums', 'bass', 'other'];
    return Object.fromEntries(
      names.map((name) => [name, `https://auto-fixtures.test/${name}.mp3`])
    );
  };

  network.use(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      requestedInput = (await request.json()).input;
      return HttpResponse.json({ id: predictionId, status: 'starting' });
    }),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({
        id: predictionId,
        status: 'succeeded',
        output: outputFor(requestedInput),
      })
    ),
    http.get('https://auto-fixtures.test/:stem.mp3', ({ params }) => {
      const audio = stemAudio.get(String(params.stem)) ?? stemAudio.get('other');
      return new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
    })
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const auto = page.getByRole('radio', {
    name: 'Auto: listen to a local file and choose 2, 4, or 6 parts',
  });
  await expect(auto).toBeVisible();
  await auto.check();
  await expect(page.locator('#split-legend')).toHaveText(
    'Processes local audio, then splits into either 2, 4, or 6 parts'
  );

  await page.locator('#file-input').setInputFiles(SOURCE_AUDIO_PATH);
  await expect(page.locator('.badge.ready')).toHaveText('READY');

  const [created] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  // The fixture is sustained and routes to two tracks. A metadata/decode
  // failure would silently use the four-track catalogue default instead.
  expect(created.model).toBe('vocals_instrumental');
  await expect(page.locator('.channel')).toHaveCount(created.expectedStems.length);
  expect(requestedInput).toBeTruthy();
  expect(browserErrors).toEqual([]);
});

test('fails an incomplete six-track result instead of rendering blank channels', async ({
  page,
  network,
  server,
}, testInfo) => {
  const predictionId = 'e2e-incomplete-six-track';
  const fourTrackOutput = Object.fromEntries(
    [...stemAudio.keys()].map((name) => [name, `https://unused-fixtures.test/${name}.mp3`])
  );

  network.use(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      expect(payload.input.model).toBe('htdemucs_6s');
      return HttpResponse.json({ id: predictionId, status: 'starting' });
    }),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({
        id: predictionId,
        status: 'succeeded',
        output: fourTrackOutput,
      })
    )
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const sixTrackChoice = page.getByRole('radio', {
    name: '6 parts: adds plucked strings and keys',
  });
  await expect(sixTrackChoice).toBeVisible();
  await sixTrackChoice.check();
  await page.locator('#file-input').setInputFiles(SOURCE_AUDIO_PATH);

  await expect(page.locator('.badge.failed')).toHaveText('FAILED');
  await expect(page.locator('.job-error')).toContainText('6-track split was incomplete');
  await expect(page.locator('.channel')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('incomplete-six-track-failed.png'),
    fullPage: true,
  });

  const [created] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  expect(created.model).toBe('htdemucs_6s');
  expect(created.expectedStems).toEqual([
    'vocals',
    'drums',
    'bass',
    'other',
    'guitar',
    'piano',
  ]);

  const resultResponse = await server.fetch(`/api/jobs/${created.id}`);
  expect(resultResponse.status).toBe(200);
  const result = await resultResponse.json();
  expect(result.status).toBe('failed');
  expect(result.stems).toEqual([]);
  expect(result.error).toContain('6-track split was incomplete');
  expect(result.error).toContain('missing guitar, piano');

  const storedKeysResponse = await e2eFetch(server, '/__e2e/audio');
  expect((await storedKeysResponse.json()).keys).toEqual([
    expect.stringMatching(/^uploads\/[0-9a-f-]+\/source\.wav$/),
  ]);
  expect(browserErrors).toEqual([]);
});

test('imports authenticated YouTube audio and runs the selected six-track split', async ({
  page,
  network,
  server,
}) => {
  const youtubeAudio = makeM4a();
  const youtubeVideoId = 'jNQXAC9IVRw';
  const separationId = 'e2e-youtube-six-track';
  const sixTrackNames = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];

  network.use(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      if (payload.input.url) {
        expect(payload).toEqual({
          version: E2E_YOUTUBE_VERSION,
          input: {
            url: `https://www.youtube.com/watch?v=${youtubeVideoId}`,
            max_duration: 900,
          },
        });
        return HttpResponse.json({
          id: 'e2e-youtube-fetch',
          status: 'succeeded',
          output: {
            audio: 'https://fixtures.replicate.delivery/imported.m4a',
            title: 'Fixture Track Delta',
            duration: 19,
          },
        });
      }

      expect(payload.input.model).toBe('htdemucs_6s');
      return HttpResponse.json({ id: separationId, status: 'starting' });
    }),
    http.get('https://fixtures.replicate.delivery/imported.m4a', () => {
      return new HttpResponse(youtubeAudio, {
        headers: {
          'Content-Type': 'audio/mp4',
          'Content-Length': String(youtubeAudio.length),
        },
      });
    }),
    http.get(`https://api.replicate.com/v1/predictions/${separationId}`, () =>
      HttpResponse.json({
        id: separationId,
        status: 'succeeded',
        output: Object.fromEntries(
          sixTrackNames.map((name) => [name, `https://youtube-stems.test/${name}.mp3`])
        ),
      })
    ),
    http.get('https://youtube-stems.test/:stem.mp3', ({ params }) => {
      const name = String(params.stem);
      const audio = stemAudio.get(name) ?? stemAudio.get('other');
      return new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
    })
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('radio', {
      name: '6 parts: adds plucked strings and keys',
    })
    .check();
  await page.getByText('Or paste a YouTube link').click();
  await page.getByLabel('YouTube link').fill(
    `https://www.youtube.com/watch?v=${youtubeVideoId}`
  );
  await page.getByRole('button', { name: 'FETCH' }).click();

  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('.console-title')).toHaveText('Fixture Track Delta');
  await expect(page.locator('.channel')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'FETCH' })).toBeEnabled();

  const [created] = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jobs') || '[]')
  );
  expect(created.model).toBe('htdemucs_6s');
  expect(created.expectedStems).toEqual(sixTrackNames);

  const storedKeysResponse = await e2eFetch(server, '/__e2e/audio');
  const { keys } = await storedKeysResponse.json();
  const sourceKey = keys.find((key) => /^uploads\/[0-9a-f-]+\/source\.m4a$/.test(key));
  expect(sourceKey).toBeTruthy();
  const storedSource = await e2eFetch(
    server,
    `/__e2e/audio?key=${encodeURIComponent(sourceKey)}`
  );
  expect(storedSource.status).toBe(200);
  expect(storedSource.headers.get('content-length')).toBe(String(youtubeAudio.length));
  expect(Buffer.from(await storedSource.arrayBuffer()).equals(youtubeAudio)).toBe(true);
  expect(browserErrors).toEqual([]);
  if (process.env.YOUTUBE_QA_SCREENSHOT) {
    await page.screenshot({ path: process.env.YOUTUBE_QA_SCREENSHOT, fullPage: true });
  }
});

test('completes a six-track split whose guitar and piano tracks are near-silent', async ({
  page,
  network,
  server,
}, testInfo) => {
  const predictionId = 'e2e-quiet-six-track';
  const sixTrackNames = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
  // Orchestral material has no guitar and no piano to find, so those tracks come
  // back quiet but perfectly valid. The job must still finish: the gate added in
  // da6ed33 rejects unplayable audio, not quiet audio, and conflating the two
  // would fail every orchestral six-track split in the class.
  const quietNames = new Set(['guitar', 'piano']);

  network.use(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      expect(payload.input.model).toBe('htdemucs_6s');
      return HttpResponse.json({ id: predictionId, status: 'starting' });
    }),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({
        id: predictionId,
        status: 'succeeded',
        output: Object.fromEntries(
          sixTrackNames.map((name) => [name, `https://quiet-fixtures.test/${name}.mp3`])
        ),
      })
    ),
    http.get('https://quiet-fixtures.test/:stem.mp3', ({ params }) => {
      const name = String(params.stem);
      const audio = quietNames.has(name) ? quietAudio : stemAudio.get(name);
      return new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
    })
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
    window.__e2eAudioElements = [];
    window.Audio = new Proxy(window.Audio, {
      construct(NativeAudio, args) {
        const audio = Reflect.construct(NativeAudio, args);
        window.__e2eAudioElements.push(audio);
        return audio;
      },
    });
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('radio', {
      name: '6 parts: adds plucked strings and keys',
    })
    .check();
  await page.locator('#file-input').setInputFiles(SOURCE_AUDIO_PATH);

  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('.channel')).toHaveCount(6);
  // Quiet is not the same as broken: no channel may render as unplayable.
  await expect(page.locator('.channel.unavailable')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play all stems' })).toBeEnabled();
  await page.waitForFunction(
    () =>
      window.__e2eAudioElements.length === 6 &&
      window.__e2eAudioElements.every(
        (audio) => audio.readyState >= HTMLMediaElement.HAVE_METADATA
      )
  );
  await page.screenshot({
    path: testInfo.outputPath('quiet-six-track-ready.png'),
    fullPage: true,
  });

  const [created] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  const resultResponse = await server.fetch(`/api/jobs/${created.id}`);
  const result = await resultResponse.json();
  expect(result.status).toBe('done');
  expect(result.error).toBeNull();
  expect(result.stems.map((stem) => stem.name)).toEqual(sixTrackNames);

  // The quiet tracks were stored verbatim rather than dropped or substituted.
  for (const name of quietNames) {
    const stored = await server.fetch(`/api/files/stems/${created.id}/${name}.mp3`);
    expect(stored.status).toBe(200);
    expect(Buffer.from(await stored.arrayBuffer()).equals(quietAudio)).toBe(true);
  }
  expect(browserErrors).toEqual([]);
});

test('imports a YouTube link and renames no_vocals for the two-track split', async ({
  page,
  network,
  server,
}) => {
  const youtubeAudio = makeM4a();
  const youtubeVideoId = 'dQw4w9WgXcQ';
  const separationId = 'e2e-youtube-two-track';

  network.use(
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      if (payload.input.url) {
        expect(payload).toEqual({
          version: E2E_YOUTUBE_VERSION,
          input: {
            url: `https://www.youtube.com/watch?v=${youtubeVideoId}`,
            max_duration: 900,
          },
        });
        return HttpResponse.json({
          id: 'e2e-youtube-two-track-fetch',
          status: 'succeeded',
          output: {
            audio: 'https://fixtures.replicate.delivery/two-track.m4a',
            title: 'Fixture Duet Epsilon',
            duration: 22,
          },
        });
      }

      // An imported source runs the same catalogue-driven karaoke payload as an
      // uploaded one — the import path must not smuggle in its own model wiring.
      expect(payload).toMatchObject({
        version: 'e2e-model-version',
        input: {
          model: 'htdemucs_ft',
          stem: 'vocals',
          output_format: 'mp3',
          mp3_bitrate: 192,
        },
      });
      return HttpResponse.json({ id: separationId, status: 'starting' });
    }),
    http.get('https://fixtures.replicate.delivery/two-track.m4a', () =>
      new HttpResponse(youtubeAudio, {
        headers: {
          'Content-Type': 'audio/mp4',
          'Content-Length': String(youtubeAudio.length),
        },
      })
    ),
    http.get(`https://api.replicate.com/v1/predictions/${separationId}`, () =>
      HttpResponse.json({
        id: separationId,
        status: 'succeeded',
        output: {
          vocals: 'https://youtube-two-track.test/vocals.mp3',
          no_vocals: 'https://youtube-two-track.test/other.mp3',
        },
      })
    ),
    http.get('https://youtube-two-track.test/:stem.mp3', ({ params }) =>
      new HttpResponse(stemAudio.get(String(params.stem)), {
        headers: { 'Content-Type': 'audio/mpeg' },
      })
    )
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('radio', { name: '2 parts: voice, everything else' }).check();
  await page.getByText('Or paste a YouTube link').click();
  await page.getByLabel('YouTube link').fill(
    `https://www.youtube.com/watch?v=${youtubeVideoId}`
  );
  await page.getByRole('button', { name: 'FETCH' }).click();

  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('.console-title')).toHaveText('Fixture Duet Epsilon');
  await expect(page.locator('.channel')).toHaveCount(2);
  await expect(page.locator('.ch-name')).toHaveText(['vocals', 'instrumental']);

  const [created] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  expect(created.model).toBe('vocals_instrumental');
  expect(created.expectedStems).toEqual(['vocals', 'instrumental']);

  const storedKeysResponse = await e2eFetch(server, '/__e2e/audio');
  const { keys } = await storedKeysResponse.json();
  expect(keys).toContain(`stems/${created.id}/instrumental.mp3`);
  expect(keys).not.toContain(`stems/${created.id}/no_vocals.mp3`);
  expect(keys.some((key) => /^uploads\/[0-9a-f-]+\/source\.m4a$/.test(key))).toBe(true);
  expect(browserErrors).toEqual([]);
});

test('browses the Internet Archive crate and splits an open-licensed track', async ({
  page,
  network,
  server,
}) => {
  const archiveAudio = stemAudio.get('vocals');
  const identifier = 'e2e-open-netlabel-release';
  const trackFile = '01-fixture-track.mp3';
  const separationId = 'e2e-archive-separation';
  const stemNames = ['vocals', 'drums', 'bass', 'other'];
  let searchQuery = '';

  network.use(
    http.get('https://archive.org/advancedsearch.php', ({ request }) => {
      searchQuery = new URL(request.url).searchParams.get('q') ?? '';
      return HttpResponse.json({
        response: {
          numFound: 1,
          docs: [
            {
              identifier,
              title: 'Fixture Netlabel Release',
              creator: 'Fixture Collective',
              licenseurl: 'http://creativecommons.org/licenses/by-nc-sa/4.0/',
              year: '2019',
              downloads: 4211,
            },
          ],
        },
      });
    }),
    http.get(`https://archive.org/metadata/${identifier}`, () =>
      HttpResponse.json({
        metadata: {
          identifier,
          title: 'Fixture Netlabel Release',
          creator: 'Fixture Collective',
          licenseurl: 'http://creativecommons.org/licenses/by-nc-sa/4.0/',
          year: '2019',
        },
        files: [
          { name: trackFile, format: 'VBR MP3', size: String(archiveAudio.length), length: '21.5' },
          // A derivative of the same track: the picker must collapse it away.
          { name: '01-fixture-track.ogg', format: 'Ogg Vorbis', size: '4096', length: '21.5' },
          // Over the 5-minute cap: excluded from the picker entirely.
          { name: '02-long-set.mp3', format: 'VBR MP3', size: '8192', length: '3600' },
          { name: 'cover.jpg', format: 'JPEG', size: '2048' },
        ],
      })
    ),
    http.get(`https://archive.org/download/${identifier}/${trackFile}`, () =>
      new HttpResponse(archiveAudio, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(archiveAudio.length),
        },
      })
    ),
    http.post('https://api.replicate.com/v1/predictions', () =>
      HttpResponse.json({ id: separationId, status: 'starting' })
    ),
    http.get(`https://api.replicate.com/v1/predictions/${separationId}`, () =>
      HttpResponse.json({
        id: separationId,
        status: 'succeeded',
        output: Object.fromEntries(
          stemNames.map((name) => [name, `https://archive-stems.test/${name}.mp3`])
        ),
      })
    ),
    http.get('https://archive-stems.test/:stem.mp3', ({ params }) => {
      const audio = stemAudio.get(String(params.stem)) ?? stemAudio.get('other');
      return new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
    })
  );

  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Archive audio is not present in the browser before the import request.
  // AUTO must state that limitation and resolve to the catalogue default,
  // never send the UI-only id to the Worker.
  await page.getByRole('radio', {
    name: 'Auto: listen to a local file and choose 2, 4, or 6 parts',
  }).check();

  // Opening the crate runs the default search.
  await page.getByRole('button', { name: /BROWSE THE CRATE/ }).click();
  await expect(page.locator('.crate-item')).toHaveCount(1);
  await expect(page.locator('.crate-license')).toHaveText('CC BY-NC-SA 4.0');

  // The licence floor and collection scope are pinned server-side.
  expect(searchQuery).toContain('mediatype:audio');
  expect(searchQuery).toContain('NOT licenseurl:*-nd*');
  expect(searchQuery).toContain('collection:netlabels');

  await page.locator('.crate-item-head').click();
  // One row: the ogg derivative collapses away and the hour-long set is hidden.
  await expect(page.locator('.crate-track')).toHaveCount(1);
  await expect(page.locator('.crate-track-len').first()).toHaveText('0:21');
  await expect(page.locator('.crate-credit')).toContainText('1 track over 5:00 not shown');
  if (process.env.ARCHIVE_QA_SCREENSHOT) {
    await page.screenshot({ path: process.env.ARCHIVE_QA_SCREENSHOT, fullPage: true });
  }

  await page.getByRole('button', { name: 'SPLIT' }).click();

  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('.console-title')).toHaveText('Fixture Collective - fixture-track');
  await expect(page.locator('.channel')).toHaveCount(4);

  const [created] = await page.evaluate(() => JSON.parse(localStorage.getItem('jobs') || '[]'));
  expect(created.model).toBe('htdemucs_ft');

  const storedKeysResponse = await e2eFetch(server, '/__e2e/audio');
  const { keys } = await storedKeysResponse.json();
  const sourceKey = keys.find((key) => /^uploads\/[0-9a-f-]+\/source\.mp3$/.test(key));
  expect(sourceKey).toBeTruthy();
  const storedSource = await e2eFetch(
    server,
    `/__e2e/audio?key=${encodeURIComponent(sourceKey)}`
  );
  expect(storedSource.status).toBe(200);
  expect(Buffer.from(await storedSource.arrayBuffer()).equals(archiveAudio)).toBe(true);
  expect(browserErrors).toEqual([]);
});

test('refuses a NoDerivatives Internet Archive item', async ({ page, network }) => {
  const identifier = 'e2e-nd-licensed-release';

  network.use(
    http.get('https://archive.org/advancedsearch.php', () =>
      HttpResponse.json({
        response: {
          numFound: 1,
          docs: [
            {
              identifier,
              title: 'No Derivatives Release',
              creator: 'Fixture Collective',
              licenseurl: 'http://creativecommons.org/licenses/by-nc-sa/4.0/',
            },
          ],
        },
      })
    ),
    // Stale index: the item itself carries an ND licence, so expanding it must
    // fail closed. Uses the CC v1.0 "nd-nc" path shape deliberately — it has no
    // "-nd" infix, so a substring check would (and once did) let it through.
    http.get(`https://archive.org/metadata/${identifier}`, () =>
      HttpResponse.json({
        metadata: {
          identifier,
          title: 'No Derivatives Release',
          licenseurl: 'http://creativecommons.org/licenses/nd-nc/1.0/',
        },
        files: [{ name: 'track.mp3', format: 'VBR MP3', size: '4096', length: '20' }],
      })
    )
  );

  await page.addInitScript((classCode) => {
    localStorage.setItem('classCode', classCode);
  }, CLASS_CODE);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /BROWSE THE CRATE/ }).click();
  await page.locator('.crate-item-head').click();

  await expect(page.locator('.crate-loading.error')).toContainText('NoDerivatives');
  await expect(page.locator('.crate-track')).toHaveCount(0);
});

test('fails an empty MP3 response and removes partial track files', async ({ network, server }) => {
  const predictionId = 'e2e-empty-track';
  const sourceKey = 'uploads/e2e/empty-track.wav';
  const output = Object.fromEntries(
    [...stemAudio.keys()].map((name) => [name, `https://empty-fixtures.test/${name}.mp3`])
  );
  const fixtureFetches = new Map([...stemAudio.keys()].map((name) => [name, 0]));

  network.use(
    http.post('https://api.replicate.com/v1/predictions', () =>
      HttpResponse.json({ id: predictionId, status: 'starting' })
    ),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({ id: predictionId, status: 'succeeded', output })
    ),
    http.get('https://empty-fixtures.test/:stem.mp3', ({ params }) => {
      const name = String(params.stem);
      fixtureFetches.set(name, (fixtureFetches.get(name) ?? 0) + 1);
      if (name === 'bass') {
        return new HttpResponse(new Uint8Array(), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }
      return new HttpResponse(stemAudio.get(name), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    })
  );

  expect(
    (
      await e2eFetch(server, `/__e2e/audio?key=${encodeURIComponent(sourceKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'audio/wav' },
        body: sourceAudio,
      })
    ).status
  ).toBe(204);

  const createResponse = await server.fetch('/api/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-class-code': CLASS_CODE,
    },
    body: JSON.stringify({
      key: sourceKey,
      filename: 'generic-source.wav',
      model: 'htdemucs_ft',
    }),
  });
  expect(createResponse.status).toBe(200);
  const { id: jobId } = await createResponse.json();

  const resultResponse = await server.fetch(`/api/jobs/${jobId}`);
  expect(resultResponse.status).toBe(200);
  const result = await resultResponse.json();
  expect(result.status).toBe('failed');
  expect(result.stems).toEqual([]);
  expect(result.error).toBe('The "bass" track was empty or was not a playable MP3');
  expect(fixtureFetches.get('vocals')).toBe(1);
  expect(fixtureFetches.get('drums')).toBe(1);
  expect(fixtureFetches.get('bass')).toBe(3);
  expect(fixtureFetches.get('other')).toBe(0);

  const storedKeysResponse = await e2eFetch(server, '/__e2e/audio');
  expect((await storedKeysResponse.json()).keys).toEqual([sourceKey]);
});

test('rejects a chunked local upload before reading it', async ({ baseURL, server }) => {
  const response = await putChunked(
    new URL('/api/local-uploads/uploads/e2e/chunked.wav', baseURL),
    sourceAudio
  );
  expect(response.status).toBe(411);
  expect(response.body).toContain('Content-Length is required');

  const headResponse = await e2eFetch(
    server,
    '/__e2e/audio?key=uploads%2Fe2e%2Fchunked.wav',
    { method: 'HEAD' }
  );
  expect(headResponse.status).toBe(404);
});

test('rejects oversized declarations and removes length-mismatched uploads', async ({ server }) => {
  const oversizedKey = 'uploads/e2e/oversized.wav';
  const oversizedResponse = await e2eFetch(
    server,
    `/__e2e/local-upload?key=${encodeURIComponent(oversizedKey)}&declaredLength=${
      MAX_SOURCE_BYTES + 1
    }&unreadBody=true`,
    { method: 'POST' }
  );
  expect(oversizedResponse.status).toBe(413);
  expect(await oversizedResponse.json()).toEqual({ error: 'File too large (max 100 MB)' });

  const mismatchedKey = 'uploads/e2e/mismatched.wav';
  const mismatchedResponse = await e2eFetch(
    server,
    `/__e2e/local-upload?key=${encodeURIComponent(mismatchedKey)}&declaredLength=${
      sourceAudio.length + 1
    }`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: sourceAudio,
    }
  );
  expect(mismatchedResponse.status).toBe(400);
  expect(await mismatchedResponse.json()).toEqual({
    error: 'Upload size did not match Content-Length',
  });

  for (const key of [oversizedKey, mismatchedKey]) {
    const headResponse = await e2eFetch(
      server,
      `/__e2e/audio?key=${encodeURIComponent(key)}`,
      { method: 'HEAD' }
    );
    expect(headResponse.status).toBe(404);
  }
});

test('deletes uploads and stems after the local 30-day retention boundary', async ({ server }) => {
  const uploadPut = await e2eFetch(
    server,
    '/__e2e/audio?key=uploads%2Fexpired%2Ftone.wav',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: sourceAudio,
    }
  );
  expect(uploadPut.status).toBe(204);
  const stemPut = await e2eFetch(
    server,
    '/__e2e/audio?key=stems%2Fexpired%2Fvocals.mp3',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: stemAudio.get('vocals'),
    }
  );
  expect(stemPut.status).toBe(204);

  const cleanupResponse = await e2eFetch(
    server,
    `/__e2e/cleanup?now=${Date.now() + THIRTY_ONE_DAYS_MS}`,
    { method: 'POST' }
  );
  expect(cleanupResponse.status).toBe(200);
  const { removed } = await cleanupResponse.json();
  expect(removed).toBe(2);
  expect(
    (
      await e2eFetch(server, '/__e2e/audio?key=uploads%2Fexpired%2Ftone.wav', {
        method: 'HEAD',
      })
    ).status
  ).toBe(404);
  expect(
    (
      await e2eFetch(server, '/__e2e/audio?key=stems%2Fexpired%2Fvocals.mp3', {
        method: 'HEAD',
      })
    ).status
  ).toBe(404);
});

test('deduplicates concurrent webhook and polling ingestion', async ({ network, server }) => {
  const predictionId = 'e2e-concurrent-prediction';
  const sourceKey = 'uploads/e2e/concurrent.wav';
  const output = Object.fromEntries(
    [...stemAudio.keys()].map((name) => [name, `https://race-fixtures.test/${name}.mp3`])
  );
  let fixtureFetches = 0;

  network.use(
    http.post('https://api.replicate.com/v1/predictions', () =>
      HttpResponse.json({ id: predictionId, status: 'starting' })
    ),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({ id: predictionId, status: 'succeeded', output })
    ),
    http.get('https://race-fixtures.test/:stem.mp3', async ({ params }) => {
      fixtureFetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const audio = stemAudio.get(String(params.stem));
      return audio
        ? new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
        : new HttpResponse(null, { status: 404 });
    })
  );

  const sourceResponse = await e2eFetch(
    server,
    `/__e2e/audio?key=${encodeURIComponent(sourceKey)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: sourceAudio,
    }
  );
  expect(sourceResponse.status).toBe(204);

  const jobResponse = await server.fetch('/api/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-class-code': CLASS_CODE,
    },
    body: JSON.stringify({
      key: sourceKey,
      filename: 'concurrent.wav',
      model: 'htdemucs_ft',
    }),
  });
  expect(jobResponse.status).toBe(200);
  const { id: jobId } = await jobResponse.json();

  const webhookPayload = { id: predictionId, status: 'succeeded', output };
  const [pollResponse, webhookResponse] = await Promise.all([
    server.fetch(`/api/jobs/${jobId}`),
    server.fetch(
      `/api/webhooks/separation?job=${jobId}&token=e2e-webhook-secret`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      }
    ),
  ]);
  expect(pollResponse.status).toBe(200);
  expect(webhookResponse.status).toBe(200);

  const completedResponse = await server.fetch(`/api/jobs/${jobId}`);
  expect(completedResponse.status).toBe(200);
  const completed = await completedResponse.json();
  expect(completed.status).toBe('done');
  expect(completed.stems.map(({ name }) => name).sort()).toEqual([...stemAudio.keys()].sort());
  expect(fixtureFetches).toBe(stemAudio.size);
});

test('retries transient stem download failures before completing ingestion', async ({
  network,
  server,
}) => {
  const predictionId = 'e2e-transient-stem-prediction';
  const sourceKey = 'uploads/e2e/transient.wav';
  const output = Object.fromEntries(
    [...stemAudio.keys()].map((name) => [name, `https://retry-fixtures.test/${name}.mp3`])
  );
  const fixtureFetches = new Map([...stemAudio.keys()].map((name) => [name, 0]));

  network.use(
    http.post('https://api.replicate.com/v1/predictions', () =>
      HttpResponse.json({ id: predictionId, status: 'starting' })
    ),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({ id: predictionId, status: 'succeeded', output })
    ),
    http.get('https://retry-fixtures.test/:stem.mp3', ({ params }) => {
      const stem = String(params.stem);
      const count = (fixtureFetches.get(stem) ?? 0) + 1;
      fixtureFetches.set(stem, count);
      if (stem === 'other' && count === 1) {
        return HttpResponse.json({ error: 'temporary outage' }, { status: 503 });
      }
      const audio = stemAudio.get(stem);
      return audio
        ? new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
        : new HttpResponse(null, { status: 404 });
    })
  );

  const sourceResponse = await e2eFetch(
    server,
    `/__e2e/audio?key=${encodeURIComponent(sourceKey)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: sourceAudio,
    }
  );
  expect(sourceResponse.status).toBe(204);

  const jobResponse = await server.fetch('/api/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-class-code': CLASS_CODE,
    },
    body: JSON.stringify({
      key: sourceKey,
      filename: 'transient.wav',
      model: 'htdemucs_ft',
    }),
  });
  expect(jobResponse.status).toBe(200);
  const { id: jobId } = await jobResponse.json();

  const completedResponse = await server.fetch(`/api/jobs/${jobId}`);
  expect(completedResponse.status).toBe(200);
  const completed = await completedResponse.json();
  expect(completed.status).toBe('done');
  expect(completed.stems.map(({ name }) => name).sort()).toEqual([...stemAudio.keys()].sort());
  expect(fixtureFetches.get('other')).toBe(2);
  expect(
    [...fixtureFetches.values()].reduce((total, count) => total + count, 0)
  ).toBe(stemAudio.size + 1);
});

test('recovers a stale ingestion lease after a Worker interruption', async ({
  network,
  server,
}) => {
  const predictionId = 'e2e-stale-ingestion-prediction';
  const sourceKey = 'uploads/e2e/stale-ingestion.wav';
  const output = Object.fromEntries(
    [...stemAudio.keys()].map((name) => [name, `https://stale-fixtures.test/${name}.mp3`])
  );

  network.use(
    http.post('https://api.replicate.com/v1/predictions', () =>
      HttpResponse.json({ id: predictionId, status: 'starting' })
    ),
    http.get(`https://api.replicate.com/v1/predictions/${predictionId}`, () =>
      HttpResponse.json({ id: predictionId, status: 'succeeded', output })
    ),
    http.get('https://stale-fixtures.test/:stem.mp3', ({ params }) => {
      const audio = stemAudio.get(String(params.stem));
      return audio
        ? new HttpResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
        : new HttpResponse(null, { status: 404 });
    })
  );

  const sourceResponse = await e2eFetch(
    server,
    `/__e2e/audio?key=${encodeURIComponent(sourceKey)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: sourceAudio,
    }
  );
  expect(sourceResponse.status).toBe(204);

  const jobResponse = await server.fetch('/api/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-class-code': CLASS_CODE,
    },
    body: JSON.stringify({
      key: sourceKey,
      filename: 'stale-ingestion.wav',
      model: 'htdemucs_ft',
    }),
  });
  expect(jobResponse.status).toBe(200);
  const { id: jobId } = await jobResponse.json();

  const strandResponse = await e2eFetch(
    server,
    `/__e2e/stale-ingestion?job=${encodeURIComponent(jobId)}`,
    { method: 'POST' }
  );
  expect(strandResponse.status).toBe(200);
  expect(await strandResponse.json()).toEqual({ changed: 1 });

  const completedResponse = await server.fetch(`/api/jobs/${jobId}`);
  expect(completedResponse.status).toBe(200);
  const completed = await completedResponse.json();
  expect(completed.status).toBe('done');
  expect(completed.error).toBeNull();
  expect(completed.stems.map(({ name }) => name).sort()).toEqual([...stemAudio.keys()].sort());
});

test('rejects malformed encoded local object paths without throwing', async ({ server }) => {
  const uploadResponse = await server.fetch('/api/local-uploads/uploads/%ZZ', {
    method: 'PUT',
    headers: {
      'Content-Length': String(sourceAudio.length),
      'Content-Type': 'audio/wav',
      'x-class-code': CLASS_CODE,
    },
    body: sourceAudio,
  });
  expect(uploadResponse.status).toBe(404);

  const sourceResponse = await server.fetch(
    '/api/local-sources/uploads/%ZZ?expires=9999999999&signature=invalid'
  );
  expect(sourceResponse.status).toBe(404);

  const stemResponse = await server.fetch('/api/files/stems/%ZZ');
  expect(stemResponse.status).toBe(404);
});

function putChunked(url, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'audio/wav',
          'x-class-code': CLASS_CODE,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    request.on('error', reject);
    request.write(body.subarray(0, Math.floor(body.length / 2)));
    request.end(body.subarray(Math.floor(body.length / 2)));
  });
}

function e2eFetch(server, path, init = {}) {
  return server.fetch(path, {
    ...init,
    headers: {
      'x-e2e-secret': E2E_SECRET,
      ...(init.headers ?? {}),
    },
  });
}

function makeM4a(size = 2048) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  return bytes;
}

test('gates the instructor console and persists a prompt amendment', async ({ page, server }) => {
  // This test deliberately provokes 401s, so unlike the other specs it asserts
  // on uncaught JS exceptions rather than on console noise.
  const browserErrors = [];
  const failedRequests = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  const analysisJobId = 'teacher-discovery-analysis-e2e';
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
      roleClassifier: { version: 'autosplit-role-v4' },
      vocabularyClassifier: {
        version: 'laion-larger-clap-music-pairwise-presence-rand-trunc-v1@a0b4534a14f58e20944452dff00a22a06ce629d1',
        weightsSha256: '5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1',
        vocabularyVersion: 'classroom-instruments-v1',
        vocabularySha256: '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140',
      },
      instrumentDiscovery: {
        status: 'complete',
        code: null,
        totalMs: 120,
        windowsAnalyzed: 3,
      },
      decision: {
        choice: 'six',
        resolvedCoreModel: 'htdemucs_6s',
        confidence: null,
        features: null,
        reason: 'reviewed core route',
      },
      detectedInstruments: [
        {
          id: 'saxophone',
          label: 'Saxophone',
          confidence: 0.82,
          state: 'possible',
          windowSupport: 2,
          windowsAnalyzed: 3,
        },
      ],
      timing: { totalMs: 200, analyzedSeconds: 45 },
      degraded: { active: false, code: null },
    },
    comparison: 'unavailable',
  };
  const sourceHash = '1'.repeat(64);
  const seededAnalysis = await e2eFetch(server, '/__e2e/job-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: analysisJobId, analysis: privateAutoRouting, sourceHash }),
  });
  expect(seededAnalysis.status).toBe(200);
  const emptyAnalysisJobId = 'teacher-discovery-empty-e2e';
  const emptyAutoRouting = structuredClone(privateAutoRouting);
  emptyAutoRouting.analysis.detectedInstruments = [];
  emptyAutoRouting.analysis.decision.reason = 'candidate abstained';
  const seededEmptyAnalysis = await e2eFetch(server, '/__e2e/job-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: emptyAnalysisJobId, analysis: emptyAutoRouting, sourceHash }),
  });
  expect(seededEmptyAnalysis.status).toBe(200);

  const unavailableAnalysisJobId = 'teacher-discovery-unavailable-e2e';
  const unavailableAutoRouting = structuredClone(privateAutoRouting);
  delete unavailableAutoRouting.analysis.vocabularyClassifier;
  unavailableAutoRouting.analysis.instrumentDiscovery = {
    status: 'unavailable',
    code: 'discovery_timeout',
    totalMs: 25_000,
    windowsAnalyzed: 0,
  };
  unavailableAutoRouting.analysis.detectedInstruments = [];
  unavailableAutoRouting.analysis.decision.reason = 'core route survived discovery timeout';
  const seededUnavailableAnalysis = await e2eFetch(server, '/__e2e/job-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: unavailableAnalysisJobId,
      analysis: unavailableAutoRouting,
      sourceHash,
    }),
  });
  expect(seededUnavailableAnalysis.status).toBe(200);

  const seededIsolation = await e2eFetch(server, '/__e2e/job-isolation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: analysisJobId, sourceHash }),
  });
  expect(seededIsolation.status).toBe(200);
  expect(await seededIsolation.json()).toEqual({ id: 'isolation_e2e_1', created: true });

  const studentReadback = await server.fetch(`http://stem-splitter.test/api/jobs/${analysisJobId}`);
  expect(studentReadback.status).toBe(200);
  const studentJob = await studentReadback.json();
  expect(studentJob.autoRouting.resolvedCoreModel).toBe('htdemucs_6s');
  expect(studentJob.autoRouting.analysis.detectedInstruments).toEqual([]);
  expect(studentJob.autoRouting.analysis.vocabularyClassifier).toBeUndefined();
  expect(studentJob.isolations).toBeUndefined();

  // The class code must not open the instructor console: it is a shared secret
  // every student holds, so it cannot gate what the Listening Guide is told to say.
  const withClassCode = await server.fetch('http://stem-splitter.test/api/teacher/prompt', {
    headers: { 'x-class-code': CLASS_CODE },
  });
  expect(withClassCode.status).toBe(401);
  expect(withClassCode.headers.get('cache-control')).toBe('no-store');
  const analysisWithClassCode = await server.fetch(
    `http://stem-splitter.test/api/teacher/jobs/${analysisJobId}/analysis`,
    { headers: { 'x-class-code': CLASS_CODE } }
  );
  expect(analysisWithClassCode.status).toBe(401);
  const isolationsWithClassCode = await server.fetch(
    `http://stem-splitter.test/api/teacher/jobs/${analysisJobId}/isolations`,
    { headers: { 'x-class-code': CLASS_CODE } }
  );
  expect(isolationsWithClassCode.status).toBe(401);
  const feedbackWithClassCode = await server.fetch(
    `http://stem-splitter.test/api/teacher/jobs/${analysisJobId}/instrument-feedback`,
    { headers: { 'x-class-code': CLASS_CODE } }
  );
  expect(feedbackWithClassCode.status).toBe(401);

  const oversizedLogin = await server.fetch('http://stem-splitter.test/api/teacher/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nobody', password: 'x'.repeat(9000) }),
  });
  expect(oversizedLogin.status).toBe(413);
  expect(oversizedLogin.headers.get('cache-control')).toBe('no-store');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#class-code-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'NOT NOW' }).click();
  const instructorLink = page.getByRole('link', { name: 'INSTRUCTOR' });
  await expect(instructorLink).toBeVisible();
  await instructorLink.click();
  await expect(page).toHaveURL(/\/teacher(?:\.html)?$/);
  await expect(page.getByRole('link', { name: 'CUNY AI Lab' })).toBeVisible();
  await expect(page.locator('#signin-panel')).toBeVisible();
  await expect(page.locator('#console-panel')).toBeHidden();
  await expect(page.locator('.tagline')).toHaveCount(0);
  expect(await page.locator('link[rel="stylesheet"]').getAttribute('href')).toMatch(/\?v=/);
  expect(await page.locator('script[src^="\/teacher.js"]').getAttribute('src')).toMatch(/\?v=/);
  const signInButton = page.getByRole('button', { name: 'SIGN IN' });
  const signInButtonBox = await signInButton.boundingBox();
  expect(signInButtonBox).not.toBeNull();
  expect(signInButtonBox.height).toBeGreaterThanOrEqual(44);

  // Wrong password is rejected, and the message does not reveal which half failed.
  await page.getByLabel('USERNAME').fill('e2eteacher');
  await page.getByLabel('PASSWORD').fill('not-the-password');
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page.locator('#signin-error')).toHaveText('Incorrect username or password.');

  const unknownUser = await server.fetch('http://stem-splitter.test/api/teacher/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nobody', password: 'whatever' }),
  });
  expect(unknownUser.status).toBe(401);
  expect(unknownUser.headers.get('cache-control')).toBe('no-store');
  expect((await unknownUser.json()).error).toBe('Incorrect username or password.');

  await page.getByLabel('PASSWORD').fill(TEACHER_PASSWORD);
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page.locator('#console-panel')).toBeVisible();
  await expect(page.locator('#teacher-who')).toBeEmpty();
  await expect(page.getByRole('heading', { name: 'CLASS GUIDANCE' })).toBeVisible();
  await expect(page.getByText('More', { exact: true })).toBeVisible();
  await expect(page.locator('#fixed-prompt-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('#fixed-prompt-scroll')).toBeHidden();
  await expect(page.getByLabel('Class guidance')).not.toHaveAttribute('placeholder');
  const instructorSurfaceText = await page.locator('body').innerText();
  expect(instructorSurfaceText).not.toMatch(
    /\b(?:e2e|end-to-end|authorized testing|advisory|classifier|routing|training eligible|job id|shadow mode)\b/i
  );

  const teacherAnalysis = await page.evaluate((jobId) =>
    fetch(`/api/teacher/jobs/${jobId}/analysis`, { credentials: 'same-origin' }).then(
      async (response) => ({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: await response.json(),
      })
    ),
    analysisJobId
  );
  expect(teacherAnalysis.status).toBe(200);
  expect(teacherAnalysis.cacheControl).toBe('no-store');
  expect(teacherAnalysis.body.autoRouting).toEqual(privateAutoRouting);

  const teacherFeedbackContext = await page.evaluate((jobId) =>
    fetch(`/api/teacher/jobs/${jobId}/instrument-feedback`, {
      credentials: 'same-origin',
    }).then(async (response) => ({
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    })),
    analysisJobId
  );
  expect(teacherFeedbackContext.status).toBe(200);
  expect(teacherFeedbackContext.cacheControl).toBe('no-store');
  expect(teacherFeedbackContext.body).toMatchObject({
    schemaVersion: '1',
    jobId: analysisJobId,
    detectedInstrumentIds: ['saxophone'],
    currentRevision: 0,
    latest: null,
    policy: {
      evidenceStatus: 'unreviewed-candidate',
      deidentified: false,
      trainingEligible: false,
      affectsCoreRouting: false,
      requestsIsolation: false,
      overlapHandling: 'review-separately-do-not-double-count',
    },
  });
  expect(teacherFeedbackContext.body.provenance.analysisSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(teacherFeedbackContext.body.reviewOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'saxophone',
        label: 'Saxophone',
        kind: 'specific-instrument-or-voice',
      }),
      expect.objectContaining({
        id: 'strings',
        kind: 'family-or-ensemble',
      }),
      expect.objectContaining({
        id: 'sampler',
        kind: 'production-texture',
      }),
    ])
  );
  expect(JSON.stringify(teacherFeedbackContext.body)).not.toContain(sourceHash);
  expect(JSON.stringify(teacherFeedbackContext.body)).not.toContain('e2eteacher');

  const teacherIsolations = await page.evaluate((jobId) =>
    fetch(`/api/teacher/jobs/${jobId}/isolations`, { credentials: 'same-origin' }).then(
      async (response) => ({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: await response.json(),
      })
    ),
    analysisJobId
  );
  expect(teacherIsolations.status).toBe(200);
  expect(teacherIsolations.cacheControl).toBe('no-store');
  expect(teacherIsolations.body).toMatchObject({
    jobId: analysisJobId,
    isolations: [
      {
        kind: 'optional_instrument_isolation',
        label: 'Optional instrument isolation',
        id: 'isolation_e2e_1',
        target: 'saxophone',
        status: 'queued',
        output: { targetAvailable: false, residualAvailable: false },
        identity: {
          provider: 'replicate',
          model: 'cjwbw/audiosep',
          version: 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8',
          contractVersion: 'audiosep-replicate-v1',
        },
      },
    ],
  });
  expect(teacherIsolations.body.isolations[0].limitations).toHaveLength(2);

  const disabledIsolationCreate = await page.evaluate((jobId) =>
    fetch(`/api/teacher/jobs/${jobId}/isolations`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'saxophone' }),
    }).then(async (response) => ({ status: response.status, body: await response.json() })),
    analysisJobId
  );
  expect(disabledIsolationCreate).toEqual({
    status: 404,
    body: { error: 'Optional isolation is unavailable.' },
  });

  // Teacher folders: the class code must not reach them, and the full
  // save/list/detail/remove/delete loop works against a finished job.
  const foldersWithClassCode = await server.fetch('http://stem-splitter.test/api/teacher/folders', {
    headers: { 'x-class-code': CLASS_CODE },
  });
  expect(foldersWithClassCode.status).toBe(401);

  const folderFlow = await page.evaluate(async (jobId) => {
    const post = (url, body) =>
      fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const created = await post('/api/teacher/folders', { name: 'Week 3 — texture' }).then((r) => r.json());
    const badName = (await post('/api/teacher/folders', { name: '   ' })).status;
    const folderId = created.folder.id;
    const saved = await post(`/api/teacher/folders/${folderId}/items`, { jobId }).then((r) => r.json());
    const savedAgain = await post(`/api/teacher/folders/${folderId}/items`, { jobId }).then((r) => r.json());
    const missingJob = (await post(`/api/teacher/folders/${folderId}/items`, { jobId: 'no-such-job' })).status;
    const list = await fetch('/api/teacher/folders', { credentials: 'same-origin' }).then((r) => r.json());
    const detail = await fetch(`/api/teacher/folders/${folderId}`, { credentials: 'same-origin' }).then((r) =>
      r.json()
    );
    const removed = (
      await fetch(`/api/teacher/folders/${folderId}/items/${jobId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
    ).status;
    const deleted = (
      await fetch(`/api/teacher/folders/${folderId}`, { method: 'DELETE', credentials: 'same-origin' })
    ).status;
    const afterDelete = (await fetch(`/api/teacher/folders/${folderId}`, { credentials: 'same-origin' })).status;
    return { created, badName, saved, savedAgain, missingJob, list, detail, removed, deleted, afterDelete };
  }, analysisJobId);
  expect(folderFlow.created.folder).toMatchObject({ name: 'Week 3 — texture', itemCount: 0 });
  expect(folderFlow.badName).toBe(400);
  expect(folderFlow.saved).toEqual({ ok: true, already: false });
  expect(folderFlow.savedAgain).toEqual({ ok: true, already: true });
  expect(folderFlow.missingJob).toBe(404);
  expect(folderFlow.list.folders).toHaveLength(1);
  expect(folderFlow.list.folders[0]).toMatchObject({
    name: 'Week 3 — texture',
    itemCount: 1,
    createdBy: 'e2eteacher',
  });
  expect(folderFlow.detail.items).toHaveLength(1);
  expect(folderFlow.detail.items[0]).toMatchObject({
    jobId: analysisJobId,
    filename: 'discovery-e2e.wav',
    model: 'htdemucs_6s',
    available: true,
  });
  expect(folderFlow.removed).toBe(200);
  expect(folderFlow.deleted).toBe(200);
  expect(folderFlow.afterDelete).toBe(404);

  // The code-owned prompt is progressively disclosed, formatted, and never an
  // editable control. Once opened it starts at the end and the caret jumps up.
  await page.getByText('System prompt', { exact: true }).click();
  await expect(page.locator('#fixed-prompt-details')).toHaveAttribute('open', '');
  await expect(page.locator('#fixed-prompt-body')).toContainText('ACTING ON THE MIXER');
  await expect(page.locator('#fixed-prompt-body h4')).toContainText([
    "WHO YOU'RE TALKING TO",
    'HOW YOU TALK (every message, both modes)',
  ]);
  await expect(page.locator('#fixed-prompt-meta')).toContainText('2026-08-20.1');
  expect(await page.locator('#fixed-prompt-body').getAttribute('contenteditable')).toBeNull();
  await page.getByRole('button', { name: 'TOP' }).click();
  await expect(page.locator('#fixed-prompt-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'END' })).toBeVisible();
  await expect.poll(() => page.locator('#fixed-prompt-scroll').evaluate((node) => node.scrollTop)).toBe(0);
  await expect
    .poll(() =>
      page.locator('#fixed-prompt-scroll').evaluate((node) =>
        Math.round(node.getBoundingClientRect().top)
      )
    )
    .toBeGreaterThanOrEqual(0);
  await expect
    .poll(() =>
      page.locator('#fixed-prompt-scroll').evaluate((node) =>
        Math.round(node.getBoundingClientRect().top)
      )
    )
    .toBeLessThanOrEqual(16);

  const amendment = 'Focus on Latin American popular music; define terms in Spanish too.';
  await page.locator('#amendment').fill(amendment);
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect(page.locator('#prompt-status')).toContainText('Add a change note');

  const changeNote = 'Add bilingual vocabulary guidance for the survey course';
  await page.locator('#change-note').fill(changeNote);
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect(page.locator('#prompt-status')).toHaveText('Saved.');
  await expect(page.locator('#amendment-meta')).toContainText('Saved by e2eteacher');
  await expect(page.locator('.teacher-history-item')).toHaveCount(1);
  await expect(page.locator('.teacher-history-item')).toContainText(changeNote);
  await expect(page.locator('.teacher-history-trace')).toContainText('BASE 2026-08-20.1');

  const promptReadback = await page.evaluate(() =>
    fetch('/api/teacher/prompt', { credentials: 'same-origin' }).then(async (response) => ({
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    }))
  );
  expect(promptReadback.cacheControl).toBe('no-store');
  const trace = promptReadback.body;
  expect(trace.basePromptHash).toMatch(/^[a-f0-9]{64}$/);
  expect(trace.effectivePromptHash).toMatch(/^[a-f0-9]{64}$/);
  expect(trace.effectivePromptHash).not.toBe(trace.basePromptHash);
  expect(trace.history[0]).toMatchObject({
    settingsRevision: 1,
    amendment,
    changeNote,
    basePromptVersion: '2026-08-20.1',
    basePromptHash: trace.basePromptHash,
    effectivePromptHash: trace.effectivePromptHash,
    updatedBy: 'e2eteacher',
  });

  // The amendment reaches the real system prompt, and the guardrails outrank it.
  await page.getByRole('button', { name: 'PREVIEW', exact: true }).click();
  await expect(page.locator('#preview-body')).toContainText(amendment);
  await expect(page.locator('#preview-body')).toContainText('NEVER invent timestamps');

  // Optimistic concurrency stops a stale console from overwriting a newer edit.
  const staleSave = await page.evaluate((nextAmendment) =>
    fetch('/api/teacher/prompt', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amendment: nextAmendment,
        changeNote: 'stale edit',
        expectedRevision: 0,
      }),
    }).then(async (response) => ({ status: response.status, body: await response.json() })),
    `${amendment} stale`
  );
  expect(staleSave.status).toBe(409);
  expect(staleSave.body.error).toContain('changed after you opened it');

  // Build more than one bounded history page through the governed API. The
  // console must expose the complete append-only trail rather than silently
  // stopping at its newest 40 rows.
  const paginated = await page.evaluate(async () => {
    let expectedRevision = 1;
    let latestAmendment = '';
    for (let revision = 2; revision <= 42; revision += 1) {
      latestAmendment = `Pagination amendment ${revision}`;
      const response = await fetch('/api/teacher/prompt', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amendment: latestAmendment,
          changeNote: `Pagination coverage ${revision}`,
          expectedRevision,
        }),
      });
      if (!response.ok) {
        return { ok: false, status: response.status, body: await response.json() };
      }
      const body = await response.json();
      expectedRevision = body.revision.settingsRevision;
    }
    return { ok: true, expectedRevision, latestAmendment };
  });
  expect(paginated).toEqual({
    ok: true,
    expectedRevision: 42,
    latestAmendment: 'Pagination amendment 42',
  });

  // Current content, session, and newest history page survive reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#console-panel')).toBeVisible();
  await expect(page.locator('#amendment')).toHaveValue('Pagination amendment 42');
  await expect(page.locator('.teacher-history-item')).toHaveCount(40);
  await expect(page.locator('.teacher-history-item').first()).toContainText('REVISION 42');
  await page.getByText('History', { exact: true }).click();
  const loadEarlier = page.getByRole('button', { name: 'LOAD EARLIER REVISIONS' });
  await expect(loadEarlier).toBeVisible();
  await loadEarlier.click();
  await expect(page.locator('.teacher-history-item')).toHaveCount(42);
  await expect(page.locator('.teacher-history-item').last()).toContainText(changeNote);
  await expect(loadEarlier).toBeHidden();

  await expect(page.getByText('AutoSplit review', { exact: true })).toHaveCount(0);

  // A failed logout must not tell the teacher the active HttpOnly session is
  // gone. Keep the console visible until the server confirms invalidation.
  await page.route('**/api/teacher/logout', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'SIGN OUT' }).click();
  await expect(page.locator('#console-panel')).toBeVisible();
  await expect(page.locator('#prompt-status')).toContainText(
    'Sign out failed. Your session may still be active.'
  );
  await expect(page.getByText('AutoSplit review', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'SIGN OUT' })).toBeEnabled();
  const afterFailedSignOut = await page.evaluate(() =>
    fetch('/api/teacher/prompt', { credentials: 'same-origin' }).then((r) => r.status)
  );
  expect(afterFailedSignOut).toBe(200);
  await page.unroute('**/api/teacher/logout');

  await page.getByRole('button', { name: 'SIGN OUT' }).click();
  await expect(page.locator('#signin-panel')).toBeVisible();
  await expect(page.locator('#amendment')).toHaveValue('');
  await expect(page.locator('.teacher-history-item')).toHaveCount(0);
  await expect(page.locator('#preview-body')).toBeEmpty();
  await expect(page.getByText('AutoSplit review', { exact: true })).toHaveCount(0);
  expect(await page.locator('body').textContent()).not.toContain('Pagination amendment 42');
  expect(await page.locator('body').textContent()).not.toContain(analysisJobId);
  expect(await page.locator('body').textContent()).not.toContain('Saxophone');
  expect(await page.locator('body').textContent()).not.toContain('Trumpet');
  const afterSignOut = await page.evaluate(() =>
    fetch('/api/teacher/prompt', { credentials: 'same-origin' }).then((r) => r.status)
  );
  expect(afterSignOut).toBe(401);
  const analysisAfterSignOut = await page.evaluate((jobId) =>
    fetch(`/api/teacher/jobs/${jobId}/analysis`, { credentials: 'same-origin' }).then(
      (response) => response.status
    ),
    analysisJobId
  );
  expect(analysisAfterSignOut).toBe(401);
  const isolationsAfterSignOut = await page.evaluate((jobId) =>
    fetch(`/api/teacher/jobs/${jobId}/isolations`, { credentials: 'same-origin' }).then(
      (response) => response.status
    ),
    analysisJobId
  );
  expect(isolationsAfterSignOut).toBe(401);
  const feedbackAfterSignOut = await page.evaluate((jobId) =>
    fetch(`/api/teacher/jobs/${jobId}/instrument-feedback`, {
      credentials: 'same-origin',
    }).then((response) => response.status),
    analysisJobId
  );
  expect(feedbackAfterSignOut).toBe(401);

  expect(browserErrors).toEqual([]);
  // Every non-2xx should be one of the auth or disabled-feature checks this test intentionally makes.
  expect(
    failedRequests.filter(
      (entry) =>
        !entry.startsWith('401 /api/teacher/') &&
        !entry.startsWith('409 /api/teacher/prompt') &&
        entry !== `400 /api/teacher/jobs/${analysisJobId}/instrument-feedback` &&
        entry !== `409 /api/teacher/jobs/${analysisJobId}/instrument-feedback` &&
        entry !== `404 /api/teacher/jobs/${analysisJobId}/isolations` &&
        // The folder flow intentionally provokes a blank name, a missing job,
        // and reads of an already-deleted folder.
        entry !== '400 /api/teacher/folders' &&
        !/^404 \/api\/teacher\/folders\//.test(entry)
    )
  ).toEqual([]);
});
