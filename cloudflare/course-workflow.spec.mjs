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
  const contexts=[],audio=await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  const pageFor = async (subject,owner=false) => {
    const token=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject});
    const gateway=await issuer.mintIdentityJwt({audience:'cail:gateway',subject});
    const context=await browser.newContext({extraHTTPHeaders:{'x-fixture-identity':token,'x-fixture-gateway-identity':gateway,...(owner?{'x-fixture-course-role':'owner'}:{})}});contexts.push(context);
    const page=await context.newPage();
    await page.route('**/api/files/stems/shared-course/*',route=>route.fulfill({contentType:'audio/mpeg',body:audio}));
    return page;
  };
  return {issuer,url,seed,pageFor,close:async()=>{for(const c of contexts)await c.close();await server.close();}};
}

// The class page keeps one place per section. A folder opens under its own row.
test('an instructor builds a class folder in place: create, add splits, share, remove and delete',async({browser},testInfo)=>{
  const f=await fixture(browser);
  try{
    await f.seed([`INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('second-song','Second class fixture','uploads/second.wav','done','htdemucs_ft','[]')`,
      `INSERT INTO job_owners VALUES('second-song','${TEST_SUBJECTS.alice}')`,
      `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('second-song','${course}','stem-member-v1-${createHash('sha256').update(`fixture:${course}:${TEST_SUBJECTS.alice}`).digest('hex')}','${TEST_SUBJECTS.alice}','course-work-v1')`]);
    const page=await f.pageFor(TEST_SUBJECTS.alice,true),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(new URL(`/classroom.html?course=${course}`,f.url).href);
    await expect(page.getByRole('button',{name:'Folders',exact:true})).toHaveAttribute('aria-current','true');
    await expect(page.locator('#classroom-create')).toBeVisible();
    await page.getByRole('button',{name:'Make class folder',exact:true}).click();
    await expect(page.getByLabel('New folder')).toBeFocused();
    await expect(page.locator('#account-status')).toBeHidden();
    await expect(page.locator('#classroom-folder-create')).toContainText('Only you and instructors see a new folder until you share it with the class.');
    await page.getByLabel('New folder').fill('Week one');
    await page.getByRole('button',{name:'Create folder',exact:true}).click();
    const row=page.locator('#classroom-folders > li',{hasText:'Week one'});
    await expect(row.locator('#classroom-folder-detail')).toBeVisible();
    await expect(row.getByRole('button',{name:'Week one',exact:true})).toHaveAttribute('aria-expanded','true');
    await expect(page).toHaveURL(/folder=/);
    await expect(page.locator('#classroom-folder-status')).toHaveText('Only the creator and instructors can see this folder until it is shared with the class.');
    await expect(page.locator('#classroom-folder-share')).toBeHidden();
    await row.getByRole('button',{name:'Add splits',exact:true}).click();
    await row.getByRole('button',{name:'Add Second class fixture to this folder',exact:true}).click();
    await expect(page.locator('#classroom-folder-items')).toContainText('Second class fixture');
    await expect(row.getByRole('button',{name:'Second class fixture is in this folder',exact:true})).toBeDisabled();
    await expect(row.getByRole('button',{name:'Add Class fixture to this folder',exact:true})).toBeEnabled();
    await page.getByLabel('Who can use this folder?').selectOption('read');
    await page.getByRole('button',{name:'Save sharing',exact:true}).click();
    await expect(page.locator('#classroom-folder-status')).toHaveText('Class members can contribute splits, listen and read notes.');
    await expect(page.locator('#classroom-folder-share')).toBeVisible();
    await expect(row.locator('.classroom-entry-meta')).toHaveText('Class · can listen');
    await page.screenshot({path:testInfo.outputPath('class-folder-open.png'),fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('class-folder-open-390.png'),fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:1280,height:900});
    await page.reload();
    await expect(page.locator('#classroom-folders > li',{hasText:'Week one'}).locator('#classroom-folder-detail')).toBeVisible();
    await page.getByRole('button',{name:'Remove Second class fixture from this folder',exact:true}).click();
    await expect(page.locator('#classroom-folder-items')).not.toContainText('Second class fixture');
    await expect(page.locator('#classroom-folder-items')).toContainText('No splits in this folder yet.');
    await page.getByRole('button',{name:'Splits',exact:true}).click();
    await expect(page).toHaveURL(/view=splits/);
    await expect(page.locator('#classroom-student-name')).toHaveText('My splits in this class');
    await expect(page.locator('#classroom-jobs')).toContainText('Second class fixture');
    await expect(page.locator('#classroom-create')).toBeVisible();
    await expect(page.locator('#classroom-folders-section')).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button',{name:'Splits',exact:true})).toHaveAttribute('aria-current','true');
    await expect(page.locator('#classroom-jobs')).toContainText('Second class fixture');
    await page.getByRole('button',{name:'Folders',exact:true}).click();
    await page.getByRole('button',{name:'Week one',exact:true}).click();
    const remove=page.getByRole('button',{name:'Delete',exact:true});
    await remove.click();
    await expect(page.locator('#classroom-folder-status')).toHaveText('Deleting removes this folder. Its splits stay in the class.');
    await page.getByRole('button',{name:'Confirm delete',exact:true}).click();
    await expect(page.locator('#classroom-folders')).not.toContainText('Week one');
    await expect(page).not.toHaveURL(/folder=/);
    await expect(page.locator('#classroom-folders')).toContainText('Class comments');
    const job=await page.request.get(new URL('/api/jobs/second-song',f.url).href);
    expect(job.status()).toBe(200);
    expect(errors).toEqual([]);
  }finally{await f.close();}
});
test('a student can start a folder and open their own splits without instructor controls',async({browser})=>{
  const f=await fixture(browser);
  try{
    await f.seed([`DELETE FROM course_folder_items`,`UPDATE course_folders SET permission='private'`]);
    const page=await f.pageFor(TEST_SUBJECTS.bob);
    await page.goto(new URL(`/classroom.html?course=${course}`,f.url).href);
    await expect(page.locator('#classroom-folders-status')).toHaveText('No folders yet. Create one, add splits, then choose who can open it.');
    await expect(page.locator('#classroom-views')).toBeVisible();
    await expect(page.locator('#classroom-folder-create')).toBeVisible();
    await expect(page.locator('#classroom-create')).toBeVisible();
    await expect(page.locator('#classroom-view-students')).toBeHidden();
    await expect(page.locator('#classroom-guidance')).toBeHidden();
    await page.getByRole('button',{name:'Make class folder',exact:true}).click();
    await expect(page.getByLabel('New folder')).toBeFocused();
    await page.getByRole('button',{name:'Splits',exact:true}).click();
    await expect(page.locator('#classroom-student-name')).toHaveText('My splits in this class');
    await expect(page.locator('#classroom-jobs-status')).toContainText('You have no splits in this class yet.');
  }finally{await f.close();}
});
test('students create and manage their folders, contribute their own splits, and retain ownership after instructor edits',async({browser},testInfo)=>{
  const f=await fixture(browser);
  try{
    const bobMember='stem-member-v1-'+createHash('sha256').update(`fixture:${course}:${TEST_SUBJECTS.bob}`).digest('hex');
    await f.seed([
      `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('peer-song','Peer class recording','uploads/peer.wav','done','htdemucs_ft','[]')`,
      `INSERT INTO job_owners VALUES('peer-song','${TEST_SUBJECTS.bob}')`,
      `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('peer-song','${course}','${bobMember}','${TEST_SUBJECTS.bob}','course-work-v1')`,
    ]);
    const creator=await f.pageFor(TEST_SUBJECTS.alice),peer=await f.pageFor(TEST_SUBJECTS.bob),instructor=await f.pageFor(TEST_SUBJECTS.bob,true);
    await creator.goto(new URL(`/classroom.html?course=${course}`,f.url).href);
    await creator.getByRole('button',{name:'Make class folder',exact:true}).click();
    await creator.getByLabel('New folder').fill('Student listening');
    await creator.getByRole('button',{name:'Create folder',exact:true}).click();
    await expect(creator.locator('#classroom-folder-title')).toHaveText('Student listening');
    const address=creator.url(),folderId=new URL(address).searchParams.get('folder');
    await expect(creator.getByRole('button',{name:'Rename',exact:true})).toBeVisible();
    await expect(creator.locator('#classroom-view-students')).toBeHidden();
    await peer.goto(new URL(`/classroom.html?course=${course}`,f.url).href);
    await expect(peer.locator('#classroom-folders')).not.toContainText('Student listening');
    expect((await peer.request.get(new URL(`/api/classroom/courses/${course}/folders/${folderId}`,f.url).href)).status()).toBe(404);
    await creator.getByRole('button',{name:'Add splits',exact:true}).click();
    await expect(creator.locator('#classroom-add-list')).not.toContainText('Peer class recording');
    await creator.getByRole('button',{name:'Add Class fixture to this folder',exact:true}).click();
    await expect(creator.locator('#classroom-folder-items')).toContainText('Class fixture');
    await creator.getByLabel('Who can use this folder?').selectOption('comment');
    await creator.getByRole('button',{name:'Save sharing',exact:true}).click();
    await expect(creator.locator('#classroom-folder-status')).toContainText('Class members can contribute splits');
    await peer.goto(address);
    await expect(peer.locator('#classroom-folder-items')).toContainText('Class fixture');
    await expect(peer.locator('#classroom-folder-sharing')).toBeHidden();
    await expect(peer.getByRole('button',{name:'Rename',exact:true})).toBeHidden();
    await expect(peer.getByRole('button',{name:'Remove Class fixture from this folder',exact:true})).toBeHidden();
    await peer.getByRole('button',{name:'Add splits',exact:true}).click();
    await expect(peer.locator('#classroom-add-list')).not.toContainText('Class fixture');
    await peer.getByRole('button',{name:'Add Peer class recording to this folder',exact:true}).click();
    await expect(peer.getByRole('button',{name:'Remove Peer class recording from this folder',exact:true})).toBeVisible();
    await peer.getByRole('button',{name:'Remove Peer class recording from this folder',exact:true}).click();
    await expect(peer.locator('#classroom-folder-items')).not.toContainText('Peer class recording');
    await peer.getByRole('button',{name:'Splits',exact:true}).click();
    await expect(peer.locator('#classroom-jobs')).toContainText('Peer class recording');
    await expect(peer.getByRole('button',{name:'Listening Guy messages',exact:true})).toBeHidden();
    await peer.getByLabel('Folder for Peer class recording').selectOption(folderId);
    await peer.getByRole('button',{name:'Add to folder',exact:true}).click();
    await expect(peer.locator('#classroom-jobs')).toContainText('Added to class folder.');
    await instructor.goto(address);
    await instructor.getByRole('button',{name:'Rename',exact:true}).click();
    await instructor.getByLabel('Folder name',{exact:true}).fill('Student listening renamed');
    await instructor.getByRole('button',{name:'Save name',exact:true}).click();
    await expect(instructor.locator('#classroom-folder-title')).toHaveText('Student listening renamed');
    await creator.reload();
    await expect(creator.getByRole('button',{name:'Rename',exact:true})).toBeVisible();
    await expect(creator.getByRole('button',{name:'Remove Peer class recording from this folder',exact:true})).toBeVisible();
    await creator.setViewportSize({width:390,height:844});
    expect(await creator.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await creator.screenshot({path:testInfo.outputPath('student-folder-mobile.png'),fullPage:true,animations:'disabled'});
    await peer.goto(address);
    await expect(peer.getByRole('button',{name:'Remove Peer class recording from this folder',exact:true})).toBeVisible();
    await creator.getByLabel('Who can use this folder?').selectOption('private');
    await creator.getByRole('button',{name:'Save sharing',exact:true}).click();
    await expect(creator.locator('#classroom-folder-status')).toContainText('Only the creator and instructors');
    await peer.getByRole('button',{name:'Remove Peer class recording from this folder',exact:true}).click();
    await expect(peer.locator('#classroom-folder-detail')).toBeHidden();
    await expect(peer.locator('#classroom-folders')).not.toContainText('Student listening renamed');
    await creator.getByRole('button',{name:'Delete',exact:true}).click();
    await creator.getByRole('button',{name:'Confirm delete',exact:true}).click();
    await expect(creator.locator('#classroom-folders')).not.toContainText('Student listening renamed');
    expect((await creator.request.get(new URL('/api/jobs/shared-course',f.url).href)).status()).toBe(200);
    expect((await peer.request.get(new URL('/api/jobs/peer-song',f.url).href)).status()).toBe(200);
  }finally{await f.close();}
});
for (const instructor of [false,true]) test(`from the Splitter, a ${instructor?'instructor':'student'} adds a class split to a class folder and it stays in the rack`,async({browser})=>{
  const f=await fixture(browser);
  try{
    const page=await f.pageFor(TEST_SUBJECTS.alice,instructor);
    await page.goto(f.url.href);
    const entry=page.locator('.console[data-job-id="shared-course"]');
    await expect(entry).toBeVisible();
    await expect(page.locator('#folders .rack-title')).toHaveText('MY FOLDERS');
    await entry.locator('.actions-toggle').click();
    await expect(entry.locator('.folder-btn')).toBeHidden();
    await expect(entry.locator('.class-workspace-link')).toHaveText('Open class');
    await entry.getByRole('button',{name:'ADD TO CLASS FOLDER',exact:true}).click();
    const menu=entry.locator('.class-folder-menu');
    await expect(menu.getByRole('button',{name:'Class comments',exact:true})).toBeVisible();
    await menu.getByLabel('New class folder name').fill('Made on the Splitter');
    await menu.getByRole('button',{name:'ADD',exact:true}).click();
    await expect(menu.locator('.class-folder-status')).toContainText('Added to Made on the Splitter.');
    await expect(entry).toBeVisible();
    await menu.locator('.class-folder-status a').click();
    await expect(page).toHaveURL(/\/classroom/);
    await expect(page.locator('#classroom-folders > li',{hasText:'Made on the Splitter'}).locator('#classroom-folder-items')).toContainText('Class fixture');
    await expect(page.locator('#classroom-folder-status')).toHaveText('Only the creator and instructors can see this folder until it is shared with the class.');
  }finally{await f.close();}
});
test('a withdrawn class folder is cleared from an open Splitter picker after a denied contribution',async({browser})=>{
  const f=await fixture(browser);
  try{
    const page=await f.pageFor(TEST_SUBJECTS.alice);
    await page.goto(f.url.href);
    const entry=page.locator('.console[data-job-id="shared-course"]');
    await expect(entry).toBeVisible();
    await entry.locator('.actions-toggle').click();
    await entry.getByRole('button',{name:'ADD TO CLASS FOLDER',exact:true}).click();
    const menu=entry.locator('.class-folder-menu');
    await expect(menu.getByRole('button',{name:'Class comments',exact:true})).toBeVisible();
    await f.seed(["UPDATE course_folders SET permission='private',revision=revision+1 WHERE id='shared-folder'"]);
    await menu.getByRole('button',{name:'Class comments',exact:true}).click();
    await expect(menu.locator('.class-folder-status')).toContainText('Class access changed.');
    await expect(menu.locator('.folder-menu-rows')).toBeEmpty();
    await expect(menu.locator('form')).toBeHidden();
  }finally{await f.close();}
});
test('a withdrawn folder is removed from the own-splits assignment picker after a denied contribution',async({browser})=>{
  const f=await fixture(browser);
  try{
    const page=await f.pageFor(TEST_SUBJECTS.alice);
    await page.goto(new URL(`/classroom.html?course=${course}&view=splits`,f.url).href);
    const picker=page.getByLabel('Folder for Class fixture');
    await picker.selectOption('shared-folder');
    await expect(page.locator('#classroom-folder-detail')).toBeHidden();
    await f.seed(["UPDATE course_folders SET permission='private',revision=revision+1 WHERE id='shared-folder'"]);
    await page.getByRole('button',{name:'Add to folder',exact:true}).click();
    await expect(picker.locator('option[value="shared-folder"]')).toHaveCount(0);
    await expect(picker).toHaveValue('');
  }finally{await f.close();}
});

// Resplit: With original split is the default for a split you own, whatever Share with says.
async function resplitPage(f,routeJob){
  const page=await f.pageFor(TEST_SUBJECTS.alice,true),sent=[],audio=await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  await page.route('**/api/files/stems/personal-one/*',route=>route.fulfill({contentType:'audio/mpeg',body:audio}));
  await page.route('**/api/uploads',route=>{sent.push({path:'uploads',course:route.request().headers()['x-stem-course']});return route.fulfill({json:{key:'uploads/resplit-fixture.mp3',uploadUrl:new URL('/__resplit-upload',f.url).href}});});
  await page.route('**/__resplit-upload',route=>route.fulfill({status:200}));
  await page.route('**/api/jobs',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    sent.push({path:'jobs',course:route.request().headers()['x-stem-course'],body:route.request().postDataJSON()});
    return route.fulfill({status:400,json:{error:'Fixture stops before any provider job.'}});
  });
  if(routeJob)await routeJob(page);
  return {page,sent};
}
const openResplit=async(page,jobId)=>{
  const entry=page.locator(`.console[data-job-id="${jobId}"]`);
  await expect(entry).toBeVisible();
  const expand=entry.getByRole('button',{name:'Expand this session',exact:true});
  if(await expand.count())await expand.click();
  await entry.locator('.resplit-btn').first().click();
  const dialog=page.getByRole('dialog',{name:'Resplit',exact:true});
  await expect(dialog.locator('.resplit-status')).not.toHaveText('Loading split choices…');
  return dialog;
};
test('a class split resplits with its original by default while Share with stays on Personal, with no new notice',async({browser})=>{
  const f=await fixture(browser);
  try{
    const {page,sent}=await resplitPage(f);
    await page.goto(f.url.href);
    await expect(page.getByLabel('Share with')).toHaveValue('personal');
    const dialog=await openResplit(page,'shared-course');
    await expect(dialog.locator('#resplit-model')).toHaveValue('vocals_instrumental');
    expect(await dialog.locator('#resplit-model option').allTextContents()).toEqual(['2 splits', '4 splits']);
    const original=dialog.getByRole('radio',{name:'With original split',exact:true}),separate=dialog.getByRole('radio',{name:'Separate split',exact:true}),notice=dialog.locator('.resplit-course-ack'),go=dialog.getByRole('button',{name:'Resplit',exact:true});
    await expect(original).toBeEnabled();await expect(original).toBeChecked();
    await expect(notice).toBeHidden();await expect(go).toBeEnabled();
    await expect(dialog.locator('.resplit-status')).toContainText('Adds the new stems under');
    await expect(dialog.locator('.resplit-status')).not.toContainText('Tick the notice');
    expect(await go.evaluate(el=>[getComputedStyle(el).opacity,getComputedStyle(el).cursor,getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)'])).toEqual(['1','pointer',false]);
    // Separate with Personal selected stays personal and asks nothing.
    await separate.check();await expect(notice).toBeHidden();await expect(go).toBeEnabled();
    await original.check();
    await go.click();
    await expect.poll(()=>sent.filter(entry=>entry.path==='jobs').length).toBe(1);
    expect(sent.map(entry=>entry.course)).toEqual([course,course]);
    const body=sent.at(-1).body;
    expect(body.model).toBe('vocals_instrumental');
    expect(body.coursePolicy).toBe('course-work-v1');
    expect(body.resplit).toEqual({parentJobId:'shared-course',stem:'vocals',placement:'with_original'});
    await expect(page.getByLabel('Share with')).toHaveValue('personal');
  }finally{await f.close();}
});
test('a separate resplit into the same class needs no new notice, while someone else\'s split still does',async({browser})=>{
  const f=await fixture(browser);
  try{
    const {page}=await resplitPage(f);
    await page.goto(new URL(`/?course=${course}`,f.url).href);
    await expect(page.getByLabel('Share with')).toHaveValue(course);
    await expect(page.locator('#course-work-ack')).not.toBeChecked();
    const dialog=await openResplit(page,'shared-course');
    const separate=dialog.getByRole('radio',{name:'Separate split',exact:true}),notice=dialog.locator('.resplit-course-ack'),go=dialog.getByRole('button',{name:'Resplit',exact:true});
    await separate.check();await expect(notice).toBeHidden();await expect(go).toBeEnabled();
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.route('**/api/jobs/shared-course',async route=>{const response=await route.fetch();const json=await response.json();return route.fulfill({response,json:{...json,permissions:{...json.permissions,owner:false}}});});
    await page.reload();
    await expect(page.getByLabel('Share with')).toHaveValue(course);
    const other=await openResplit(page,'shared-course');
    await expect(other.locator('.resplit-course-ack')).toBeVisible();
    await expect(other.getByRole('button',{name:'Resplit',exact:true})).toBeDisabled();
    expect(await other.getByRole('button',{name:'Resplit',exact:true}).evaluate(el=>[getComputedStyle(el).opacity,getComputedStyle(el).cursor])).toEqual(['0.45','not-allowed']);
  }finally{await f.close();}
});
test('a personal split resplits with its original while Share with names a class, and a separate split takes the class notice',async({browser})=>{
  const f=await fixture(browser);
  try{
    await f.seed([`INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('personal-one','Personal fixture','uploads/personal.wav','done','htdemucs_ft','[{"name":"vocals","key":"stems/personal-one/vocals.mp3"}]')`,
      `INSERT INTO job_owners VALUES('personal-one','${TEST_SUBJECTS.alice}')`]);
    const {page,sent}=await resplitPage(f);
    await page.goto(f.url.href);
    await expect(page.getByLabel('Share with')).toBeEnabled();await page.getByLabel('Share with').selectOption(course);
    await expect(page.locator('#course-work-ack')).not.toBeChecked();
    const dialog=await openResplit(page,'personal-one');
    const original=dialog.getByRole('radio',{name:'With original split',exact:true}),separate=dialog.getByRole('radio',{name:'Separate split',exact:true}),notice=dialog.locator('.resplit-course-ack'),go=dialog.getByRole('button',{name:'Resplit',exact:true});
    await expect(original).toBeChecked();await expect(notice).toBeHidden();await expect(go).toBeEnabled();
    await expect(dialog.getByRole('combobox',{name:'Number of splits',exact:true})).not.toHaveValue('');
    await separate.check();
    await expect(notice).toBeVisible();await expect(go).toBeDisabled();
    await notice.locator('input').check();await expect(go).toBeEnabled();
    await original.check();
    await expect(notice).toBeHidden();await expect(go).toBeEnabled();
    await separate.check();
    await expect(notice.locator('input')).not.toBeChecked();await expect(go).toBeDisabled();
    await original.check();
    await go.click();
    await expect.poll(()=>sent.filter(entry=>entry.path==='jobs').length).toBe(1);
    expect(sent.map(entry=>entry.course)).toEqual(['personal','personal']);
    expect(sent.at(-1).body.coursePolicy).toBeUndefined();
    expect(sent.at(-1).body.resplit).toEqual({parentJobId:'personal-one',stem:'vocals',placement:'with_original'});
  }finally{await f.close();}
});
test('someone else\'s split cannot be kept with its original, and the greyed choice says why',async({browser})=>{
  const f=await fixture(browser);
  try{
    const {page}=await resplitPage(f,page=>page.route('**/api/jobs/shared-course',async route=>{
      const response=await route.fetch();const json=await response.json();
      return route.fulfill({response,json:{...json,permissions:{...json.permissions,owner:false}}});
    }));
    await page.goto(f.url.href);
    const dialog=await openResplit(page,'shared-course');
    const original=dialog.getByRole('radio',{name:'With original split',exact:true});
    await expect(original).toBeDisabled();await expect(original).not.toBeChecked();
    await expect(dialog.getByRole('radio',{name:'Separate split',exact:true})).toBeChecked();
    await expect(dialog.locator('.resplit-placement-help')).toHaveText('Keeping results with the original is available for your own saved splits.');
    expect(await dialog.locator('.resplit-placement label').first().evaluate(el=>getComputedStyle(el).opacity)).toBe('0.45');
    await expect(dialog.getByRole('button',{name:'Resplit',exact:true})).toBeEnabled();
  }finally{await f.close();}
});

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
    await expect(page.getByLabel('Share with')).toHaveValue(course);
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
  await expect(page.getByRole('button',{name:'Splits',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Splits',exact:true}).click();
  await expect(page.getByRole('link',{name:'Create shared split',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Folders',exact:true}).click();
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


for (const owner of [false,true]) for (const width of [1280,390]) test(`Create shared split retains the class for ${owner?'instructors':'students'} at ${width}px`,async({browser},testInfo)=>{
 const f=await fixture(browser);
 try {
  const page=await f.pageFor(TEST_SUBJECTS.alice,owner),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:900});
  await page.goto(new URL(`/classroom.html?course=${course}`,f.url).href);
  await expect(page.locator('#classroom-course')).toHaveValue(course);
  if(owner)await page.getByRole('button',{name:'Splits',exact:true}).click();
  await page.getByRole('link',{name:'Create shared split',exact:true}).click();
  await expect(page).toHaveURL(new URL(`/?course=${course}`,f.url).href);
  await expect(page).toHaveTitle(/Stem Splitter/);
  const select=page.getByLabel('Share with');
  await expect(select).toBeEnabled();await expect(select).toHaveValue(course);
  await expect(page.locator('#course-work-ack')).toBeVisible();
  await expect(page.locator('#course-work-ack')).not.toBeChecked();
  expect(await page.evaluate(()=>{try{creationCourse();return '';}catch(error){return error.message;}})).toContain('disclosure');
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:testInfo.outputPath('workspace-class.png'),animations:'disabled'});
  const box=await select.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+.1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#course-work-ack').check();
  expect(await page.evaluate(()=>creationCourse())).toBe(course);
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(select).toBeEnabled();await expect(select).toHaveValue(course);
  await expect(page.locator('#course-work-ack')).toBeChecked();
  await page.reload();await expect(select).toHaveValue(course);
  await expect(page.locator('#course-work-ack')).not.toBeChecked();
  await select.selectOption('personal');
  expect(new URL(page.url()).searchParams.has('course')).toBe(false);
  await page.reload();await expect(select).toHaveValue('personal');
  expect(errors).toEqual([]);
 } finally {await f.close();}
});

for (const failure of ['unavailable','outage']) test(`a course link requires a workspace choice after ${failure}`,async({browser})=>{
 const f=await fixture(browser);
 try {
  const page=await f.pageFor(TEST_SUBJECTS.alice);
  await page.route('**/api/classroom/courses',route=>route.fulfill(failure==='outage'
   ?{status:503,json:{error:'Fixture outage'}}:{json:{courses:[],nextCursor:null}}));
  await page.goto(new URL(`/?course=${course}`,f.url).href);
  const select=page.getByLabel('Share with');
  await expect(select).toBeEnabled();await expect(select).toHaveValue('');
  await expect(page.locator('#course-context')).toBeVisible();
  expect(await page.evaluate(()=>{try{creationCourse();return '';}catch(error){return error.message;}})).toContain('Choose a workspace');
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(select).toBeEnabled();await expect(select).toHaveValue('');
  await select.selectOption('personal');
  expect(await page.evaluate(()=>creationCourse())).toBe('personal');
 } finally {await f.close();}
});

for (const owner of [false,true]) for (const width of [1280,390]) test(`new splits default to Personal for ${owner?'instructors':'students'} at ${width}px`,async({browser})=>{
 const f=await fixture(browser);
 try {
  const page=await f.pageFor(TEST_SUBJECTS.alice,owner);
  await page.setViewportSize({width,height:900});
  await page.addInitScript(({subject,course})=>localStorage.setItem(`stem-workspace-choice:v1:${subject}`,course),{subject:TEST_SUBJECTS.alice,course});
  await page.goto(f.url.href);
  const select=page.getByLabel('Share with');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('personal');
  await expect(page.locator('#course-work-ack')).toBeHidden();
  expect(await page.evaluate(()=>creationCourse())).toBe('personal');
  const control=page.getByRole('combobox',{name:/^Workspace:/});
  const personalBox=await control.boundingBox();
  expect(personalBox.width).toBeGreaterThan(150);expect(personalBox.height).toBeGreaterThanOrEqual(44);
  await control.focus();await expect(control).toBeFocused();
  await control.press('Tab');await expect(control).not.toBeFocused();
  await select.selectOption(course);
  await expect(select).toHaveValue(course);
  await expect(page.locator('#course-work-ack')).toBeVisible();
  await expect(page.locator('#course-work-ack')).not.toBeChecked();
  await page.locator('#course-work-ack').check();
  expect(await page.evaluate(()=>creationCourse())).toBe(course);
  expect((await control.boundingBox()).width).toBeGreaterThan(personalBox.width);
  const courseBox=await control.boundingBox();
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
  await expect(page.getByLabel('Share with')).toBeEnabled();
  expect(await page.evaluate(()=>creationCourse())).toBe('personal');
  await page.getByLabel('Share with').selectOption('second-fixture-course');
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Share with')).toBeEnabled();
  await expect(page.getByLabel('Share with')).toHaveValue('second-fixture-course');
  classes=[classes[0]];
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Share with')).toHaveValue('');
  expect(await page.evaluate(()=>{try{creationCourse();return '';}catch(error){return error.message;}})).toContain('Choose a workspace');
  await expect(page.locator('#course-work-ack')).toBeHidden();
  await page.getByLabel('Share with').selectOption(course);
  await page.reload();await expect(page.getByLabel('Share with')).toHaveValue('personal');
  // Leave the old document before switching fixture identities: its session guard
  // may otherwise reload concurrently with the explicit navigation below.
  // The same browser context retains storage for the course-default assertion.
  await page.goto('about:blank');
  await page.setExtraHTTPHeaders({'x-fixture-identity':await f.issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.bob})});
  await page.goto(f.url.href);await expect(page.getByLabel('Share with')).toHaveValue('personal');
  classes=[];await page.goto(f.url.href);
  // The section starts hidden while membership loads. Wait for the actual
  // access check to finish before asserting that creation is available.
  await expect(page.getByLabel('Share with')).toBeEnabled();
  await expect(page.locator('#course-context')).toBeHidden();
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
  await expect.poll(()=>page.evaluate(()=>selectedCourse)).toBe('');
  release();await expect.poll(()=>page.evaluate(()=>courseSelectionPending)).toBe(false);
  await expect(page.locator('#job-list')).toContainText('Personal recording');
  expect(await page.evaluate(()=>selectedCourse)).toBe('');
  await expect(page.locator('#course-context')).toBeVisible();
  expect((await page.request.get(new URL('/api/jobs/personal-kept',f.url).href)).status()).toBe(200);
 } finally {await f.close();}
});

for (const classSplit of [false,true]) test(`a file selected during session refresh starts once in ${classSplit?'the acknowledged class':'Personal without course enrollment'}`,async({browser})=>{
 const f=await fixture(browser);
 try {
  const page=await f.pageFor(TEST_SUBJECTS.alice);
  const courses=classSplit?[{classId:course,className:'Music',term:'Fall',section:'01'}]:[];
  let release,started,hold=false;
  const waiting=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  await page.route('**/api/classroom/courses',async route=>{
   if(hold){started();await waiting;}
   await route.fulfill({json:{courses,nextCursor:null}});
  });
  await page.goto(new URL(classSplit?`/?course=${course}`:'/',f.url).href);
  await expect(page.getByLabel('Share with')).toBeEnabled();
  if(classSplit)await page.locator('#course-work-ack').check();
  let uploads=0,starts=0,received;
  await page.route('**/api/uploads',route=>{uploads++;return route.fulfill({json:{key:'uploads/picker.mp3',uploadUrl:new URL('/picker-audio',f.url).href}});});
  await page.route('**/picker-audio',route=>route.fulfill({status:200,body:''}));
  await page.route('**/api/jobs',route=>{
   if(route.request().method()!=='POST')return route.continue();
   starts++;received=route.request().headers();
   return route.fulfill({status:503,json:{error:'Fixture provider unavailable. Retry this split.'}});
  });
  hold=true;
  await page.evaluate(()=>dispatchEvent(new Event('focus')));await ready;
  const audio={name:'Tab Steps Out.mp3',mimeType:'audio/mpeg',buffer:await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url))};
  await page.locator('#file-input').setInputFiles(audio);
  await page.locator('#file-input').setInputFiles(audio);
  expect(uploads).toBe(0);expect(starts).toBe(0);
  release();
  await expect.poll(()=>starts).toBe(1);
  expect(uploads).toBe(1);
  expect(received['x-stem-course']).toBe(classSplit?course:'personal');
  await expect(page.locator('#upload-message')).toBeVisible();
  await expect(page.locator('#upload-message')).toContainText('Fixture provider unavailable');
  // Finishing a poll for older runs must preserve this new attempt's feedback.
  await page.evaluate(()=>pollActiveJobs());
  await expect(page.locator('#upload-message')).toBeVisible();
  // A later focus check must retain the current feedback when it restores the page.
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await expect(page.locator('#upload-message')).toBeVisible();
 } finally {await f.close();}
});
