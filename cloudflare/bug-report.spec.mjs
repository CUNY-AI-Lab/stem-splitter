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
test('original pages keep their existing footer while the report adapter stays in the background', async ({ page }) => {
  const f = await setup(page);
  try {
    for (const path of ['/account.html', '/teacher.html', '/']) {
      await page.goto(new URL(path, f.url).href);
      await expect(page.locator('.project-credit')).toContainText('Built through the Critical AI Literacy Institute.');
      await expect(page.locator('.bug-report, form[aria-label="Report a bug"], a[href="/classroom.html"]')).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
test('background report API preserves the same reference through an explicit safe retry', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control('unavailable');
    expect(await submit(page)).toMatchObject({ status: 503, body: { ok: false, code: 'unavailable', retryable: true, reportId: report.reportId } });
    const first = (await f.stats())[0];
    await f.control('accepted');
    expect(await submit(page)).toMatchObject({ status: 200, body: { ok: true, reportId: report.reportId } });
    expect((await f.stats())[0]).toEqual(first); expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('background report API distinguishes uncertain delivery without exposing a new form', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control('unknown');
    expect(await submit(page)).toMatchObject({ status: 503, body: { ok: false, code: 'delivery_unknown', retryable: false, reportId: report.reportId } });
    expect(await f.stats()).toHaveLength(1);
    await expect(page.locator('.bug-report, form[aria-label="Report a bug"]')).toHaveCount(0);
    expect(f.errors).toEqual([]);
  } finally { await f.harness.close(); }
});
