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
async function fulfillTone(route){
 const bytes=tone(),range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
 const start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
 await route.fulfill({status:range?206:200,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})},body:bytes.subarray(start,end+1)});
}
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
 await page.route('**/api/files/stems/course-song/*',fulfillTone);
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
  await expect(page.locator('.top-return a')).toHaveText('Back to Splitter');await expect(page.locator('.bug-report a')).toHaveAttribute('href','mailto:ailab@gc.cuny.edu');await expect(page.locator('.bug-report > summary')).toBeVisible();expect(await page.locator('.bug-report').evaluate(el=>[getComputedStyle(el).borderTopWidth,getComputedStyle(el).borderBottomWidth])).toEqual(['1px','1px']);
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
  await page.close();page=await context.newPage();await page.route('**/api/files/stems/course-song/*',fulfillTone);
  await page.goto(new URL('/?job=course-song',f.url).href);await page.locator('.note-btn').click();await page.getByRole('textbox',{name:'Note text',exact:true}).fill('Previous account draft');
  await context.setExtraHTTPHeaders({});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.console')).toHaveCount(0);await expect(page.getByText('Previous account draft',{exact:true})).toHaveCount(0);
 }finally{await f.server.close();}
});
test('native Chromium 200 percent browser zoom keeps the shared note and controls usable',async({page})=>{
 test.skip(Boolean(process.env.STEM_BROWSER),'Native zoom uses Chromium browser extension API; other engines retain layout coverage.');
 const f=await setup(page);const temp=await mkdtemp('/tmp/stem-native-zoom-');let context;
 try{
  await f.seed([`UPDATE jobs SET stems='[{"name":"vocals","key":"stems/course-song/vocals.mp3"},{"name":"drums","key":"stems/course-song/drums.mp3"}]' WHERE id='course-song'`]);
  await mkdir(`${temp}/extension`);await writeFile(`${temp}/extension/manifest.json`,JSON.stringify({manifest_version:3,name:'Local zoom fixture',version:'1.0',permissions:['tabs'],host_permissions:['<all_urls>'],background:{service_worker:'worker.js'}}));await writeFile(`${temp}/extension/worker.js`,'chrome.runtime.onInstalled.addListener(()=>{});');
  context=await chromium.launchPersistentContext(`${temp}/profile`,{channel:'chromium',headless:process.env.STEM_NATIVE_HEADFUL!=='true',viewport:null,args:[`--disable-extensions-except=${temp}/extension`,`--load-extension=${temp}/extension`,'--window-size=1280,1000']});
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.bob});const zoomPage=await context.newPage();await zoomPage.route('**/api/files/stems/course-song/*',fulfillTone);await zoomPage.goto(new URL('/?job=course-song',f.url).href);await expect(zoomPage.locator('.console')).toBeVisible();await expect.poll(()=>zoomPage.evaluate(()=>mixers.get('course-song').audios[0].duration)).toBeGreaterThan(30);
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const before=await zoomPage.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio}));
  const nativeZoom=await worker.evaluate(async origin=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.startsWith(origin));await chrome.tabs.setZoom(tab.id,2);return chrome.tabs.getZoom(tab.id);},f.url.origin);expect(nativeZoom).toBe(2);
  await expect.poll(()=>zoomPage.evaluate(()=>devicePixelRatio)).toBe(before.dpr*2);expect(await zoomPage.evaluate(()=>innerWidth)).toBeLessThan(before.width);
  await expect.poll(()=>zoomPage.evaluate(()=>mixers.get('course-song').audios.every(audio=>audio.duration>30))).toBe(true);
  const waveform=zoomPage.locator('.waveform-seek').last();await waveform.scrollIntoViewIfNeeded();const waveBox=await waveform.boundingBox();
  await zoomPage.mouse.click(waveBox.x+waveBox.width*.5,waveBox.y+waveBox.height/2);
  await expect.poll(()=>zoomPage.evaluate(()=>{const audio=mixers.get('course-song').audios;return audio.length===2&&audio.every(track=>track.paused&&Math.abs(track.currentTime-17.5)<.4);})).toBe(true);
  await waveform.press('Home');await waveform.press('ArrowRight');
  await expect.poll(()=>zoomPage.evaluate(()=>{const audio=mixers.get('course-song').audios;return audio.every(track=>track.currentTime>0&&track.currentTime<.1&&Math.abs(track.currentTime-audio[0].currentTime)<.01);})).toBe(true);
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

