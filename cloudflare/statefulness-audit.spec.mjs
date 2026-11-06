import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

const courseId = 'msh-245-the-american-musical-experience-fall-2026-01';
async function fixture(page, vars = {}) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true', ...vars },
  }] });
  const { url } = await server.listen();
  const seed = async statements => expect((await server.fetch('/__fixture/schema', {
    method: 'POST', headers: { 'x-fixture': 'local-only' },
    body: JSON.stringify(statements),
  })).status).toBe(200);
  await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
  const token = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.bob });
  const identity = { 'x-fixture-identity': token };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setExtraHTTPHeaders(identity);
  return { url, identity, errors, seed, close: async () => { await page.close(); await server.close(); } };
}

for (const direct of [false, true]) test(`Instructor Console discovers authorized classes after the first assignment page (${direct ? 'direct' : 'discovery'})`, async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.setExtraHTTPHeaders({ ...f.identity, 'x-fixture-course-role': 'owner' });
    await page.route(/\/api\/classroom\/courses(?:\?.*)?$/, async route => {
      if (new URL(route.request().url()).searchParams.has('cursor')) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: { ...body, courses: [], nextCursor: 'fixture-page-two' } });
    });
    await page.goto(new URL('/teacher.html' + (direct ? '?course=' + courseId : ''), f.url).href);
    await expect(page.locator('#console-panel')).toBeVisible();
    await expect(page.locator('#prompt-scope-note')).toContainText('Applies to');
    await expect(page.locator('#prompt-form')).toBeVisible();
    await expect(page.locator('[data-instructor-nav]')).toBeVisible();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('Splitter removes application instructor folders when the same account loses that role', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.seed([`INSERT INTO app_users(subject,role) VALUES('${TEST_SUBJECTS.bob}','instructor')`]);
    await page.goto(f.url.href);
    await expect(page.locator('#folders')).toBeVisible();
    const documentId = await page.evaluate(() => window.auditDocument = crypto.randomUUID());
    await f.seed([`UPDATE app_users SET role='student',updated_by='fixture',revision=revision+1 WHERE subject='${TEST_SUBJECTS.bob}'`]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[data-instructor-nav]')).toBeHidden();
    await expect(page.locator('#folders')).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/instructor/);
    expect(await page.evaluate(() => window.auditDocument)).toBe(documentId);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const startsAsInstructor of [false, true]) test(`Workspace refresh follows a same-person class role change from ${startsAsInstructor ? 'instructor to student' : 'student to instructor'}`, async ({ page }) => {
  const f = await fixture(page);
  try {
    const roleHeaders = owner => ({ ...f.identity, ...(owner ? { 'x-fixture-course-role': 'owner' } : {}) });
    await page.setExtraHTTPHeaders(roleHeaders(startsAsInstructor));
    await page.goto(new URL('/classroom.html?course=' + courseId, f.url).href);
    await expect(page.locator('#console-panel')).toBeVisible();
    await expect(page.locator('#classroom-folder-create')).toBeVisible({ visible: startsAsInstructor });
    const documentId = await page.evaluate(() => window.auditDocument = crypto.randomUUID());
    await page.setExtraHTTPHeaders(roleHeaders(!startsAsInstructor));
    await page.locator('#classroom-refresh').click();
    await expect(page.locator('#console-panel')).toBeVisible();
    await expect(page.locator('#classroom-folder-create')).toBeVisible({ visible: !startsAsInstructor });
    await expect(page.locator('#classroom-guidance')).toBeVisible({ visible: !startsAsInstructor });
    await expect(page.locator('#classroom-roster-section')).toBeVisible({ visible: !startsAsInstructor });
    expect(await page.evaluate(() => window.auditDocument)).toBe(documentId);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const persona of ['individual', 'student', 'course instructor']) test(`${persona} receives the matching navigation, workspace, Settings and console authority`, async ({ page }) => {
  const f = await fixture(page, persona === 'individual' ? { TEST_NO_COURSES: 'true' } : {});
  const teaches = persona === 'course instructor';
  try {
    if (teaches) await page.setExtraHTTPHeaders({ ...f.identity, 'x-fixture-course-role': 'owner' });
    for (const path of ['/account.html', '/classroom.html', '/teacher.html', '/']) {
      await page.goto(new URL(path, f.url).href);
      await expect(page.locator('.workspace-nav')).toBeVisible();
      await expect(page.locator('#header-signin')).toBeHidden();
      await expect(page.locator('.workspace-nav a:visible')).toHaveText(teaches
        ? ['Splitter', 'Workspace', 'Settings', 'Instructor Console'] : ['Splitter', 'Workspace', 'Settings']);
      if (path === '/account.html') {
        await expect(page.locator('#account-role')).toHaveText(persona === 'student' ? 'Student access' : 'CUNY AI Lab member access');
        await expect(page.locator('#account-admin')).toBeHidden();
        await expect(page.locator('#student-review')).toBeHidden();
      } else if (path === '/classroom.html') {
        if (persona === 'individual') {
          await expect(page.locator('#account-status')).toContainText('No current classes');
          await expect(page.locator('#console-panel')).toBeHidden();
        } else {
          await expect(page.locator('#console-panel')).toBeVisible();
          await expect(page.locator('#classroom-course')).toHaveValue(courseId);
          await expect(page.locator('#classroom-guidance')).toBeVisible({ visible: teaches });
          await expect(page.locator('#classroom-roster-section')).toBeVisible({ visible: teaches });
        }
      } else if (path === '/teacher.html') {
        await expect(page.locator('#console-panel')).toBeVisible({ visible: teaches });
        if (!teaches) await expect(page.locator('#course-discovery-status')).toContainText('No instructor classes');
      } else {
        await expect(page.locator('#new-split-course')).toHaveValue('personal');
        await expect(page.locator('#course-context')).toBeVisible({ visible: persona !== 'individual' });
        if (persona !== 'individual') {
          await page.locator('#new-split-course').selectOption(courseId);
          await expect(page.locator('#course-work-ack')).not.toBeChecked();
        }
      }
      const permissions = await page.evaluate(async id => {
        const status = async path => (await fetch(path)).status;
        return { admin: await status('/api/admin/users'), globalFolders: await status('/api/teacher/folders'),
          roster: await status(`/api/classroom/courses/${id}/roster`), prompt: await status(`/api/classroom/courses/${id}/prompt`) };
      }, courseId);
      expect(permissions).toEqual({ admin: 403, globalFolders: 403, roster: teaches ? 200 : 403, prompt: teaches ? 200 : 403 });
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const path of ['/', '/classroom.html', '/teacher.html']) test(`repeated empty assignment pages stop safely on ${path}`, async ({ page }) => {
  const f = await fixture(page);
  let reads = 0;
  try {
    await page.route(/\/api\/classroom\/courses(?:\?.*)?$/, route => {
      reads++;
      return route.fulfill({ status: reads > 10 ? 503 : 200, json: { courses: [], nextCursor: 'repeated-page' } });
    });
    await page.goto(new URL(path, f.url).href);
    const status = path === '/' ? '.course-load-status' : path === '/classroom.html' ? '#account-status' : '#teacher-access-status';
    await expect(page.locator(status)).toContainText('could not be fully checked');
    expect(reads).toBeLessThanOrEqual(4);
    await expect(page.locator('.workspace-nav')).toBeVisible();
    await expect(page.locator('[data-instructor-nav]')).toBeHidden();
    if (path === '/') {
      await expect(page.locator('#new-split-course')).toBeEnabled();
      await expect(page.locator('#new-split-course')).toHaveValue('personal');
    } else await expect(page.locator('#console-panel')).toBeHidden();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('instructor folder outage conceals controls and recovery preserves the existing rename draft', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.seed([`INSERT INTO app_users(subject,role) VALUES('${TEST_SUBJECTS.bob}','instructor')`,
      `INSERT INTO folders(id,name,created_by) VALUES('audit-folder','Private fixture folder','${TEST_SUBJECTS.bob}')`]);
    await page.goto(f.url.href);
    await page.locator('.folder-rename').click();
    await page.getByLabel('Folder name', { exact: true }).fill('Retained draft');
    await page.route('**/api/teacher/me', route => route.fulfill({ status: 503, json: { error: 'Fixture outage' } }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#folders')).toBeHidden();
    await page.unroute('**/api/teacher/me');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#folders')).toBeVisible();
    await expect(page.getByLabel('Folder name', { exact: true })).toHaveValue('Retained draft');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a late authorized folder response cannot restore tools after instructor revocation', async ({ page }) => {
  const f = await fixture(page);
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  try {
    await f.seed([`INSERT INTO app_users(subject,role) VALUES('${TEST_SUBJECTS.bob}','instructor')`,
      `INSERT INTO folders(id,name,created_by) VALUES('late-folder','Earlier instructor-only folder','${TEST_SUBJECTS.bob}')`]);
    await page.route('**/api/teacher/folders', async route => {
      const response = await route.fetch(); started(); await pending;
      await route.fulfill({ response });
    });
    await page.goto(f.url.href);
    await received;
    await f.seed([`UPDATE app_users SET role='student',updated_by='fixture',revision=revision+1 WHERE subject='${TEST_SUBJECTS.bob}'`]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[data-instructor-nav]')).toBeHidden();
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/teacher/folders');
    release();
    await (await delivered).finished();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    await expect(page.locator('#folders')).toBeHidden();
    await expect(page.locator('#folder-list')).toBeEmpty();
    expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
});

test('session loss during class discovery preserves the report without reopening class data or throwing', async ({ page }) => {
  const f = await fixture(page);
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  try {
    await page.route(/\/api\/classroom\/courses(?:\?.*)?$/, async route => {
      const response = await route.fetch(); started(); await pending;
      await route.fulfill({ response });
    });
    await page.goto(new URL('/classroom.html', f.url).href);
    await received;
    await page.evaluate(() => {
      window.StemReportDraft = { hasDraft: () => true, sessionChanged() { window.auditReportRetained = true; } };
      window.StemSessionGuard.clear();
    });
    release();
    // Session cleanup aborts the browser requests, so there is deliberately no
    // response to await. Let their rejection handlers finish before inspecting.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    await expect(page.locator('.workspace-nav')).toBeHidden();
    await expect(page.locator('#console-panel')).toBeEmpty();
    await expect(page.locator('#account-status')).toContainText('Your session changed');
    expect(await page.evaluate(() => window.auditReportRetained)).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
});
