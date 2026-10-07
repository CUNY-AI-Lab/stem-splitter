import { test,expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { readFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { http,HttpResponse } from 'msw';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
test.use({ignoreHTTPSErrors:true});

test('guest browser enters through a verified check, resumes own work, conceals pending authority and switches cleanly',async({page,context})=>{
  let origin='';const issuer=await createTestIdentityIssuer();
  const mp3=await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  let providerStarts=0,courseRequests=0,holdAccount=false,releaseAccount;
  const network=setupServer(
    http.post('https://challenges.cloudflare.com/turnstile/v0/siteverify',()=>HttpResponse.json({success:true,hostname:new URL(origin).hostname,action:'stem_guest',challenge_ts:new Date().toISOString()})),
    http.post('https://api.replicate.com/v1/predictions',()=>{providerStarts++;return HttpResponse.json({id:'browser-guest-prediction',status:'starting'});}),
    http.get('https://api.replicate.com/v1/predictions/browser-guest-prediction',()=>HttpResponse.json({id:'browser-guest-prediction',status:'succeeded',output:Object.fromEntries(['vocals','drums','bass','other'].map(name=>[name,`https://fixtures.replicate.delivery/${name}.mp3`]))})),
    http.get('https://fixtures.replicate.delivery/:name.mp3',()=>new HttpResponse(mp3,{headers:{'Content-Type':'audio/mpeg'}})),
  );
  network.listen({onUnhandledRequest:'error'});
  const config=JSON.parse(await readFile(new URL('./test-wrangler.jsonc',import.meta.url),'utf8'));
  const harness=createTestHarness({root:fileURLToPath(new URL('./',import.meta.url)),workers:[{config:{...config,dev:{local_protocol:'https'},
    vars:{...config.vars,TEST_BROWSER:'true',TEST_JWKS:issuer.jwksJson,GUEST_ENABLED:'true',GUEST_COOKIE_SECRET:'browser-fixture-cookie-secret-0000000000',GUEST_TURNSTILE_SITE_KEY:'fixture-site-key',
      GUEST_TURNSTILE_SECRET:'fixture-turnstile-secret-only',GUEST_GATEWAY_API_KEY:'sk-cail-fixture-sponsor-key-only-000000',
      REPLICATE_API_TOKEN:'guest-fixture-token',REPLICATE_MODEL_VERSION:'guest-fixture-pin',WEBHOOK_SECRET:'guest-fixture-webhook'},
  }}]});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/classroom/'))courseRequests++;});
  try {
    const {url}=await harness.listen();origin=url.origin;expect(url.protocol).toBe('https:');const worker=harness.getWorker('stem-preview-contract-test');
    await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')))});
    await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:'',contentType:'text/css'}));
    await page.route('https://fonts.gstatic.com/**',route=>route.abort());
    await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',route=>route.fulfill({contentType:'text/javascript',body:`window.turnstile={render(root,options){const button=document.createElement('button');button.textContent='Complete fixture guest check';button.onclick=()=>options.callback('browser-fixture-'+crypto.randomUUID());root.append(button);return 'fixture';},reset(){}};`}));
    await page.route('**/api/account',async route=>{
      if(holdAccount){await new Promise(resolve=>{releaseAccount=resolve;});holdAccount=false;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture unavailable"}'});return;}
      await route.continue();
    });
    await page.goto(origin);
    await expect(page.getByRole('button',{name:'Continue as guest',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Continue as guest',exact:true}).click();
    await page.getByRole('button',{name:'Complete fixture guest check'}).click();
    await expect(page.getByRole('link',{name:'My guest session',exact:true})).toBeVisible();
    expect(courseRequests).toBe(0);
    const uploaded=page.waitForResponse(response=>response.url().includes('/api/local-uploads/'));
    await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../tests/fixtures/audio/source.wav',import.meta.url)));
    const upload=await uploaded;expect(upload.status()).toBe(204);
    await expect(page.locator('.console-title')).toHaveText('source.wav',{timeout:20000});
    await expect(page.locator('.badge.ready')).toBeVisible({timeout:20000});
    expect(providerStarts).toBe(1);
    await expect(page.locator('.share-btn:not(.to-remix-btn):not(.refresh-btn)')).toBeHidden();
    await page.reload();
    await expect(page.locator('.console-title')).toHaveText('source.wav');
    await page.getByRole('link',{name:'My guest session',exact:true}).click();
    await expect(page.locator('#account-splits')).toContainText('1 completed');
    await expect(page.locator('#account-splits')).toContainText('of 5');
    await expect(page.locator('#account-chat')).toContainText('of 25');
    await expect(page.locator('#account-admin')).toBeHidden();
    await expect(page.locator('#account-reference')).toBeHidden();
    for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
    await page.goto(origin);
    await expect(page.locator('.console-title')).toHaveText('source.wav');
    holdAccount=true;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('main')).toBeHidden();
    await expect(page.locator('#session-check')).toContainText('Checking');
    releaseAccount();
    await expect(page.locator('#session-check')).toContainText('hidden until access is checked');
    await expect(page.locator('main')).toBeHidden();
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('.console-title')).toHaveText('source.wav');
    for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
    await expect(page.locator('main')).toHaveCount(1);await expect(page.locator('h1')).toHaveCount(1);
    if(process.env.STEM_SCREENSHOT_DIR){
      await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});
      await page.evaluate(()=>{window.scrollTo(0,0);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      await page.screenshot({path:process.env.STEM_SCREENSHOT_DIR+'/guest-resumed-work-'+(process.env.STEM_BROWSER||'chrome')+'.png',animations:'disabled'});
      await page.locator('.console').screenshot({path:process.env.STEM_SCREENSHOT_DIR+'/guest-owned-split-'+(process.env.STEM_BROWSER||'chrome')+'.png',animations:'disabled'});
    }
    const oldCookie=(await context.cookies()).find(cookie=>cookie.name==='__Host-stem-guest');
    await context.clearCookies();
    const second=await worker.fetch(origin+'/auth/guest',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:'second-browser-guest'})});
    expect(second.status).toBe(200);const cookie=second.headers.get('set-cookie').split(';')[0].split('=');
    await context.addCookies([{name:cookie[0],value:cookie[1],url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.console-title')).toHaveCount(0);
    await expect(page.getByRole('link',{name:'My guest session',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'My guest session',exact:true}).click();
    await expect(page.locator('#account-splits')).toContainText('0 completed');
    await page.getByRole('button',{name:'End guest session',exact:true}).click();
    await expect(page.getByRole('button',{name:'Continue as guest',exact:true})).toBeVisible();
    expect((await context.cookies()).some(cookie=>cookie.name==='__Host-stem-guest')).toBe(false);
    expect(oldCookie.value).not.toBe(cookie[1]);expect(errors).toEqual([]);
  }finally{releaseAccount?.();await page.unrouteAll({behavior:'wait'});await page.close();await harness.close();network.close();}
});
