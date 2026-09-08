import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

for (const remixer of [false, true]) test(`Crate first, no adversarial panel; Remixer flag ${remixer}`, async ({ page }) => {
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
    if (remixer) await page.getByRole('tab', { name: /REMIXER/ }).click();
    await expect(page.locator(`#view-${remixer ? 'remixer' : 'splitter'} > section`).first()).toHaveAttribute('id', 'crate');
    await expect(page.locator('#crate')).toHaveCount(1);
    await expect(page.locator('[id^="da-"], .da-panel')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/devil|defend your mix|challenge me/i);
    await page.locator('#crate-toggle').click();
    await expect(page.locator('#crate-body')).toBeVisible();
    await page.locator('#crate-toggle').click();
    await expect(page.locator('#crate-body')).toBeHidden();
    const receipts = process.env.STEM_SCREENSHOT_DIR;
    if (receipts) {
      await mkdir(receipts, { recursive: true });
      await page.screenshot({ path: `${receipts}/${remixer ? 'remixer' : 'splitter'}-crate-first-desktop.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (receipts) await page.screenshot({ path: `${receipts}/${remixer ? 'remixer' : 'splitter'}-crate-first-mobile.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
