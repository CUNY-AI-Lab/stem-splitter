import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

const course = 'msh-245-the-american-musical-experience-fall-2026-01';
const anotherCourse = 'cail-teaching-tools-demo';
const courseChoices = [
  { classId: course, className: 'MSH 245 The American Musical Experience', term: 'Fall 2026', section: '01' },
  { classId: anotherCourse, className: 'The CAIL Teaching Tools Demo', term: 'Ongoing', section: 'Demo' },
];
const courseList = courseChoices.map(({ classId, className, term, section }) => ({
  classId, className, term, section, participant: true, owner: false,
}));

async function fixture(browser, viewport = { width: 1280, height: 900 }) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' },
  }] });
  const { url } = await server.listen();
  const seed = async statements => expect((await server.fetch('/__fixture/schema', {
    method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements),
  })).status).toBe(200);
  await seed([
    ...schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')),
    `INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}'),('${TEST_SUBJECTS.bob}')`,
  ]);
  const contexts = [];
  const pageFor = async subject => {
    const identity = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject });
    const gateway = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject });
    const context = await browser.newContext({ viewport, extraHTTPHeaders: {
      'x-fixture-identity': identity,
      'x-fixture-gateway': gateway,
      'x-fixture-course-role': 'owner',
    } });
    contexts.push(context);
    return context.newPage();
  };
  const selectCourses = async page => {
    await page.route('**/api/classroom/courses', route => route.fulfill({
      json: { courses: courseList, nextCursor: null },
    }));
  };
  return {
    url, pageFor, selectCourses,
    close: async () => { for (const context of contexts) await context.close(); await server.close(); },
  };
}

const option = name => ({ name, exact: true });

test('workspace menu supports pointer selection and keeps same-course notice state', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const page = await f.pageFor(TEST_SUBJECTS.alice);
    await f.selectCourses(page);
    await page.goto(f.url.href);
    const menu = page.getByRole('combobox', { name: /^Workspace:/ });
    const courseName = 'MSH 245 The American Musical Experience · Fall 2026';
    await expect(menu).toBeVisible();
    await menu.click();
    await page.getByRole('option', { name: /The American Musical Experience/ }).click();
    await expect(menu).toHaveAccessibleName(`Workspace: ${courseName}`);
    const labelBox = await menu.locator('.stem-select-label').evaluate(element => ({
      width: element.clientWidth, contentWidth: element.scrollWidth,
      height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(labelBox.contentWidth).toBeLessThanOrEqual(labelBox.width);
    expect(labelBox.height).toBeLessThanOrEqual(labelBox.lineHeight + 1);
    await expect(page.locator('#new-split-course')).toHaveValue(course);
    const notice = page.locator('#course-work-ack');
    await expect(notice).toBeVisible();
    await notice.check();

    // Re-selecting the same course value must retain its existing acknowledgment.
    await menu.click();
    await page.getByRole('option', { name: /The American Musical Experience/ }).click();
    await expect(page.locator('#new-split-course')).toHaveValue(course);
    await expect(notice).toBeChecked();

    await menu.click();
    await page.getByRole('option', option('Personal')).click();
    await expect(notice).toBeHidden();
    await menu.click();
    await page.getByRole('option', { name: /The American Musical Experience/ }).click();
    await expect(notice).toBeVisible();
    await expect(notice).not.toBeChecked();
  } finally { await f.close(); }
});

test('workspace menu supports arrows, Enter, Escape, Tab and typeahead', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const page = await f.pageFor(TEST_SUBJECTS.alice);
    await f.selectCourses(page);
    await page.goto(f.url.href);
    const menu = page.getByRole('combobox', { name: /^Workspace:/ });
    const list = page.getByRole('listbox', { name: 'Workspace' });
    await menu.focus();
    await page.keyboard.press('ArrowDown');
    await expect(list).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#new-split-course')).toHaveValue(course);
    await expect(list).toBeHidden();

    await menu.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await expect(list).toBeHidden();
    await expect(menu).not.toBeFocused();

    await menu.focus();
    await page.keyboard.press('p');
    let activeId = await menu.getAttribute('aria-activedescendant');
    await expect(page.locator(`[id="${activeId}"]`)).toHaveText('Personal');
    await page.keyboard.press('Enter');
    await expect(page.locator('#new-split-course')).toHaveValue('personal');

    await menu.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    activeId = await menu.getAttribute('aria-activedescendant');
    await expect(page.locator(`[id="${activeId}"]`)).toHaveText(/The CAIL Teaching Tools Demo/);
    await page.keyboard.press('Enter');
    await expect(page.locator('#new-split-course')).toHaveValue(anotherCourse);
    await expect(menu).toHaveAccessibleName('Workspace: The CAIL Teaching Tools Demo · Ongoing');
  } finally { await f.close(); }
});

test('class menu supports pointer choice and preserves its selected course', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const page = await f.pageFor(TEST_SUBJECTS.alice);
    await page.goto(new URL('/classroom.html', f.url).href);
    const menu = page.getByRole('combobox', { name: /^Class:/ });
    await expect(menu).toBeVisible();
    await menu.click();
    await page.getByRole('option', { name: /The American Musical Experience/ }).click();
    await expect(menu).toHaveAccessibleName('Class: The American Musical Experience · Fall 2026');
    await expect(page.locator('#classroom-course')).toHaveValue(course);
    await expect(page).toHaveURL(new RegExp(`course=${course}`));
  } finally { await f.close(); }
});

test('workspace control stays disabled during access refresh and can recover', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const page = await f.pageFor(TEST_SUBJECTS.alice);
    let release;
    let reached;
    const requestStarted = new Promise(resolve => { reached = resolve; });
    await page.route('**/api/classroom/courses', route => {
      reached();
      return new Promise(resolve => { release = () => resolve(route.fulfill({ json: { courses: courseList, nextCursor: null } })); });
    });
    await page.goto(f.url.href);
    await requestStarted;
    const native = page.locator('#new-split-course');
    const menu = page.getByRole('combobox', { name: /^Workspace:/ });
    await expect(native).toBeDisabled();
    await expect(menu).toBeDisabled();
    release();
    await expect(menu).toBeEnabled();
    await expect(native).toBeEnabled();
  } finally { await f.close(); }
});

test('class menu opens at 390px without horizontal overflow and uses the shared theme variables', async ({ browser }) => {
  const f = await fixture(browser, { width: 390, height: 844 });
  try {
    const page = await f.pageFor(TEST_SUBJECTS.alice);
    await f.selectCourses(page);
    await page.goto(new URL('/classroom.html', f.url).href);
    const menu = page.getByRole('combobox', { name: /^Class:/ });
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await menu.click();
    const list = page.getByRole('listbox', { name: 'Class' });
    await expect(list).toBeVisible();
    const style = await list.evaluate(element => {
      const box = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return { left: box.left, right: box.right, width: box.width, background: css.backgroundColor, border: css.borderColor };
    });
    expect(style.left).toBeGreaterThanOrEqual(0);
    expect(style.right).toBeLessThanOrEqual(390);
    expect(style.width).toBeGreaterThan(0);
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(style.border).not.toBe('rgba(0, 0, 0, 0)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await f.close(); }
});
