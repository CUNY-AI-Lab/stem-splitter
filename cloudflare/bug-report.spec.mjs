import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { fixtureFetch, localHttpsFixture } from './bug-report-https-fixture.mjs';

test.use({ ignoreHTTPSErrors: true });

const sessions = { alice: '11111111-1111-4111-8111-111111111111.' + 'a'.repeat(43), bob: '22222222-2222-4222-8222-222222222222.' + 'b'.repeat(43) };
const description = 'The button stayed unavailable after I tried to upload.';
async function setup(page, signedIn = true) {
  const issuer = await createTestIdentityIssuer();
  const harness = createTestHarness({ workers: [{ config: {
    name: 'bug-report-test', main: fileURLToPath(new URL('./test-bug-report-worker.ts', import.meta.url)),
    alias: { hono: fileURLToPath(import.meta.resolve('hono-cloudflare')), 'hono/factory': fileURLToPath(import.meta.resolve('hono-cloudflare/factory')) },
    compatibility_date: '2026-09-06', compatibility_flags: ['nodejs_compat'],
    assets: { directory: fileURLToPath(new URL('../public', import.meta.url)), binding: 'ASSETS', run_worker_first: true },
    d1_databases: [{ binding: 'DB', database_name: 'bug-report-test', database_id: '00000000-0000-0000-0000-000000000000' }],
    vars: { AUTH_MODE: 'cail', PUBLIC_BASE_URL: 'https://split.test', RELEASE: 'report-browser-20261020', CAIL_COURSE_IDS: '',
      TEST_JWKS: issuer.jwksJson, TEST_ALICE_JWT: await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice }),
      TEST_BOB_JWT: await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.bob }) },
    ratelimits: [{ name: 'REQUEST_LIMIT', namespace_id: '884476', simple: { limit: 1000, period: 60 } }],
  } }] });
  await harness.listen();
  const frontend = await localHttpsFixture(request => fixtureFetch(harness, request));
  const url = new URL(frontend.origin);
  const control = input => harness.fetch('/__bug-fixture', { method: 'POST', body: JSON.stringify(input) });
  await control({ sql: schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')) });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const signIn = async (actor = 'alice') => {
    await control({ expired: false });
    await page.context().addCookies([{ name: '__Host-stem-session', value: sessions[actor], url: url.href, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  };
  if (signedIn) await signIn();
  await page.goto(new URL('/account.html', url).href);
  return { harness, url, errors, control, signIn, stats: async () => (await (await harness.fetch('/__bug-fixture')).json()),
    close: async () => { await frontend.close(); await harness.close(); expect(frontend.errors).toEqual([]); } };
}
const field = page => page.getByRole('textbox', { name: 'Description of the bug', exact: true });
const status = page => page.locator('.bug-report__status');
const trigger = page => page.getByRole('button', { name: 'Report a bug', exact: true });
const panel = page => page.getByRole('dialog', { name: 'Report a bug', exact: true });
async function openReport(page) {
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole('form', { name: 'Report a bug', exact: true })).toBeVisible();
}
async function fillReport(page) {
  await openReport(page); await expect(field(page)).toBeEditable(); await field(page).fill(description);
}

test('all four footers expose one accessible description field without submitting on open', async ({ page }, testInfo) => {
  const f = await setup(page);
  try {
    for (const path of ['/account.html', '/teacher.html', '/', '/classroom.html']) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(new URL(path, f.url).href);
      await expect(page.locator('.project-credit')).toContainText('Built through the Critical AI Literacy Institute.');
      await trigger(page).focus(); await page.keyboard.press('Enter');
      await expect(panel(page)).toBeVisible();
      await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(field(page)).toBeEditable();
      await expect(page.locator('.bug-report input')).toHaveCount(0);
      await expect(page.locator('.bug-report textarea')).toHaveCount(1);
      await expect(panel(page)).toContainText('No maps, audio or chats are attached.');
      await expect(page.getByRole('group', { name: 'Report page context' })).toContainText(new Map([
        ['/account.html', 'My account'], ['/teacher.html', 'Instructor'], ['/', 'Workspace'], ['/classroom.html', 'Class workspace'],
      ]).get(path));
      if (path === '/') await page.screenshot({ path: testInfo.outputPath('report-desktop.png'), animations: 'disabled' });
      await page.getByRole('button', { name: 'Close bug report', exact: true }).click();
      await expect(panel(page)).toBeHidden(); await expect(trigger(page)).toBeFocused();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.keyboard.press('Enter'); await expect(panel(page)).toBeVisible();
      await expect(field(page)).toBeEditable();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const bounds = await panel(page).boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
      if (path === '/') await page.screenshot({ path: testInfo.outputPath('report-mobile.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden(); await expect(trigger(page)).toBeFocused();
      await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    }
    expect((await f.stats()).calls).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('closing the compact panel preserves an unsent draft and returns keyboard focus', async ({ page }, testInfo) => {
  const f = await setup(page);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(new URL('/account.html?student=private&job=private#private-fragment', f.url).href);
    await fillReport(page);
    await field(page).press('Escape');
    await expect(panel(page)).toBeHidden(); await expect(trigger(page)).toBeFocused();
    expect(await page.evaluate(() => window.StemReportDraft.hasDraft())).toBe(true);
    await page.keyboard.press('Enter'); await expect(field(page)).toHaveValue(description);
    await expect(field(page)).toBeEditable(); expect((await f.stats()).calls).toEqual([]);
    await expect(page.getByRole('group', { name: 'Report page context' })).toHaveText('This pageMy account');
    expect(await panel(page).evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await expect(panel(page)).not.toContainText('private-fragment');
    await expect(panel(page)).not.toContainText('student=');
    await page.screenshot({ path: testInfo.outputPath('report-draft-desktop.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close bug report', exact: true }).click();
    await expect(trigger(page)).toBeFocused(); await expect(panel(page)).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger(page).click(); await expect(field(page)).toHaveValue(description);
    await expect(field(page)).toBeEditable();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath('report-draft-mobile.png'), animations: 'disabled' });
    expect((await f.stats()).calls).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('anonymous visitors use existing sign-in and cannot call the report API', async ({ page }) => {
  const f = await setup(page, false);
  try {
    await openReport(page);
    await expect(status(page)).toContainText('Sign in with CUNY Login');
    await expect(page.getByRole('button', { name: 'Send bug report', exact: true })).toBeDisabled();
    await expect(page.getByRole('link', { name: 'CUNY Login (opens a new tab)' })).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('link', { name: 'CUNY Login (opens a new tab)' })).toHaveAttribute('href', '/auth/login?next=%2Faccount.html');
    const response = await page.evaluate(async () => {
      const result = await fetch('/api/bug-reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return result.status;
    });
    expect(response).toBe(401); expect((await f.stats()).calls).toEqual([]);
  } finally { await f.close(); }
});

test('double click saves one report with server attribution and a route free of private parameters', async ({ page }) => {
  const f = await setup(page);
  try {
    await page.goto(new URL('/account.html?student=private&job=private#private-fragment', f.url).href);
    await f.control({ mode: 'slow' }); await fillReport(page);
    await page.getByRole('button', { name: 'Send bug report', exact: true }).dblclick();
    await expect(status(page)).toContainText('Your report was saved for the Lab administrators.');
    const stats = await f.stats(); expect(stats.calls).toHaveLength(1); expect(stats.records).toHaveLength(1);
    expect(stats.calls[0]).toMatchObject({ description, path: '/account.html', subject: TEST_SUBJECTS.alice, release: 'report-browser-20261020' });
    expect(Object.keys(stats.calls[0]).sort()).toEqual(['description', 'origin', 'path', 'release', 'reportId', 'subject']);
    expect(JSON.stringify(stats.calls)).not.toContain('private');
    await expect(page.getByRole('button', { name: 'Report saved', exact: true })).toBeDisabled();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('lost storage acknowledgement retains the same immutable attempt and explicitly recovers one record', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control({ mode: 'lost-ack' }); await fillReport(page);
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('We could not confirm whether your report was saved.');
    await expect(field(page)).not.toBeEditable(); await expect(field(page)).toHaveValue(description);
    const first = await f.stats(); expect(first.calls).toHaveLength(1); expect(first.records).toHaveLength(1);
    await page.getByRole('button', { name: 'Check report status', exact: true }).click();
    await expect(status(page)).toContainText('Your report was saved');
    const recovered = await f.stats(); expect(recovered.calls).toHaveLength(2); expect(recovered.records).toHaveLength(1);
    expect(recovered.calls[1]).toEqual(first.calls[0]);
    expect(recovered.records).toEqual(first.records); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('an unavailable receiver keeps the draft and retries the same UUID only after an explicit action', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control({ mode: 'unavailable' }); await fillReport(page);
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('We could not confirm');
    await expect(field(page)).toHaveValue(description); await expect(field(page)).not.toBeEditable();
    const first = (await f.stats()).calls[0];
    await f.control({ mode: 'saved' });
    await expect(page.getByRole('button', { name: 'Check report status', exact: true })).toBeEnabled();
    expect((await f.stats()).calls).toHaveLength(1);
    await page.getByRole('button', { name: 'Check report status', exact: true }).click();
    await expect(status(page)).toContainText('Your report was saved');
    expect((await f.stats()).calls[1]).toEqual(first); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('expired sessions retain the draft while private views stay cleared and same-account recheck never submits', async ({ page }) => {
  const f = await setup(page);
  try {
    await fillReport(page); await f.control({ expired: true });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(status(page)).toContainText('Sign in with CUNY Login');
    await expect(field(page)).toHaveValue(description);
    await expect(page.locator('#account-details')).toBeHidden();
    const staleWrite = await page.evaluate(async () => (await fetch('/api/jobs', { method: 'POST', body: '{}' })).status);
    expect(staleWrite).toBe(401); expect((await f.stats()).calls).toEqual([]);
    await f.signIn(); await page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
    await expect(field(page)).toBeEditable(); expect((await f.stats()).calls).toEqual([]);
    await expect(page.locator('#account-details')).toBeHidden();
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('Your report was saved');
    expect((await f.stats()).records[0].subject).toBe(TEST_SUBJECTS.alice); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('account switch cannot attribute an existing draft to the next account', async ({ page }) => {
  const f = await setup(page);
  try {
    await fillReport(page); await f.signIn('bob');
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('The signed-in account changed.');
    await expect(field(page)).toHaveValue(description); expect((await f.stats()).calls).toEqual([]);
    await page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
    await expect(status(page)).toContainText('The signed-in account changed.');
    expect((await f.stats()).calls).toEqual([]);
    await f.signIn('alice'); await page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send bug report', exact: true })).toBeEnabled();
    expect((await f.stats()).calls).toEqual([]);
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('Your report was saved');
    expect((await f.stats()).records[0].subject).toBe(TEST_SUBJECTS.alice); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a rate-limited session recheck keeps the draft and never submits automatically', async ({ page }) => {
  const f = await setup(page);
  try {
    await fillReport(page); await f.control({ expired: true });
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('Sign in with CUNY Login');
    await f.control({ expired: false, limitReports: true });
    await page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
    await expect(status(page)).toContainText('We could not check CUNY Login. Your description is still here.');
    await expect(field(page)).toHaveValue(description); expect((await f.stats()).calls).toEqual([]);
    await f.control({ limitReports: false });
    await page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
    await expect(field(page)).toBeEditable(); expect((await f.stats()).calls).toEqual([]);
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('Your report was saved'); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a network failure keeps the UUID for manual recovery and empty descriptions stay in the browser', async ({ page }) => {
  const f = await setup(page);
  try {
    const attempts = [];
    await fillReport(page); await field(page).fill('Short');
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    expect((await f.stats()).calls).toEqual([]);
    await field(page).fill(description);
    await page.route('**/api/bug-reports', async route => { attempts.push(route.request().postDataJSON()); await route.abort('failed'); });
    await page.getByRole('button', { name: 'Send bug report', exact: true }).click();
    await expect(status(page)).toContainText('We could not confirm');
    expect(attempts).toHaveLength(1); await expect(field(page)).toHaveValue(description);
    await page.unroute('**/api/bug-reports');
    await page.getByRole('button', { name: 'Check report status', exact: true }).click();
    await expect(status(page)).toContainText('Your report was saved');
    expect((await f.stats()).calls[0].reportId).toBe(attempts[0].reportId); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
