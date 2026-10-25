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
const field = page => page.getByRole('textbox', { name: 'What went wrong?', exact: true });
const status = page => page.locator('.bug-report__status');
const trigger = page => page.getByRole('button', { name: 'Report a problem', exact: true });
const panel = page => page.getByRole('dialog', { name: 'Report a problem', exact: true });
async function openReport(page) {
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole('form', { name: 'Report a problem', exact: true })).toBeVisible();
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
      await expect(panel(page)).toContainText('No sign-in needed. Please leave out private information.');
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

test('anonymous visitors submit reports while course and roster APIs remain protected', async ({ page }) => {
  const f=await setup(page,false);
  try {
    await fillReport(page);
    await expect(panel(page).getByRole('link')).toHaveCount(0);
    await page.getByRole('button',{name:'Send report',exact:true}).click();
    await expect(status(page)).toContainText('accepted for email delivery');
    const results=await page.evaluate(async()=>Promise.all(['/api/classroom/courses','/api/listening-usage'].map(async path=>(await fetch(path)).status)));
    expect(results).toEqual([401,401]);
    const {calls}=await f.stats();expect(calls).toHaveLength(1);expect(calls[0]).not.toHaveProperty('subject');
    expect(calls[0]).not.toHaveProperty('email');expect(f.errors).toEqual([]);
  } finally {await f.close();}
});

