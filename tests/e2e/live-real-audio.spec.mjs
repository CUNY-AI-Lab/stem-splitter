import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const CASES = {
  bs_roformer_vocals: {
    radio: /2 STEMS · vocals \+ instrumental/i,
    stems: ['vocals', 'instrumental'],
  },
  htdemucs_ft: {
    radio: /4 STEMS · vocals \+ drums \+ bass \+ other/i,
    stems: ['vocals', 'drums', 'bass', 'other'],
  },
  htdemucs_6s: {
    radio: /6 STEMS · vocals \+ drums \+ bass \+ other \+ guitar \+ piano/i,
    stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
  },
};

const sourcePath = process.env.REAL_AUDIO_SOURCE;
const model = process.env.REAL_AUDIO_MODEL;
const liveCase = model ? CASES[model] : undefined;
const classCode = process.env.REAL_AUDIO_CLASS_CODE || 'local-class-code';
const caseSlug = process.env.REAL_AUDIO_CASE_SLUG || model || 'real-audio';
const artifactDir = resolve(
  process.env.REAL_AUDIO_ARTIFACT_DIR || `output/playwright/real-audio/${caseSlug}`
);
const resultPath = resolve(process.env.REAL_AUDIO_RESULT_PATH || `${artifactDir}/result.json`);

test.skip(!sourcePath || !liveCase, 'Set REAL_AUDIO_SOURCE and a supported REAL_AUDIO_MODEL');

