import {test,expect} from '@playwright/test';
import {createTestHarness} from 'wrangler';
import {createTestIdentityIssuer,TEST_SUBJECTS} from '@cuny-ai-lab/cail-identity/testing';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {schemaStatements} from '../tests/e2e/schema-statements.mjs';
const course='msh-245-the-american-musical-experience-fall-2026-01';
async function fixture(context){
 const issuer=await createTestIdentityIssuer();
 const harness=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol,TEST_BROWSER:'true',TEST_COURSE_OWNER_SUBJECT:TEST_SUBJECTS.alice,TEST_ROSTER_SUBJECT:TEST_SUBJECTS.bob}}]});
 const {url}=await harness.listen();
 expect((await harness.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')))})).status).toBe(200);
 const tokens={};for(const name of ['alice','bob','carol'])tokens[name]=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS[name]});
 await context.setExtraHTTPHeaders({'x-fixture-identity':tokens.alice});
 return {harness,url,tokens};
}
async function savePrompt(page,text,note){await page.locator('#amendment').fill(text);await page.locator('#change-note').fill(note);await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#prompt-status')).toContainText('Saved.');}
for(const mode of ['course','global'])test(`${mode} instruction customization saves, reloads, previews and resets without model calls`,async({page,context})=>{
 const f=await fixture(context),errors=[],modelCalls=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/\/(guide|chat)$/.test(new URL(r.url()).pathname))modelCalls.push(r.url());});
 try{
  if(mode==='global')await context.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.carol});
  await page.goto(new URL('/teacher.html'+(mode==='course'?`?course=${course}`:''),f.url).href);
  await expect(page).toHaveTitle('Stem Splitter · Instructor Console');await expect(page.getByRole('heading',{name:'Instructor Console',exact:true})).toBeVisible();
  await expect(page.locator('#console-panel')).toBeVisible();
  if(mode==='course'){await expect(page.locator('.sample-editor')).toBeHidden();await expect(page.locator('#teacher-classroom')).toHaveAttribute('href',`/classroom.html?course=${course}`);await expect(page.locator('#course-roster')).toContainText('Fixture Student');}
  else {
   await expect(page.locator('.sample-editor')).toBeVisible();await expect(page.locator('#sample-settings-form')).toBeHidden();
   const summary=page.locator('#sample-editor-summary');await expect(summary).toHaveAttribute('aria-expanded','false');
   await summary.focus();await summary.press('Enter');await expect(summary).toHaveAttribute('aria-expanded','true');await expect(page.locator('#sample-settings-form')).toBeVisible();
   await summary.press('Space');await expect(summary).toHaveAttribute('aria-expanded','false');await summary.press('Enter');
   await expect(page.locator('#prompt-scope-note')).toContainText('Applies across Stem Splitter');
  }
  await page.locator('#amendment').fill('Fixture teaching instructions');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#prompt-status')).toContainText('Add a change note');
  await savePrompt(page,'Fixture teaching instructions','First synthetic revision');
  if(mode==='global'){
   const saved=await(await page.request.get(new URL('/api/teacher/prompt',f.url).href)).json();
   expect(saved.updatedBy).toBe(TEST_SUBJECTS.carol);expect(saved.history[0].updatedBy).toBe(TEST_SUBJECTS.carol);
   await expect(page.locator('#amendment-meta')).not.toContainText(TEST_SUBJECTS.carol);
   await expect(page.locator('#prompt-history')).not.toContainText(TEST_SUBJECTS.carol);
   await expect(page.locator('#amendment-meta')).toContainText('Saved ·');
  }
  await page.locator('#preview-btn').click();await expect(page.locator('#preview-body')).toContainText('Fixture teaching instructions');
  await page.reload();await expect(page.locator('#amendment')).toHaveValue('Fixture teaching instructions');
  await page.locator('#fixed-prompt-title').click();await expect(page.locator('#fixed-prompt-body')).not.toBeEmpty();await page.locator('#fixed-prompt-toggle').click();await expect(page.locator('#fixed-prompt-toggle-label')).toHaveText('End');await page.locator('#fixed-prompt-toggle').click();await expect(page.locator('#fixed-prompt-toggle-label')).toHaveText('Top');
  await savePrompt(page,'','Reset synthetic instructions');await page.locator('#preview-btn').click();await expect(page.locator('#preview-body')).not.toContainText('Fixture teaching instructions');
  await page.locator('#prompt-history-title').click();await expect(page.locator('#prompt-history')).toContainText('First synthetic revision');
  if(mode==='course'){await page.getByRole('button',{name:'Restore revision 1 as a new version',exact:true}).click();await expect(page.locator('#amendment')).toHaveValue('Fixture teaching instructions');await expect(page.locator('#change-note')).toHaveValue('Restored revision 1');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#prompt-status')).toContainText('Saved.');await expect(page.locator('#prompt-history')).toContainText('Revision 3');}
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByRole('textbox',{name:'Teaching instructions',exact:true})).toBeVisible();
  await expect(page.locator('.workspace-nav [aria-current="page"]')).toHaveText('Settings');
  const instructionCount=await page.locator('#amendment-count').boundingBox(),noteLabel=await page.locator('label[for="change-note"]').boundingBox();
  expect(instructionCount.y+instructionCount.height).toBeLessThan(noteLabel.y);
  await expect(page.locator('#amendment')).toHaveAttribute('aria-describedby','amendment-count');
  await expect(page.locator('#change-note')).toHaveAttribute('aria-describedby','change-note-count');
  for(const selector of ['#change-note','#preview-btn','#prompt-form button[type="submit"]']) expect((await page.locator(selector).boundingBox()).height).toBeGreaterThanOrEqual(44);
  if(mode==='global'){
   await page.locator('#sample-editor-summary').click();
   for(const selector of ['#samples-hold','#samples-cadence','#sample-search']) expect((await page.locator(selector).boundingBox()).height).toBeGreaterThanOrEqual(44);
   const options=await page.locator('#sample-search-results button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,scroll:node.scrollHeight,client:node.clientHeight};}));
   // Firefox rounds adjoining DOMRect edges independently; allow 0.001 CSS px.
   for(let index=0;index<options.length;index++){expect(options[index].height).toBeGreaterThanOrEqual(44);expect(options[index].scroll).toBeLessThanOrEqual(options[index].client+1);if(index)expect(options[index].top).toBeGreaterThanOrEqual(options[index-1].bottom-0.001);}
  }
  expect(modelCalls).toEqual([]);expect(errors).toEqual([]);
 }finally{await f.harness.close();}
});
test('class discovery excludes students and course settings fail closed on role loss',async({page,context})=>{
 const f=await fixture(context);
 try{
  await page.goto(new URL('/teacher.html',f.url).href);await expect(page).toHaveURL(new URL(`/teacher?course=${course}`,f.url).href);
  await expect(page.locator('#console-panel')).toBeVisible();
  await savePrompt(page,'Private course fixture','Synthetic setting');await page.locator('#preview-btn').click();
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.alice,'x-fixture-course-state':'revoked'});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#teacher-protected-region')).toBeHidden();await expect(page.locator('#amendment')).toHaveValue('');await expect(page.locator('#fixed-prompt-body')).toBeEmpty();await expect(page.locator('#preview-body')).toBeEmpty();await expect(page.locator('#course-roster')).toBeEmpty();
  await page.reload();await expect(page.locator('#console-panel')).toBeHidden();
  await page.goto('about:blank');await context.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.bob});await page.goto(new URL('/teacher.html',f.url).href);await expect(page.locator('#course-discovery-status')).toContainText('No instructor classes');await expect(page.locator('#console-panel')).toBeHidden();
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeHidden();await expect(page.locator('#teacher-access-status')).toContainText('Instructor access is not available');
 }finally{await f.harness.close();}
});
test('failed prompt saves retain the draft and uncertain authority conceals prior settings',async({page,context})=>{
 const f=await fixture(context),path=`**/api/classroom/courses/${course}/prompt`;
 try{
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeVisible();
  await page.route(path,route=>route.request().method()==='PUT'?route.fulfill({status:409,json:{error:{message:'A newer revision exists. Reload before saving.'}}}):route.continue());
  await page.locator('#amendment').fill('Unsaved fixture draft');await page.locator('#change-note').fill('Draft explanation');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#prompt-status')).toContainText('newer revision');await expect(page.locator('#amendment')).toHaveValue('Unsaved fixture draft');await expect(page.locator('#change-note')).toHaveValue('Draft explanation');
  await page.unroute(path);await page.route(path,route=>route.fulfill({status:503,json:{error:{message:'Temporary course lookup failure'}}}));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#teacher-protected-region')).toBeHidden();await expect(page.locator('#teacher-access-status')).toContainText('could not be verified');
  await page.unroute(path);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#teacher-protected-region')).toBeVisible();await expect(page.locator('#amendment')).toHaveValue('Unsaved fixture draft');
 }finally{await f.harness.close();}
});
test('global song controls persist enable, reshuffle, remove and timing; reload discards drafts',async({page,context})=>{
 const f=await fixture(context);
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.carol});await page.goto(new URL('/teacher.html',f.url).href);await page.locator('#sample-editor-summary').click();await expect(page.locator('#sample-selected .sample-card')).toHaveCount(6);
  const cards=page.locator('#sample-selected .sample-card');
  await expect(cards.first().getByRole('button',{name:/Move up:/})).toBeDisabled();await expect(cards.last().getByRole('button',{name:/Move down:/})).toBeDisabled();
  await page.locator('#samples-enabled').uncheck();await page.locator('#samples-reshuffle').uncheck();await page.locator('#samples-hold').fill('4');await page.locator('#samples-cadence').fill('7');await cards.first().getByRole('button',{name:/Remove:/}).click();await expect(cards).toHaveCount(5);
  await page.getByRole('button',{name:'Save songs',exact:true}).click();await expect(page.locator('#sample-settings-status')).toContainText('Saved.');await page.reload();await page.locator('#sample-editor-summary').click();await expect(cards).toHaveCount(5);await expect(page.locator('#samples-enabled')).not.toBeChecked();await expect(page.locator('#samples-reshuffle')).not.toBeChecked();await expect(page.locator('#samples-hold')).toHaveValue('4');await expect(page.locator('#samples-cadence')).toHaveValue('7');
  await page.locator('#samples-enabled').check();await page.locator('#samples-hold').fill('9');await page.getByRole('button',{name:'Reload saved songs'}).click();await expect(page.locator('#samples-enabled')).not.toBeChecked();await expect(page.locator('#samples-hold')).toHaveValue('4');
 }finally{await f.harness.close();}
});
test('song loading and readback failures disable unsafely initialized controls and allow reload',async({page,context})=>{
 const f=await fixture(context),path='**/api/teacher/song-samples';let failure=true;
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.carol});await page.route(path,route=>route.request().method()==='GET'&&failure?route.fulfill({status:503,json:{error:{message:'Fixture songs unavailable'}}}):route.continue());
  await page.goto(new URL('/teacher.html',f.url).href);await page.locator('#sample-editor-summary').click();await expect(page.locator('#console-panel')).toBeVisible();await expect(page.locator('#samples-save')).toBeDisabled();await expect(page.locator('#samples-hold')).toBeDisabled();await expect(page.locator('#samples-reload')).toBeEnabled();
  failure=false;await page.locator('#samples-reload').click();await expect(page.locator('#samples-save')).toBeEnabled();await expect(page.locator('#sample-selected .sample-card')).toHaveCount(6);
  failure=true;await page.locator('#samples-enabled').uncheck();await page.locator('#samples-save').click();await expect(page.locator('#sample-settings-status')).toContainText('readback failed');await expect(page.locator('#samples-save')).toBeDisabled();
  failure=false;await page.locator('#samples-reload').click();await expect(page.locator('#samples-save')).toBeEnabled();await expect(page.locator('#samples-enabled')).not.toBeChecked();
 }finally{await f.harness.close();}
});
test('switching signed-in accounts removes the prior instructor settings',async({page,context})=>{
 const f=await fixture(context);
 try{
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeVisible();await savePrompt(page,'Prior account private instructions','Synthetic account test');await page.locator('#preview-btn').click();await expect(page.locator('#preview-body')).toContainText('Prior account private instructions');
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.bob});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#console-panel')).toBeHidden();await expect(page.locator('body')).not.toContainText('Prior account private instructions');await expect(page.locator('#teacher-access-status')).toContainText('Instructor access is not available');
 }finally{await f.harness.close();}
});
test('late prompt preview cannot restore content after course revocation',async({page,context})=>{
 const f=await fixture(context);let release,started;const waiting=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{started=resolve;});
 try{
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeVisible();
  await page.route(`**/api/classroom/courses/${course}/prompt/preview`,async route=>{started();await waiting;await route.fulfill({json:{prompt:'Late private instructor preview'}}).catch(()=>{});});
  await page.locator('#preview-btn').click();await requested;
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.tokens.alice,'x-fixture-course-state':'revoked'});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#teacher-protected-region')).toBeHidden();await expect(page.locator('#fixed-prompt-body')).toBeEmpty();
  release();await expect(page.locator('#prompt-status')).toContainText('Instructor access changed');await expect(page.locator('#preview-body')).toBeEmpty();await expect(page.locator('body')).not.toContainText('Late private instructor preview');await expect(page.locator('#teacher-protected-region')).toBeHidden();
 }finally{release();await f.harness.close();}
});
test('course instruction history loads earlier revisions and opens their saved snapshot',async({page,context})=>{
 const f=await fixture(context);
 try{
  const statements=Array.from({length:41},(_,index)=>`INSERT INTO course_prompt_revisions(course_id,revision,amendment,change_note,base_version,base_hash,effective_hash,actor) VALUES('${course}',${index+1},'Synthetic instructions ${index+1}','Synthetic note ${index+1}','fixture','${'a'.repeat(64)}','${'b'.repeat(64)}','fixture-instructor')`);
  expect((await f.harness.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(statements)})).status).toBe(200);
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeVisible();await page.locator('#prompt-history-title').click();await expect(page.locator('#prompt-history > li')).toHaveCount(40);await page.locator('#prompt-history-more').click();await expect(page.locator('#prompt-history > li')).toHaveCount(41);await expect(page.locator('#prompt-history-more')).toBeHidden();
  const oldest=page.locator('#prompt-history > li').last();await oldest.locator('summary').click();await expect(oldest).toContainText('Synthetic instructions 1');
 }finally{await f.harness.close();}
});
for(const failure of ['503','network'])test(`ordinary course save ${failure} conceals pending and uncertain access, retains draft and never retries the write`,async({page,context})=>{
 const f=await fixture(context),path=`**/api/classroom/courses/${course}/prompt`;let release,writeCount=0;const pending=new Promise(resolve=>{release=resolve;});
 try{
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeVisible();
  await page.route(path,async route=>{if(route.request().method()!=='PUT')return route.continue();writeCount++;await pending;if(failure==='network')await route.abort();else await route.fulfill({status:503,json:{error:{message:'Fixture authority outage'}}});});
  await page.locator('#amendment').fill('Retained uncertain-save draft');await page.locator('#change-note').fill('Retained explanation');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#teacher-protected-region')).toBeHidden();
  release();await expect(page.locator('#teacher-access-status')).toContainText('could not be verified');await expect(page.locator('#teacher-protected-region')).toBeHidden();await expect(page.locator('#amendment')).toHaveValue('Retained uncertain-save draft');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#teacher-protected-region')).toBeVisible();await expect(page.locator('#amendment')).toHaveValue('Retained uncertain-save draft');await expect(page.locator('#change-note')).toHaveValue('Retained explanation');expect(writeCount).toBe(1);
 }finally{release();await f.harness.close();}
});
test('late successful preview cannot reopen settings after an uncertain course write',async({page,context})=>{
 const f=await fixture(context);let releaseWrite,releasePreview,previewStarted;const writing=new Promise(r=>{releaseWrite=r;}),previewing=new Promise(r=>{releasePreview=r;}),started=new Promise(r=>{previewStarted=r;});
 try{
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeVisible();
  await page.route(`**/api/classroom/courses/${course}/prompt`,async route=>{if(route.request().method()!=='PUT')return route.continue();await writing;await route.fulfill({status:503,json:{error:{message:'Uncertain write fixture'}}});});
  await page.route(`**/api/classroom/courses/${course}/prompt/preview`,async route=>{previewStarted();await previewing;await route.fulfill({json:{prompt:'Late authorized preview fixture'}});});
  await page.locator('#amendment').fill('Uncertain draft');await page.locator('#change-note').fill('Retain original revision');await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.evaluate(()=>document.querySelector('#preview-btn').dispatchEvent(new Event('click')));await started;releaseWrite();await expect(page.locator('#teacher-access-status')).toContainText('could not be verified');releasePreview();await expect(page.locator('#preview-body')).toContainText('Late authorized preview fixture');await expect(page.locator('#teacher-protected-region')).toBeHidden();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#teacher-protected-region')).toBeVisible();await expect(page.locator('#amendment')).toHaveValue('Uncertain draft');
 }finally{releaseWrite();releasePreview();await f.harness.close();}
});
test('a stalled course write times out after eight seconds and stays concealed',async({page,context})=>{
 const f=await fixture(context);let release;const waiting=new Promise(r=>{release=r;});
 try{
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);await expect(page.locator('#console-panel')).toBeVisible();await page.clock.install();
  await page.route(`**/api/classroom/courses/${course}/prompt`,async route=>{if(route.request().method()!=='PUT')return route.continue();await waiting;await route.abort().catch(()=>{});});
  await page.locator('#amendment').fill('Timeout draft');await page.locator('#change-note').fill('Synthetic timeout');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#teacher-protected-region')).toBeHidden();await page.clock.fastForward(8001);await expect(page.locator('#teacher-access-status')).toContainText('could not be verified');await expect(page.locator('#amendment')).toHaveValue('Timeout draft');await expect(page.locator('#teacher-protected-region')).toBeHidden();
 }finally{release();await f.harness.close();}
});


