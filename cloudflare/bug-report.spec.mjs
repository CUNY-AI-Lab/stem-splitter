import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { fileURLToPath } from 'node:url';

async function setup(page) {
  const harness = createTestHarness({ workers: [{ config: {
    name: 'bug-report-test', main: fileURLToPath(new URL('./test-bug-report-worker.ts', import.meta.url)),
    alias: { hono: 'hono-cloudflare', 'hono/factory': 'hono-cloudflare/factory' },
    compatibility_date: '2026-09-06', compatibility_flags: ['nodejs_compat'],
    assets: { directory: fileURLToPath(new URL('../public', import.meta.url)), binding: 'ASSETS', run_worker_first: true },
    vars: { AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://split.test' },
    ratelimits: [{ name: 'REQUEST_LIMIT', namespace_id: '884476', simple: { limit: 1000, period: 60 } }],
  } }] });
  const { url } = await harness.listen();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const control = mode => harness.fetch('/__bug-fixture', { method: 'POST', body: JSON.stringify({ mode }) });
  const stats = async () => (await (await harness.fetch('/__bug-fixture')).json()).calls;
  await page.goto(new URL('/account.html', url).href);
  return { harness, url, errors, control, stats };
}
const report = { reportId: '77000000-0000-4000-8000-000000000001', name: 'Fixture Reporter', email: 'reporter@example.edu', description: 'The button stayed unavailable after I tried to upload.' };
const submit = (page, body = report) => page.evaluate(async body => {
  const response = await fetch('/api/bug-reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}, body);
async function fillComment(page) {
  await page.getByRole('button', { name: 'Send us a comment', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill(report.name);
  await page.getByLabel('Your email', { exact: true }).fill(report.email);
  await page.getByLabel('What happened?', { exact: true }).fill(report.description);
}
test('each page exposes a keyboard-accessible comment action without sending on open', async ({ page }, testInfo) => {
  const f = await setup(page);
  try {
    for (const path of ['/account.html', '/teacher.html', '/', '/classroom.html']) {
      await page.goto(new URL(path, f.url).href);
      await expect(page.locator('.project-credit')).toContainText('Built through the Critical AI Literacy Institute.');
      const open = page.getByRole('button', { name: 'Send us a comment', exact: true });
      await expect(open).toBeVisible();
      await open.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('form', { name: 'Send us a comment' })).toBeVisible();
      await expect(page.getByLabel('Your name', { exact: true })).toBeFocused();
      await expect(page.locator('#comment-help')).toContainText('Do not include passwords, private student information, or Listening Guy conversations.');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (path === '/') await page.locator('.bug-report').screenshot({ path: testInfo.outputPath('feedback-mobile.png') });
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(open).toBeFocused();
    }
    expect(await f.stats()).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('background report API accepts only the original bounded report fields', async ({ page }) => {
  const f = await setup(page);
  try {
    expect(await submit(page, { ...report, attachment: 'private fixture' })).toMatchObject({ status: 400, body: { ok: false, code: 'invalid' } });
    expect(await f.stats()).toEqual([]);
    expect(await submit(page)).toEqual({ status: 200, body: { ok: true, status: 'accepted', reportId: report.reportId } });
    const calls = await f.stats(); expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]).sort()).toEqual(['description', 'email', 'name', 'origin', 'rateDay', 'rateKey', 'reportId']);
    expect(calls[0]).toMatchObject(report); expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('comment form sends only entered fields and accepts once', async ({ page }) => {
  const f = await setup(page);
  try {
    await fillComment(page);
    await page.getByRole('button', { name: 'Send comment', exact: true }).click();
    await expect(page.locator('#comment-status')).toContainText('Your comment was accepted. Reference:');
    const calls = await f.stats(); expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]).sort()).toEqual(['description', 'email', 'name', 'origin', 'rateDay', 'rateKey', 'reportId']);
    expect(calls[0]).toMatchObject({ name: report.name, email: report.email, description: report.description });
    await expect(page.getByRole('button', { name: 'Send comment', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Send us a comment', exact: true }).click();
    await expect(page.locator('#comment-status')).toContainText(calls[0].reportId);
    expect(await f.stats()).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('comment form preserves the same reference and fields through an explicit safe retry', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control('unavailable');
    await fillComment(page);
    await page.getByRole('button', { name: 'Send comment', exact: true }).click();
    await expect(page.locator('#comment-status')).toContainText('Your comment was not accepted.');
    await expect(page.getByLabel('What happened?', { exact: true })).toBeDisabled();
    const first = (await f.stats())[0];
    expect(first).toMatchObject({ name: report.name, email: report.email, description: report.description });
    await f.control('accepted');
    await page.getByRole('button', { name: 'Retry same comment', exact: true }).click();
    await expect(page.locator('#comment-status')).toContainText('Your comment was accepted.');
    expect((await f.stats())[0]).toEqual(first); expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('uncertain delivery preserves the reference and disables another send', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control('unknown');
    await fillComment(page);
    await page.getByRole('button', { name: 'Send comment', exact: true }).click();
    await expect(page.locator('#comment-status')).toContainText('Your comment may already have been sent');
    const calls = await f.stats(); expect(calls).toHaveLength(1);
    await expect(page.locator('#comment-status')).toContainText(calls[0].reportId);
    await expect(page.getByRole('button', { name: 'Send comment', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Send us a comment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send comment', exact: true })).toBeDisabled();
    expect(await f.stats()).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('a lost response is uncertain and never retries automatically', async ({ page }) => {
  const f = await setup(page);
  try {
    let attempts = 0;
    await page.route('**/api/bug-reports', route => { attempts++; return route.abort('failed'); });
    await fillComment(page);
    await page.getByRole('button', { name: 'Send comment', exact: true }).click();
    await expect(page.locator('#comment-status')).toContainText('We could not confirm delivery.');
    await expect(page.getByRole('button', { name: 'Send comment', exact: true })).toBeDisabled();
    expect(attempts).toBe(1); expect(await f.stats()).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('empty or too-short comments stay in the browser', async ({ page }) => {
  const f = await setup(page);
  try {
    await fillComment(page);
    await page.getByLabel('What happened?', { exact: true }).fill('Short');
    await page.getByRole('button', { name: 'Send comment', exact: true }).click();
    expect(await f.stats()).toEqual([]);
    await expect(page.getByLabel('What happened?', { exact: true })).toBeEditable();
    expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
