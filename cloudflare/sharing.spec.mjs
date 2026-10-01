import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('shared split opens signed out, plays, and keeps private tools and data inaccessible', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    sql.push(`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO jobs (id, filename, source_key, status, model, stems, labels) VALUES ('remix-fixture', 'Shared audio', 'uploads/private.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]', '{"vocals":"PRIVATE LABEL"}')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`);
    await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) });
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    const token = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': token });
    await page.goto(url.href);
    await expect(page.locator('.console-title')).toHaveText('Shared audio');
    await page.locator('.share-btn:not(.to-remix-btn)').click();
    await expect.poll(async () => (await server.fetch('/api/shared-jobs/remix-fixture')).status).toBe(200);
    await page.locator('.unshare-btn').click();
    await expect.poll(async () => (await server.fetch('/api/shared-jobs/remix-fixture')).status).toBe(404);
    await page.locator('.share-btn:not(.to-remix-btn)').click();
    await expect.poll(async () => (await server.fetch('/api/shared-jobs/remix-fixture')).status).toBe(200);
    await context.setExtraHTTPHeaders({});
    await page.goto(new URL('/?job=remix-fixture', url).href);
    await expect(page.locator('.console-title')).toHaveText('Shared audio');
    await expect(page.locator('.badge')).toHaveText('SHARED');
    await expect(page.locator('.coach')).toBeHidden();
    await expect(page.locator('.note-btn')).toBeHidden();
    await expect(page.locator('.folder-btn')).toBeHidden();
    await expect(page.getByText('PRIVATE LABEL')).toHaveCount(0);
    await page.locator('.play-btn').click();
    await expect(page.locator('.tc-now')).not.toHaveText('0:00', { timeout: 8000 });
    await page.locator('.play-btn').click();
    expect(new URL(page.url()).searchParams.get('job')).toBe('remix-fixture');
    await page.reload();
    await expect(page.locator('.console-title')).toHaveText('Shared audio');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.play-btn')).toBeVisible();
    await page.screenshot({ path: '/tmp/stem-shared-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
