import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('account rack recovers on a new browser; isolates people; handles paging, import and outages', async ({ page, context, browser }) => {
  const issuer = await createTestIdentityIssuer();
  const tokens = Object.fromEntries(await Promise.all(['alice', 'bob'].map(async name => [name,
    await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS[name] })])));
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' }, secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let second;
  try {
    const { url } = await server.listen();
    const seed = async statements => expect((await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements) })).status).toBe(200);
    await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
    const sql = [
      ...['alice', 'bob'].map(name => `INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS[name]}')`),
      `INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Alice saved recording', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`,
      `INSERT INTO annotations (id, job_id, at_seconds, text) VALUES ('saved-note', 'remix-fixture', 1, 'Saved listening note')`,
      `INSERT INTO jobs (id, filename, source_key, status) VALUES ('bob-only', 'Bob private recording', 'uploads/bob.wav', 'failed')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('bob-only', '${TEST_SUBJECTS.bob}')`,
      `INSERT INTO jobs (id, filename, source_key, status) VALUES ('unclaimed', 'Reviewed legacy recording', 'uploads/legacy.wav', 'failed')`,
      `INSERT INTO jobs (id, filename, source_key, status, created_at) VALUES ('expired', 'Expired recording', 'uploads/old.wav', 'failed', datetime('now', '-91 days'))`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('expired', '${TEST_SUBJECTS.alice}')`,
    ];
    for (let n = 0; n < 41; n++) {
      sql.push(`INSERT INTO jobs (id, filename, source_key, status, created_at) VALUES ('older-${n}', 'Older recording ${n}', 'uploads/older.wav', 'failed', datetime('now', '-60 days'))`,
        `INSERT INTO job_owners (job_id, subject) VALUES ('older-${n}', '${TEST_SUBJECTS.alice}')`);
    }
    await seed(sql);
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    await page.goto(url.href);
    const login = page.getByRole('link', { name: 'CUNY Login', exact: true });
    await expect(login).toHaveClass('account-button');
    await expect(login).toHaveAttribute('href', '/auth/login');
    expect((await login.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#job-list .console')).toHaveCount(0);
    const receipts = process.env.STEM_SCREENSHOT_DIR;
    if (receipts) { await mkdir(receipts, { recursive: true }); await page.screenshot({ path: `${receipts}/cuny-login-desktop.png`, animations: 'disabled' }); }

    await context.setExtraHTTPHeaders({ 'x-fixture-identity': tokens.alice });
    await page.reload();
    await expect(page.getByRole('link', { name: 'My account', exact: true })).toHaveClass('account-button');
    await expect(page.locator('.badge.ready')).toBeVisible();
    await expect(page.locator('#job-list .console')).toHaveCount(40);
    await expect(page.locator('#job-list')).toContainText('Saved listening note');
    await expect(page.locator('#job-list')).not.toContainText(/Bob private|Reviewed legacy|Expired recording/);
    await page.getByRole('button', { name: 'Load more splits', exact: true }).click();
    await expect(page.locator('#job-list .console')).toHaveCount(42);
    await expect(page.locator('#rack-more')).toBeHidden();
    await expect(page.locator('#rack-status')).toBeHidden();
    await page.route('**/api/jobs', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ json: { id: 'saved-message', filename: 'Saved example', model: 'htdemucs_ft', status: 'processing', savedToAccount: true } });
    });
    await page.route('**/api/jobs/saved-message', route => route.fulfill({ json: { id: 'saved-message', filename: 'Saved example', model: 'htdemucs_ft', status: 'processing', stems: [] } }));
    await page.locator('#yt-url').fill('https://www.youtube.com/watch?v=fixture1234');
    await page.locator('#yt-form button').click();
    await expect(page.locator('#upload-message')).toContainText('Saved to your account.');
    await page.unroute('**/api/jobs');
    await page.route('**/api/jobs', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 429, json: { code: 'split_daily_limit', error: 'Limit reached', resetsAt: '2026-09-30T00:00:00Z' } });
    });
    await page.locator('#yt-url').fill('https://www.youtube.com/watch?v=fixture1234');
    await page.locator('#yt-form button').click();
    await expect(page.locator('#upload-message')).toContainText("Today's 15 places are completed or in progress.");
    await expect(page.locator('#upload-message')).not.toContainText('Saved to your account');
    await page.unroute('**/api/jobs');
    await page.getByRole('link', { name: 'My account', exact: true }).click();
    await expect(page.locator('#account-role')).toHaveText('Student access');
    await page.getByRole('link', { name: '← Back to Splitter', exact: true }).click();
    await expect(page.locator('.badge.ready')).toBeVisible();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.badge.ready')).toBeVisible();

    second = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-identity': tokens.alice }, viewport: { width: 390, height: 844 } });
    // A separate browser with storage unavailable must still recover owned work.
    await second.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); }; });
    const fresh = await second.newPage();
    fresh.on('pageerror', error => errors.push(error.message));
    await fresh.goto(url.href);
    await expect(fresh.locator('.badge.ready')).toHaveText('READY');
    await expect(fresh.locator('.console-title').first()).toContainText('Alice saved recording');
    await expect(fresh.locator('#job-list')).toContainText('Saved listening note');
    expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (receipts) {
      await fresh.screenshot({ path: `${receipts}/account-button-mobile.png`, animations: 'disabled' });
      await fresh.locator('#job-list .console').first().evaluate(el => el.scrollIntoView({ block: 'start' }));
      await fresh.screenshot({ path: `${receipts}/account-rack-mobile.png`, animations: 'disabled' });
    }
    await second.close(); second = null;

    // An approved importer only needs to assign reviewed ownership; no browser
    // localStorage edits are needed for the imported record to be discoverable.
    await seed([`INSERT INTO job_owners (job_id, subject) VALUES ('unclaimed', '${TEST_SUBJECTS.alice}')`]);
    await page.reload();
    await expect(page.locator('#job-list')).toContainText('Reviewed legacy recording');
    await page.route('**/api/jobs', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' }));
    await page.reload();
    await expect(page.locator('#rack-status')).toHaveText('Your saved splits could not be loaded. Try again.');
    await expect(page.locator('#empty-state')).toBeHidden();
    await page.unroute('**/api/jobs');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.locator('.badge.ready')).toBeVisible();
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': tokens.bob });
    await page.reload();
    await expect(page.locator('#job-list')).toContainText('Bob private recording');
    await expect(page.locator('#job-list .console')).toHaveCount(1);
    await expect(page.locator('#job-list')).not.toContainText(/Alice saved|Saved listening note|Reviewed legacy/);
    await context.setExtraHTTPHeaders({});
    await page.reload();
    await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toBeVisible();
    await expect(page.locator('#job-list .console')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { if (second) await second.close(); await server.close(); }
});
