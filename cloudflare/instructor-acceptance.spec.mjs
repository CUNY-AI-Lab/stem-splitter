import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const course = 'msh-245-the-american-musical-experience-fall-2026-01';
const member = subject => 'stem-member-v1-' + createHash('sha256').update(`fixture:${course}:${subject}`).digest('hex');
async function fixture(context) {
  const issuer = await createTestIdentityIssuer();
  const alice = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const bob = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.bob });
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true', TEST_ROSTER_SUBJECT: TEST_SUBJECTS.alice,
  } }] });
  const { url } = await harness.listen();
  const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.push(`INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}'),('${TEST_SUBJECTS.bob}')`,
    `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('course-song','Class fixture recording','uploads/source.wav','done','htdemucs_ft','[]'),('personal-song','Private personal fixture','uploads/private.wav','done','htdemucs_ft','[]'),('teaching-song','Instructor course fixture','uploads/teacher.wav','done','htdemucs_ft','[]')`,
    `INSERT INTO job_owners VALUES('course-song','${TEST_SUBJECTS.alice}'),('personal-song','${TEST_SUBJECTS.alice}'),('teaching-song','${TEST_SUBJECTS.bob}')`,
    `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('course-song','${course}','${member(TEST_SUBJECTS.alice)}','${TEST_SUBJECTS.alice}','course-work-v1'),('teaching-song','${course}','${member(TEST_SUBJECTS.bob)}','${TEST_SUBJECTS.bob}','course-work-v1')`,
    `INSERT INTO course_folders(id,course_id,name,created_by,permission) VALUES('shared-folder','${course}','Shared listening','${TEST_SUBJECTS.alice}','comment'),('private-folder','${course}','Instructor preparation','${TEST_SUBJECTS.alice}','private')`,
    `INSERT INTO course_folder_items(folder_id,job_id,filename,model) VALUES('shared-folder','course-song','Class fixture recording','htdemucs_ft')`,
    `INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance) VALUES('course-note','course-song',3,'Listen to the bass entrance','${TEST_SUBJECTS.alice}','Alex Rivera','student'),('personal-note','personal-song',1,'Private personal note','${TEST_SUBJECTS.alice}','Alex Rivera','student'),('teaching-note','teaching-song',5,'A student hears the melody','${TEST_SUBJECTS.alice}','Alex Rivera','student')`,
    `INSERT INTO course_conversations(job_id,subject,revision,expires_at) VALUES('course-song','${TEST_SUBJECTS.alice}',1,datetime('now','+1 day'))`,
    ...Array.from({ length: 42 }, (_, i) => `INSERT INTO course_messages(id,job_id,subject,turn_id,kind,provenance,text) VALUES('message-${i}','course-song','${TEST_SUBJECTS.alice}','turn-${i}','${i % 2 ? 'coach' : 'you'}','${i % 2 ? 'server-assistant' : 'student'}','Synthetic course message ${i}')`));
  const seeded = await harness.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) });
  expect(seeded.status).toBe(200);
  await context.setExtraHTTPHeaders({ 'x-fixture-identity': alice, 'x-fixture-course-role': 'owner' });
  return { harness, url, alice, bob, seed: async statements => {
    expect((await harness.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements) })).status).toBe(200);
  } };
}
test('instructor reviews course roster, splits and paginated conversations and explicitly shares folders', async ({ page, context }) => {
  const f = await fixture(context), errors = [], modelCalls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/(guide|chat)$/.test(new URL(request.url()).pathname)) modelCalls.push(request.url()); });
  try {
    await page.goto(new URL(`/classroom.html?course=${course}`, f.url).href);
    await expect(page).toHaveTitle('Stem Splitter · Class workspace');
    await expect(page.getByRole('heading', { name: 'Class workspace', exact: true })).toBeVisible();
    await expect(page.locator('#classroom-roster')).toContainText('Zero split student');
    await expect(page.locator('#classroom-usage')).toContainText('2 enrolled students shown · 1 assigned split');
    await expect(page.locator('#classroom-roster')).toContainText('App use: 2 split attempts · 2 completed');
    await expect(page.locator('#classroom-roster')).not.toContainText('Private personal fixture');
    await page.getByRole('button', { name: 'Fixture Student with a long preferred display name', exact: true }).click();
    await expect(page.locator('#classroom-jobs')).toContainText('Class fixture recording');
    await expect(page.locator('#classroom-jobs')).not.toContainText('Private personal fixture');
    await page.getByRole('button', { name: 'Annotations', exact: true }).click();
    await expect(page.locator('#classroom-notes')).toContainText('0:03 · Alex Rivera: Listen to the bass entrance');
    await expect(page.locator('#classroom-notes')).not.toContainText('Private personal note');
    await page.getByRole('button', { name: 'Listening Guy messages' }).click();
    await expect(page.locator('#classroom-messages li')).toHaveCount(40);
    await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
    await expect(page.locator('#classroom-messages li')).toHaveCount(42);
    expect(modelCalls).toEqual([]);
    await page.getByLabel('New private folder').fill('New class listening');
    await page.getByRole('button', { name: 'Create folder' }).click();
    await expect(page.locator('#classroom-folder-title')).toHaveText('New class listening');
    await expect(page.getByLabel('Who can use this folder?')).toHaveValue('private');
    const created = (await (await page.request.get(new URL(`/api/classroom/courses/${course}/folders`, f.url).href)).json()).folders.find(row => row.name === 'New class listening');
    expect(created.permission).toBe('private');
    await page.getByLabel('Who can use this folder?').selectOption('comment');
    const beforeSave = await page.request.get(new URL(`/api/classroom/courses/${course}/folders/${created.id}`, f.url).href);
    expect((await beforeSave.json()).folder.permission).toBe('private');
    await page.getByRole('button', { name: 'Save sharing', exact: true }).click();
    await expect(page.locator('#classroom-folder-status')).toHaveText('Class members can listen and add notes.');
    await page.getByLabel('Folder for Class fixture recording').selectOption(created.id);
    await page.getByRole('button', { name: 'Add to folder', exact: true }).click();
    await expect(page.locator('#classroom-folder-items')).toContainText('Class fixture recording');
    await expect(page.getByLabel('Class folder link')).toHaveValue(new URL(`/classroom.html?course=${course}&folder=${created.id}`, f.url).href);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('.workspace-nav [aria-current="page"]')).toHaveText('Workspace');
      expect((await page.locator('#classroom-course').boundingBox()).height).toBeGreaterThanOrEqual(44);
      if (width === 390) expect((await page.locator('.classroom-toolbar').boundingBox()).height).toBeLessThanOrEqual(104);
      await page.locator('#classroom-messages').focus();
      await expect(page.locator('#classroom-messages')).toBeFocused();
      expect(await page.locator('#classroom-messages').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await mkdir('/tmp/stem-classroom-acceptance', { recursive: true });
      await page.screenshot({ path: `/tmp/stem-classroom-acceptance/instructor-${width}.png`, fullPage: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `/tmp/stem-classroom-acceptance/instructor-${width}-viewport.png` });
      await page.locator('#classroom-folder-detail').screenshot({ path: `/tmp/stem-classroom-acceptance/folder-${width}.png` });
    }
    expect(errors).toEqual([]);
  } finally { await f.harness.close(); }
});
test('student sees shared folder and annotation permission without instructor or private content', async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.bob });
    await page.goto(new URL(`/classroom.html?course=${course}&folder=shared-folder`, f.url).href);
    await expect(page.locator('#classroom-folder-items')).toContainText('Class fixture recording');
    await expect(page.locator('#classroom-folder-status')).toHaveText('Class members can listen and add notes.');
    await expect(page.locator('#classroom-roster-section')).toBeHidden();
    await expect(page.locator('#classroom-guidance')).toBeHidden();
    await expect(page.locator('#classroom-own-splits')).toBeHidden();
    await expect(page.locator('#classroom-folder-create')).toBeHidden();
    await expect(page.locator('#classroom-folder-sharing')).toBeHidden();
    await expect(page.locator('#classroom-folders')).not.toContainText('Instructor preparation');
    await expect(page.locator('#classroom-messages')).toBeEmpty();
    expect((await page.request.get(new URL(`/api/classroom/courses/${course}/jobs/course-song/conversation`, f.url).href)).status()).toBe(403);
  } finally { await f.harness.close(); }
});
test('an instructor outside the student roster can add their own course split to a shared folder', async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.bob, 'x-fixture-course-role': 'owner' });
    await page.goto(new URL(`/classroom.html?course=${course}`, f.url).href);
    await page.getByRole('button', { name: 'My course splits', exact: true }).click();
    await expect(page.locator('#classroom-jobs')).toContainText('Instructor course fixture');
    await expect(page.locator('#classroom-jobs')).not.toContainText('Class fixture recording');
    await page.getByRole('button', { name: 'Annotations', exact: true }).click();
    await expect(page.locator('#classroom-notes')).toContainText('Alex Rivera: A student hears the melody');
    await page.getByLabel('Folder for Instructor course fixture').selectOption('shared-folder');
    await page.getByRole('button', { name: 'Add to folder', exact: true }).click();
    await page.getByRole('button', { name: 'Shared listening', exact: true }).click();
    await expect(page.locator('#classroom-folder-items')).toContainText('Instructor course fixture');
  } finally { await f.harness.close(); }
});
test('revocation hides loaded course content on refresh', async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await page.goto(new URL(`/classroom.html?course=${course}&folder=shared-folder`, f.url).href);
    await expect(page.locator('#classroom-folder-items')).toContainText('Class fixture recording');
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-course-role': 'owner', 'x-fixture-course-state': 'revoked' });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#console-panel')).toBeHidden();
    await expect(page.locator('#classroom-roster')).toBeEmpty();
    await expect(page.locator('#classroom-folder-items')).toBeEmpty();
    await expect(page.locator('#account-status')).toContainText('Class access changed');
  } finally { await f.harness.close(); }
});
test('automatic refresh reflects enrolled course work and attributed notes while preserving sharing drafts', async ({ page, context }) => {
  const f = await fixture(context), modelCalls = [], jobReads = [];
  page.on('request', request => { if (/\/(guide|chat)$/.test(new URL(request.url()).pathname)) modelCalls.push(request.url()); });
  page.on('request', request => { if (/^\/api\/jobs\//.test(new URL(request.url()).pathname)) jobReads.push(new URL(request.url()).pathname); });
  try {
    await page.clock.install();
    await page.goto(new URL(`/classroom.html?course=${course}&folder=shared-folder`, f.url).href);
    await page.getByRole('button', { name: 'Fixture Student with a long preferred display name', exact: true }).click();
    await page.getByRole('button', { name: 'Annotations', exact: true }).click();
    await expect(page.locator('#classroom-notes')).toContainText('Listen to the bass entrance');
    await page.getByRole('button', { name: 'Listening Guy messages', exact: true }).click();
    await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
    await expect(page.locator('#classroom-messages li')).toHaveCount(42);
    await page.getByLabel('New private folder').fill('Unsaved folder draft');
    await page.getByLabel('Who can use this folder?').selectOption('read');
    await page.getByLabel('Folder for Class fixture recording').selectOption('shared-folder');
    await f.seed([
      `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('new-course-song','New enrolled course run','uploads/new.wav','done','htdemucs_ft','[]')`,
      `INSERT INTO job_owners VALUES('new-course-song','${TEST_SUBJECTS.alice}')`,
      `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('new-course-song','${course}','${member(TEST_SUBJECTS.alice)}','${TEST_SUBJECTS.alice}','course-work-v1')`,
      `INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance) VALUES('new-course-note','course-song',8,'A second listener hears the drums','${TEST_SUBJECTS.bob}','Blair Chen','student')`,
    ]);
    await page.clock.fastForward(15001);
    await expect(page.locator('#classroom-roster')).toContainText('2 splits');
    await expect(page.locator('#classroom-jobs')).toContainText('New enrolled course run');
    await expect(page.locator('#classroom-notes')).toContainText('0:08 · Blair Chen: A second listener hears the drums');
    await expect(page.locator('#classroom-messages li')).toHaveCount(42);
    await expect(page.locator('#classroom-notes')).not.toContainText('Private personal note');
    await expect(page.getByLabel('New private folder')).toHaveValue('Unsaved folder draft');
    await expect(page.getByLabel('Who can use this folder?')).toHaveValue('read');
    await expect(page.getByLabel('Folder for Class fixture recording')).toHaveValue('shared-folder');
    const stored = await page.request.get(new URL(`/api/classroom/courses/${course}/folders/shared-folder`, f.url).href);
    expect((await stored.json()).folder.permission).toBe('comment');
    expect(jobReads).toEqual(['/api/jobs/course-song', '/api/jobs/course-song']);
    expect(modelCalls).toEqual([]);
  } finally { await f.harness.close(); }
});
test('automatic class refresh pauses in a hidden tab and rechecks on return', async ({ page, context }) => {
  const f = await fixture(context), reads = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/classroom/courses/')) reads.push(request.url()); });
  try {
    await page.clock.install();
    await page.goto(new URL(`/classroom.html?course=${course}`, f.url).href);
    await expect(page.locator('#classroom-roster')).toContainText('Zero split student');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = reads.length;
    await page.clock.fastForward(60000);
    expect(reads.length).toBe(before);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#classroom-refresh-status')).toContainText('Updated');
    expect(reads.length).toBe(before + 2);
    await expect(page.locator('#console-panel')).toBeVisible();
  } finally { await f.harness.close(); }
});
test('selected annotation refresh fails closed when course access is revoked', async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await page.clock.install();
    await page.goto(new URL(`/classroom.html?course=${course}`, f.url).href);
    await page.getByRole('button', { name: 'Fixture Student with a long preferred display name', exact: true }).click();
    await page.getByRole('button', { name: 'Annotations', exact: true }).click();
    await expect(page.locator('#classroom-notes')).toContainText('Listen to the bass entrance');
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-course-role': 'owner', 'x-fixture-course-state': 'revoked' });
    await page.clock.fastForward(15001);
    await expect(page.locator('#console-panel')).toBeHidden();
    await expect(page.locator('#classroom-notes')).toBeEmpty();
    await expect(page.locator('#classroom-roster')).toBeEmpty();
  } finally { await f.harness.close(); }
});
test('folder read, comment and private settings persist after reload and a pending edit cannot overwrite a newer grant', async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await page.clock.install();
    const address = new URL(`/classroom.html?course=${course}&folder=shared-folder`, f.url).href;
    await page.goto(address);
    for (const permission of ['read', 'comment', 'private']) {
      await page.getByLabel('Who can use this folder?').selectOption(permission);
      await page.getByRole('button', { name: 'Save sharing', exact: true }).click();
      await expect(page.locator('#console-panel')).toBeVisible();
      await page.reload();
      await expect(page.getByLabel('Who can use this folder?')).toHaveValue(permission);
      const response = await page.request.get(new URL(`/api/classroom/courses/${course}/folders/shared-folder`, f.url).href);
      expect((await response.json()).folder.permission).toBe(permission);
    }
    await page.getByLabel('Who can use this folder?').selectOption('comment');
    await f.seed(["UPDATE course_folders SET permission='read',revision=revision+1 WHERE id='shared-folder'"]);
    await page.clock.fastForward(15001);
    await expect(page.locator('#classroom-refresh-status')).toContainText('Updated');
    await expect(page.getByLabel('Who can use this folder?')).toHaveValue('comment');
    await page.getByRole('button', { name: 'Save sharing', exact: true }).click();
    await expect(page.locator('#classroom-folder-status')).toContainText('Refresh and try again');
    const current = await page.request.get(new URL(`/api/classroom/courses/${course}/folders/shared-folder`, f.url).href);
    expect((await current.json()).folder.permission).toBe('read');
    await page.reload();
    await expect(page.getByLabel('Who can use this folder?')).toHaveValue('read');
  } finally { await f.harness.close(); }
});
test('annotation review rejects a response for a different or personal workspace', async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await page.route('**/api/jobs/course-song', route => route.fulfill({ json: { courseId: null, annotations: [{ atSeconds: 0, text: 'Unexpected personal fixture' }] } }));
    await page.goto(new URL(`/classroom.html?course=${course}`, f.url).href);
    await page.getByRole('button', { name: 'Fixture Student with a long preferred display name', exact: true }).click();
    await page.getByRole('button', { name: 'Annotations', exact: true }).click();
    await expect(page.locator('#console-panel')).toBeHidden();
    await expect(page.locator('#classroom-notes')).toBeEmpty();
    await expect(page.locator('body')).not.toContainText('Unexpected personal fixture');
    await expect(page.getByRole('button', { name: 'Retry class access' })).toBeVisible();
  } finally { await f.harness.close(); }
});
for (const failure of ['503', 'network', 'invalid JSON']) test(`${failure} conceals prior roster while course authority is uncertain and permits an explicit retry`, async ({ page, context }) => {
  const f = await fixture(context);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const pattern = `**/api/classroom/courses/${course}/participants/*/jobs`;
  try {
    await page.goto(new URL(`/classroom.html?course=${course}`, f.url).href);
    await expect(page.locator('#classroom-roster')).toContainText('Zero split student');
    await page.route(pattern, async route => {
      await pending;
      if (failure === 'network') await route.abort();
      else if (failure === 'invalid JSON') await route.fulfill({ contentType: 'application/json', body: '{invalid' });
      else await route.fulfill({ status: 503, json: { error: { message: 'Course access is temporarily unavailable.' } } });
    });
    await page.getByRole('button', { name: 'Fixture Student with a long preferred display name', exact: true }).click();
    await expect(page.locator('#console-panel')).toBeHidden();
    release();
    await expect(page.locator('#classroom-roster')).toBeEmpty();
    await expect(page.locator('#classroom-jobs')).toBeEmpty();
    await expect(page.locator('#account-status')).toContainText('Class access could not be confirmed');
    await page.unroute(pattern);
    await page.getByRole('button', { name: 'Retry class access' }).click();
    await expect(page.locator('#classroom-roster')).toContainText('Zero split student');
    await expect(page.locator('#console-panel')).toBeVisible();
  } finally { release(); await f.harness.close(); }
});
test('changing course selection clears in-flight roster and conversation results', async ({ page, context }) => {
  const f = await fixture(context);
  let release; const wait = new Promise(resolve => { release = resolve; });
  try {
    await page.goto(new URL(`/classroom.html?course=${course}`, f.url).href);
    await expect(page.locator('#classroom-roster')).toContainText('Zero split student');
    await page.route(`**/api/classroom/courses/${course}/roster`, async route => {
      await wait;
      await route.fulfill({ json: { participants: [{ displayName: 'Late private roster', memberId: 'late', splitCount: 0, retainedCount: 0 }], nextCursor: null } }).catch(() => {});
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#classroom-roster-status')).toContainText('Loading');
    await page.getByLabel('Class', { exact: true }).selectOption('');
    release();
    await expect(page.locator('#console-panel')).toBeHidden();
    await expect(page.locator('#classroom-roster')).toBeEmpty();
    await expect(page.locator('body')).not.toContainText('Late private roster');
  } finally { release(); await f.harness.close(); }
});
