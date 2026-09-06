import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const receipts = process.env.STEM_SCREENSHOT_DIR;
test('CAIL student, instructor and admin surfaces; one Crate and attribution-bearing Remixer capture', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const alice = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const admin = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.carol });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, REMIXER_ENABLED: 'true', TEST_BROWSER: 'true',
  }, secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (receipts) await mkdir(receipts, { recursive: true });
  try {
    const { url } = await server.listen();
    const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    const attribution = { title: 'Licensed fixture', creator: 'Fixture ensemble', sourceUrl: 'https://archive.org/details/fixture', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', fileName: 'fixture.mp3' };
    sql.push(`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Licensed fixture', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`,
      `INSERT INTO job_attributions (job_id, attribution) VALUES ('remix-fixture', '${JSON.stringify(attribution)}')`);
    expect((await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) })).status).toBe(200);
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    await page.goto(new URL('/teacher.html', url).href);
    await expect(page.locator('#signin-panel')).toBeVisible();
    await expect(page.getByLabel('PASSWORD')).toBeHidden();
    if (receipts) await page.screenshot({ path: `${receipts}/01-instructor-signed-out.png`, fullPage: true, animations: 'disabled' });
    await context.setExtraHTTPHeaders({ 'x-cail-identity-jwt': alice });
    await page.addInitScript((subject) => localStorage.setItem(`jobs:${subject}`, JSON.stringify([{ id: 'remix-fixture', filename: 'Licensed fixture', model: 'htdemucs_ft' }])), TEST_SUBJECTS.alice);
    await page.goto(url.href);
    await expect(page.locator('.badge.ready')).toBeVisible();
    await expect(page.locator('#crate')).toHaveCount(1);
    await expect(page.locator('#split-summary')).toHaveText('// a closer listen');
    await page.getByRole('tab', { name: /REMIXER/ }).click();
    await expect(page.locator('#crate')).toBeVisible();
    await page.locator('.shelf-stem').first().click();
    await expect(page.locator('.rlayer')).toHaveCount(1);
    await page.getByRole('button', { name: '● CAPTURE' }).click();
    await expect(page.getByRole('button', { name: '■ END TAKE' })).toBeVisible();
    await expect(page.locator('.rlayer')).toHaveAttribute('inert', '');
    await expect.poll(() => page.evaluate(() => remixNow())).toBeGreaterThan(0.25);
    await page.getByRole('button', { name: '■ END TAKE' }).click();
    const save = page.getByRole('link', { name: 'SAVE WITH CREDITS ↓' });
    await expect(save).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const bytes = await readFile(await download.path());
    const bundle = { signature: [...bytes.slice(0, 4)], text: new TextDecoder().decode(bytes) };
    expect(bundle.signature).toEqual([80, 75, 3, 4]);
    expect(bundle.text).toContain('ATTRIBUTION.txt');
    expect(bundle.text).toContain('Fixture ensemble');
    expect(bundle.text).toContain('https://creativecommons.org/licenses/by/4.0/');
    if (receipts) await page.screenshot({ path: `${receipts}/02-remixer-fixture-export.png`, fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: /SPLITTER/ }).click();
    await expect(page.locator('.console-title')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.mouse.move(0, 0);
    if (receipts) await page.screenshot({ path: `${receipts}/03-student-mobile-fixture.png`, fullPage: true, animations: 'disabled' });
    await context.setExtraHTTPHeaders({ 'x-cail-identity-jwt': admin });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/account.html', url).href);
    await expect(page.locator('#account-admin')).toBeVisible();
    expect((await page.getByRole('button', { name: 'SAVE', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.locator('#access-role').selectOption('instructor');
    await page.locator('#access-expiry').fill('2026-12-01T12:00');
    await page.getByRole('button', { name: 'SAVE', exact: true }).click();
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    if (receipts) await page.screenshot({ path: `${receipts}/04-admin-access-fixture.png`, fullPage: true, animations: 'disabled' });
    await context.setExtraHTTPHeaders({ 'x-cail-identity-jwt': alice });
    await page.goto(new URL('/teacher.html', url).href);
    await expect(page.locator('#console-panel')).toBeVisible();
    await page.locator('#amendment').fill('Ask students to compare two layers.');
    await page.locator('#change-note').fill('Listening exercise');
    await page.getByRole('button', { name: 'SAVE', exact: true }).click();
    await expect(page.locator('#prompt-status')).toContainText('Saved');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