test('double click saves one report without account attribution and a route free of private parameters', async ({ page }) => {
  const f = await setup(page);
  try {
    await page.goto(new URL('/account.html?student=private&job=private#private-fragment', f.url).href);
    await f.control({ mode: 'slow' }); await fillReport(page);
    await page.getByRole('button', { name: 'Send report', exact: true }).dblclick();
    await expect(status(page)).toContainText('Your report was accepted for email delivery.');
    const stats = await f.stats(); expect(stats.calls).toHaveLength(1); expect(stats.records).toHaveLength(1);
    expect(stats.calls[0]).toMatchObject({ description, path: '/account.html', release: 'report-browser-20261020' });
    expect(Object.keys(stats.calls[0]).sort()).toEqual(['description', 'origin', 'path', 'rateDay', 'rateKey', 'release', 'reportId']);
    expect(JSON.stringify(stats.calls)).not.toContain('private');
    await expect(page.getByRole('button', { name: 'Report sent', exact: true })).toBeDisabled();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('lost storage acknowledgement retains the same immutable attempt and explicitly recovers one record', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control({ mode: 'lost-ack' }); await fillReport(page);
    await page.getByRole('button', { name: 'Send report', exact: true }).click();
    await expect(status(page)).toContainText('We could not confirm whether your report was sent.');
    await expect(field(page)).not.toBeEditable(); await expect(field(page)).toHaveValue(description);
    const first = await f.stats(); expect(first.calls).toHaveLength(1); expect(first.records).toHaveLength(1);
    await page.getByRole('button', { name: 'Check report status', exact: true }).click();
    await expect(status(page)).toContainText('Your report was accepted for email delivery');
    const recovered = await f.stats(); expect(recovered.calls).toHaveLength(2); expect(recovered.records).toHaveLength(1);
    expect(recovered.calls[1]).toEqual(first.calls[0]);
    expect(recovered.records).toEqual(first.records); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('an unavailable receiver keeps the draft and retries the same UUID only after an explicit action', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control({ mode: 'unavailable' }); await fillReport(page);
    await page.getByRole('button', { name: 'Send report', exact: true }).click();
    await expect(status(page)).toContainText('We could not confirm');
    await expect(field(page)).toHaveValue(description); await expect(field(page)).not.toBeEditable();
    const first = (await f.stats()).calls[0];
    await f.control({ mode: 'saved' });
    await expect(page.getByRole('button', { name: 'Check report status', exact: true })).toBeEnabled();
    expect((await f.stats()).calls).toHaveLength(1);
    await page.getByRole('button', { name: 'Check report status', exact: true }).click();
    await expect(status(page)).toContainText('Your report was accepted for email delivery');
    expect((await f.stats()).calls[1]).toEqual(first); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('session expiry hides private work without attaching the old or new account to a report', async ({page})=>{
  const f=await setup(page);
  try {
    await fillReport(page);await f.control({expired:true});
    await page.evaluate(()=>window.StemReportDraft.sessionChanged());
    await expect(field(page)).toBeEditable();
    await page.getByRole('button',{name:'Send report',exact:true}).click();
    await expect(status(page)).toContainText('accepted for email delivery');
    expect((await f.stats()).calls[0]).not.toHaveProperty('subject');
  } finally {await f.close();}
});

test('a network failure keeps the UUID for manual recovery and empty descriptions stay in the browser', async ({ page }) => {
  const f = await setup(page);
  try {
    const attempts = [];
    await fillReport(page); await field(page).fill('Short');
    await page.getByRole('button', { name: 'Send report', exact: true }).click();
    expect((await f.stats()).calls).toEqual([]);
    await field(page).fill(description);
    await page.route('**/api/bug-reports', async route => { attempts.push(route.request().postDataJSON()); await route.abort('failed'); });
    await page.getByRole('button', { name: 'Send report', exact: true }).click();
    await expect(status(page)).toContainText('We could not confirm');
    expect(attempts).toHaveLength(1); await expect(field(page)).toHaveValue(description);
    await page.unroute('**/api/bug-reports');
    await page.getByRole('button', { name: 'Check report status', exact: true }).click();
    await expect(status(page)).toContainText('Your report was accepted for email delivery');
    expect((await f.stats()).calls[0].reportId).toBe(attempts[0].reportId); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('an initial availability outage exposes a keyboard retry, mounts once after recovery, and preserves the report draft', async ({ page }) => {
  let available=false,checks=0;
  await page.route('**/api/bug-reports/availability', route=>{
    checks++;
    return route.fulfill(available?{json:{enabled:true}}:{status:503,json:{error:'Fixture unavailable'}});
  });
  const f=await setup(page,false);
  try {
    const retry=page.getByRole('button',{name:'Retry problem reporting',exact:true});
    await expect(retry).toBeVisible();
    await expect(page.getByRole('status').filter({hasText:'Problem reporting is temporarily unavailable.'})).toBeVisible();
    await expect(trigger(page)).toHaveCount(0);
    expect((await f.stats()).calls).toHaveLength(0);
    available=true;await retry.focus();await page.keyboard.press('Enter');
    await expect(trigger(page)).toBeFocused();
    await expect(page.locator('.bug-report')).toHaveCount(1);
    await expect(retry).toHaveCount(0);
    await fillReport(page);await field(page).fill('An unsent synthetic report draft.');
    await page.getByRole('button',{name:'Close bug report',exact:true}).click();
    const completedChecks=checks;available=false;
    await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));});
    await openReport(page);
    await expect(field(page)).toHaveValue('An unsent synthetic report draft.');
    expect(checks).toBe(completedChecks);
    await expect(page.locator('.bug-report')).toHaveCount(1);
    expect((await f.stats()).calls).toHaveLength(0);
    expect(f.errors).toEqual([]);
  } finally {await f.close();}
});

test('disabled reporting stays absent and repeated offline/focus events coalesce while availability is pending',async({page})=>{
  let checks=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/bug-reports/availability',async route=>{checks++;await held;await route.fulfill({json:{enabled:false}});});
  const f=await setup(page,false);
  try {
    await expect.poll(()=>checks).toBe(1);
    await page.evaluate(()=>{for(let i=0;i<5;i++){window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));}});
    expect(checks).toBe(1);release();
    await expect(trigger(page)).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Retry problem reporting',exact:true})).toHaveCount(0);
    expect((await f.stats()).calls).toHaveLength(0);
  }finally{release();await f.close();}
});

test('production Redmine mode never falls back to email without its secret', async ({ page }) => {
  const f = await setup(page, false);
  try {
    await f.control({ reportMode: 'redmine' });
    // Exercise the same HTTPS listener as the browser instead of a second
    // request origin through the parallel Workerd harness proxy.
    const availability = await page.request.get(new URL('/api/bug-reports/availability', f.url).href);
    expect(availability.status()).toBe(200);
    expect(await availability.json()).toEqual({ enabled: false, mode: 'contact', delivery: 'redmine' });
    const response = await page.request.post(new URL('/api/bug-reports', f.url).href, { data: { reportId: crypto.randomUUID(), description, path: '/' } });
    expect(response.status()).toBe(503);
    expect((await f.stats()).calls).toHaveLength(0);
  } finally { await f.close(); }
});

test('production fallback records authenticated and validated guest reports with truthful email status', async ({ page }) => {
  const f = await setup(page);
  try {
    await f.control({ reportMode: 'redmine-fallback' });
    await page.reload();
    await page.getByRole('button', { name: 'Report a bug', exact: true }).click();
    await page.getByRole('textbox', { name: 'What went wrong?', exact: true }).fill(description);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(status(page)).toHaveText('Report recorded. Email accepted for delivery.');
    expect((await f.stats()).records).toHaveLength(1);
    await page.context().clearCookies(); await page.reload();
    await page.getByRole('button', { name: 'Report a bug', exact: true }).click();
    await page.getByRole('button', { name: 'No account?', exact: true }).click();
    await page.getByLabel('First name').fill('Synthetic'); await page.getByLabel('Last name').fill('Guest');
    await page.locator('input[name="email"]').fill('synthetic@example.com');
    await page.getByRole('textbox', { name: 'What went wrong?', exact: true }).fill(description);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('[data-error="email"]')).toBeVisible(); expect((await f.stats()).records).toHaveLength(1);
    await page.locator('input[name="email"]').fill('synthetic@example.edu');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(status(page)).toHaveText('Report recorded. Email accepted for delivery.');
    expect((await f.stats()).records).toHaveLength(2);
  } finally { await f.close(); }
});