test(`real ${model || 'audio'} browser pipeline`, async ({ page }) => {
  const source = resolve(sourcePath);
  const sourceBytes = await readFile(source);
  const sourceStat = await stat(source);
  const browserMessages = [];
  const startedAt = Date.now();
  const screenshots = {};
  const downloadEvidence = [];

  await mkdir(artifactDir, { recursive: true });
  page.on('pageerror', (error) => browserMessages.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  await page.addInitScript((code) => {
    if (!sessionStorage.getItem('realAudioRunInitialized')) {
      localStorage.clear();
      sessionStorage.setItem('realAudioRunInitialized', 'true');
    }
    localStorage.setItem('classCode', code);
    window.__realAudioElements = [];
    window.Audio = new Proxy(window.Audio, {
      construct(NativeAudio, args) {
        const audio = Reflect.construct(NativeAudio, args);
        window.__realAudioElements.push(audio);
        return audio;
      },
    });
  }, classCode);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle('Stem Splitter');
  await expect(page.getByRole('heading', { name: /STEM SPLITTER/ })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/Internal Server Error|Application Error/);

  await page.getByRole('radio', { name: liveCase.radio }).check();
  await page.locator('#file-input').setInputFiles(source);
  await expect(page.locator('#upload-status')).toBeVisible();
  screenshots.processing = resolve(artifactDir, '01-processing.png');
  await page.screenshot({
    path: screenshots.processing,
    fullPage: true,
    animations: 'disabled',
  });

  await waitForTerminalState(page);
  await expect(page.locator('.badge.ready')).toHaveText('READY');
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  await expect(page.locator('#upload-status')).toBeHidden();
  await expect(page.locator('.console-title')).toHaveText(basename(source));
  await expect(page.locator('.channel')).toHaveCount(liveCase.stems.length);

  const renderedStems = await page.locator('.ch-name').allTextContents();
  const renderedStemNames = renderedStems.map((name) => name.trim().toLowerCase());
  expect([...renderedStemNames].sort()).toEqual([...liveCase.stems].sort());
  await page.waitForFunction(
    (count) =>
      window.__realAudioElements.length === count &&
      window.__realAudioElements.every(
        (audio) =>
          audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
          Number.isFinite(audio.duration) &&
          audio.duration > 1
      ),
    liveCase.stems.length
  );

  screenshots.ready = resolve(artifactDir, '02-ready.png');
  await page.screenshot({ path: screenshots.ready, fullPage: true, animations: 'disabled' });

  const playButton = page.getByRole('button', { name: 'Play all stems' });
  await playButton.click();
  await expect(playButton).toHaveClass(/playing/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.min(...window.__realAudioElements.map((audio) => audio.currentTime))
      )
    )
    .toBeGreaterThan(0.1);
  screenshots.playing = resolve(artifactDir, '03-playing.png');
  await page.screenshot({ path: screenshots.playing, fullPage: true, animations: 'disabled' });

  const seek = page.getByRole('slider', { name: 'Seek' });
  await seek.fill('300');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.min(...window.__realAudioElements.map((audio) => audio.currentTime))
      )
    )
    .toBeGreaterThan(2);
  await playButton.click();
  await expect(playButton).not.toHaveClass(/playing/);
  expect(
    await page.evaluate(() => window.__realAudioElements.every((audio) => audio.paused))
  ).toBe(true);

  const muteButton = page.getByRole('button', { name: 'Mute vocals' });
  await muteButton.click();
  await expect(muteButton).toHaveAttribute('aria-pressed', 'true');
  screenshots.muted = resolve(artifactDir, '04-vocals-muted.png');
  await page.screenshot({ path: screenshots.muted, fullPage: true, animations: 'disabled' });
  await muteButton.click();

  const firstName = page.locator('.ch-name').first();
  await firstName.click();
  const nameInput = page.locator('.ch-name-input');
  await nameInput.fill('Lead vocal verified');
  await nameInput.press('Enter');
  await expect(page.locator('.ch-name').first()).toHaveText('Lead vocal verified');

  await page.getByRole('button', { name: /NOTE/ }).click();
  await page.getByRole('textbox', { name: 'Note text' }).fill(
    `${caseSlug}: browser persistence check`
  );
  await page.getByRole('button', { name: 'SAVE' }).click();
  await expect(page.locator('.note-text')).toHaveText(
    `${caseSlug}: browser persistence check`
  );
  screenshots.annotated = resolve(artifactDir, '05-annotated-renamed.png');
  await page.screenshot({
    path: screenshots.annotated,
    fullPage: true,
    animations: 'disabled',
  });

  const downloadLinks = page.locator('.dl');
  for (let index = 0; index < liveCase.stems.length; index += 1) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadLinks.nth(index).click(),
    ]);
    const downloadedPath = await download.path();
    const bytes = await readFile(downloadedPath);
    expect(bytes.length).toBeGreaterThan(1024);
    downloadEvidence.push({
      stem: renderedStemNames[index],
      filename: download.suggestedFilename(),
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  expect(new Set(downloadEvidence.map((item) => item.sha256)).size).toBe(
    liveCase.stems.length
  );

  const durations = await page.evaluate(() =>
    window.__realAudioElements.map((audio) => audio.duration)
  );
  expect(Math.max(...durations) - Math.min(...durations)).toBeLessThan(0.25);

  await page.reload();
  await expect(page.locator('.badge.ready')).toHaveText('READY');
  await expect(page.locator('.ch-name').first()).toHaveText('Lead vocal verified');
  await expect(page.locator('.note-text')).toHaveText(
    `${caseSlug}: browser persistence check`
  );
  await expect(page.locator('#upload-status')).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBe(0);
  screenshots.persisted = resolve(artifactDir, '06-persisted-after-reload.png');
  await page.screenshot({
    path: screenshots.persisted,
    fullPage: true,
    animations: 'disabled',
  });

  expect(browserMessages).toEqual([]);

  const [{ id: jobId, model: storedModel }] = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jobs') || '[]')
  );
  expect(storedModel).toBe(model);

  const result = {
    caseSlug,
    model,
    expectedStems: liveCase.stems,
    renderedStems,
    jobId,
    source: {
      filename: basename(source),
      bytes: sourceStat.size,
      sha256: sha256(sourceBytes),
    },
    elapsedSeconds,
    durations,
    downloads: downloadEvidence,
    browserMessages,
    screenshots: Object.fromEntries(
      Object.entries(screenshots).map(([name, screenshotPath]) => [
        name,
        basename(screenshotPath),
      ])
    ),
    completedAt: new Date().toISOString(),
  };
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function waitForTerminalState(page) {
  const deadline = Date.now() + 20 * 60_000;
  let consecutiveHealthFailures = 0;

  while (Date.now() < deadline) {
    if (await page.locator('.badge.ready').count()) return;
    if (await page.locator('.badge.failed').count()) {
      throw new Error(`Separation failed: ${await page.locator('.job-error').textContent()}`);
    }
    if (await page.locator('#upload-status.error').count()) {
      throw new Error(`Upload failed: ${await page.locator('#upload-status').textContent()}`);
    }

    try {
      const health = await page.request.get('/api/separation-options', { timeout: 2_000 });
      consecutiveHealthFailures = health.ok() ? 0 : consecutiveHealthFailures + 1;
    } catch {
      consecutiveHealthFailures += 1;
    }
    if (consecutiveHealthFailures >= 3) {
      throw new Error('Local Worker became unreachable during separation');
    }
    await page.waitForTimeout(2_000);
  }

  throw new Error('Separation did not reach a terminal state within 20 minutes');
}
