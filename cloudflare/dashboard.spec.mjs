import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const course='msh-245-the-american-musical-experience-fall-2026-01';
async function fixture(page,vars={}) {
 const issuer=await createTestIdentityIssuer();
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_BROWSER:'true',TEST_ADMIN:TEST_SUBJECTS.carol,...vars}}]});
 const {url}=await server.listen();
 const seed=async sql=>expect((await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(sql)})).status).toBe(200);
 await seed(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')));
 const tokens={};for(const name of ['alice','bob','carol'])tokens[name]=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS[name]});
 const errors=[],models=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/\/(guide|chat)$/.test(new URL(r.url()).pathname))models.push(r.url());});
 return {url,tokens,seed,errors,models,close:async()=>{await page.close();await server.close();}};
}
async function save(page,text,note) {
 await page.locator('#amendment').fill(text);await page.locator('#change-note').fill(note);
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#prompt-status')).toHaveText('Saved.');
}
async function capture(page,name) {
 if(!process.env.STEM_SCREENSHOT_DIR)return;
 await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});
 await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/${name}.png`,fullPage:true,animations:'disabled'});
}
for(const persona of ['individual','student','instructor'])test(`${persona} saves only their own Personal instructions and revisions through Dashboard`,async({page})=>{
 const f=await fixture(page,persona==='individual'?{TEST_NO_COURSES:'true'}:{});
 try {
  await page.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.bob,...(persona==='instructor'?{'x-fixture-course-role':'owner'}:{})});
  await page.goto(new URL('/account.html',f.url).href);
  await expect(page.locator('.workspace-nav a:visible')).toHaveText(['Splitter','Classes','Account']);
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await expect(page.locator('#amendment-label')).toHaveText('Personal instructions');
  await expect(page.locator('#instruction-scope')).toHaveValue('personal');
  await expect(page.locator('#instruction-scope option')).toHaveCount(persona==='instructor'?2:1);
  await expect(page.locator('#sample-editor')).toBeHidden();
  await save(page,'Compare texture before harmony.','First personal instruction');
  await page.locator('#preview-btn').click();await expect(page.locator('#preview-body')).toContainText('Compare texture before harmony.');
  await page.reload();await expect(page.locator('#amendment')).toHaveValue('Compare texture before harmony.');
  await save(page,'','Reset personal instructions');
  await page.locator('#prompt-history-title').click();
  await page.getByRole('button',{name:'Restore revision 1 as a new version',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#prompt-history')).toContainText('Revision 3');
  await page.locator('#amendment').fill('Uncommitted draft');
  const marker=await page.evaluate(()=>window.dashboardDocument=crypto.randomUUID());
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#teacher-protected-region')).toBeVisible();
  await expect(page.locator('#amendment')).toHaveValue('Uncommitted draft');
  expect(await page.evaluate(()=>window.dashboardDocument)).toBe(marker);
  await page.locator('#prompt-reload').click();await expect(page.locator('#amendment')).toHaveValue('Compare texture before harmony.');
  if(persona==='instructor') {
   await page.locator('#instruction-scope').selectOption(course);await expect(page.locator('#amendment-label')).toHaveText('Class instructions');
   await expect(page.locator('#amendment')).toHaveValue('');await save(page,'Class-only rhythmic study.','Class assignment');
   await page.locator('#instruction-scope').selectOption('personal');await expect(page.locator('#amendment')).toHaveValue('Compare texture before harmony.');
  }
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await capture(page,`dashboard-${persona}-phone`);
  await page.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.alice});await page.reload();
  await expect(page.locator('#amendment')).toHaveValue('');await page.locator('#prompt-history-title').click();await expect(page.locator('#prompt-history')).toBeEmpty();
  expect(f.models).toEqual([]);expect(f.errors).toEqual([]);
 }finally{await f.close();}
});
test('Personal drafts survive conflicts and outages without retrying writes or leaking to the next account',async({page})=>{
 const f=await fixture(page,{TEST_NO_COURSES:'true'});let writes=0;
 try {
  await page.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.bob});await page.goto(new URL('/teacher.html',f.url).href);
  await expect(page.locator('#amendment')).toBeVisible();
  await page.route('**/api/account/prompt',route=>{if(route.request().method()==='PUT'){writes++;return route.fulfill({status:409,json:{error:'A newer revision exists.'}});}return route.continue();});
  await page.locator('#amendment').fill('A private unsaved draft');await page.locator('#change-note').fill('Draft reason');await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('#prompt-status')).toHaveText('A newer revision exists.');await expect(page.locator('#amendment')).toHaveValue('A private unsaved draft');
  await page.unroute('**/api/account/prompt');await page.route('**/api/account/prompt',route=>route.fulfill({status:503,json:{error:'Fixture outage'}}));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#teacher-protected-region')).toBeHidden();
  await page.unroute('**/api/account/prompt');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#amendment')).toHaveValue('A private unsaved draft');await expect(page.locator('#amendment')).toBeVisible();
  expect(writes).toBe(1);
  await page.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.alice});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#amendment')).toHaveValue('');await expect(page.locator('#prompt-history')).toBeEmpty();expect(f.errors).toEqual([]);
 }finally{await f.close();}
});
test('focus rechecks retain Splitter geometry, search text and Share with selection without document reloads',async({page})=>{
 const f=await fixture(page);let release;
 try {
  await page.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.bob});await page.goto(f.url.href);
  await expect(page.locator('#new-split-course')).toBeEnabled();await page.locator('#new-split-course').selectOption(course);
  await page.locator('#yt-url').fill('Retained artist query');await page.locator('#course-work-ack').check();
  const marker=await page.evaluate(()=>window.dashboardDocument=crypto.randomUUID()),before=await page.locator('#course-context').boundingBox();
  const pending=new Promise(resolve=>{release=resolve;});let asked=false;
  await page.route(/\/api\/classroom\/courses(?:\?.*)?$/,async route=>{asked=true;await pending;await route.continue();});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>asked).toBe(true);
  const during=await page.locator('#course-context').boundingBox();expect(during.y).toBeCloseTo(before.y,1);expect(during.height).toBeCloseTo(before.height,1);
  release();await expect(page.locator('#new-split-course')).toBeEnabled();await expect(page.locator('#new-split-course')).toHaveValue(course);
  await expect(page.locator('#yt-url')).toHaveValue('Retained artist query');await expect(page.locator('#course-work-ack')).toBeChecked();
  expect(await page.evaluate(()=>window.dashboardDocument)).toBe(marker);
  for(const width of [1280,390,320]) {
   await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const main=await page.locator('main').boundingBox();expect(main.width).toBeLessThanOrEqual(780);
   const intro=await page.locator('#station-tagline').boundingBox();if(width===1280)expect(intro.width).toBeLessThan(main.width/2);
   await capture(page,`splitter-layout-${width}`);
  }
  expect(f.errors).toEqual([]);
 }finally{release?.();await f.close();}
});
test('Account role loss removes privileged activity in place without reloading the signed-in Dashboard',async({page})=>{
 const f=await fixture(page);
 try {
  await f.seed([`INSERT INTO app_users(subject,role) VALUES('${TEST_SUBJECTS.bob}','instructor')`]);
  await page.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.bob});await page.goto(new URL('/account.html',f.url).href);
  await expect(page.locator('#student-review')).toBeVisible();const marker=await page.evaluate(()=>window.dashboardDocument=crypto.randomUUID());
  await f.seed([`UPDATE app_users SET role='student',revision=revision+1,updated_by='fixture' WHERE subject='${TEST_SUBJECTS.bob}'`]);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#student-review')).toBeHidden();
  await expect(page.locator('.dashboard-nav')).toBeVisible();expect(await page.evaluate(()=>window.dashboardDocument)).toBe(marker);expect(f.errors).toEqual([]);
 }finally{await f.close();}
});
