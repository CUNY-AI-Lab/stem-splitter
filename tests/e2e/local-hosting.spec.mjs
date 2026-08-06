import { test as base, expect } from '@playwright/test';
import { pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { createTestHarness } from 'wrangler';

const CLASS_CODE = 'e2e-class-code';
// Fixture teacher, hashed the same way production credentials are. The
// plaintext exists only here, in a test, for an account that only exists here.
const TEACHER_PASSWORD = 'e2e-teacher-password';
const TEACHER_SEED = JSON.stringify([
  {
    username: 'e2eteacher',
    name: 'E2E Teacher',
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
              YOUTUBE_FETCH_ORDER: 'replicate-first',
            },
            secrets: {
              R2_ACCESS_KEY_ID: 'e2e-r2-access-key',
              R2_SECRET_ACCESS_KEY: 'e2e-r2-secret-key',
              REPLICATE_API_TOKEN: 'e2e-replicate-token',
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
      const schema = (await readFile(SCHEMA_PATH, 'utf8'))
        .replace(/--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
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
  await expect(page.locator('#split-summary')).toHaveText('// produces 4 or 6 tracks per split');
  await expect(page.locator('#engine-summary')).toHaveText('SEPARATION MODEL: DEMUCS');
  await expect(
    page.getByRole('radio', { name: '4 STEMS · vocals + drums + bass + other' })
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

  expect(signedSourceUrl).toMatch(/^http:\/\/stem-splitter\.test\/api\/local-sources\//);
  const signedSourceResponse = await server.fetch(signedSourceUrl);
  expect(signedSourceResponse.status).toBe(200);
  expect(signedSourceResponse.headers.get('content-length')).toBe(String(sourceAudio.length));
  expect(Buffer.from(await signedSourceResponse.arrayBuffer()).equals(sourceAudio)).toBe(true);

  const [{ id: jobId, model: storedModel }] = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jobs') || '[]')
  );
  expect(storedModel).toBe('htdemucs_ft');
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
    name: '6 STEMS · vocals + drums + bass + other + guitar + piano',
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
    http.get('https://api.replicate.com/v1/models/test/yt-audio', () =>
      HttpResponse.json({ latest_version: { id: 'e2e-yt-version' } })
    ),
    http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
      const payload = await request.json();
      if (payload.input.url) {
        expect(payload).toEqual({
          version: 'e2e-yt-version',
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
      name: '6 STEMS · vocals + drums + bass + other + guitar + piano',
    })
    .check();
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
          // Over the 15-minute cap: offered but not importable.
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

  // Opening the crate runs the default search.
  await page.getByRole('button', { name: /BROWSE THE CRATE/ }).click();
  await expect(page.locator('.crate-item')).toHaveCount(1);
  await expect(page.locator('.crate-license')).toHaveText('CC BY-NC-SA 4.0');

  // The licence floor and collection scope are pinned server-side.
  expect(searchQuery).toContain('mediatype:audio');
  expect(searchQuery).toContain('NOT licenseurl:*-nd*');
  expect(searchQuery).toContain('collection:netlabels');

  await page.locator('.crate-item-head').click();
  await expect(page.locator('.crate-track')).toHaveCount(2); // ogg derivative collapsed away
  await expect(page.locator('.crate-track-len').first()).toHaveText('0:21');
  await expect(page.getByRole('button', { name: 'TOO LONG' })).toBeDisabled();
  if (process.env.ARCHIVE_QA_SCREENSHOT) {
    await page.screenshot({ path: process.env.ARCHIVE_QA_SCREENSHOT, fullPage: true });
  }

  await page.getByRole('button', { name: 'SPLIT' }).click();

  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('.console-title')).toHaveText('Fixture Collective - fixture-track');
  await expect(page.locator('.channel')).toHaveCount(4);

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

  // The class code must not open the instructor console: it is a shared secret
  // every student holds, so it cannot gate what the coach is told to say.
  const withClassCode = await server.fetch('http://stem-splitter.test/api/teacher/prompt', {
    headers: { 'x-class-code': CLASS_CODE },
  });
  expect(withClassCode.status).toBe(401);

  await page.goto('/teacher.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#signin-panel')).toBeVisible();
  await expect(page.locator('#console-panel')).toBeHidden();

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
  expect((await unknownUser.json()).error).toBe('Incorrect username or password.');

  await page.getByLabel('PASSWORD').fill(TEACHER_PASSWORD);
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page.locator('#console-panel')).toBeVisible();
  await expect(page.locator('#teacher-who')).toHaveText('SIGNED IN AS E2E TEACHER');

  const amendment = 'Focus on Latin American popular music; define terms in Spanish too.';
  await page.locator('#amendment').fill(amendment);
  await page.getByRole('button', { name: 'SAVE' }).click();
  await expect(page.locator('#prompt-status')).toContainText('SAVED');
  await expect(page.locator('#amendment-meta')).toContainText('LAST EDITED BY E2ETEACHER');

  // The amendment reaches the real system prompt, and the guardrails outrank it.
  await page.getByRole('button', { name: 'PREVIEW FULL PROMPT' }).click();
  await expect(page.locator('#preview-body')).toContainText(amendment);
  await expect(page.locator('#preview-body')).toContainText('NEVER invent timestamps');

  // Survives a reload — the session is a cookie and the text is in D1.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#console-panel')).toBeVisible();
  await expect(page.locator('#amendment')).toHaveValue(amendment);

  await page.getByRole('button', { name: 'SIGN OUT' }).click();
  await expect(page.locator('#signin-panel')).toBeVisible();
  const afterSignOut = await page.evaluate(() =>
    fetch('/api/teacher/prompt', { credentials: 'same-origin' }).then((r) => r.status)
  );
  expect(afterSignOut).toBe(401);

  expect(browserErrors).toEqual([]);
  // Every non-2xx should be one of the auth checks this test intentionally makes.
  expect(failedRequests.filter((entry) => !entry.startsWith('401 /api/teacher/'))).toEqual([]);
});
