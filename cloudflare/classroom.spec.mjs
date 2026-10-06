import { test, expect, chromium } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const course='msh-245-the-american-musical-experience-fall-2026-01';
const member=subject=>'stem-member-v1-'+createHash('sha256').update(`fixture:${course}:${subject}`).digest('hex');
const screenshots=process.env.STEM_SCREENSHOT_DIR||'/tmp/stem-classroom-screenshots';
function tone(){const rate=8000,n=rate*35,buffer=Buffer.alloc(44+n*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)buffer.writeInt16LE(Math.round(1200*Math.sin(i*2*Math.PI*220/rate)),44+i*2);return buffer;}
async function setup(page){
 const issuer=await createTestIdentityIssuer();const alice=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice});const bob=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.bob});const gateway=await issuer.mintIdentityJwt({audience:'cail:gateway',subject:TEST_SUBJECTS.alice});
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_BROWSER:'true',TEST_ROSTER_SUBJECT:TEST_SUBJECTS.alice}}]});const {url}=await server.listen();
 const seed=async(sql)=>{const result=await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(sql)});expect(result.status).toBe(200);};
 const sql=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 sql.push(`INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}'),('${TEST_SUBJECTS.bob}')`,
  `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('course-song','A long course recording title for responsive review','uploads/source.wav','done','htdemucs_ft','[{"name":"vocals","key":"stems/course-song/vocals.mp3"}]')`,
  `INSERT INTO job_owners VALUES('course-song','${TEST_SUBJECTS.alice}')`,
  `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('course-song','${course}','${member(TEST_SUBJECTS.alice)}','${TEST_SUBJECTS.alice}','course-work-v1')`,
  `INSERT INTO course_folders(id,course_id,name,created_by,permission) VALUES('course-folder','${course}','Listening together','${TEST_SUBJECTS.alice}','comment')`,
  `INSERT INTO course_folder_items(folder_id,job_id,filename,model) VALUES('course-folder','course-song','Course recording','htdemucs_ft')`,
  `INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance) VALUES('first-note','course-song',3,'First student note','${TEST_SUBJECTS.alice}','Alex Rivera','student')`);
 await seed(sql);await mkdir(screenshots,{recursive:true});
 await page.route('**/api/files/stems/course-song/*',route=>route.fulfill({contentType:'audio/wav',body:tone()}));
 return {server,url,alice,bob,gateway,seed};
}
test('course share Refresh preserves live audio, controls and draft; protects names and handles revocation',async({page,context})=>{
 const f=await setup(page);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.bob});await page.goto(new URL('/?job=course-song',f.url).href);
  await expect(page).toHaveTitle('Stem Splitter');await expect(page.locator('.console')).toBeVisible();await expect(page.locator('.note-author')).toHaveText('Alex Rivera');
  await expect(page.locator('.coach')).toBeHidden();await expect(page.locator('.note-del')).toBeHidden();
  await page.locator('.note-btn').click();await page.getByRole('textbox',{name:'Note text',exact:true}).fill('Unsaved note draft');
  await page.evaluate(async()=>{const m=mixers.get('course-song');m.rate=.75;m.audios[0].playbackRate=.75;m.loop={start:0,end:30};await m.play();m.audios[0].volume=.6;});
  await expect.poll(()=>page.evaluate(()=>mixers.get('course-song').audios[0].currentTime)).toBeGreaterThan(.2);
  const before=await page.evaluate(()=>{const m=mixers.get('course-song');window.originalAudio=m.audios[0];return {time:m.audios[0].currentTime,volume:m.audios[0].volume};});
  await f.seed([`INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance) VALUES('new-note','course-song',4,'New peer observation','${TEST_SUBJECTS.alice}','Morgan Chen','student')`]);
  await page.locator('.refresh-btn').click();await expect(page.locator('.refresh-status')).toContainText('Updated');await expect(page.locator('.note-author')).toHaveText(['Alex Rivera','Morgan Chen']);
  await expect(page.getByRole('textbox',{name:'Note text',exact:true})).toHaveValue('Unsaved note draft');
  const after=await page.evaluate(()=>{const m=mixers.get('course-song');return {same:m.audios[0]===window.originalAudio,time:m.audios[0].currentTime,rate:m.rate,loop:m.loop,volume:m.audios[0].volume,playing:m.playing};});
  expect(after.same).toBe(true);expect(after.time).toBeGreaterThan(before.time);expect(after.rate).toBe(.75);expect(after.loop).toEqual({start:0,end:30});expect(after.volume).toBe(before.volume);expect(after.playing).toBe(true);
  let reads=0;let release;await page.route('**/api/jobs/course-song',async route=>{reads++;await new Promise(resolve=>{release=resolve;});await route.continue();});
  await page.locator('.refresh-btn').click();await expect(page.locator('.refresh-btn')).toBeDisabled();await page.evaluate(()=>mixers.get('course-song').refresh());expect(reads).toBe(1);release();await expect(page.locator('.refresh-btn')).toBeEnabled();await page.unroute('**/api/jobs/course-song');
  await page.route('**/api/jobs/course-song',route=>route.abort('failed'));await page.locator('.refresh-btn').click();await expect(page.locator('.refresh-status')).toContainText('Could not refresh');await expect(page.getByRole('textbox',{name:'Note text',exact:true})).toHaveValue('Unsaved note draft');await page.unroute('**/api/jobs/course-song');
  for(const width of [320,360,390,414,540,768,1024,1440]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator('h1')).toHaveText('Stem Splitter');expect(await page.locator('h1').evaluate(e=>getComputedStyle(e).textTransform)).toBe('none');}
  await page.screenshot({path:`${screenshots}/classroom-refresh-desktop-${process.env.STEM_BROWSER||'chrome'}.png`,fullPage:true,animations:'disabled'});await page.setViewportSize({width:390,height:844});await page.locator('.console').screenshot({path:`${screenshots}/classroom-refresh-mobile-${process.env.STEM_BROWSER||'chrome'}.png`});
  await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>document.documentElement.style.zoom='2');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>document.documentElement.style.zoom='1');
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.bob,'x-fixture-course-state':'revoked'});await page.locator('.refresh-btn').click();await expect(page.locator('.refresh-status')).toContainText('Access ended');await expect(page.locator('.note-text')).toHaveCount(0);expect(await page.evaluate(()=>mixers.get('course-song').playing)).toBe(false);expect(errors).toEqual([]);
 }finally{await f.server.close();}
});
test('instructor roster, course prompt, readonly conversations and folder grants render at desktop and mobile',async({page,context})=>{
 const f=await setup(page);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.alice,'x-fixture-gateway-identity':f.gateway,'x-fixture-course-role':'owner'});
  await page.goto(new URL('/teacher.html',f.url).href);await expect(page).toHaveTitle('Stem Splitter · Instructor');await expect(page.locator('#console-panel')).toBeVisible();await expect(page.getByRole('link',{name:'Course roster and conversations'})).toBeVisible();
  await page.locator('#amendment').fill('Compare the voices in this course.');await page.locator('#change-note').fill('New listening exercise');await page.getByRole('button',{name:'SAVE',exact:true}).click();await expect(page.locator('#prompt-status')).toContainText('Saved');
  await page.screenshot({path:`${screenshots}/classroom-prompt-desktop-${process.env.STEM_BROWSER||'chrome'}.png`,fullPage:true,animations:'disabled'});
  await page.getByRole('link',{name:'Course roster and conversations'}).click();await expect(page).toHaveTitle('Stem Splitter · Courses');await expect(page.locator('#roster-list')).toContainText('Zero split student · 0 splits');
  await page.locator('#roster-list button').first().click();await expect(page.locator('#student-jobs')).toContainText('A long course recording');await page.getByRole('button',{name:'Read conversation',exact:true}).click();await expect(page.locator('#conversation-messages')).toContainText('No retained conversation');
  await page.getByRole('button',{name:'Open folder',exact:true}).click();await expect(page.locator('#folder-items')).toContainText('Course recording');await page.locator('#folder-permission').selectOption('read');await page.getByRole('button',{name:'Save sharing',exact:true}).click();await expect(page.locator('#folder-status')).toContainText('Sharing updated');
  await expect(page.locator('.top-return a')).toHaveText('Back to Splitter');await expect(page.locator('.bottom-help a')).toHaveAttribute('href','mailto:ailab@gc.cuny.edu');expect(await page.locator('.bottom-help hr').count()).toBe(2);
  for(const width of [320,360,390,414,540,768,1024,1440]){await page.setViewportSize({width,height:1000});expect((await page.locator('#classroom-course').boundingBox()).height).toBeGreaterThanOrEqual(44);expect((await page.locator('#folder-permission').boundingBox()).height).toBeGreaterThanOrEqual(44);const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,intrinsic:[...document.querySelectorAll('main *')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,id:e.id,width:e.clientWidth,scroll:e.scrollWidth})),overflow:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+.5).map(e=>({tag:e.tagName,id:e.id,class:e.className,right:e.getBoundingClientRect().right}))}));expect(bounds.scroll,JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.width);}
  await expect(page.locator('main')).toHaveCount(1);await expect(page.locator('h1')).toHaveCount(1);
  await page.evaluate(()=>window.scrollTo(0,0));await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:`${screenshots}/classroom-roster-folders-desktop-${process.env.STEM_BROWSER||'chrome'}.png`,animations:'disabled'});await page.locator('#folder-detail').screenshot({path:`${screenshots}/classroom-folder-detail-${process.env.STEM_BROWSER||'chrome'}.png`});await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${screenshots}/classroom-roster-folders-mobile-${process.env.STEM_BROWSER||'chrome'}.png`,fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Use in folder',exact:true}).click();await page.locator('#folder-name').fill('A new course folder');await page.getByRole('button',{name:'Create private folder',exact:true}).click();await page.getByRole('button',{name:'Add selected split',exact:true}).click();await expect(page.locator('#folder-items')).toContainText('A long course recording');
  await f.seed([`INSERT INTO course_conversations(job_id,subject,revision,expires_at) VALUES('course-song','${TEST_SUBJECTS.alice}',1,datetime('now','+1 day'))`,...Array.from({length:70},(_,i)=>`INSERT INTO course_messages(id,job_id,subject,turn_id,kind,provenance,text) VALUES('page-${i}','course-song','${TEST_SUBJECTS.alice}','turn-${i}','${i%2?'coach':'you'}','${i%2?'server-assistant':'student'}','Saved message ${i}')`)]);
  await page.getByRole('button',{name:'Read conversation',exact:true}).click();await expect(page.locator('#conversation-messages li')).toHaveCount(40);await page.getByRole('button',{name:'More messages',exact:true}).click();await expect(page.locator('#conversation-messages li')).toHaveCount(70);
  await page.locator('.top-return a').click();await expect(page).toHaveTitle('Stem Splitter');await expect(page.locator('.compact-masthead h1')).toHaveText('Stem Splitter');expect(errors).toEqual([]);
 }finally{await f.server.close();}
});

test('second-account transitions clear prior roster, prompt drafts and live split drafts',async({page,context})=>{
 const f=await setup(page);
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.alice,'x-fixture-course-role':'owner'});
  await page.goto(new URL('/classroom.html',f.url).href);await expect(page.locator('#roster-list')).toContainText('Zero split student');
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.bob});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#classroom-content')).toBeVisible();await expect(page.locator('#classroom-status')).toHaveText('Course access checked.');
  await expect(page.locator('#classroom-roster')).toBeHidden();await expect(page.locator('#roster-list')).not.toContainText('Zero split student');
  await page.close();page=await context.newPage();
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.alice,'x-fixture-course-role':'owner'});
  await page.goto(new URL('/teacher.html',f.url).href);await expect(page.locator('#console-panel')).toBeVisible();await page.locator('#amendment').fill('Private unsaved course instruction');
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.bob});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#signin-panel')).toBeVisible();await expect(page.locator('#signin-panel')).toContainText('Current course ownership');
  await expect(page.locator('#console-panel')).toBeHidden();await expect(page.locator('#amendment')).not.toHaveValue('Private unsaved course instruction');
  await page.close();page=await context.newPage();await page.route('**/api/files/stems/course-song/*',route=>route.fulfill({contentType:'audio/wav',body:tone()}));
  await page.goto(new URL('/?job=course-song',f.url).href);await page.locator('.note-btn').click();await page.getByRole('textbox',{name:'Note text',exact:true}).fill('Previous account draft');
  await context.setExtraHTTPHeaders({});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.console')).toHaveCount(0);await expect(page.getByText('Previous account draft',{exact:true})).toHaveCount(0);
 }finally{await f.server.close();}
});
test('native Chromium 200 percent browser zoom keeps the shared note and controls usable',async({page})=>{
 test.skip(Boolean(process.env.STEM_BROWSER),'Native zoom uses Chromium browser extension API; other engines retain layout coverage.');
 const f=await setup(page);const temp=await mkdtemp('/tmp/stem-native-zoom-');let context;
 try{
  await mkdir(`${temp}/extension`);await writeFile(`${temp}/extension/manifest.json`,JSON.stringify({manifest_version:3,name:'Local zoom fixture',version:'1.0',permissions:['tabs'],host_permissions:['<all_urls>'],background:{service_worker:'worker.js'}}));await writeFile(`${temp}/extension/worker.js`,'chrome.runtime.onInstalled.addListener(()=>{});');
  context=await chromium.launchPersistentContext(`${temp}/profile`,{channel:'chromium',headless:process.env.STEM_NATIVE_HEADFUL!=='true',viewport:null,args:[`--disable-extensions-except=${temp}/extension`,`--load-extension=${temp}/extension`,'--window-size=1280,1000']});
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.bob});const zoomPage=await context.newPage();await zoomPage.route('**/api/files/stems/course-song/*',route=>route.fulfill({contentType:'audio/wav',body:tone()}));await zoomPage.goto(new URL('/?job=course-song',f.url).href);await expect(zoomPage.locator('.console')).toBeVisible();await expect.poll(()=>zoomPage.evaluate(()=>mixers.get('course-song').audios[0].duration)).toBeGreaterThan(30);
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const before=await zoomPage.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio}));
  const nativeZoom=await worker.evaluate(async origin=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.startsWith(origin));await chrome.tabs.setZoom(tab.id,2);return chrome.tabs.getZoom(tab.id);},f.url.origin);expect(nativeZoom).toBe(2);
  await expect.poll(()=>zoomPage.evaluate(()=>devicePixelRatio)).toBe(before.dpr*2);expect(await zoomPage.evaluate(()=>innerWidth)).toBeLessThan(before.width);
  await zoomPage.locator('.note-btn').click();await zoomPage.getByRole('textbox',{name:'Note text',exact:true}).fill('Native zoom note');expect(await zoomPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const form=await zoomPage.locator('.note-form').boundingBox(),speed=await zoomPage.getByRole('group',{name:'Playback speed'}).boundingBox();expect(speed.y).toBeGreaterThanOrEqual(form.y+form.height+4);
  await zoomPage.locator('.console').scrollIntoViewIfNeeded();await zoomPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await zoomPage.evaluate(()=>document.querySelector('.console').scrollIntoView({block:'center'}));await expect(zoomPage.locator('.console')).toBeInViewport();
  const screenshot=await worker.evaluate(async origin=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(origin));return chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});},f.url.origin);
  await writeFile(`${screenshots}/classroom-native-browser-200-chromium.png`,Buffer.from(screenshot.split(',')[1],'base64'));
 }finally{await context?.close();await f.server.close();await rm(temp,{recursive:true,force:true});}
});

test('author note edits survive Refresh and save under the original verified name',async({page,context})=>{
 const f=await setup(page);
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.alice});await page.goto(new URL('/?job=course-song',f.url).href);await page.getByRole('button',{name:'Edit note',exact:true}).click();
  const input=page.getByRole('textbox',{name:'Edit note text',exact:true});await input.fill('Unsaved author edit');
  await f.seed([`INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance) VALUES('edit-peer','course-song',5,'Peer changed this','${TEST_SUBJECTS.bob}','Morgan Chen','student')`]);
  await page.locator('.refresh-btn').click();await expect(page.locator('.notes')).toContainText('Peer changed this');await expect(input).toHaveValue('Unsaved author edit');
  await page.locator('.note-edit-form').getByRole('button',{name:'Save',exact:true}).click();await expect(input).toHaveCount(0);await expect(page.locator('.note-text').first()).toContainText('Unsaved author edit');await page.reload();await expect(page.locator('.note-text').first()).toContainText('Unsaved author edit');await expect(page.locator('.note-author').first()).toHaveText('Alex Rivera');
 }finally{await f.server.close();}
});
