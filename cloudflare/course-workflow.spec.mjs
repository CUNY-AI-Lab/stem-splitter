import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const course = 'msh-245-the-american-musical-experience-fall-2026-01';
async function fixture(browser,vars={}) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_BROWSER:'true',...vars}}]});
  const {url} = await server.listen();
  const seed = async statements => expect((await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(statements)})).status).toBe(200);
  const member = 'stem-member-v1-' + createHash('sha256').update(`fixture:${course}:${TEST_SUBJECTS.alice}`).digest('hex');
  await seed([...schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')),
    `INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}'),('${TEST_SUBJECTS.bob}')`,
    `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('shared-course','Class fixture','uploads/source.wav','done','htdemucs_ft','[{"name":"vocals","key":"stems/shared-course/vocals.mp3"}]')`,
    `INSERT INTO job_owners VALUES('shared-course','${TEST_SUBJECTS.alice}')`,
    `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('shared-course','${course}','${member}','${TEST_SUBJECTS.alice}','course-work-v1')`,
    `INSERT INTO course_folders(id,course_id,name,created_by,permission) VALUES('shared-folder','${course}','Class comments','${TEST_SUBJECTS.alice}','comment')`,
    `INSERT INTO course_folder_items(folder_id,job_id,filename,model) VALUES('shared-folder','shared-course','Class fixture','htdemucs_ft')`]);
  const contexts=[];
  const pageFor = async (subject,owner=false) => {
    const token=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject});
    const gateway=await issuer.mintIdentityJwt({audience:'cail:gateway',subject});
    const context=await browser.newContext({extraHTTPHeaders:{'x-fixture-identity':token,'x-fixture-gateway-identity':gateway,...(owner?{'x-fixture-course-role':'owner'}:{})}});contexts.push(context);
    const page=await context.newPage();
    await page.route('**/api/files/stems/shared-course/*',route=>route.fulfill({contentType:'audio/mpeg',body:Buffer.alloc(0)}));
    return page;
  };
  return {issuer,url,seed,pageFor,close:async()=>{for(const c of contexts)await c.close();await server.close();}};
}

test('course creation requires disclosure and sends an exact course with the acknowledged policy',async({browser})=>{
  const f=await fixture(browser);
  try{
    const page=await f.pageFor(TEST_SUBJECTS.alice,true);let received;
    await page.route('**/api/jobs',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      received={headers:route.request().headers(),body:route.request().postDataJSON()};
      return route.fulfill({status:400,json:{error:'Fixture stops before any provider job.'}});
    });
    await page.goto(new URL(`/?course=${course}`,f.url).href);
    await expect(page.locator('label[for="new-split-course"]')).toHaveText('Share with');
    await expect(page.getByLabel('Share with')).toHaveValue('personal');
    await page.getByLabel('Share with').selectOption(course);
    await expect(page.locator('#course-work-ack')).not.toBeChecked();
    const blocked=await page.evaluate(async()=>{try{await api('/api/jobs',{method:'POST',body:JSON.stringify({key:'uploads/fixture.wav',filename:'Fixture',model:'htdemucs_ft'})});return null;}catch(error){return error.message;}});
    expect(blocked).toContain('disclosure');expect(received).toBeUndefined();
    await page.locator('#course-work-ack').check();
    await page.evaluate(async()=>{try{await api('/api/jobs',{method:'POST',body:JSON.stringify({key:'uploads/fixture.wav',filename:'Fixture',model:'htdemucs_ft'})});}catch{}});
    expect(received.headers['x-stem-course']).toBe(course);expect(received.body.coursePolicy).toBe('course-work-v1');
    const courseKey=received.headers['idempotency-key'];
    await page.locator('#course-work-ack').uncheck();
    const withdrawn=await page.evaluate(async courseContext=>{try{await api('/api/jobs',{method:'POST',courseContext,body:JSON.stringify({key:'uploads/fixture.wav',filename:'Fixture',model:'htdemucs_ft'})});return null;}catch(error){return error.message;}},course);
    expect(withdrawn).toContain('disclosure');expect(received.headers['idempotency-key']).toBe(courseKey);
    await page.getByLabel('Share with').selectOption('personal');
    await page.evaluate(async()=>{try{await api('/api/jobs',{method:'POST',body:JSON.stringify({key:'uploads/fixture.wav',filename:'Fixture',model:'htdemucs_ft'})});}catch{}});
    expect(received.headers['x-stem-course']).toBe('personal');expect(received.body.coursePolicy).toBeUndefined();expect(received.headers['idempotency-key']).not.toBe(courseKey);
  }finally{await f.close();}
});

