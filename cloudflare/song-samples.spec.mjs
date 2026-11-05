import {test,expect} from '@playwright/test';
import {createTestHarness} from 'wrangler';
import {createTestIdentityIssuer,TEST_SUBJECTS} from '@cuny-ai-lab/cail-identity/testing';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setupServer} from 'msw/node';
import {http,HttpResponse} from 'msw';
import {schemaStatements} from '../tests/e2e/schema-statements.mjs';
async function fixture(vars={}){
 const issuer=await createTestIdentityIssuer();const harness=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol,TEST_BROWSER:'true',...vars}}]});
 const {url}=await harness.listen();await harness.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')))});
 return {harness,url,admin:await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.carol}),student:await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice})};
}
test('instructor searches Archive incrementally, selects songs, drags and saves ordered cards with role protection',async({page,context})=>{
 const f=await fixture(),audio=await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));let releaseSlow,slowStarted=false;
 const slow=new Promise(resolve=>{releaseSlow=resolve;});
 const network=setupServer(
  http.get('https://archive.org/advancedsearch.php',()=>HttpResponse.json({response:{docs:[{identifier:'editor-fast',title:'Fixture piano',creator:'Fixture ensemble'},{identifier:'editor-slow',title:'Fixture piano alternate',creator:'Fixture ensemble'}]}})),
  http.get('https://archive.org/metadata/:id',async({params})=>{if(params.id==='editor-slow'){slowStarted=true;await slow;}return HttpResponse.json({metadata:{title:'Fixture piano',creator:'Fixture ensemble',mediatype:'audio',subject:'Music'},files:[{name:'piano.mp3',title:'Fixture piano',artist:'Fixture ensemble',length:'2',size:String(audio.length)}]});}),
  http.get('https://archive.org/download/:id/:file',()=>new HttpResponse(audio,{headers:{'content-type':'audio/mpeg','content-length':String(audio.length)}})),
 );
 network.listen({onUnhandledRequest(request,print){if(new URL(request.url).origin===f.url.origin)return;print.error();}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.admin});await page.goto(new URL('/teacher.html',f.url).href);await page.locator('#sample-editor-summary').click();
  await expect(page.locator('#sample-selected .sample-card')).toHaveCount(6);
  await expect(page.locator('#sample-selected')).toContainText('Bill Evans');await expect(page.locator('#sample-selected')).not.toContainText(/\b(jazz|electronic|country|funk|rock|folk) ·/);
  await expect(page.locator('#sample-selected')).toContainText('complete import tested');
  const selected=page.locator('#sample-search-results [aria-selected="true"]').first();
  await expect(selected).toBeDisabled();await expect(selected.locator('.sample-choice-state')).toHaveText('Selected');
  expect(await selected.evaluate(node=>getComputedStyle(node).opacity)).toBe('1');
  await documentScreenshots(page);
  await page.locator("#samples-hold").focus();await page.locator("#samples-hold").press("ArrowUp");await expect(page.locator("#samples-hold")).toHaveValue("4");
  await page.locator("#samples-hold").press("ArrowDown");await expect(page.locator("#samples-hold")).toHaveValue("3.5");
  await page.locator('#samples-enabled').uncheck();await page.locator('#samples-reshuffle').uncheck();
  await page.locator('#sample-search').fill('https://archive.org/details/example');await expect(page.locator('#sample-search-status')).toHaveText('Search by artist or song title.');
  await page.locator('#sample-search').fill('Fixture piano');
  const option=page.getByRole('option',{name:/^Fixture ensemble — Fixture piano(?: ·|$)/});await expect(option).toBeVisible({timeout:4000});expect(slowStarted).toBe(true);
  await option.focus();await option.press('Enter');await expect(page.locator('#sample-selected .sample-card')).toHaveCount(7);
  await expect(option).toBeDisabled();await expect(option).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#sample-search')).toBeFocused();
  await page.getByRole('button',{name:'Remove: Fixture piano',exact:true}).click();
  await expect(page.locator('#sample-selected .sample-card')).toHaveCount(6);await expect(option).toBeEnabled();
  await option.click();await expect(page.locator('#sample-selected .sample-card')).toHaveCount(7);
  const cards=page.locator('#sample-selected .sample-card');
  await cards.nth(1).locator('.sample-drag-handle').dragTo(cards.first().locator('.sample-drag-handle'));
  await expect(cards.first()).toContainText('Yellow Magic Orchestra');
  for(let i=0;i<6;i++)await page.getByRole('button',{name:'Move up: Fixture piano',exact:true}).click();
  await expect(cards.first()).toContainText('Fixture piano');
  await page.getByRole('button',{name:'Move down: Fixture piano',exact:true}).click();await expect(cards.nth(1)).toContainText('Fixture piano');
  await cards.nth(1).focus();await cards.nth(1).press('ArrowUp');await expect(cards.first()).toContainText('Fixture piano');
  await expect(page.locator('.sample-card select')).toHaveCount(0);
  await expect(page.locator('#sample-selected')).not.toContainText(/\b(jazz|electronic|country|funk|rock|folk)\b ·/);
  await page.locator('#samples-hold').fill('4');await page.locator('#samples-cadence').fill('7');
  await page.getByRole('button',{name:'Save songs',exact:true}).click();await expect(page.locator('#sample-settings-status')).toContainText('Saved.',{timeout:5000});
  releaseSlow();
  const saved=await(await f.harness.fetch('/api/teacher/song-samples',{headers:{'x-fixture-identity':f.admin}})).json(),snapshot=saved.settings;
  expect(saved.revision).toBe(1);expect(snapshot.tracks[0].title).toBe('Fixture piano');expect(snapshot.holdMs).toBe(4000);expect(snapshot.cadenceMs).toBe(7000);expect(snapshot.enabled).toBe(false);expect(snapshot.reshuffle).toBe(false);
  expect((await(await f.harness.fetch('/api/song-samples')).json()).updatedBy).toBeUndefined();
  await page.reload();await page.locator('#sample-editor-summary').click();await expect(cards.first()).toContainText('Fixture piano');await expect(page.locator('#samples-hold')).toHaveValue('4');await expect(page.locator('#samples-cadence')).toHaveValue('7');await expect(page.locator('#samples-enabled')).not.toBeChecked();await expect(page.locator('#samples-reshuffle')).not.toBeChecked();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await page.locator('#sample-editor-title').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.STEM_SCREENSHOT_DIR+'/instructor-song-editor-mobile.png',animations:'disabled'});}
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.student});await page.reload();await expect(page.locator('#console-panel')).toBeHidden();
  expect(errors).toEqual([]);
 }finally{releaseSlow();network.close();await f.harness.close();}
});

