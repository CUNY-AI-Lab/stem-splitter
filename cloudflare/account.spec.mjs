import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('Account stays simple; administration is deliberate, responsive, and recoverable', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const identities = Object.fromEntries(await Promise.all(['alice', 'carol'].map(async name => [name,
    await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS[name] })])));
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true' },
    secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let memberReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/users') memberReads++; });
  const receipts = process.env.STEM_SCREENSHOT_DIR;
  try {
    const { url } = await server.listen();
    const seed = statements => server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements) });
    await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.carol });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/account.html', url).href);
    await expect(page).toHaveTitle('STEM Splitter · Account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.locator('#account-role')).toHaveText('Administrator access');
    await expect(page.getByRole('link', { name: 'Class guidance', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '← Back to Splitter', exact: true })).toHaveAttribute('href', '/');
    await expect(page.locator('#access-form')).toBeHidden();
    await expect(page.locator('#account-id')).toBeHidden();
    expect(memberReads).toBe(0);
    await expect(page.locator('body')).not.toContainText(/Workspace ID|back to the mixer|Manage CUNY sign-in/);
    if (receipts) {
      await mkdir(receipts, { recursive: true });
      await page.screenshot({ path: `${receipts}/account-admin-desktop-fixture.png`, fullPage: true });
    }
    await page.getByText('Manage access', { exact: true }).click();
    await expect(page.locator('#access-empty')).toBeVisible();
    await expect(page.locator('#access-form')).toBeHidden();
    expect(memberReads).toBe(1);

    await seed([`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`]);
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeHidden();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toBeHidden();
    await expect(page.getByLabel('Allow access to STEM Splitter', { exact: true })).toBeChecked();
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('instructor');
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toHaveAttribute('required', '');
    await page.getByLabel('Instructor access ends', { exact: true }).fill('2026-12-01T12:00');
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('student');
    await page.getByLabel('Allow access to STEM Splitter', { exact: true }).uncheck();
    const [update] = await Promise.all([
      page.waitForRequest(request => request.method() === 'PUT'),
      page.getByRole('button', { name: 'Save changes', exact: true }).click(),
    ]);
    expect(update.postDataJSON()).toMatchObject({ role: 'student', disabled: true, expiresAt: null });
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    await expect(page.getByLabel('Allow access to STEM Splitter', { exact: true })).not.toBeChecked();
    await page.getByLabel('Allow access to STEM Splitter', { exact: true }).check();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => (await page.request.get(new URL('/api/admin/users', url).href)).json().then(body => body.users.find(user => user.subject === TEST_SUBJECTS.alice).disabled)).toBe(0);

    // A provider-boundary failure affects only the deliberately opened management area.
    await page.route('**/api/admin/users', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Account access is temporarily unavailable.' }) }));
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await expect(page.locator('#access-status')).toHaveText('Account access is temporarily unavailable.');
    await expect(page.locator('#account-role')).toHaveText('Administrator access');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.locator('#account-login')).toBeHidden();
    await expect(page.locator('#access-form')).toBeHidden();
    await page.unroute('**/api/admin/users');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.locator('#access-status')).toBeEmpty();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.getByRole('button', { name: 'Save changes', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    if (receipts) await page.screenshot({ path: `${receipts}/account-access-mobile-fixture.png`, fullPage: true });

    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.alice });
    await page.reload();
    await expect(page.locator('#account-role')).toHaveText('Student access');
    await expect(page.locator('#account-admin')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Class guidance', exact: true })).toBeHidden();
    await page.getByText('Account ID', { exact: true }).click();
    await expect(page.locator('#account-id')).toHaveText(TEST_SUBJECTS.alice);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByText('Account ID', { exact: true }).click();
    if (receipts) await page.screenshot({ path: `${receipts}/account-student-mobile-fixture.png`, fullPage: true });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.carol });
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('instructor');
    await page.getByLabel('Instructor access ends', { exact: true }).fill('2026-12-01T12:00');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.alice });
    await page.reload();
    await expect(page.locator('#account-role')).toHaveText('Instructor access');
    await expect(page.getByRole('link', { name: 'Class guidance', exact: true })).toBeVisible();
    await expect(page.locator('#account-admin')).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