async function addSecondCourse(page) {
  const other = 'fixture-course-b';
  await page.route('**/api/classroom/courses', async route => {
    const response = await route.fetch(), body = await response.json();
    body.courses.push({ ...body.courses[0], classId: other, className: 'Course B', section: '02', owner: true });
    await route.fulfill({ response, json: body });
  });
  return other;
}

test('account rechecks conceal and disable private views through delay, outage and retry', async ({ page, context }) => {
  const f = await setup(page);
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-course-role': 'owner' });
    await page.goto(new URL('/teacher.html', f.url).href);
    await expect(page.locator('#amendment')).toBeEnabled(); await page.locator('#amendment').fill('Same-account private draft');
    let mode = 'delay', release;
    await page.route('**/api/account', async route => {
      if (mode === 'delay') { await new Promise(resolve => { release = resolve; }); await route.fulfill({ status: 503, json: { error: 'Unavailable' } }); }
      else if (mode === 'offline') await route.abort('failed');
      else await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('main')).toBeHidden(); expect(await page.locator('main').evaluate(node => node.inert)).toBe(true);
    await expect(page.locator('#session-check')).toContainText('Checking your account');
    await expect.poll(() => Boolean(release)).toBe(true); release();
    await expect(page.locator('#session-check')).toContainText('Could not verify your account');
    await expect(page.locator('main')).toBeHidden();
    await page.screenshot({ path: `${screenshots}/classroom-account-unavailable-${process.env.STEM_BROWSER || 'chrome'}.png` });
    mode = 'offline'; await page.locator('#session-check button').click();
    await expect(page.locator('#session-check button')).toBeVisible(); await expect(page.locator('main')).toBeHidden();
    mode = 'normal'; await page.locator('#session-check button').click();
    await expect(page.locator('main')).toBeVisible(); expect(await page.locator('main').evaluate(node => node.inert)).toBe(false);
    await expect(page.locator('#amendment')).toHaveValue('Same-account private draft');
    await page.unroute('**/api/account');
    await page.goto(new URL('/?job=course-song', f.url).href);
    await page.locator('.note-btn').click(); await page.getByRole('textbox', { name: 'Note text', exact: true }).fill('Same-account note draft');
    await page.locator('.play-btn').click(); await expect.poll(() => page.evaluate(() => mixers.get('course-song').playing)).toBe(true);
    await page.route('**/api/account', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('main')).toBeHidden(); await expect(page.locator('#session-check button')).toBeVisible();
    expect(await page.evaluate(() => mixers.get('course-song').audios.every(audio => audio.paused))).toBe(true);
    await page.unroute('**/api/account'); await page.locator('#session-check button').click();
    await expect(page.locator('main')).toBeVisible(); await expect(page.getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('Same-account note draft');
    expect(await page.evaluate(() => mixers.get('course-song').playing)).toBe(false);
  } finally { await f.server.close(); }
});

test('prompt loads, writes, preview and history remain bound to the selected course generation', async ({ page, context }) => {
  const f = await setup(page);
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-course-role': 'owner' });
    const other = await addSecondCourse(page), holds = new Set(), releases = new Map(), writes = [];
    let failB = true;
    const record = id => ({ amendment: id === course ? 'A saved instructions' : 'B saved instructions', revision: 1, basePrompt: `Base for ${id}`, history: [], historyHasMore: true, historyNextBeforeId: 50 });
    await page.route('**/api/classroom/courses/*/**', async route => {
      const path = new URL(route.request().url()).pathname, id = path.split('/')[4], method = route.request().method();
      const kind = path.endsWith('/preview') ? 'preview' : path.endsWith('/history') ? 'history' : method === 'PUT' ? 'save' : 'load';
      const key = `${id}:${kind}`;
      if (method === 'PUT') writes.push({ id, body: route.request().postDataJSON() });
      if (holds.has(key)) await new Promise(resolve => releases.set(key, resolve));
      if (id === other && kind === 'load' && failB) { await route.fulfill({ status: 503, json: { error: 'Course B unavailable' } }); return; }
      const body = kind === 'save' ? { changed: true } : kind === 'preview' ? { prompt: `Private preview ${id}` } : kind === 'history' ? { history: [{ settingsRevision: 0, changeNote: `Old history ${id}`, createdAt: '2026-10-06T12:00:00Z', updatedBy: 'Instructor', amendment: `Old ${id}`, basePromptVersion: 'v1' }] } : record(id);
      await route.fulfill({ json: body });
    });
    const waitHeld = key => expect.poll(() => releases.has(key)).toBe(true);
    const release = key => { holds.delete(key); releases.get(key)(); releases.delete(key); };
    await page.goto(new URL('/teacher.html', f.url).href); await expect(page.locator('#amendment')).toHaveValue('A saved instructions');
    await page.locator('#teacher-course').selectOption(other);
    await expect(page.locator('#prompt-status')).toContainText('Course B unavailable'); await expect(page.locator('#amendment')).toHaveValue('');
    await expect(page.locator('#amendment')).toBeDisabled(); await expect(page.locator('#prompt-form button[type=submit]')).toBeDisabled();
    await page.locator('#prompt-form').dispatchEvent('submit'); expect(writes).toEqual([]);
    failB = false; await page.locator('#prompt-reload').click(); await expect(page.locator('#amendment')).toHaveValue('B saved instructions');
    holds.add(`${course}:load`); await page.locator('#teacher-course').selectOption(course); await waitHeld(`${course}:load`);
    await expect(page.locator('#amendment')).toHaveValue(''); await expect(page.locator('#preview-btn')).toBeDisabled();
    await page.locator('#teacher-course').selectOption(other); await expect(page.locator('#amendment')).toHaveValue('B saved instructions');
    release(`${course}:load`); await page.waitForLoadState('networkidle'); await expect(page.locator('#amendment')).toHaveValue('B saved instructions');
    holds.add(`${other}:preview`); await page.locator('#preview-btn').click(); await waitHeld(`${other}:preview`);
    holds.add(`${other}:history`); await page.getByText('History', { exact: true }).click(); await page.locator('#prompt-history-more').click(); await waitHeld(`${other}:history`);
    await page.locator('#teacher-course').selectOption(course); await expect(page.locator('#amendment')).toHaveValue('A saved instructions');
    release(`${other}:preview`); release(`${other}:history`); await page.waitForLoadState('networkidle');
    await expect(page.locator('#preview-wrap')).toBeHidden(); await expect(page.locator('#prompt-history')).not.toContainText(other);
    await page.locator('#amendment').fill('A new instructions'); await page.locator('#change-note').fill('A update');
    holds.add(`${course}:save`); await page.locator('#prompt-form button[type=submit]').click(); await waitHeld(`${course}:save`);
    page.once('dialog', dialog => dialog.accept()); await page.locator('#teacher-course').selectOption(other);
    await expect(page.locator('#amendment')).toHaveValue('B saved instructions'); release(`${course}:save`); await page.waitForLoadState('networkidle');
    await expect(page.locator('#teacher-course')).toHaveValue(other); await expect(page.locator('#amendment')).toHaveValue('B saved instructions');
    expect(writes).toEqual([{ id: course, body: { amendment: 'A new instructions', changeNote: 'A update', expectedRevision: 1 } }]);
  } finally { await f.server.close(); }
});