test('instructors retain roster and class controls when supplemental usage storage is unavailable',async({browser})=>{
 const f=await fixture(browser,{TEST_ROSTER_SUBJECT:TEST_SUBJECTS.alice});
 try {
  await f.seed(['DROP TABLE course_usage_accounts']);
  const page=await f.pageFor(TEST_SUBJECTS.alice,true);
  await page.goto(new URL(`/classroom.html?course=${course}`,f.url).href);
  await expect(page.locator('#classroom-roster')).toContainText('App usage temporarily unavailable');
  await expect(page.locator('#classroom-roster-status')).toHaveText('');
  await expect(page.getByRole('link',{name:'Create a split',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Course record',exact:true})).toBeVisible();
  await expect(page.locator('#classroom-folders')).toContainText('Class comments');
 } finally {await f.close();}
});

test('shared class notes refresh across students, preserve failed drafts, attribute authors, and stop on revocation',async({browser})=>{
  const f=await fixture(browser);
  try{
    const owner=await f.pageFor(TEST_SUBJECTS.alice,true),student=await f.pageFor(TEST_SUBJECTS.bob);
    await Promise.all([owner.goto(new URL('/?job=shared-course',f.url).href),student.goto(new URL('/?job=shared-course',f.url).href)]);
    await expect(student.locator('.console')).toBeVisible();
    await expect(student.locator('.coach')).toBeHidden();
    let fail=true;
    await student.route('**/api/jobs/shared-course/annotations',async route=>fail?(fail=false,route.fulfill({status:503,json:{error:'Fixture temporary failure'}})):route.continue());
    await student.locator('.note-btn').click();await student.getByRole('textbox',{name:'Note text'}).fill('A classmate hears the bass entrance.');
    await student.getByRole('button',{name:'SAVE',exact:true}).click();
    await expect(student.getByRole('textbox',{name:'Note text'})).toHaveValue('A classmate hears the bass entrance.');
    await student.getByRole('button',{name:'SAVE',exact:true}).click();
    await expect(student.locator('.note-text')).toContainText('Fixture Student');
    await expect(owner.locator('.note-text')).toContainText('A classmate hears the bass entrance.',{timeout:9000});
    await expect(owner.locator('.note-del')).toBeHidden();
    await expect(student.locator('.note-del')).toBeVisible();
    expect(await student.evaluate(()=>mixers.get('shared-course').exportMarkdown())).toContain('(Fixture Student)');
    await f.seed(["UPDATE course_folders SET permission='private',revision=revision+1 WHERE id='shared-folder'"]);
    await expect(student.locator('.console')).toBeHidden({timeout:9000});
    const response=await student.request.get(new URL('/api/jobs/shared-course',f.url).href);expect(response.status()).toBe(404);
  }finally{await f.close();}
});

test('owner Listening Guy cue recovers visibly after a failed stream and can be retried',async({browser})=>{
  const f=await fixture(browser);
  try{
    const page=await f.pageFor(TEST_SUBJECTS.alice,true);let fail=true;
    await page.route('**/api/jobs/shared-course/guide',route=>fail?(fail=false,route.fulfill({status:503,json:{error:'Fixture guide unavailable. Try again.'}})):route.fulfill({contentType:'text/event-stream',body:'data: {"type":"delta","text":"Listen for the bass."}\n\ndata: {"type":"done","text":"Listen for the bass.","model":"fixture"}\n\n'}));
    await page.goto(new URL('/?job=shared-course',f.url).href);await page.locator('.coach-toggle').click();
    await page.locator('.coach-cue-btn').click();await expect(page.locator('.coach-hint')).toContainText('Fixture guide unavailable');
    await expect(page.locator('.coach-cue-btn')).toBeEnabled();await page.locator('.coach-cue-btn').click();
    await expect(page.locator('.coach-guide-text')).toContainText('Listen for the bass.');
  }finally{await f.close();}
});


for (const owner of [false,true]) for (const width of [1280,390]) test(`new splits default to Personal for ${owner?'instructors':'students'} at ${width}px`,async({browser})=>{
 const f=await fixture(browser);
 try {
  const page=await f.pageFor(TEST_SUBJECTS.alice,owner);
  await page.setViewportSize({width,height:900});
  await page.addInitScript(({subject,course})=>localStorage.setItem(`stem-workspace-choice:v1:${subject}`,course),{subject:TEST_SUBJECTS.alice,course});
  await page.goto(new URL(`/?course=${course}`,f.url).href);
  const select=page.getByLabel('Share with');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('personal');
  await expect(page.locator('#course-work-ack')).toBeHidden();
  expect(await page.evaluate(()=>creationCourse())).toBe('personal');
  const personalBox=await select.boundingBox();
  expect(personalBox.width).toBeLessThan(150);expect(personalBox.height).toBeGreaterThanOrEqual(44);
  await select.focus();await expect(select).toBeFocused();
  await select.press('Tab');await expect(select).not.toBeFocused();
  await select.selectOption(course);
  await expect(select).toHaveValue(course);
  await expect(page.locator('#course-work-ack')).toBeVisible();
  await expect(page.locator('#course-work-ack')).not.toBeChecked();
  await page.locator('#course-work-ack').check();
  expect(await page.evaluate(()=>creationCourse())).toBe(course);
  expect((await select.boundingBox()).width).toBeGreaterThan(personalBox.width);
  const courseBox=await select.boundingBox();
  expect(courseBox.x).toBeGreaterThanOrEqual(0);
  expect(courseBox.x+courseBox.width).toBeLessThanOrEqual(width);
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(select).toBeEnabled();await expect(select).toHaveValue(course);
  await page.route('**/api/classroom/courses',route=>route.fulfill({status:503,json:{error:'Fixture outage'}}));
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(select).toHaveValue('');
  expect(await page.evaluate(()=>{try{creationCourse();return '';}catch(error){return error.message;}})).toContain('Choose a workspace');
  await page.unroute('**/api/classroom/courses');
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(select).toBeEnabled();await expect(select).toHaveValue('');
  await select.selectOption('personal');
  expect(await page.evaluate(()=>creationCourse())).toBe('personal');
  await page.reload();await expect(select).toHaveValue('personal');
  await expect(page.locator('#course-work-ack')).toBeHidden();
  await page.goto(new URL(`/classroom.html`,f.url).href);
  await expect(page.locator('#classroom-course')).toHaveValue(course);
  await expect(page.locator('#console-panel')).toBeVisible();
 } finally {await f.close();}
});

test('multiple courses default to Personal while explicit choices remain usable until access changes',async({browser})=>{
 const f=await fixture(browser);
 try {
  const page=await f.pageFor(TEST_SUBJECTS.alice);
  let classes=[{classId:course,className:'First class',term:'Fall',section:'01'},
   {classId:'second-fixture-course',className:'Second class',term:'Fall',section:'02'}];
  await page.route('**/api/classroom/courses',route=>route.fulfill({json:{courses:classes,nextCursor:null}}));
  await page.goto(f.url.href);
  await expect(page.getByLabel('Share with')).toHaveValue('personal');
  expect(await page.evaluate(()=>creationCourse())).toBe('personal');
  await page.getByLabel('Share with').selectOption('second-fixture-course');
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Share with')).toBeEnabled();
  await expect(page.getByLabel('Share with')).toHaveValue('second-fixture-course');
  classes=[classes[0]];
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Share with')).toHaveValue('personal');
  await expect(page.locator('#course-work-ack')).toBeHidden();
  await page.getByLabel('Share with').selectOption(course);
  await page.reload();await expect(page.getByLabel('Share with')).toHaveValue('personal');
  // Leave the old document before switching fixture identities: its session guard
  // may otherwise reload concurrently with the explicit navigation below.
  // The same browser context retains storage for the course-default assertion.
  await page.goto('about:blank');
  await page.setExtraHTTPHeaders({'x-fixture-identity':await f.issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.bob})});
  await page.goto(f.url.href);await expect(page.getByLabel('Share with')).toHaveValue('personal');
  classes=[];await page.goto(f.url.href);await expect(page.locator('#course-context')).toBeHidden();
  expect(await page.evaluate(()=>creationCourse())).toBe('personal');
 } finally {await f.close();}
});

test('membership refresh fences old responses, blocks creation while checking and preserves personal recordings',async({browser})=>{
 const f=await fixture(browser);
 try {
  await f.seed([`INSERT INTO jobs(id,filename,source_key,status,stems) VALUES('personal-kept','Personal recording','uploads/personal.wav','done','[]')`,
   `INSERT INTO job_owners(job_id,subject) VALUES('personal-kept','${TEST_SUBJECTS.alice}')`]);
  const page=await f.pageFor(TEST_SUBJECTS.alice);
  await page.goto(f.url.href);await expect(page.getByLabel('Share with')).toHaveValue('personal');
  await page.getByLabel('Share with').selectOption(course);
  await expect(page.locator('#job-list')).toContainText('Personal recording');
  let release,started;const waiting=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);let reads=0;
  await page.route('**/api/classroom/courses',async route=>{
   if(++reads===1){started();await waiting;await route.fulfill({json:{courses:[{classId:course,className:'Old class',term:'Fall',section:'01'}]}});}
   else await route.fulfill({json:{courses:[],nextCursor:null}});
  });
  await page.evaluate(()=>dispatchEvent(new Event('focus')));await ready;
  await expect(page.getByLabel('Share with')).toBeDisabled();
  expect(await page.evaluate(()=>{try{creationCourse();return '';}catch(error){return error.message;}})).toContain('Checking your class access');
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect.poll(()=>page.evaluate(()=>selectedCourse)).toBe('personal');
  release();await expect.poll(()=>page.evaluate(()=>courseSelectionPending)).toBe(false);
  await expect(page.locator('#job-list')).toContainText('Personal recording');
  expect(await page.evaluate(()=>selectedCourse)).toBe('personal');
  expect((await page.request.get(new URL('/api/jobs/personal-kept',f.url).href)).status()).toBe(200);
 } finally {await f.close();}
});
