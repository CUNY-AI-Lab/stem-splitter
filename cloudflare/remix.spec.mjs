import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('Crate audio -> multi-source arrangement -> recorded song with credits, without separation', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const token = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const mp3 = await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  let downloads = 0;
  let predictions = 0;
  const network = setupServer(
    http.get('https://archive.org/advancedsearch.php', () => HttpResponse.json({ response: { numFound: 1, docs: [{ identifier: 'remix-test', title: 'Open recordings', creator: 'Fixture ensemble', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' }] } })),
    http.get('https://archive.org/metadata/remix-test', () => HttpResponse.json({ metadata: { title: 'Open recordings', creator: 'Fixture ensemble', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' }, files: ['one.mp3', 'two.mp3'].map(name => ({ name, title: name, size: String(mp3.length), length: '3' })) })),
    http.get('https://archive.org/download/remix-test/:file', () => { downloads++; return new HttpResponse(mp3, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(mp3.length) } }); }),
    http.post('https://api.replicate.com/v1/predictions', () => { predictions++; return HttpResponse.json({}, { status: 500 }); }),
  );
  network.listen({ onUnhandledRequest: 'error' });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, REMIXER_ENABLED: 'true', TEST_BROWSER: 'true' }, secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
    expect((await server.fetch('/api/remix/archive-audio', { method: 'POST', headers: { Origin: url.origin }, body: '{}' })).status).toBe(401);
    expect(downloads).toBe(0);
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': token });
    await page.goto(url.href);
    await expect(page).toHaveTitle('Stem Splitter');
    await page.getByRole('tab', { name: /REMIXER/ }).click();
    await expect(page.locator('#view-remixer > section').first()).toHaveAttribute('id', 'crate');
    await expect(page.locator('#da-toggle')).toHaveCount(0);
    await page.getByRole('button', { name: 'SEARCH', exact: true }).click();
    await page.locator('.crate-item-head').click();
    await page.locator('.crate-preview').first().click();
    await expect(page.locator('.crate-track audio')).toHaveCount(1);
    await page.locator('.crate-add').first().click();
    await page.locator('.crate-add').nth(1).click();
    await expect(page.locator('.rlayer')).toHaveCount(2);
    expect(downloads).toBe(2); // Preview and first layer share the same validated bytes.
    expect(predictions).toBe(0);
    await page.getByLabel('Song title').fill('My first song');
    await page.getByLabel('Length (seconds)').fill('2');
    await page.locator('.rl-offset').nth(1).fill('0.5');
    await page.locator('.rl-offset').nth(1).press('Tab');
    await page.locator('.rl-rate').nth(1).selectOption('0.75');
    await page.locator('.rl-loop').first().click();
    await page.locator('.rl-pan').nth(1).fill('30');
    await page.getByRole('button', { name: '● CAPTURE' }).click();
    await expect(page.getByRole('button', { name: '■ END TAKE' })).toBeVisible();
    await expect(page.locator('.rlayer').first()).toHaveAttribute('inert', '');
    await expect(page.getByRole('link', { name: 'SAVE WITH CREDITS ↓' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play the remix', exact: true })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'SAVE WITH CREDITS ↓' }).click()]);
    expect(download.suggestedFilename()).toBe('My-first-song-take-01.zip');
    const bytes = await readFile(await download.path());
    expect([...bytes.slice(0, 4)]).toEqual([80, 75, 3, 4]);
    const text = new TextDecoder().decode(bytes);
    for (const value of ['ATTRIBUTION.txt', 'remix.json', 'one.mp3', 'two.mp3', 'Fixture ensemble', 'https://creativecommons.org/licenses/by/4.0/', 'My first song']) expect(text).toContain(value);
    expect(bytes.length).toBeGreaterThan(1500);
    const receipts = process.env.STEM_SCREENSHOT_DIR;
    if (receipts) { await mkdir(receipts, { recursive: true }); await page.screenshot({ path: `${receipts}/07-crate-remix-download-desktop.png`, fullPage: true }); }
    await page.getByRole('button', { name: 'CLEAR', exact: true }).click();
    await page.getByRole('button', { name: 'SURE?', exact: true }).click();
    await expect(page.locator('.rlayer')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'SAVE WITH CREDITS ↓' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (receipts) await page.screenshot({ path: `${receipts}/08-crate-remix-download-mobile.png`, fullPage: true });
    expect(errors).toEqual([]);
    expect(predictions).toBe(0);
  } finally { await server.close(); network.close(); }
});