test('instructor roster separates personal app activity, class work and unavailable usage',async({page,context},testInfo)=>{
 const f=await fixture(context), errors=[];page.on('pageerror',e=>errors.push(e.message));
 let usageStatus='available';
 try{
  await page.route(`**/api/classroom/courses/${course}/roster`,async route=>{
   const response=await route.fetch(),data=await response.json();
   data.appUsageStatus=usageStatus;
   data.participants=[{displayName:'Fixture Student',memberId:'fixture-member',splitCount:0,completedCount:0,
    appUsage:usageStatus==='available'?{runs:3,completed:2,guideTurns:4,recordedVisits:5,lastActiveAt:null}:null}];
   data.demonstrationParticipants=[{displayName:'Sample student',splitCount:3}];
   await route.fulfill({response,json:data});
  });
  await page.goto(new URL(`/teacher.html?course=${course}`,f.url).href);
  await expect(page).toHaveTitle('Stem Splitter · Instructor Console');
  await expect(page.locator('#course-roster')).toContainText('0 splits for this class · 0 completed');
  await expect(page.locator('#course-roster')).toContainText('App use: 3 split attempts · 2 completed · 4 Guide turns · 5 recorded visits in 30 days');
  await expect(page.locator('#course-roster-status')).toHaveText('1 enrolled student shown.');
  await page.locator('#course-roster').scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('instructor-usage-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('instructor-usage-phone.png')});
  usageStatus='pending';await page.reload();await expect(page.locator('#course-roster')).toContainText('App usage pending');
  usageStatus='unavailable';await page.reload();await expect(page.locator('#course-roster')).toContainText('App usage temporarily unavailable');
  expect(errors).toEqual([]);
 }finally{await f.harness.close();}
});