async function documentScreenshots(page){
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);
  for(const id of ['samples-hold','samples-cadence','sample-search'])expect((await page.locator('#'+id).boundingBox()).height).toBeGreaterThanOrEqual(44);
  const layout=await page.locator('.sample-timing').evaluate(node=>{const fields=[...node.querySelectorAll('input')].map(input=>input.getBoundingClientRect());return {sameRow:Math.abs(fields[0].top-fields[1].top)<1,stacked:fields[1].top>=fields[0].bottom};});
  expect(width>600?layout.sameRow:layout.stacked).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await page.locator('.sample-editor').evaluate(node=>node.scrollIntoView({block:'start'}));await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/song-settings-${width}.png`,animations:'disabled'});}
 }
 await page.setViewportSize({width:1280,height:900});
}

test('instructor edits imported names, cancels drafts and preserves the exact Archive file after saving',async({page,context})=>{
 const f=await fixture(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const artist='Éléonore & friends',title='A quiet room — 夜の歌';
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.admin});
  const before=await(await f.harness.fetch('/api/teacher/song-samples',{headers:{'x-fixture-identity':f.admin}})).json();
  const original=before.settings.tracks[0];
  await page.goto(new URL('/teacher.html',f.url).href);await page.locator('#sample-editor-summary').click();
  const card=page.locator('#sample-selected .sample-card').first();
  await card.getByRole('button',{name:`Edit names: ${original.title}`,exact:true}).click();
  await card.getByLabel('Artist',{exact:true}).fill('Unfinished draft');
  await card.getByLabel('Title',{exact:true}).fill('Discard this title');
  await card.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(card).toContainText(original.artist);await expect(card).toContainText(original.title);
  await expect(card).not.toContainText('Discard this title');
  await card.getByRole('button',{name:`Edit names: ${original.title}`,exact:true}).click();
  await card.getByLabel('Artist',{exact:true}).fill(artist);
  await card.getByLabel('Title',{exact:true}).fill(title);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const label of ['Artist','Title'])expect((await card.getByLabel(label,{exact:true}).boundingBox()).height).toBeGreaterThanOrEqual(44);
  if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await card.screenshot({path:process.env.STEM_SCREENSHOT_DIR+'/editable-song-names-mobile.png',animations:'disabled'});}
  await card.getByRole('button',{name:'Done',exact:true}).click();
  await expect(card).toContainText(`${artist} — ${title}`);
  await page.getByRole('button',{name:'Save songs',exact:true}).click();
  await expect(page.locator('#sample-settings-status')).toContainText('Saved.',{timeout:5000});
  const saved=await(await f.harness.fetch('/api/teacher/song-samples',{headers:{'x-fixture-identity':f.admin}})).json();
  expect(saved.settings.tracks[0]).toMatchObject({artist,title,archiveId:original.archiveId,archiveFile:original.archiveFile,durationSec:original.durationSec});
  expect(saved.catalog.find(track=>track.archiveId===original.archiveId&&track.archiveFile===original.archiveFile)).toMatchObject({artist,title});
  const publicSongs=await(await f.harness.fetch('/api/song-samples')).json();
  expect(publicSongs.tracks[0]).toMatchObject({artist,title,archiveId:original.archiveId,archiveFile:original.archiveFile});
  await page.reload();await page.locator('#sample-editor-summary').click();await expect(card).toContainText(`${artist} — ${title}`);
  await card.getByRole('button',{name:`Edit names: ${title}`,exact:true}).click();
  await expect(card.getByLabel('Artist',{exact:true})).toHaveValue(artist);
  await expect(card.getByLabel('Title',{exact:true})).toHaveValue(title);
  await card.getByRole('button',{name:'Cancel',exact:true}).click();
  // Return raw provider names to prove the saved instructor labels reach import.
  // The job creation response is replaced locally, so this never starts inference.
  await page.route('**/api/song-samples',route=>route.fulfill({json:{...publicSongs,tracks:[publicSongs.tracks[0]]}}));
  await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:[{...original,id:'renamed-suggestion',bytes:100000,sourceUrl:'https://archive.org/details/'+original.archiveId}]}}));
  await page.route('**/api/jobs',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{error:'Local import assertion complete.'}}):route.continue());
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(f.url.href);
  await page.getByLabel('Share with').selectOption('personal');
  await expect(page.locator('#yt-url')).toHaveAttribute('placeholder',`${artist} ${title}`);
  await page.locator('#yt-form .yt-go').click();
  const choice=page.locator('#source-songs [role="option"]');
  await expect(choice).toContainText(title);await expect(choice).toContainText(artist);await choice.click();
  const importRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/jobs'&&request.method()==='POST');
  await page.locator('#yt-form .yt-go').click();
  expect((await importRequest).postDataJSON()).toMatchObject({archiveId:original.archiveId,archiveFile:original.archiveFile,archiveSearch:true,displayTitle:`${artist} — ${title}`});
  expect(errors).toEqual([]);
 }finally{await f.harness.close();}
});

test('renamed suggestions refresh cached search labels for the same Archive file',async({page,context})=>{
 const f=await fixture(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const original={artist:'Artist É',title:'Nocturne',archiveId:'same-source',archiveFile:'song.mp3'};
 let snapshot={revision:1,version:'1-original',enabled:true,holdMs:3500,cadenceMs:6000,reshuffle:true,tracks:[original]};
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.admin});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/song-samples',route=>route.fulfill({json:snapshot}));
  await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:[{...original,id:'same-source/song.mp3',durationSec:30,bytes:100000,sourceUrl:'https://archive.org/details/same-source'}]}}));
  await page.route('**/api/jobs',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{error:'Local import assertion complete.'}}):route.continue());
  await page.goto(f.url.href);
  await page.getByLabel('Share with').selectOption('personal');
  const input=page.locator('#yt-url'),choices=page.locator('#source-songs'),choice=choices.getByRole('option');
  await expect(input).toHaveAttribute('placeholder','Artist É Nocturne');
  await page.locator('#yt-form .yt-go').click();
  await expect(choice).toContainText('Nocturne');await expect(choices).not.toHaveAttribute('aria-busy','true');
  await input.fill('');
  await expect(input).toHaveAttribute('placeholder','Artist É Nocturne');
  const renamed={...original,artist:'ARTIST É',title:'NOCTURNE'};
  snapshot={...snapshot,revision:2,version:'2-renamed',tracks:[renamed]};
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(input).toHaveAttribute('placeholder','ARTIST É NOCTURNE');
  await page.locator('#yt-form .yt-go').click();
  await expect(choice).toContainText('NOCTURNE');await expect(choice).toContainText('ARTIST É');
  await choice.click();await expect(input).toHaveValue('NOCTURNE — File artist: ARTIST É');
  const importRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/jobs'&&request.method()==='POST');
  await page.locator('#yt-form .yt-go').click();
  expect((await importRequest).postDataJSON()).toMatchObject({archiveId:original.archiveId,archiveFile:original.archiveFile,displayTitle:'ARTIST É — NOCTURNE'});
  expect(errors).toEqual([]);
 }finally{await f.harness.close();}
});

for(const cadenceMs of [5000,6000])test(`configured hints reveal slowly at ${cadenceMs}ms cadence, preserve progress and refresh instructor changes`,async({page})=>{
 test.setTimeout(65000);const f=await fixture();let snapshot={revision:1,version:'1-first',enabled:true,holdMs:3500,cadenceMs,reshuffle:true,tracks:[0,1,2].map(i=>({artist:`Artist ${i}`,title:`Song ${i}`,archiveId:`steady-${i}`,archiveFile:'song.mp3'}))};
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.addInitScript(()=>{Math.random=()=>0;});
  await page.route('**/api/song-samples',route=>route.fulfill({json:snapshot}));
  await page.route('**/api/music/search?*',async route=>{const id=new URL(route.request().url()).searchParams.get('sampleItem');if(id==='steady-0')await new Promise(resolve=>setTimeout(resolve,200));const t=snapshot.tracks.find(t=>t.archiveId===id);return route.fulfill({json:{results:t?[{...t,id:t.archiveId,title:t.title,artist:t.artist,durationSec:30,bytes:100000,sourceUrl:'https://archive.org/details/'+id}]:[]}});});
  await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{window.songCadenceEvents=[];const input=document.querySelector('#yt-url');let last='';new MutationObserver(()=>{const value=input.placeholder,full=/^Artist \d Song \d$/.test(value);if(input.classList.contains('showing-sample')&&value!==last){window.songCadenceEvents.push({value,full,time:performance.now()});last=value;}}).observe(input,{attributes:true,attributeFilter:['placeholder']});}));
  await page.goto(f.url.href);
  const input=page.locator('#yt-url');
  for(const i of [0,1,2])await expect(input).toHaveAttribute('placeholder',`Artist ${i} Song ${i}`,{timeout:6500});
  const events=await page.evaluate(()=>window.songCadenceEvents),full=events.filter(e=>e.full);
  expect(full.map(e=>e.value)).toEqual(['Artist 0 Song 0','Artist 1 Song 1','Artist 2 Song 2']);
  const revealMs=Math.min(2000,cadenceMs-snapshot.holdMs);
  for(const e of full){const start=events.filter(x=>x.value==='A'&&x.time<=e.time).at(-1);expect(e.time-start.time).toBeGreaterThanOrEqual(revealMs-100);expect(e.time-start.time).toBeLessThan(revealMs+500);}
  for(let i=1;i<full.length;i++){expect(full[i].time-full[i-1].time).toBeGreaterThan(cadenceMs-400);expect(full[i].time-full[i-1].time).toBeLessThan(cadenceMs+600);}
  for(const e of full.slice(0,-1)){const left=events.find(x=>x.time>e.time&&x.value!==e.value);expect(left.time-e.time).toBeGreaterThanOrEqual(3500);}
  await page.reload();await expect(input).toHaveAttribute('placeholder','Artist 1 Song 1',{timeout:3500});
  snapshot={...snapshot,revision:2,version:'2-disabled',enabled:false,tracks:[]};
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.locator('#source-sample-hint')).toBeHidden({timeout:1500});await expect(input).toHaveAttribute('placeholder','Search songs');
  expect(errors).toEqual([]);
 }finally{await f.harness.close();}
});

test('mobile streams inside the search field with no hint or extra box',async({page})=>{
 const f=await fixture();
 const track={artist:'A particularly long ensemble name',title:'An extended live recording with a very long song title',archiveId:'mobile-example',archiveFile:'song.mp3'};
 const query=`${track.artist} ${track.title}`;
 let releaseSamples;const samplesReady=new Promise(resolve=>{releaseSamples=resolve;});
 try{
  await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
   window.mobileSampleGeometry=[];
   const input=document.querySelector('#yt-url');
   new MutationObserver(()=>{if(input.classList.contains('showing-sample'))window.mobileSampleGeometry.push({height:input.getBoundingClientRect().height,fetchOffset:document.querySelector('.yt-go').getBoundingClientRect().top-input.getBoundingClientRect().top});}).observe(input,{attributes:true,attributeFilter:['placeholder']});
  }));
  await page.route('**/api/song-samples',async route=>{await samplesReady;return route.fulfill({json:{revision:1,version:'mobile',enabled:true,holdMs:3500,cadenceMs:5000,reshuffle:true,tracks:[track]}});});
  await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:[{...track,id:track.archiveId,durationSec:30,bytes:100000,sourceUrl:'https://archive.org/details/'+track.archiveId}]}}));
  await page.setViewportSize({width:375,height:812});await page.goto(f.url.href);
  await page.evaluate(()=>document.fonts.ready);releaseSamples();
  const input=page.locator('#yt-url'),hint=page.locator('#source-sample-hint');
  await expect(input).toHaveAttribute('placeholder',query);await expect(hint).toBeHidden();
  const streamingGeometry=await page.evaluate(()=>window.mobileSampleGeometry);
  expect(streamingGeometry.length).toBeGreaterThan(1);
  expect(streamingGeometry).toEqual(streamingGeometry.map(()=>streamingGeometry[0]));
  for(const width of [320,375,560]){
   await page.setViewportSize({width,height:812});await expect(input).toHaveAttribute('placeholder',query);await expect(hint).toBeHidden();
   expect(await page.evaluate(()=>{
    const input=document.querySelector('#yt-url'),field=input.getBoundingClientRect(),button=document.querySelector('.yt-go').getBoundingClientRect(),style=getComputedStyle(input);
    return {overflow:document.documentElement.scrollWidth>innerWidth,sameRow:Math.abs(field.top-button.top)<1,paddingBalanced:style.paddingRight===style.paddingLeft,extraBox:!!document.querySelector('.source-sample-title')};
   })).toEqual({overflow:false,sameRow:true,paddingBalanced:true,extraBox:false});
  }
  await page.setViewportSize({width:900,height:812});await expect(hint).toBeVisible();await expect(input).toHaveAttribute('placeholder',query);
  await page.setViewportSize({width:375,height:812});await expect(hint).toBeHidden();
  if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await page.locator('#yt-disclosure').screenshot({path:process.env.STEM_SCREENSHOT_DIR+'/song-suggestion-mobile.png'});}
  await page.locator('#yt-form .yt-go').click();await expect(input).toHaveValue(query);await expect(page.locator('#source-songs [role="option"]')).toBeVisible();
  await input.fill('jazz');await expect(input).toHaveValue('jazz');
 }finally{releaseSamples();await f.harness.close();}
});

test('unified search keeps one audio import flow and no separate metadata controls through retries',async({page,context})=>{
 const f=await fixture();const errors=[];page.on('pageerror',e=>errors.push(e.message));let request;const searches=[];
 const mbid='12345678-1234-1234-1234-123456789012';
 const commons={id:'commons:123:original',title:'Synthetic music',artist:'Fixture creator',durationSec:10,sourceUrl:'https://commons.wikimedia.org/wiki/File:Fixture.mp3',providerName:'Wikimedia Commons',licenseName:'CC BY 4.0',openAudio:{provider:'commons',itemId:'123',fileId:'original'}};
 const archive={id:'fixture/song.mp3',title:'Synthetic music live',artist:'Fixture creator',durationSec:10,sourceUrl:'https://archive.org/details/fixture',providerName:'Internet Archive',archiveId:'fixture',archiveFile:'song.mp3'};
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.student});
  await page.route('**/api/song-samples',route=>route.fulfill({json:{enabled:false,revision:0,tracks:[]}}));
  await page.route('**/api/music/search?*',route=>{const url=new URL(route.request().url());searches.push(url);return route.fulfill({json:url.searchParams.get('q')==='Different music'
    ?{results:[commons],references:[],providers:{archive:'unavailable',commons:'ready',musicbrainz:'unavailable'}}
    :{results:[archive,commons],references:[{id:mbid,title:'Synthetic music',artist:'Fixture creator',disambiguation:'studio recording',kind:'metadata',sourceUrl:'https://musicbrainz.org/recording/'+mbid}],providers:{archive:'ready',commons:'ready',musicbrainz:'ready'}}});});
  await page.route('**/api/music/recordings/*',route=>route.fulfill({json:{relations:[{label:'free download · archive.org',url:'https://archive.org/details/fixture'}]}}));
  await page.route('**/api/jobs',async route=>{if(route.request().method()!=='POST')return route.continue();request=route.request().postDataJSON();return route.fulfill({status:503,json:{error:'Synthetic import stopped before processing.'}});});
  await page.goto(f.url.href);await page.getByLabel('Share with').selectOption('personal');
  await expect(page.getByLabel('Audio source',{exact:true})).toHaveCount(0);
  const beforeSearch=await page.locator('#stem-choice').boundingBox();
  await page.locator('#yt-url').fill('Synthetic music');await expect(page.locator('#source-songs')).toContainText('CC BY 4.0');
  await expect(page.locator('#source-songs')).toContainText('Internet Archive');
  await expect(page.locator('#source-songs [role="option"]')).toHaveCount(2);
  expect(await page.locator('#stem-choice').boundingBox()).toEqual(beforeSearch);
  await expect(page.locator('#recording-references')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Related pages',exact:true})).toHaveCount(0);
  await page.locator('#source-songs [role="option"]').nth(1).click();
  expect(request).toBeUndefined();
  await page.locator('#yt-form').evaluate(form=>form.requestSubmit());
  await expect.poll(()=>request?.openAudio?.provider).toBe('commons');expect(request.openAudio).toEqual(commons.openAudio);expect(request.archiveId).toBeUndefined();
  await expect(page.locator('#yt-url')).toBeEnabled();request=undefined;
  await page.locator('#yt-url').fill('Different music');await expect(page.locator('#source-songs [role="option"]')).toHaveCount(1);
  await expect(page.locator('#source-songs')).toContainText('temporarily unavailable');
  await expect(page.locator('#recording-references')).toHaveCount(0);
  await page.locator('#yt-url').press('Escape');await expect(page.locator('#source-songs')).toBeHidden();expect(request).toBeUndefined();
  await page.locator('#yt-url').fill('Synthetic music');await expect(page.locator('#source-songs [role="option"]')).toHaveCount(2);
  await page.locator('#source-songs [role="option"]').first().click();await page.locator('#yt-form').evaluate(form=>form.requestSubmit());
  await expect.poll(()=>request?.archiveId).toBe('fixture');expect(request.archiveFile).toBe('song.mp3');expect(request.openAudio).toBeUndefined();
  expect(searches.every(url=>!url.searchParams.has('provider'))).toBe(true);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.STEM_SCREENSHOT_DIR)await page.screenshot({path:process.env.STEM_SCREENSHOT_DIR+'/unified-music-mobile.png',fullPage:true,animations:'disabled'});
  expect(errors).toEqual([]);
 }finally{await f.harness.close();}
});

test('manually searching a preloaded hint stays unified and accepting the hint keeps its exact file',async({page,context})=>{
 const f=await fixture({TEST_NO_COURSES:'true'}),requests=[];
 const track={artist:'Fixture ensemble',title:'Verified suggestion',archiveId:'hint-exact',archiveFile:'exact.mp3'},query=`${track.artist} ${track.title}`;
 const exact={...track,id:'hint-exact/exact.mp3',durationSec:30,sourceUrl:'https://archive.org/details/hint-exact'};
 const commons={id:'commons:123:original',title:'Related rendition',artist:'Fixture creator',durationSec:30,providerName:'Wikimedia Commons',openAudio:{provider:'commons',itemId:'123',fileId:'original'}};
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.student});await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/song-samples',route=>route.fulfill({json:{enabled:true,revision:1,tracks:[track]}}));
  await page.route('**/api/music/search?*',route=>{const url=new URL(route.request().url());requests.push(url);return route.fulfill({json:{results:url.searchParams.has('sampleItem')?[exact]:[exact,commons]}});});
  await page.goto(f.url.href);const input=page.locator('#yt-url'),options=page.locator('#source-songs [role="option"]');
  await expect(input).toHaveAttribute('placeholder',query);
  await input.fill(query);await expect(options).toHaveCount(2);await expect(page.locator('#source-songs')).toContainText('Wikimedia Commons');
  expect(requests.filter(url=>!url.searchParams.has('sampleItem'))).toHaveLength(1);
  await input.fill('');await expect(input).toHaveAttribute('placeholder',query);await input.press('Tab');
  await expect(input).toHaveValue(query);await expect(options).toHaveCount(1);
  await expect(options).toContainText('Verified suggestion');
  await input.fill('changed');await input.fill(query);await expect(options).toHaveCount(2);
  expect(requests.filter(url=>!url.searchParams.has('sampleItem'))).toHaveLength(1);
 }finally{await f.harness.close();}
});

for (const submitAction of ['Enter','Fetch']) test(`Tab accepts the verified sample and ${submitAction} starts one split with immediate pending feedback`,async({page,context})=>{
 const f=await fixture({TEST_NO_COURSES:'true'}),errors=[],requests=[],keys=[];page.on('pageerror',error=>errors.push(error.message));
 const track={artist:'Fixture ensemble',title:'Verified suggestion',archiveId:'verified-suggestion',archiveFile:'exact-recording.mp3'};
 const query=`${track.artist} ${track.title}`;
 let release;const pending=new Promise(resolve=>{release=resolve;});
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.student});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/song-samples',route=>route.fulfill({json:{enabled:true,revision:1,tracks:[track]}}));
  await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:[{...track,id:'verified-suggestion/exact-recording.mp3',durationSec:30,bytes:100000,sourceUrl:'https://archive.org/details/verified-suggestion'}]}}));
  await page.route('**/api/jobs',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   requests.push(route.request().postDataJSON());keys.push(route.request().headers()['idempotency-key']);await pending;
   return route.fulfill({status:503,json:{error:'Fixture import unavailable. Try again.'}});
  });
  await page.goto(f.url.href);
  await expect(page.getByLabel('Share with')).toBeHidden();
  const input=page.locator('#yt-url'),button=page.locator('#yt-form .yt-go'),form=page.locator('#yt-form');
  await expect(input).toHaveAttribute('placeholder',query);await input.focus();await input.press('Tab');
  await expect(input).toHaveValue(query);await expect(input).toBeFocused();
  await page.route('**/api/music/search?*',route=>route.abort());
  // The accepted recording is sufficient even while a later search is unavailable.
  if(submitAction==='Enter')await input.press('Enter');else await button.click();
  await expect(button).toHaveText('FETCHING…',{timeout:1500});
  await expect(button).toBeDisabled();await expect(input).toBeDisabled();await expect(form).toHaveAttribute('aria-busy','true');
  await expect(page.locator('#upload-message')).toContainText('IMPORTING AUDIO');
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0]).toMatchObject({archiveId:track.archiveId,archiveFile:track.archiveFile,archiveSearch:true,displayTitle:`${track.artist} — ${track.title}`});
  // Exercise both real input paths and repeated submit events while acceptance waits.
  await page.keyboard.press('Enter');await button.evaluate(node=>node.click());
  await form.evaluate(node=>{node.requestSubmit();node.requestSubmit();});
  await page.waitForTimeout(200);expect(requests).toHaveLength(1);
  if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await page.locator('#yt-disclosure').screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/sample-${submitAction.toLowerCase()}-pending.png`});}
  release();await expect(page.locator('#upload-message')).toHaveText('Fixture import unavailable. Try again.');
  await expect(input).toBeEnabled();await expect(button).toBeEnabled();await expect(button).toHaveText('FETCH');await expect(form).not.toHaveAttribute('aria-busy','true');
  // A subsequent deliberate retry remains available after an unsuccessful response.
  await button.click();await expect.poll(()=>requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);expect(keys[1]).toBe(keys[0]);await expect(button).toBeEnabled();expect(errors).toEqual([]);
 }finally{release();await f.harness.close();}
});

