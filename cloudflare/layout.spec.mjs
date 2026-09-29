import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

for (const remixer of [false, true]) test(`Crate below the workspace, no adversarial panel; Remixer flag ${remixer}`, async ({ page }) => {
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
    await expect(page.locator('#split-summary')).toHaveText('// a closer listen');
    await expect(page.getByRole('textbox', { name: 'YouTube link', exact: true })).toBeVisible();
    await page.locator('#yt-disclosure summary').click();
    await expect(page.locator('#yt-url')).toBeHidden();
    await page.locator('#yt-disclosure summary').click();
    await expect(page.locator('#yt-url')).toBeVisible();
    if (process.env.STEM_SCREENSHOT_DIR && !remixer) {
      await mkdir(process.env.STEM_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.STEM_SCREENSHOT_DIR}/youtube-expanded-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#yt-url').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.STEM_SCREENSHOT_DIR}/youtube-expanded-mobile.png` });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    if (remixer) await page.getByRole('tab', { name: /REMIXER/ }).click();
    await expect(page.locator(`#view-${remixer ? 'remixer' : 'splitter'} > section`).last()).toHaveAttribute('id', 'crate');
    const workspace = page.locator(remixer ? '#remix-deck' : '#jobs');
    const workspaceBox = await workspace.boundingBox();
    const crateBox = await page.locator('#crate').boundingBox();
    expect(crateBox.y).toBeGreaterThanOrEqual(workspaceBox.y + workspaceBox.height);
    await expect(page.locator('#crate')).toHaveCount(1);
    await expect(page.locator('[id^="da-"], .da-panel')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/devil|defend your mix|challenge me/i);
    if (!remixer) await page.locator('#crate-toggle').click();
    await expect(page.locator('#crate-body')).toBeVisible();
    await page.locator('#crate-toggle').click();
    await expect(page.locator('#crate-body')).toBeHidden();
    const receipts = process.env.STEM_SCREENSHOT_DIR;
    if (receipts) {
      await mkdir(receipts, { recursive: true });
      await page.locator('#crate').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${receipts}/${remixer ? 'remixer' : 'splitter'}-crate-below-desktop.png`, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const mobileWorkspace = await workspace.boundingBox();
    const mobileCrate = await page.locator('#crate').boundingBox();
    expect(mobileCrate.y).toBeGreaterThanOrEqual(mobileWorkspace.y + mobileWorkspace.height);
    if (receipts) {
      await page.locator('#crate').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${receipts}/${remixer ? 'remixer' : 'splitter'}-crate-below-mobile.png`, animations: 'disabled' });
    }
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
