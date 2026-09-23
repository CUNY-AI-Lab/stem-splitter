import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('Listening Guide preserves the mixer through completion, refusal and cancellation', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const subject = TEST_SUBJECTS.alice;
  const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject });
  const gatewayJwt = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true' }, secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const headers = { 'x-fixture-identity': appJwt, 'x-fixture-gateway-identity': gatewayJwt };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    sql.push(`INSERT INTO app_users (subject) VALUES ('${subject}')`,
      `INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Synthetic audio', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${subject}')`);
    expect((await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) })).status).toBe(200);
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    await context.setExtraHTTPHeaders(headers);
    await page.addInitScript(subject => localStorage.setItem(`jobs:${subject}`, JSON.stringify([{ id: 'remix-fixture', filename: 'Synthetic audio', model: 'htdemucs_ft' }])), subject);
    await page.goto(url.href);
    await expect(page.locator('.badge.ready')).toBeVisible();
    await page.locator('.coach-toggle').click();
    await page.locator('.coach-cue-btn').click();
    await expect(page.locator('.coach-guide')).toContainText('Listen for the bass');
    await expect(page.getByRole('button', { name: 'CANCEL REQUEST', exact: true })).toBeHidden();
    const stats = async () => (await (await server.fetch('/__fixture/gateway-stats', { headers: { 'x-fixture': 'local-only' } })).json()).gatewayCalls;
    expect(await stats()).toBe(1);
    await context.setExtraHTTPHeaders({ ...headers, 'x-fixture-gateway-mode': 'trailing-error' });
    await page.locator('.coach-form input').fill('Compare these layers.');
    await page.locator('.coach-form input').press('Enter');
    await expect(page.locator('.coach-row.error')).toContainText('CAIL model usage limit');
    await expect(page.locator('.coach-row.error')).toContainText('Support ID:');
    expect(await stats()).toBe(2);
    await expect(page.locator('.badge.ready')).toBeVisible();
    await context.setExtraHTTPHeaders({ ...headers, 'x-fixture-gateway-mode': 'pending' });
    await page.locator('.coach-form input').fill('A cancellable request.');
    await page.locator('.coach-form input').press('Enter');
    await expect.poll(stats).toBe(3);
    await page.getByRole('button', { name: 'CANCEL REQUEST', exact: true }).click();
    await expect(page.locator('.coach-row.error').last()).toContainText('Request cancelled');
    await expect(page.locator('.coach-form input')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'CANCEL REQUEST', exact: true })).toBeHidden();
    expect(await stats()).toBe(3);
    await context.setExtraHTTPHeaders(headers);
    await page.goto(new URL('/account.html', url).href);
    await expect(page.locator('#account-quota')).toContainText('90%');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