for(const changed of ['replacement','clearing'])test(`editing the accepted sample by ${changed} restores explicit recording selection`,async({page,context})=>{
 const f=await fixture();let creates=0;
 const track={artist:'Fixture ensemble',title:'Verified suggestion',archiveId:'verified-suggestion',archiveFile:'exact-recording.mp3'},query=`${track.artist} ${track.title}`;
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.student});await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/song-samples',route=>route.fulfill({json:{enabled:true,revision:1,tracks:[track]}}));
  await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:[{...track,id:'verified-suggestion/exact-recording.mp3',durationSec:30,bytes:100000,sourceUrl:'https://archive.org/details/verified-suggestion'}]}}));
  await page.route('**/api/jobs',route=>{if(route.request().method()!=='POST')return route.continue();creates++;return route.fulfill({status:503,json:{error:'Fixture import stopped.'}});});
  await page.goto(f.url.href);await page.getByLabel('Share with').selectOption('personal');
  const input=page.locator('#yt-url'),button=page.locator('#yt-form .yt-go');
  await expect(input).toHaveAttribute('placeholder',query);await input.focus();await input.press('Tab');await expect(input).toHaveValue(query);
  await input.fill(changed==='replacement'?'A different song':'');await input.fill(query);
  await button.click();await expect(page.locator('#source-songs [role="option"]')).toBeVisible();await expect(button).toBeEnabled();expect(creates).toBe(0);
  await page.locator('#source-songs [role="option"]').click();await button.click();await expect.poll(()=>creates).toBe(1);await expect(button).toBeEnabled();
 }finally{await f.harness.close();}
});

