import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

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
async function fill(page) {
  await page.getByLabel('Name', { exact: true }).fill('Fixture Reporter');
  await page.getByLabel('Email', { exact: true }).fill('reporter@example.edu');
  await page.getByLabel('Description of the bug').fill('The button stayed unavailable after I tried to upload.');
}
test('signed-out footer expands by keyboard and submits once without private attachments', async ({ page }) => {
  const f = await setup(page);
  try {
    for (const path of ['/account.html', '/teacher.html', '/classroom.html', '/']) {
      await page.goto(new URL(path, f.url).href);
      await expect(page.locator('.bug-report > summary')).toBeVisible();
      await expect(page.getByRole('form', { name: 'Report a bug' })).toBeHidden();
    }
    await page.goto(new URL('/account.html', f.url).href);
    const summary = page.locator('.bug-report > summary'); await summary.focus(); await summary.press('Enter');
    await expect(page.getByLabel('Name', { exact: true })).toBeVisible(); await fill(page);
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(page.locator('.bug-report__status')).toContainText('accepted for delivery');
    await expect(page.getByRole('button', { name: 'Report sent' })).toBeDisabled();
    const calls = await f.stats(); expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]).sort()).toEqual(['description', 'email', 'name', 'origin', 'rateDay', 'rateKey', 'reportId']);
    expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('known failure preserves editable fields and explicit retry uses the same reference', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control('unavailable'); await page.locator('.bug-report > summary').click(); await fill(page);
    const sent = []; page.on('request', request => { if (request.url().endsWith('/api/bug-reports')) sent.push(request.postDataJSON()); });
    await page.getByRole('button', { name: 'Send bug report' }).click();
    await expect(page.locator('.bug-report__status')).toContainText('description is still here');
    await expect(page.getByLabel('Name', { exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await f.control('accepted'); await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.bug-report__status')).toContainText('accepted for delivery');
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('double submit is suppressed and a lost browser response checks the original report', async ({ page }) => {
  const f = await setup(page);
  try {
    let pending; const sent = [];
    await page.route('**/api/bug-reports', route => { pending = route; sent.push(route.request().postDataJSON()); });
    await page.locator('.bug-report > summary').click(); await fill(page);
    await page.getByRole('button', { name: 'Send bug report' }).click();
    await expect(page.getByRole('form', { name: 'Report a bug' })).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Send bug report' })).toBeDisabled();
    await page.getByRole('form', { name: 'Report a bug' }).evaluate(form => form.requestSubmit());
    await expect.poll(() => sent.length).toBe(1); await pending.abort();
    await expect(page.getByRole('button', { name: 'Check report status' })).toBeEnabled();
    await expect(page.getByLabel('Description of the bug')).toBeDisabled();
    await page.unroute('**/api/bug-reports');
    await page.getByRole('button', { name: 'Check report status' }).click();
    await expect(page.locator('.bug-report__status')).toContainText('accepted for delivery');
    const calls = await f.stats(); expect(calls).toHaveLength(1);
    expect(calls[0].reportId).toBe(sent[0].reportId); expect(calls[0].description).toBe(sent[0].description);
    expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('uncertain response locks content and checks the same reference; phone footer remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await setup(page);
  try {
    await f.control('unknown'); await page.locator('.bug-report > summary').click(); await fill(page);
    await page.getByRole('button', { name: 'Send bug report' }).click();
    await expect(page.locator('.bug-report__status')).toContainText('could not confirm');
    await expect(page.getByLabel('Description of the bug')).toBeDisabled();
    await page.getByRole('button', { name: 'Check report status' }).click();
    await expect(page.getByRole('button', { name: 'Check report status' })).toBeInViewport({ ratio: 1 });
    const calls = await f.stats(); expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const borders = await page.locator('.bug-report').evaluate(el => { const css = getComputedStyle(el); return [css.borderTopWidth, css.borderBottomWidth]; });
    expect(borders).toEqual(['1px', '1px']);
    if (process.env.BUG_REPORT_SCREENSHOTS) {
      await mkdir(process.env.BUG_REPORT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.BUG_REPORT_SCREENSHOTS}/stem-phone-uncertain.png`, fullPage: true });
    }
    await page.locator('.bug-report > summary').click(); await expect(page.getByRole('form', { name: 'Report a bug' })).toBeHidden();
    expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
