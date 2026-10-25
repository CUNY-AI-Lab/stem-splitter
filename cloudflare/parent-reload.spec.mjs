import {test,expect} from '@playwright/test';
import {createTestHarness} from 'wrangler';
import {createTestIdentityIssuer,TEST_SUBJECTS} from '@cuny-ai-lab/cail-identity/testing';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {schemaStatements} from '../tests/e2e/schema-statements.mjs';

test('parent reloads keep mastheads static, preload one brand font and retain account gating',async({browser,browserName},testInfo)=>{
 test.skip(browserName!=='chromium','First-paint/cache instrumentation uses Chromium CDP.');
 test.setTimeout(90000);
 const issuer=await createTestIdentityIssuer();const jwt=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice});
 const harness=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol,TEST_BROWSER:'true'}}]});
 const measurements=[],contexts=[];let releaseAccount;
 try{
  const{url}=await harness.listen();const sql=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));sql.push(`UPDATE song_sample_settings SET settings=json_set(settings,'$.enabled',json('false')) WHERE id=1`);
  await harness.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(sql)});
  for(const reducedMotion of['no-preference','reduce'])for(const path of['/','/classroom.html','/account.html'])for(const mode of['cold','warm','delayed-font']){
   const context=await browser.newContext({reducedMotion,extraHTTPHeaders:{'x-fixture-identity':jwt}});contexts.push(context);const page=await context.newPage();const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setBlockedURLs',{urls:['https://fonts.googleapis.com/*','https://fonts.gstatic.com/*']});
   let fontRequests=0;page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('bricolage-grotesque-800.ttf'))fontRequests++;});
   // Routing is used only for delayed-font cases; warm cases retain the real HTTP cache.
   if(mode==='delayed-font')await page.route('**/fonts/bricolage-grotesque-800.ttf',async route=>{await new Promise(resolve=>setTimeout(resolve,1200));await route.continue();});
   await page.addInitScript(()=>{window.parentPaintFrames=[];const frame=()=>{const h=document.querySelector('.masthead h1'),logo=document.querySelector('.masthead .lab-brand'),brand=document.querySelector('.home-brand');if(h&&logo&&brand){const range=document.createRange();range.selectNodeContents(brand.firstChild);window.parentPaintFrames.push({at:performance.now(),font:[...document.fonts].find(f=>f.family.includes('Stem Splitter Brand'))?.status,width:range.getBoundingClientRect().width,hOpacity:getComputedStyle(h).opacity,hTransform:getComputedStyle(h).transform,hAnimation:getComputedStyle(h).animationName,logoOpacity:getComputedStyle(logo).opacity,logoTransform:getComputedStyle(logo).transform,logoAnimation:getComputedStyle(logo).animationName});}if(performance.now()<2000)requestAnimationFrame(frame);};requestAnimationFrame(frame);});
   if(mode==='warm'){await page.goto(new URL(path,url).href);await page.evaluate(()=>document.fonts.ready);fontRequests=0;}
   if(mode==='warm')await page.reload({waitUntil:'domcontentloaded'});else await page.goto(new URL(path,url).href,{waitUntil:'domcontentloaded'});
   const preload=page.locator('link[rel="preload"][as="font"]');await expect(preload).toHaveCount(1);await expect(preload).toHaveAttribute('href','/fonts/bricolage-grotesque-800.ttf');await expect(preload).toHaveAttribute('type','font/ttf');await expect(preload).toHaveAttribute('crossorigin','');
   await page.waitForTimeout(1400);const frames=await page.evaluate(()=>window.parentPaintFrames);expect(frames.length).toBeGreaterThan(0);
   for(const f of frames){expect(f.hOpacity).toBe('1');expect(f.logoOpacity).toBe('1');expect(f.hTransform).toBe('none');expect(f.logoTransform).toBe('none');expect(f.hAnimation).toBe('none');expect(f.logoAnimation).toBe('none');}
   await page.evaluate(()=>document.fonts.ready);expect(fontRequests).toBeLessThanOrEqual(1);
   const widths=[...new Set(frames.map(f=>f.width))];if(mode==='warm')expect(widths).toHaveLength(1);if(mode==='delayed-font')expect(widths.length).toBeGreaterThan(1); // A preload is not a zero-swap guarantee.
   const fontTiming=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('bricolage-grotesque-800.ttf')).map(e=>({startTime:e.startTime,responseEnd:e.responseEnd,initiatorType:e.initiatorType})));expect(fontTiming).toHaveLength(1);expect(fontTiming[0].initiatorType).toBe('link');measurements.push({path,reducedMotion,mode,fontRequests,widths,fontTiming,firstFrame:frames[0],lastFrame:frames.at(-1)});await context.close();
  }
  const context=await browser.newContext({extraHTTPHeaders:{'x-fixture-identity':jwt}});contexts.push(context);const page=await context.newPage();let release;const pending=new Promise(resolve=>{release=resolve;releaseAccount=resolve;});await page.route('**/api/account',async route=>{await pending;await route.continue();});
  await page.goto(new URL('/account.html',url).href,{waitUntil:'domcontentloaded'});await page.evaluate(()=>document.fonts.ready);await expect(page.locator('#account-details')).toBeHidden();await expect(page.locator('#account-status')).toHaveText('Loading…');const before=await page.locator('.workspace-nav').boundingBox();release();await expect(page.locator('#account-details')).toBeVisible();const after=await page.locator('.workspace-nav').boundingBox();expect(after.y).toBe(before.y);await context.close();
  await testInfo.attach('parent-reload-measurements',{body:JSON.stringify(measurements,null,2),contentType:'application/json'});console.log('PARENT_RELOAD_MEASUREMENTS '+JSON.stringify(measurements.map(({path,reducedMotion,mode,widths,fontTiming})=>({path,reducedMotion,mode,widths,fontTiming}))));
 }finally{releaseAccount?.();await Promise.all(contexts.map(context=>context.close()));await harness.close();}
});