for(const saved of ['auto','adaptive_four','htdemucs_6s'])test(`manual-only catalog resolves saved ${saved} and submits the selected model`,async({page,context})=>{
 const f=await fixture({TEST_NO_COURSES:'true'}),errors=[];let submitted;
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await context.setExtraHTTPHeaders({'x-fixture-identity':f.student});
  await page.addInitScript(value=>localStorage.setItem('stem-split-choice-v1',value),saved);
  await page.route('**/api/song-samples',route=>route.fulfill({json:{enabled:false,revision:0,tracks:[]}}));
  await page.route('**/api/jobs',route=>{
   if(route.request().method()!=='POST')return route.continue();
   submitted=route.request().postDataJSON();return route.fulfill({status:503,json:{error:'Fixture stops before provider submission.'}});
  });
  await page.goto(f.url.href);
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(page.locator('input[value="auto"]')).toHaveCount(0);
  await expect(page.locator('input[value="adaptive_four"]')).toHaveCount(0);
  const catalog=await(await f.harness.fetch('/api/separation-options')).json();
  const selected=saved==='htdemucs_6s'?saved:catalog.defaultModel;
  await expect(page.locator(`input[value="${selected}"]`)).toBeChecked();
  await expect(page.getByLabel('Share with')).toBeHidden();
  await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../tests/fixtures/audio/source.wav',import.meta.url)));
  await expect.poll(()=>submitted?.model).toBe(selected);
  expect(submitted.routingRequest).toBeUndefined();expect(submitted.browserAnalysis).toBeUndefined();
  expect(errors).toEqual([]);
 }finally{await f.harness.close();}
});
