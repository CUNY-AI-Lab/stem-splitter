import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('Listening Guide preserves the mixer and syncs private CUNY history across browsers', async ({ page, context, browser }) => {
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
    await page.locator('.coach-form input').fill('What should I listen for next?');
    await page.locator('.coach-form input').press('Enter');
    await expect(page.locator('.coach-row.coach')).toContainText('Listen for the bass against the drums.');
    await expect(page.locator('.coach-save-status')).toContainText('Saved to your CUNY account.');
    const secondContext = await browser.newContext();
    try {
      await secondContext.setExtraHTTPHeaders(headers);
      const secondPage = await secondContext.newPage();
      await secondPage.goto(url.href);
      await expect(secondPage.locator('.badge.ready')).toBeVisible();
      const downloaded = secondPage.waitForEvent('download');
      await secondPage.locator('.export-btn').click();
      const archive = await downloaded;
      expect((await readFile(await archive.path())).includes(Buffer.from('What should I listen for next?'))).toBe(true);
      await secondPage.locator('.coach-toggle').click();
      await expect(secondPage.locator('.coach-archive')).toBeVisible();
      await expect(secondPage.locator('.coach-archive-toggle')).toContainText('EARLIER SESSION · 2');
      await secondPage.locator('.coach-form input').fill('And now the drums?');
      await secondPage.locator('.coach-form input').press('Enter');
      await expect(secondPage.locator('.coach-row.coach')).toContainText('Listen for the bass against the drums.');
      const captured = await server.fetch('/__fixture/gateway-messages', { headers: { 'x-fixture': 'local-only' } }).then(response => response.json());
      expect(captured.messages.map(message => message.content)).toContain('What should I listen for next?');
      expect(captured.messages.map(message => message.content)).toContain('And now the drums?');
      expect(captured.messages.some(message => message.role === 'assistant' && message.content === 'Listen for the bass against the drums.')).toBe(true);
      await expect(secondPage.locator('.coach-form input')).toBeEnabled();
      await expect(secondPage.locator('.coach-save-status')).toContainText('Saved to your CUNY account.');
    } finally { await secondContext.close(); }
    expect(await stats()).toBe(3);
    await page.reload();
    await expect(page.locator('.badge.ready')).toBeVisible();
    await page.locator('.coach-toggle').click();
    await expect(page.locator('.coach-archive-toggle')).toContainText('EARLIER SESSION · 4');
    await context.setExtraHTTPHeaders({ ...headers, 'x-fixture-gateway-mode': 'trailing-error' });
    await page.locator('.coach-form input').fill('Compare these layers.');
    await page.locator('.coach-form input').press('Enter');
    await expect(page.locator('.coach-row.error')).toContainText('CAIL model usage limit');
    await expect(page.locator('.coach-row.error')).toContainText('Support ID:');
    expect(await stats()).toBe(4);
    await expect(page.locator('.badge.ready')).toBeVisible();
    await context.setExtraHTTPHeaders({ ...headers, 'x-fixture-gateway-mode': 'pending' });
    await page.locator('.coach-form input').fill('A cancellable request.');
    await page.locator('.coach-form input').press('Enter');
    await expect.poll(stats).toBe(5);
    await page.getByRole('button', { name: 'CANCEL REQUEST', exact: true }).click();
    await expect(page.locator('.coach-row.error').last()).toContainText('Request cancelled');
    await expect(page.locator('.coach-form input')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'CANCEL REQUEST', exact: true })).toBeHidden();
    expect(await stats()).toBe(5);
    await context.setExtraHTTPHeaders(headers);
    await page.locator('.coach-reset').click();
    await page.locator('.coach-reset').click();
    await expect(page.locator('.coach-archive')).toBeHidden();
    await page.reload();
    await expect(page.locator('.badge.ready')).toBeVisible();
    const restored = page.waitForResponse(response => response.url().endsWith('/listening-conversation') && response.request().method() === 'GET');
    await page.locator('.coach-toggle').click();
    expect((await (await restored).json()).entries).toEqual([]);
    await expect(page.locator('.coach-archive')).toBeHidden();
    await expect(page.locator('.coach-guide')).toContainText('Listen for the bass');
    await page.goto(new URL('/account.html', url).href);
    await expect(page.locator('#account-quota')).toContainText('90%');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
