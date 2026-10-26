import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('failed attempts leave the rack on the next session while successful runs remain', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const token = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true', RUN_DELETION_ENABLED: 'true' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    const seed = async statements => expect((await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements) })).status).toBe(200);
    await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
    await seed([
      `INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Successful recording', 'uploads/success.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO jobs (id, filename, source_key, status) VALUES ('failed-attempt', 'Failed attempt', 'uploads/failure.wav', 'failed')`,
      ...['remix-fixture', 'failed-attempt'].map(id => `INSERT INTO job_owners (job_id, subject) VALUES ('${id}', '${TEST_SUBJECTS.alice}')`),
    ]);
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': token });
    await page.goto(url.href);
    await expect(page.locator('#job-list')).toContainText('Failed attempt');
    await expect(page.locator('.badge.ready')).toHaveText('READY');
    await page.reload();
    await expect(page.locator('#job-list')).toContainText('Failed attempt');
    await expect(page.locator('.badge.ready')).toHaveText('READY');
    await page.close();

    const next = await context.newPage();
    next.on('pageerror', error => errors.push(error.message));
    await next.goto(url.href);
    await expect(next.locator('#job-list .console')).toHaveCount(1);
    await expect(next.locator('#job-list')).toContainText('Successful recording');
    await expect(next.locator('#job-list')).not.toContainText('Failed attempt');
    await expect(next.locator('.badge.ready')).toHaveText('READY');
    await next.reload();
    await expect(next.locator('#job-list .console')).toHaveCount(1);
    await expect(next.locator('.badge.ready')).toHaveText('READY');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('account rack recovers on a new browser; isolates people; handles paging, import and outages', async ({ page, context, browser }) => {
  await context.addInitScript(() => {
    window.detachedReadyCards = [];
    addEventListener('DOMContentLoaded', () => {
      const rack = document.getElementById('job-list');
      if (!rack) return;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.removedNodes) {
          if (node.nodeType === 1 && node.matches('.console') && node.querySelector('.badge.ready'))
            window.detachedReadyCards.push(node.querySelector('.console-title')?.textContent);
        }
      }).observe(rack, { childList: true });
    });
  });
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
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', '/account.html');
    await expect(page.locator('.badge.ready')).toBeVisible();
    await expect(page.locator('#job-list .console')).toHaveCount(40);
    await expect(page.locator('#job-list .badge').filter({ hasText: 'CHECKING STATUS' })).toHaveCount(0);
    expect(await page.evaluate(() => window.detachedReadyCards)).toEqual([]);
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
    await page.getByLabel('Share with').selectOption('personal');
    await page.locator('#yt-url').fill('https://www.youtube.com/watch?v=fixture1234');
    await page.locator('#yt-form button[type=submit]').click();
    await expect(page.locator('#upload-message')).toContainText('Saved to your account.');
    await page.unroute('**/api/jobs');
    await page.route('**/api/jobs', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 429, json: { code: 'split_daily_limit', error: 'Limit reached', resetsAt: '2026-09-30T00:00:00Z' } });
    });
    await page.locator('#yt-url').fill('https://www.youtube.com/watch?v=fixture1234');
    await page.locator('#yt-form button[type=submit]').click();
    await expect(page.locator('#upload-message')).toContainText("You've used today's runs.");
    await expect(page.locator('#upload-message')).not.toContainText('Saved to your account');
    await page.unroute('**/api/jobs');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.locator('#account-role')).toHaveText('Student access');
    await page.getByRole('link', { name: 'Splitter', exact: true }).click();
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

