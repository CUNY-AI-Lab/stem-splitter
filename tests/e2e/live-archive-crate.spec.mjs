// Live evaluation of the Internet Archive crate: real archive.org fetches and a
// real local separation per track, timed per phase. Run via
// scripts/run-archive-crate-e2e.sh (it boots the local worker + separator stack).
//
// Unlike local-hosting.spec.mjs nothing is mocked here — flakes in this suite
// mean archive.org or the separator, not the app. Keep it out of `test:e2e`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// Pinned for reproducibility: open-licensed, non-ND, first importable track
// under ~5 minutes (csr008's first importable runs 9½ minutes, so its 4-minute
// track is pinned by title instead). Override with ARCHIVE_EVAL_IDS=a,b,c.
const DEFAULT_TRACKS = [
  { identifier: 'NS050', genre: 'electronic' },
  { identifier: 'MIXG032', genre: 'jazz' },
  { identifier: 'badpanda049', genre: 'psych rock', trackTitle: /plumy tale/i },
  { identifier: 'csr008', genre: 'lo-fi rock', trackTitle: /reefer/i },
  { identifier: 'Free_20s_Jazz_Collection', genre: '1920s jazz · 64 kbps' },
];

const TRACKS = process.env.ARCHIVE_EVAL_IDS
  ? process.env.ARCHIVE_EVAL_IDS.split(',').map((identifier) => ({ identifier: identifier.trim() }))
  : DEFAULT_TRACKS;

const MODEL = process.env.ARCHIVE_EVAL_MODEL || 'htdemucs_ft';
const MODEL_RADIOS = {
  bs_roformer_vocals: /2 STEMS · vocals \+ instrumental/i,
  htdemucs_ft: /4 STEMS · vocals \+ drums \+ bass \+ other/i,
  htdemucs_6s: /6 STEMS · vocals \+ drums \+ bass \+ other \+ guitar \+ piano/i,
};
const MODEL_STEM_COUNTS = { bs_roformer_vocals: 2, htdemucs_ft: 4, htdemucs_6s: 6 };

const classCode = process.env.ARCHIVE_EVAL_CLASS_CODE || 'local-class-code';
const artifactDir = resolve(process.env.ARCHIVE_EVAL_ARTIFACT_DIR || 'output/playwright/archive-crate');

// Deliberately NOT serial mode: with workers=1 the tracks still run in order,
// but one track's failure (e.g. a transient archive.org 5xx) must not skip the
// remaining tracks — this suite is an evaluation, not a gate.
for (const entry of TRACKS) {
  test(`archive crate eval: ${entry.identifier}`, async ({ page }) => {
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });

    await mkdir(artifactDir, { recursive: true });
    await page.addInitScript((code) => {
      // Each track starts with an empty rack so channel counts are per-job.
      localStorage.removeItem('jobs');
      localStorage.setItem('classCode', code);
      window.__evalAudioElements = [];
      window.Audio = new Proxy(window.Audio, {
        construct(NativeAudio, args) {
          const audio = Reflect.construct(NativeAudio, args);
          window.__evalAudioElements.push(audio);
          return audio;
        },
      });
    }, classCode);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('radio', { name: MODEL_RADIOS[MODEL] }).check();

    // -- search: identifier full-text match returns exactly the pinned item --
    await page.getByRole('button', { name: /BROWSE THE CRATE/ }).click();
    await page.getByLabel('Search the Internet Archive').fill(entry.identifier);
    const searchStart = Date.now();
    await page.getByRole('button', { name: 'SEARCH' }).click();
    await expect(page.locator('.crate-item')).toHaveCount(1, { timeout: 60_000 });
    const searchMs = Date.now() - searchStart;
    const license = (await page.locator('.crate-license').textContent()).trim();

    // -- expand: item metadata + track list ---------------------------------
    const itemResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/archive/items/') && response.ok()
    );
    const tracksStart = Date.now();
    await page.locator('.crate-item-head').click();
    const item = await (await itemResponsePromise).json();
    await expect(page.locator('.crate-track').first()).toBeVisible({ timeout: 60_000 });
    const tracksMs = Date.now() - tracksStart;

    // -- pick the pinned (or first importable) track ------------------------
    const rows = page.locator('.crate-track');
    let row = rows.filter({ has: page.getByRole('button', { name: 'SPLIT' }) }).first();
    if (entry.trackTitle) {
      row = rows.filter({ hasText: entry.trackTitle }).first();
    }
    const trackTitle = (await row.locator('.crate-track-name').textContent()).trim();
    const trackMeta = item.tracks.find((candidate) => candidate.title === trackTitle);
    expect(trackMeta?.importable).toBe(true);

    // -- import: one POST covers the real archive.org download + R2 write ---
    const importStart = Date.now();
    const jobResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/jobs') && response.request().method() === 'POST',
      { timeout: 5 * 60_000 }
    );
    await row.getByRole('button', { name: 'SPLIT' }).click();
    const jobResponse = await jobResponsePromise;
    const importMs = Date.now() - importStart;
    expect(jobResponse.ok()).toBe(true);
    const job = await jobResponse.json();

    // -- separation: real model run in the local separator ------------------
    const separationStart = Date.now();
    await expect
      .poll(
        async () => {
          const badge = await page.locator('.badge').first().textContent();
          if (/FAILED/i.test(badge ?? '')) {
            throw new Error(`separation failed: ${await page.locator('.console').first().textContent()}`);
          }
          return badge?.trim();
        },
        { timeout: 20 * 60_000, intervals: [2_000] }
      )
      .toBe('READY');
    const separationMs = Date.now() - separationStart;

    // -- verify the mixer is actually playable ------------------------------
    const stemCount = MODEL_STEM_COUNTS[MODEL];
    await expect(page.locator('.channel')).toHaveCount(stemCount);
    await page.waitForFunction(
      (count) =>
        window.__evalAudioElements.length === count &&
        window.__evalAudioElements.every(
          (audio) =>
            audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
            Number.isFinite(audio.duration) &&
            audio.duration > 1
        ),
      stemCount,
      { timeout: 120_000 }
    );
    const durations = await page.evaluate(() =>
      window.__evalAudioElements.map((audio) => audio.duration)
    );
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThan(0.5);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.dl').first().click(),
    ]);
    const stemBytes = (await readFile(await download.path())).length;
    expect(stemBytes).toBeGreaterThan(1024);

    const screenshot = resolve(artifactDir, `${entry.identifier}-ready.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    expect(browserErrors).toEqual([]);

    const result = {
      identifier: entry.identifier,
      genre: entry.genre ?? null,
      itemTitle: item.title,
      creator: item.creator,
      license,
      track: {
        title: trackTitle,
        durationSec: trackMeta.durationSec,
        bytes: trackMeta.bytes,
      },
      model: MODEL,
      jobId: job.id,
      timings: {
        searchMs,
        tracksMs,
        importMs,
        separationMs,
        totalMs: searchMs + tracksMs + importMs + separationMs,
      },
      stemDurations: durations,
      firstStemBytes: stemBytes,
      screenshot: basename(screenshot),
      completedAt: new Date().toISOString(),
    };
    await writeFile(
      resolve(artifactDir, `${entry.identifier}.json`),
      `${JSON.stringify(result, null, 2)}\n`
    );
  });
}
