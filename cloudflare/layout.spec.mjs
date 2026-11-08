import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

for (const remixer of [false, true]) test(`No Crate and no adversarial panel; Remixer flag ${remixer}`, async ({ page }) => {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, REMIXER_ENABLED: String(remixer), TEST_BROWSER: 'true' },
    secrets: { WEBHOOK_SECRET: 'fixture-only' },
  }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' },
      body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
    await page.goto(url.href);
    await expect(page).toHaveTitle('Stem Splitter');
    await expect(page.locator('#split-summary')).toBeHidden();
    await expect(page.getByRole('combobox', { name: 'Song or link', exact: true })).toBeVisible();
    await expect(page.locator('#yt-disclosure summary, #song-provider, #audio-source')).toHaveCount(0);
    await expect(page.locator('#song-search-label, #split-picker-label')).toHaveCount(0);
    await expect(page.locator('#yt-url')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Number of splits', exact: true })).toBeVisible();
    await expect(page.getByText('Split into', { exact: true })).toHaveCount(0);
    if (process.env.STEM_SCREENSHOT_DIR && !remixer) {
      await mkdir(process.env.STEM_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.STEM_SCREENSHOT_DIR}/video-link-expanded-desktop.png`, animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#yt-url').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.STEM_SCREENSHOT_DIR}/video-link-expanded-mobile.png`, animations: 'disabled' });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    // Keep the unified search action compact at desktop and phone widths.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const search = page.locator('.yt-form > .yt-go');
      await expect(search).toBeVisible();
      const button = await search.boundingBox();
      const form = await page.locator('.yt-form').boundingBox();
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.width).toBeLessThan(form.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // The song box's placeholder fits whole at phone widths and keeps its size on wider screens.
    for (const width of [320, 375, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      // The box's width reaches the stylesheet through a ResizeObserver, which runs before the next paint.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const fit = await page.evaluate(() => {
        const input = document.querySelector('#yt-url'), style = getComputedStyle(input), placeholder = getComputedStyle(input, '::placeholder');
        const context = document.createElement('canvas').getContext('2d');
        context.font = `${placeholder.fontWeight} ${placeholder.fontSize} ${placeholder.fontFamily}`;
        return { text: context.measureText(input.getAttribute('placeholder')).width, room: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          size: parseFloat(placeholder.fontSize), base: parseFloat(style.fontSize) };
      });
      expect(fit.text, `placeholder at ${width}px`).toBeLessThanOrEqual(fit.room);
      // Shrinking is only for a box too narrow for the whole placeholder plus the stylesheet's 3% margin (room / 21).
      if (fit.room >= 21 * fit.base) expect(fit.size).toBe(fit.base);
      if (width === 1280) expect(fit.size).toBe(fit.base);
    }
    if (remixer) await page.getByRole('tab', { name: /REMIXER/ }).click();
    await expect(page.locator(remixer ? '#remix-deck' : '#jobs')).toBeVisible();
    await expect(page.locator('#crate, [id^="crate-"], [class*="crate"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/browse the crate/i);
    await expect(page.locator('[id^="da-"], .da-panel')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/devil|defend your mix|challenge me/i);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