test('rapid course changes clear stale classroom content and keep later folder writes in the visible course', async ({ page, context }) => {
  const f = await setup(page);
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-course-role': 'owner' });
    const other = await addSecondCourse(page), releases = [], writes = [], detailReads = [];
    let delayB = true, failB = false, releaseWrite;
    await page.route('**/api/classroom/courses/*/**', async route => {
      const path = new URL(route.request().url()).pathname, id = path.split('/')[4], method = route.request().method(), label = id === course ? 'A' : 'B';
      if (method === 'POST') {
        writes.push({ id, name: route.request().postDataJSON().name });
        await new Promise(resolve => { releaseWrite = resolve; });
        await route.fulfill({ json: { folder: { id: 'created-A' } } }); return;
      }
      if (/\/folders\//.test(path)) { detailReads.push(path); await route.fulfill({ json: { folder: { id: 'created-A', name: 'Created', permission: 'private' }, items: [] } }); return; }
      if (id === other && delayB) await new Promise(resolve => releases.push(resolve));
      if (id === other && failB) { await route.fulfill({ status: 503, json: { error: 'Course B unavailable' } }); return; }
      await route.fulfill({ json: path.endsWith('/roster') ? { participants: [{ memberId: `member-${label}`, displayName: `${label} student`, splitCount: 0, retainedCount: 0 }], nextCursor: null } : { folders: [{ id: `folder-${label}`, name: `${label} folder`, permission: 'private' }] } });
    });
    await page.goto(new URL('/classroom.html', f.url).href); await expect(page.locator('#roster-list')).toContainText('A student');
    await page.locator('#classroom-course').selectOption(other); await expect.poll(() => releases.length).toBe(2);
    await expect(page.locator('#roster-list')).toBeEmpty(); await expect(page.locator('#course-folders')).toBeEmpty(); await expect(page.locator('#folder-create')).toBeHidden();
    await page.locator('#classroom-course').selectOption(course); await expect(page.locator('#classroom-status')).toHaveText('Course access checked.');
    delayB = false; releases.splice(0).forEach(release => release()); await page.waitForLoadState('networkidle');
    await expect(page.locator('#classroom-course')).toHaveValue(course); await expect(page.locator('#roster-list')).toContainText('A student');
    await expect(page.locator('#roster-list')).not.toContainText('B student'); await expect(page.locator('#course-folders')).toContainText('A folder');
    await expect(page.locator('#classroom-prompt')).toHaveAttribute('href', `/teacher.html?course=${course}`);
    await page.locator('#folder-name').fill('A new folder'); await page.getByRole('button', { name: 'Create private folder' }).click(); await expect.poll(() => Boolean(releaseWrite)).toBe(true);
    await page.locator('#classroom-course').selectOption(other); await expect(page.locator('#roster-list')).toContainText('B student');
    await page.locator('#folder-name').fill('B draft'); releaseWrite(); await page.waitForLoadState('networkidle');
    await expect(page.locator('#folder-name')).toHaveValue('B draft'); await expect(page.locator('#folder-detail')).toBeHidden();
    expect(writes).toEqual([{ id: course, name: 'A new folder' }]); expect(detailReads).toEqual([]);
    await page.locator('#classroom-course').selectOption(course); await expect(page.locator('#roster-list')).toContainText('A student');
    failB = true; await page.locator('#classroom-course').selectOption(other);
    await expect(page.locator('#classroom-status')).toContainText('Course B unavailable'); await expect(page.locator('#roster-list')).toBeEmpty();
    await expect(page.locator('#course-folders')).toBeEmpty(); await expect(page.locator('#classroom-prompt')).toBeHidden(); await expect(page.locator('#folder-create')).toBeHidden();
  } finally { await f.server.close(); }
});