for (const width of [1280, 390]) test(`folder moves persist and restore the saved split at ${width}px`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 900 });
  const issuer = await createTestIdentityIssuer();
  const alice = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const bob = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.bob });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true', RUN_DELETION_ENABLED: 'true' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    const seed = async statements => expect((await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements) })).status).toBe(200);
    await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
    await seed([
      `INSERT INTO app_users(subject, role) VALUES ('${TEST_SUBJECTS.alice}', 'instructor'), ('${TEST_SUBJECTS.bob}', 'instructor')`,
      `INSERT INTO jobs(id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Saved folder recording', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO job_owners(job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`,
      `INSERT INTO annotations(id, job_id, at_seconds, text) VALUES ('folder-note', 'remix-fixture', 1, 'Preserved folder note')`,
      `INSERT INTO folders(id,name,created_by) VALUES ('folder-one','Week one','${TEST_SUBJECTS.alice}'), ('folder-two','Week two','${TEST_SUBJECTS.alice}')`,
    ]);
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': alice });
    await page.goto(url.href);
    const card = page.locator('#job-list .console');
    await expect(card).toContainText('Preserved folder note');
    const chooseFolder = async name => {
      if (await card.locator('.actions-toggle').isVisible()) await card.locator('.actions-toggle').click();
      await card.locator('.folder-btn').click();
      await page.getByRole('button', { name, exact: true }).click();
    };
    await page.route('**/api/teacher/folders/folder-one/items', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
    await chooseFolder('Week one');
    await expect(page.locator('.folder-menu')).toContainText('FAILED — TRY AGAIN');
    await expect(card).toHaveCount(1);
    await page.unroute('**/api/teacher/folders/folder-one/items');
    await page.getByRole('button', { name: 'FAILED — TRY AGAIN', exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#rack-status')).toBeHidden();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: /Week one · 1/ }).click();
    await expect(page.locator('.folder-item-name')).toHaveText('Saved folder recording');
    await page.getByRole('button', { name: 'LOAD', exact: true }).click();
    await expect(card).toContainText('Preserved folder note');
    await chooseFolder('Week two');
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Week one · 0/ })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: /Week two · 1/ }).click();
    await expect(page.locator('.folder-item-name')).toHaveText('Saved folder recording');
    await expect(card).toHaveCount(0);
    const receipts = process.env.STEM_SCREENSHOT_DIR;
    if (receipts) { await mkdir(receipts, { recursive: true }); await page.screenshot({ path: `${receipts}/folder-moved-${width}.png` }); }
    const forbidden = await context.request.post(new URL('/api/teacher/folders/folder-two/items', url).href,
      { headers: { 'x-fixture-identity': bob, origin: url.origin }, data: { jobId: 'remix-fixture' } });
    expect(forbidden.status()).toBe(404);
    const remove = page.locator('.folder-item-remove');
    await remove.click(); await remove.click();
    await expect(card).toContainText('Preserved folder note');
    await chooseFolder('Week one');
    await expect(card).toHaveCount(0);
    const folder = page.locator('.folder').filter({ hasText: 'Week one' });
    await folder.locator('.folder-del').click(); await folder.locator('.folder-del').click();
    await expect(card).toContainText('Preserved folder note');
    await page.reload();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Preserved folder note');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('pending song titles keep their own full-width row on narrow screens', async ({page,context}) => {
  const issuer=await createTestIdentityIssuer();
  const token=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice});
  const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_BROWSER:'true',RUN_DELETION_ENABLED:'true'}}]});
  const title='David Bowie - Sound and Vision.mp3';
  try {
    const {url}=await server.listen();
    await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify([
      ...schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')),
      `INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO jobs(id,filename,source_key,status,model) VALUES('pending-layout','${title}','uploads/layout/source.mp3','processing','htdemucs_6s')`,
      `INSERT INTO job_owners(job_id,subject) VALUES('pending-layout','${TEST_SUBJECTS.alice}')`,
    ])});
    await context.setExtraHTTPHeaders({'x-fixture-identity':token});
    await page.route('**/api/jobs/pending-layout',route=>route.fulfill({json:{id:'pending-layout',filename:title,status:'processing',model:'htdemucs_6s',permissions:{owner:true},createdAt:new Date().toISOString(),stems:[]}}));
    await page.goto(url.href);
    const card=page.locator('[data-job-id="pending-layout"]');
    await expect(card.locator('.badge')).toContainText('SEPARATING');
    await expect(card.getByRole('button',{name:'DELETE',exact:true})).toBeVisible();
    for(const width of [320,360,390,540]) {
      await page.setViewportSize({width,height:844});
      await expect.poll(()=>card.evaluate(el=>{
        const head=el.querySelector('.console-head').getBoundingClientRect(),title=el.querySelector('.console-title').getBoundingClientRect(),badge=el.querySelector('.badge').getBoundingClientRect(),remove=el.querySelector('.delete-btn').getBoundingClientRect();
        return title.width>=head.width-1 && title.height<100 && badge.top>=title.bottom && remove.top>=title.bottom && document.documentElement.scrollWidth<=innerWidth;
      })).toBe(true);
    }
    await page.setViewportSize({width:320,height:844});
    await card.screenshot({path:'/tmp/stem-pending-title-mobile.png',animations:'disabled'});
  } finally {await server.close();}
});

