import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

const courseId = 'msh-245-the-american-musical-experience-fall-2026-01';
const paths = ['/', '/account.html', '/classroom.html', '/teacher.html'];
async function fixture(page) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true' },
  }] });
  const { url } = await server.listen();
  const seed = async statements => expect((await server.fetch('/__fixture/schema', {
    method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements),
  })).status).toBe(200);
  await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
  const tokens = Object.fromEntries(await Promise.all(['alice', 'bob', 'carol'].map(async name =>
    [name, await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS[name] })])));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { server, url, tokens, seed, errors };
}
async function header(page, signedIn, instructor = false) {
  const nav = page.locator('.workspace-nav');
  if (!signedIn) {
    await expect(nav).toBeHidden();
    await expect(page.locator('#header-signin')).toBeVisible();
    await expect(page.locator('.lab-account .account-nav')).toHaveText(/Guest\s*\|\s*CUNY Login/);
    const logo = await page.locator('.lab-brand').boundingBox();
    const login = await page.locator('#header-signin').boundingBox();
    expect(login.y).toBeGreaterThanOrEqual(logo.y + logo.height);
    return;
  }
  await expect(nav).toBeVisible();
  await expect(page.locator('#header-signin')).toBeHidden();
  await expect(nav.locator('a:visible')).toHaveText(instructor
    ? ['Splitter', 'Workspace', 'Settings', 'Instructor Console'] : ['Splitter', 'Workspace', 'Settings']);
}
for (const path of paths) test('signed-out ' + path + ' hides the whole menu with login below the logo', async ({ page }) => {
  const f = await fixture(page);
  try {
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(new URL(path, f.url).href);
      await header(page, false);
      for (const region of await page.locator('#account-details, #account-admin, #console-panel').all()) await expect(region).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (path === '/' && process.env.STEM_SCREENSHOT_DIR) {
        await mkdir(process.env.STEM_SCREENSHOT_DIR, { recursive: true });
        await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        await page.screenshot({ path: process.env.STEM_SCREENSHOT_DIR + '/signed-out-header-' + width + '.png' });
      }
    }
    expect(f.errors).toEqual([]);
  } finally { await page.close(); await f.server.close(); }
});
test('pending authentication does not flash navigation or private Settings', async ({ page }) => {
  const f = await fixture(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    await page.setExtraHTTPHeaders({ 'x-fixture-identity': f.tokens.bob });
    await page.route('**/api/account', async route => { await pending; await route.continue(); });
    await page.goto(new URL('/account.html', f.url).href, { waitUntil: 'domcontentloaded' });
    await header(page, false);
    await expect(page.locator('#account-details')).toBeHidden();
    release();
    await expect(page.locator('#account-details')).toBeVisible();
    await header(page, true);
    expect(f.errors).toEqual([]);
  } finally { release(); await page.close(); await f.server.close(); }
});
for (const role of ['member', 'instructor', 'admin', 'course instructor']) test(role + ' navigation follows actual console access on every page', async ({ page }) => {
  const f = await fixture(page);
  try {
    if (role === 'instructor') await f.seed(["INSERT INTO app_users(subject,role) VALUES('" + TEST_SUBJECTS.bob + "','instructor')"]);
    await page.setExtraHTTPHeaders({
      'x-fixture-identity': role === 'admin' ? f.tokens.carol : f.tokens.bob,
      ...(role === 'course instructor' ? { 'x-fixture-course-role': 'owner' } : {}),
    });
    for (const path of paths) {
      await page.goto(new URL(path, f.url).href);
      await header(page, true, role !== 'member');
      if (role !== 'member') {
        await expect(page.locator('[data-instructor-nav]')).toHaveAttribute('href', role === 'course instructor' ? '/teacher.html?course=' + courseId : '/teacher.html');
        if (path === '/teacher.html') {
          await expect(page.locator('#console-panel')).toBeVisible();
          await expect(page.locator('.workspace-nav [aria-current="page"]')).toHaveText('Instructor Console');
        }
      }
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (path === '/' && process.env.STEM_SCREENSHOT_DIR) {
          await mkdir(process.env.STEM_SCREENSHOT_DIR, { recursive: true });
          await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        await page.screenshot({ path: process.env.STEM_SCREENSHOT_DIR + '/' + role.replaceAll(' ', '-') + '-header-' + width + '.png' });
        }
      }
    }
    expect(f.errors).toEqual([]);
  } finally { await page.close(); await f.server.close(); }
});
test('course permission changes update navigation without changing the signed-in person', async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.setExtraHTTPHeaders({ 'x-fixture-identity': f.tokens.bob, 'x-fixture-course-role': 'owner' });
    await page.goto(f.url.href);
    await header(page, true, true);
    const documentId = await page.evaluate(() => window.navigationDocumentId = crypto.randomUUID());
    await page.setExtraHTTPHeaders({ 'x-fixture-identity': f.tokens.bob });
    await page.evaluate(() => window.StemSessionGuard.check({ conceal: false }));
    await header(page, true, false);
    await page.setExtraHTTPHeaders({ 'x-fixture-identity': f.tokens.bob, 'x-fixture-course-role': 'owner' });
    await page.evaluate(() => window.StemSessionGuard.check({ conceal: false }));
    await header(page, true, true);
    expect(await page.evaluate(() => window.navigationDocumentId)).toBe(documentId);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); await f.server.close(); }
});
test('account outage hides navigation, recovery restores it, and sign-out clears it', async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.setExtraHTTPHeaders({ 'x-fixture-identity': f.tokens.carol });
    await page.goto(f.url.href);
    await header(page, true, true);
    const documentId = await page.evaluate(() => window.navigationDocumentId = crypto.randomUUID());
    await page.route('**/api/account', route => route.fulfill({ status: 503, json: { error: 'Fixture outage' } }));
    await page.evaluate(() => window.StemSessionGuard.check({ conceal: false }));
    await expect(page.locator('.workspace-nav')).toBeHidden();
    await expect(page.locator('#header-signin')).toBeHidden();
    await page.unroute('**/api/account');
    await page.evaluate(() => window.StemSessionGuard.check());
    await header(page, true, true);
    expect(await page.evaluate(() => window.navigationDocumentId)).toBe(documentId);
    await page.setExtraHTTPHeaders({});
    await Promise.all([page.waitForEvent('domcontentloaded'), page.evaluate(() => void window.StemSessionGuard.check())]);
    await header(page, false);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); await f.server.close(); }
});
test('a late instructor response cannot reopen navigation after session loss with a retained report', async ({ page }) => {
  const f = await fixture(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    await page.setExtraHTTPHeaders({ 'x-fixture-identity': f.tokens.carol });
    await page.goto(f.url.href);
    await header(page, true, true);
    let requested = false;
    await page.route('**/api/teacher/me', async route => {
      requested = true; await pending;
      await route.fulfill({ json: { teacher: { username: TEST_SUBJECTS.carol, displayName: 'Fixture instructor' } } }).catch(() => {});
    });
    await page.evaluate(() => window.StemSessionGuard.check({ conceal: false }));
    await expect.poll(() => requested).toBe(true);
    await page.evaluate(() => { window.StemReportDraft = { hasDraft: () => true, sessionChanged: () => {} }; });
    await page.setExtraHTTPHeaders({});
    await page.evaluate(() => window.StemSessionGuard.check());
    release();
    await header(page, false);
    await expect(page.locator('[data-instructor-nav]')).toBeHidden();
    await expect(page.locator('#rack-status')).toContainText('Your session changed');
    expect(f.errors).toEqual([]);
  } finally { release(); await page.close(); await f.server.close(); }
});

test('class lookup failure does not relabel a verified member as Guest or show a login link', async ({ page }) => {
  const f=await fixture(page);
  try {
    await page.setExtraHTTPHeaders({ 'x-fixture-identity': f.tokens.bob });
    await page.route('**/api/classroom/courses**', route => route.fulfill({ status: 503, json: { error: 'Fixture class outage' } }));
    await page.goto(new URL('/classroom.html', f.url).href);
    await expect(page.locator('#account-status')).toContainText('Fixture class outage');
    await header(page,true);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); await f.server.close(); }
});