for (const width of [1280,390]) test(`owned recording names persist in the rack and folders at ${width}px`,async({page,context})=>{
  const issuer=await createTestIdentityIssuer();
  const token=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice});
  const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_BROWSER:'true',RUN_DELETION_ENABLED:'false'}}]});
  const original='Archive imported recording',renamed='Mélodie — 夜の歌',folderTitle='Seminar listening — final take';
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const {url}=await server.listen();
    const seed=async statements=>expect((await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(statements)})).status).toBe(200);
    await seed([
      ...schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')),
      `INSERT INTO app_users(subject,role) VALUES('${TEST_SUBJECTS.alice}','instructor')`,
      `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('remix-fixture','${original}','uploads/imported.mp3','done','htdemucs_ft','[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO job_owners(job_id,subject) VALUES('remix-fixture','${TEST_SUBJECTS.alice}')`,
      `INSERT INTO folders(id,name,created_by) VALUES('rename-folder','Listening notes','${TEST_SUBJECTS.alice}')`,
    ]);
    await server.fetch('/__fixture/audio',{method:'POST',headers:{'x-fixture':'local-only'},body:await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url))});
    await context.setExtraHTTPHeaders({'x-fixture-identity':token});
    await page.setViewportSize({width,height:900});await page.goto(url.href);
    const card=page.locator('#job-list .console'),input=page.getByRole('textbox',{name:'Recording title',exact:true});
    const openReadyActions=async()=>{
      // Cached titles render before the saved split has loaded its controls.
      await expect(card.locator('.badge.ready')).toHaveText('READY');
      if(width<=540){
        const toggle=card.getByRole('button',{name:'Session actions',exact:true});
        await expect(toggle).toBeVisible();await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded','true');
      }
    };
    await expect(card.locator('.badge.ready')).toHaveText('READY');
    await page.getByRole('button',{name:`Rename recording: ${original}`,exact:true}).click();
    await input.fill('Discard this title');await input.press('Escape');
    await expect(input).toHaveCount(0);await expect(card.locator('.console-title')).toHaveText(original);
    await page.getByRole('button',{name:`Rename recording: ${original}`,exact:true}).click();
    await input.fill(renamed);await input.press('Enter');
    await expect(card.locator('.console-title')).toHaveText(renamed);
    await expect(input).toHaveCount(0);
    const saved=await(await server.fetch('/api/jobs/remix-fixture',{headers:{'x-fixture-identity':token}})).json();
    expect(saved.filename).toBe(renamed);
    await page.reload();await expect(card.locator('.console-title')).toHaveText(renamed);
    await openReadyActions();
    await card.locator('.folder-btn').click();
    await page.getByRole('button',{name:'Listening notes',exact:true}).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button',{name:/Listening notes · 1/}).click();
    await expect(page.locator('.folder-item-name')).toHaveText(renamed);
    await page.getByRole('button',{name:'LOAD',exact:true}).click();
    await expect(card.locator('.console-title')).toHaveText(renamed);
    await openReadyActions();
    await card.getByRole('button',{name:'RENAME',exact:true}).click();
    await input.fill(folderTitle);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await card.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/editable-recording-title-${width}.png`,animations:'disabled'});}
    await input.press('Enter');await expect(card.locator('.console-title')).toHaveText(folderTitle);
    await expect(page.locator('.folder-item-name')).toHaveText(folderTitle);
    await page.reload();await page.getByRole('button',{name:/Listening notes · 1/}).click();
    await expect(page.locator('.folder-item-name')).toHaveText(folderTitle);
    await page.getByRole('button',{name:'LOAD',exact:true}).click();
    await expect(card.locator('.console-title')).toHaveText(folderTitle);
    expect(errors).toEqual([]);
  }finally{await server.close();}
});

for (const width of [1280, 390]) test(`account access failures keep one Settings destination at ${width}px`, async ({ page }) => {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' } }] });
  try {
    const { url } = await server.listen();
    await page.setViewportSize({ width, height: 900 });
    let accountStatus = 403;
    await page.route('**/api/account', route => accountStatus === 0 ? route.abort('failed') : route.fulfill({
      status: accountStatus, json: { error: 'Account fixture unavailable' },
    }));
    for (const status of [403, 503, 0, 401]) {
      accountStatus = status;
      await page.goto(url.href);
      if (status === 401) await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toBeVisible();
      else await expect(page.locator('#rack-status')).toContainText(status === 403 ? 'Open Settings for details.' : 'Reload to try again.');
      const settings = page.getByRole('link', { name: 'Settings', exact: true });
      await expect(settings).toHaveCount(1);
      await expect(settings).toHaveAttribute('href', '/account.html');
      await expect(page.locator('#workspace-nav > a')).toHaveText(['Splitter', 'Workspace', 'Settings']);
      await expect(page.locator('footer .footer-teacher-link')).toHaveText('Instructor Console');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (status !== 401) await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toHaveCount(0);
    }
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(new URL('/account', url).href);
    await expect(page).toHaveTitle('Stem Splitter · Settings');
  } finally { await server.close(); }
});

test('instructor folder names support cancel, failed-save retry and persisted readback',async({page,context})=>{
 const issuer=await createTestIdentityIssuer();
 const subject=TEST_SUBJECTS.carol;
 const token=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject});
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_BROWSER:'true',TEST_ADMIN:subject}}]});
 try {
  const {url}=await server.listen();
  await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify([...schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')),`INSERT INTO app_users(subject,role) VALUES('${subject}','instructor')`,`INSERT INTO folders(id,name,created_by) VALUES('rename-folder','Original folder','${subject}')`])});
  await context.setExtraHTTPHeaders({'x-fixture-identity':token});
  let writes=0,fail=true;
  await page.route('**/api/teacher/folders/rename-folder',route=>{
   if(route.request().method()!=='PUT')return route.continue();
   writes++;return fail?route.fulfill({status:503,json:{error:'Temporary save failure'}}):route.continue();
  });
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Rename',exact:true}).click();
  await page.getByLabel('Folder name',{exact:true}).fill('Cancelled name');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(writes).toBe(0);
  await expect(page.locator('.folder-name')).toHaveText('Original folder');
  await page.getByRole('button',{name:'Rename',exact:true}).click();
  await page.locator('.folder-rename-form [type="submit"]').click();expect(writes).toBe(0);
  await page.getByRole('button',{name:'Rename',exact:true}).click();
  await page.getByLabel('Folder name',{exact:true}).fill('   ');
  await page.locator('.folder-rename-form [type="submit"]').click();
  await expect(page.locator('.folder-rename-form [role="status"]')).toHaveText('Enter a folder name.');expect(writes).toBe(0);
  await page.getByLabel('Folder name',{exact:true}).fill('Rhythm examples');
  await page.locator('.folder-rename-form [type="submit"]').click();
  await expect(page.locator('.folder-rename-form [role="status"]')).toHaveText('Temporary save failure');
  await expect(page.getByLabel('Folder name',{exact:true})).toHaveValue('Rhythm examples');
  fail=false;await page.locator('.folder-rename-form [type="submit"]').click();
  await expect(page.locator('.folder-name')).toHaveText('Rhythm examples');
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('.folder-name')).toHaveText('Rhythm examples');
  const result=await(await page.request.get(new URL('/api/teacher/folders/rename-folder',url).href)).json();
  expect(result.folder.id).toBe('rename-folder');expect(result.folder.name).toBe('Rhythm examples');
 }finally{await server.close();}
});
