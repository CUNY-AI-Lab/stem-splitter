import { test,expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { http,HttpResponse } from 'msw';
import { mp3FrameInfo } from '../src/reliability/media.ts';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
test.use({ignoreHTTPSErrors:true});

async function setup(page, chatAvailable = false) {
  let origin = '', providerStarts = 0, verifications = 0, widgetLoads = 0;
  const issuer = await createTestIdentityIssuer();
  const mp3 = await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  const music={identifier:'song-fixture',title:'Song fixture',creator:'Fixture Ensemble',mediatype:'audio',subject:['Music','Rock']};
  const network = setupServer(
    http.get('https://archive.org/advancedsearch.php',()=>HttpResponse.json({response:{docs:[music]}})),
    http.get('https://archive.org/metadata/song-fixture',()=>HttpResponse.json({metadata:music,files:[{name:'song.mp3',title:'Song fixture',size:String(mp3.length),length:String(mp3FrameInfo(new Uint8Array(mp3).buffer).seconds)}]})),
    http.get('https://archive.org/download/song-fixture/song.mp3',({request})=>request.headers.has('range')
      ? new HttpResponse(mp3.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,mp3.length-1)}/${mp3.length}`}})
      : new HttpResponse(mp3,{headers:{'content-type':'audio/mpeg','content-length':String(mp3.length)}})),
    http.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', () => {
      verifications++;
      return HttpResponse.json({ success: true, hostname: new URL(origin).hostname, action: 'stem_guest', challenge_ts: new Date().toISOString() });
    }),
    http.post('https://api.replicate.com/v1/predictions', () => HttpResponse.json({ id: `browser-guest-prediction-${++providerStarts}`, status: 'starting' })),
    http.get('https://api.replicate.com/v1/predictions/:id', ({ params }) => HttpResponse.json({ id: params.id, status: 'succeeded', output: Object.fromEntries(['vocals', 'drums', 'bass', 'other'].map(name => [name, `https://fixtures.replicate.delivery/${name}.mp3`])) })),
    http.get('https://fixtures.replicate.delivery/:name.mp3', () => new HttpResponse(mp3, { headers: { 'Content-Type': 'audio/mpeg' } })),
  );
  network.listen({ onUnhandledRequest(request, print) { if (new URL(request.url).origin === origin) return; print.error(); } });
  const config = JSON.parse(await readFile(new URL('./test-wrangler.jsonc', import.meta.url), 'utf8'));
  const harness = createTestHarness({ root: fileURLToPath(new URL('./', import.meta.url)), workers: [{ config: { ...config, dev: { local_protocol: 'https' },
    vars: { ...config.vars, TEST_BROWSER: 'true', TEST_JWKS: issuer.jwksJson, GUEST_ENABLED: 'true', GUEST_COOKIE_SECRET: 'browser-fixture-cookie-secret-0000000000', GUEST_TURNSTILE_SITE_KEY: 'fixture-site-key',
      GUEST_TURNSTILE_SECRET: 'fixture-turnstile-secret-only', GUEST_GATEWAY_API_KEY: chatAvailable ? 'sk-cail-fixture-sponsor-key-only-000000' : '',
      REPLICATE_API_TOKEN: 'guest-fixture-token', REPLICATE_MODEL_VERSION: 'guest-fixture-pin', WEBHOOK_SECRET: 'guest-fixture-webhook' },
  } }] });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ path: new URL(request.url()).pathname, method: request.method(), key: request.headers()['idempotency-key'] }));
  const { url } = await harness.listen(); origin = url.origin;
  const worker = harness.getWorker('stem-preview-contract-test');
  const seeded = await worker.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
  expect(seeded.status).toBe(200);
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '', contentType: 'text/css' }));
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => {
    widgetLoads++;
    return route.fulfill({ contentType: 'text/javascript', body: `window.turnstile={render(root,options){if(options.appearance!=='interaction-only')throw new Error('Unexpected widget appearance');const button=document.createElement('button');button.textContent='Complete fixture guest check';button.onclick=()=>options.callback('browser-fixture-'+crypto.randomUUID());root.append(button);return 'fixture';},remove(){}};` });
  });
  return { origin, errors, requests, issuer, network, counts: () => ({ providerStarts, verifications, widgetLoads }),
    close: async () => { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await harness.close(); network.close(); } };
}
const account = page => page.evaluate(async () => (await fetch('/api/account')).json());
test('guest upload and notes survive eligible sign-in, interrupted claim and repeated reloads',async({page})=>{
 const f=await setup(page);
 try {
  await page.goto(f.origin);
  await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
  const guest=(await account(page)).account.subject;
  await startUpload(page);await completed(page,1);
  const id=await page.evaluate(()=>getJobs()[0].id);
  expect(await page.evaluate(async id=>(await fetch(`/api/jobs/${id}/annotations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({atSeconds:1,text:'My guest note'})})).status,id)).toBe(200);
  const original=await page.evaluate(key=>localStorage.getItem(key),`jobs:${guest}`);
  const jwt=await f.issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice});
  await page.setExtraHTTPHeaders({'x-fixture-identity':jwt});
  await page.route('**/api/account/claim-guest',route=>route.fulfill({status:503,json:{error:'Local fixture interruption'}}));
  await page.reload();await expect(page.locator('#upload-message')).toContainText('originals are preserved');
  expect(await page.evaluate(key=>localStorage.getItem(key),`jobs:${guest}`)).toBe(original);
  await page.unroute('**/api/account/claim-guest');await page.reload();
  await expect(page.locator('.console-title')).toHaveText('source.wav');
  await expect(page.locator('.badge.ready')).toHaveCount(1);
  const saved=await page.evaluate(async id=>(await fetch(`/api/jobs/${id}`)).json(),id);
  expect(saved.annotations[0].text).toBe('My guest note');
  expect(saved.annotations[0].canDelete).toBe(true);
  expect((await account(page)).splitAllowance.remaining).toBe(15);
  await page.reload();await expect(page.locator('.badge.ready')).toHaveCount(1);
  expect(f.counts().providerStarts).toBe(1);
  expect(await page.evaluate(key=>localStorage.getItem(key),`jobs:${guest}`)).toBe(original);
  expect(f.errors).toEqual([]);
 } finally {await f.close();}
});
async function startUpload(page) {
  const uploaded = page.waitForResponse(response => response.url().includes('/api/local-uploads/'));
  await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../tests/fixtures/audio/source.wav', import.meta.url)));
  expect((await uploaded).status()).toBe(204);
}
async function completed(page, count) {
  await expect(page.locator('.badge.ready')).toHaveCount(count, { timeout: 25000 });
  await expect.poll(async () => (await account(page)).splitAllowance.completed).toBe(count);
}
test('guest rejects retired Vimeo and submits YouTube through the existing video field', async ({ page }) => {
  const f = await setup(page);
  let pendingSubmission;
  const submissions = [];
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  try {
    await page.goto(f.origin);
    await expect(page).toHaveURL(f.origin + '/');
    await expect(page).toHaveTitle('Stem Splitter');
    await expect(page.locator('#split-summary')).toHaveText('// a closer listen');
    await expect.poll(async () => (await account(page)).account?.subject).toMatch(/^guest-/);
    const before = await account(page);
    const input = page.getByRole('combobox', { name: 'Song or link', exact: true });
    await expect(input).toHaveAttribute('placeholder', 'jazz piano');
    await expect(page.locator('#yt-disclosure summary')).toHaveText('Or search for a song or paste a link');
    await page.locator('input[name="stem-model"][value="htdemucs_ft"]').check();
    const retiredResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs'&&response.request().method()==='POST');
    await input.fill('https://vimeo.com/76979871');
    await page.locator('#yt-form button[type=submit]').click();
    expect((await retiredResponse).status()).toBe(400);
    await expect(page.locator('#upload-message')).toHaveText('Choose a supported video link or upload an audio file. Code: unsupported_source.');
    await expect(input).toBeEnabled();
    await expect(page.locator('#job-list .console')).toHaveCount(0);
    expect((await account(page)).splitAllowance).toEqual(before.splitAllowance);
    await page.route(/\/api\/jobs$/, route => {
      if (route.request().method() !== 'POST') return route.continue();
      submissions.push({ body: route.request().postDataJSON(), headers: route.request().headers() });
      pendingSubmission = route;
    });
    await page.route(/\/api\/jobs\/video-fixture-\d+$/, route => route.fulfill({ json: {
      id: new URL(route.request().url()).pathname.split('/').at(-1), filename: 'Video fixture',
      model: 'htdemucs_ft', status: 'importing', stems: [],
    } }));
    for (const videoUrl of ['https://www.youtube.com/watch?v=jNQXAC9IVRw']) {
      pendingSubmission = undefined;
      await input.fill(videoUrl);
      await page.locator('#yt-form button[type=submit]').click();
      await expect.poll(() => Boolean(pendingSubmission)).toBe(true);
      await expect(page.locator('#upload-message')).toHaveText('IMPORTING AUDIO…');
      await expect(page.locator('#yt-form')).toHaveAttribute('aria-busy', 'true');
      await expect(input).toBeDisabled();
      await expect(page.locator('#yt-form button[type=submit]')).toBeDisabled();
      expect(submissions.at(-1).body).toEqual({ videoUrl, model: 'htdemucs_ft' });
      expect(submissions.at(-1).headers['idempotency-key']).toBeTruthy();
      expect(submissions.at(-1).headers['x-stem-course']).toBe('personal');
      {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(input).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (process.env.STEM_SCREENSHOT_DIR) {
            await mkdir(process.env.STEM_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: `${process.env.STEM_SCREENSHOT_DIR}/video-import-${width}.png`, animations: 'disabled' });
          }
        }
      }
      await pendingSubmission.fulfill({ status: 202, json: {
        id: `video-fixture-${submissions.length}`, filename: 'Video fixture', model: 'htdemucs_ft', status: 'importing',
      } });
      pendingSubmission = undefined;
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue('');
      await expect(page.locator('#yt-form button[type=submit]')).toBeEnabled();
      await expect(page.locator('#upload-message')).toContainText('PROCESSING');
      await expect(page.locator('#job-list .console')).toHaveCount(submissions.length);
    }
    expect(submissions).toHaveLength(1);
    const after = await account(page);
    expect(after.account.subject).toBe(before.account.subject);
    expect(after.splitAllowance).toEqual(before.splitAllowance);
    expect(f.counts()).toEqual({ providerStarts: 0, verifications: 0, widgetLoads: 0 });
    await expect(page.locator('#guest-panel, #guest-session, #session-check, vite-error-overlay, nextjs-portal')).toHaveCount(0);
    // Account discovery uses 401 and the retired source returns 400;
    // other browser errors are unexpected.
    expect(consoleErrors.filter(error => !(
      (error.text === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)'
        && ['/api/account', '/api/teacher/me'].includes(new URL(error.url, f.origin).pathname))
      || (error.text === 'Failed to load resource: the server responded with a status of 400 (Bad Request)'
        && new URL(error.url, f.origin).pathname === '/api/jobs')
    ))).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    if (pendingSubmission) await pendingSubmission.abort().catch(() => {});
    await f.close();
  }
});
for (const chatAvailable of [true, false]) test(`guest starts silently, plays and resumes with optional chat ${chatAvailable}`, async ({ page, context }) => {
  const f = await setup(page, chatAvailable);
  try {
    await page.goto(f.origin);
    await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toBeVisible();
    await expect.poll(async () => (await account(page)).account?.subject).toMatch(/^guest-/);
    const first = await account(page);
    expect(first.guest.verificationRequired).toBe(false);
    await expect(page.locator('#guest-panel, #guest-session, #course-context, .bug-report, .compact-masthead')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue as guest', exact: true })).toHaveCount(0);
    expect(f.counts()).toEqual({ providerStarts: 0, verifications: 0, widgetLoads: 0 });
    await startUpload(page); await completed(page, 1);
    const jobId = await page.evaluate(() => [...mixers.keys()][0]);
    await expect(page.locator('.console-title')).toHaveText('source.wav');
    await expect(page.locator('.coach-toggle')).toBeVisible();
    await expect(page.locator('.coach-body')).toBeHidden();
    await expect(page.locator('.guest-coach-notice, .refresh-btn, .waveform-seek')).toHaveCount(0);
    await page.locator('.play-btn').click();
    await expect.poll(() => page.evaluate(() => [...mixers.values()][0].audios[0].currentTime)).toBeGreaterThan(0);
    await page.reload();
    await expect(page.locator('.console-title')).toHaveText('source.wav');
    const resumed = await account(page);
    expect(resumed.account.subject).toBe(first.account.subject);
    expect(resumed.guest.expiresAt).toBe(first.guest.expiresAt);
    expect(resumed.splitAllowance.completed).toBe(1);
    expect(resumed.splitAllowance.limit).toBe(5);
    expect(f.counts()).toEqual({ providerStarts: 1, verifications: 0, widgetLoads: 0 });
    expect(f.requests.filter(request => request.path.startsWith('/api/classroom/'))).toEqual([]);
    await page.goto(f.origin + '/account.html');
    await expect(page).toHaveURL(f.origin + '/');
    for (const width of [390, 768, 1280]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    await expect(page.locator('.console-title')).toHaveText('source.wav');
    await page.locator('.play-btn').click();
    let releaseCheck;
    const heldCheck = new Promise(resolve => { releaseCheck = resolve; });
    await page.route('**/api/account', async route => { await heldCheck; await route.fulfill({ status: 503, json: { error: 'Fixture authority unavailable' } }); });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#job-list')).toBeHidden();
    await expect(page.locator('.masthead')).toBeVisible();
    expect(await page.evaluate(() => [...mixers.values()][0].audios.every(audio => audio.paused))).toBe(true);
    releaseCheck();
    await expect(page.locator('#rack-status')).toContainText('Please retry the connection');
    await expect(page.locator('#job-list')).toBeHidden();
    await expect(page.locator('#session-check')).toHaveCount(0);
    await page.unroute('**/api/account'); await page.locator('#rack-retry').click();
    await expect(page.locator('#job-list')).toBeVisible();
    await expect(page.locator('.console-title')).toHaveText('source.wav');
    expect(await page.evaluate(() => [...mixers.values()][0].playing)).toBe(false);
    await expect.poll(() => page.evaluate(() => rackLoading)).toBe(false);
    let pendingJobs;
    await page.route(/\/api\/jobs(?:\?.*)?$/, route => { pendingJobs = route; });
    await page.evaluate(() => { void loadAccountJobs(); });
    await expect.poll(() => Boolean(pendingJobs)).toBe(true);
    await context.clearCookies();
    const secondSession = await page.request.post(f.origin + '/auth/guest', { headers: { Origin: f.origin }, data: {} });
    expect(secondSession.status()).toBe(200);
    const secondAccount = await (await page.request.get(f.origin + '/api/account')).json();
    expect(secondAccount.account.subject).not.toBe(first.account.subject);
    const secondJobs = await (await page.request.get(f.origin + '/api/jobs?limit=40')).json();
    await page.unroute(/\/api\/jobs(?:\?.*)?$/);
    await pendingJobs.fulfill({ status: 200, headers: { 'X-Stem-Account': secondAccount.account.subject }, json: secondJobs });
    await expect.poll(() => page.evaluate(() => accountSubject).catch(() => null)).toBe(secondAccount.account.subject);
    await expect(page.locator('.console-title')).toHaveCount(0);
    expect(await page.evaluate(async id => (await fetch('/api/jobs/' + id)).status, jobId)).toBe(404);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
test('guest completes three splits before the fourth requests verification and retries the same submission', async ({ page }) => {
  test.setTimeout(120000);
  const f = await setup(page);
  try {
    await page.goto(f.origin);
    await expect.poll(async () => (await account(page)).account?.subject).toMatch(/^guest-/);
    const subject = (await account(page)).account.subject;
    for (let count = 1; count <= 3; count++) { await startUpload(page); await completed(page, count); }
    expect(f.counts()).toEqual({ providerStarts: 3, verifications: 0, widgetLoads: 0 });
    expect((await account(page)).guest.verificationRequired).toBe(true);
    const blocked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs' && response.request().method() === 'POST' && response.status() === 403);
    await startUpload(page);
    expect((await (await blocked).json()).error.code).toBe('guest_verification_required');
    await expect(page.locator('#upload-status').getByRole('button', { name: 'Complete fixture guest check' })).toBeVisible();
    expect(f.counts().providerStarts).toBe(3);
    await page.getByRole('button', { name: 'Complete fixture guest check' }).click();
    await completed(page, 4);
    const posts = f.requests.filter(request => request.path === '/api/jobs' && request.method === 'POST');
    expect(posts).toHaveLength(5); expect(posts[3].key).toBeTruthy(); expect(posts[4].key).toBe(posts[3].key);
    expect((await account(page)).account.subject).toBe(subject);
    expect((await account(page)).guest.verificationRequired).toBe(false);
    expect(f.counts()).toEqual({ providerStarts: 4, verifications: 1, widgetLoads: 1 });
    await expect(page.getByRole('button', { name: 'Complete fixture guest check' })).toHaveCount(0);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test('guest searches and imports a complete song through the existing field',async({page})=>{
  const f=await setup(page);
  try {
    await page.goto(f.origin);await expect(page).toHaveTitle('Stem Splitter');
    await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
    await page.locator('input[name="stem-model"][value="htdemucs_ft"]').check();
    const input=page.getByRole('combobox',{name:'Song or link',exact:true});
    await input.pressSequentially('Fixture Ensemble song');
    const suggestion=page.getByRole('option',{name:'Song fixture — Item creator: Fixture Ensemble',exact:false});
    await expect(suggestion).toBeVisible();
    await expect(input).toHaveAttribute('aria-expanded','true');
    await suggestion.click();
    await expect(input).toHaveValue('Song fixture — Item creator: Fixture Ensemble');
    await expect(page.getByRole('listbox',{name:'Songs'})).toBeHidden();
    const submission=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/jobs'&&r.request().method()==='POST');
    await page.locator('#yt-form button[type=submit]').click();const response=await submission;
    expect(response.status()).toBe(202);expect(response.request().postDataJSON()).toMatchObject({archiveId:'song-fixture',archiveFile:'song.mp3',archiveSearch:true});
    expect((await response.json()).savedToAccount).toBe(false);
    await completed(page,1);expect(f.counts().providerStarts).toBe(1);
    await expect(page.locator('#upload-message')).not.toContainText('Saved to your account');
    await expect(page.locator('#yt-url')).toHaveValue('');
    for(const width of [1280,390]) {
      await page.setViewportSize({width,height:900});await expect(input).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/song-import-${width}.png`,animations:'disabled'});}
    }
    expect((await account(page)).splitAllowance.remaining).toBe(4);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('a delayed song search cannot replace a newer query or a pasted link',async({page})=>{
  const f=await setup(page);let delayed;
  try {
    await page.goto(f.origin);await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
    await page.route('**/api/music/search?q=Slow',route=>{delayed=route;});
    const input=page.getByRole('combobox',{name:'Song or link',exact:true});
    await input.fill('Slow');await expect.poll(()=>Boolean(delayed)).toBe(true);
    await input.fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await delayed.fulfill({json:{results:[{id:'4zxjE',title:'Stale result',artist:'Artist',durationSec:200}]}});delayed=undefined;
    await expect(page.locator('#source-songs [role="option"]')).toHaveCount(0);
    await expect(page.locator('#source-songs')).toBeHidden();await expect(input).toHaveValue('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
  }finally{if(delayed)await delayed.abort().catch(()=>{});await f.close();}
});

test('song suggestions support keyboard selection and stay closed after Escape or blur',async({page})=>{
  const f=await setup(page);let delayed;
  const tracks=[
    {id:'4zxjE',title:"Huntin' Koch",artist:'De köchunterzZ',durationSec:274},
    {id:'second',title:"Huntin' Koch (remix)",artist:'De köchunterzZ',durationSec:205},
  ];
  try {
    await page.goto(f.origin);await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
    await page.route('**/api/music/search?*',route=>{delayed=route;});
    const input=page.getByRole('combobox',{name:'Song or link',exact:true}),list=page.getByRole('listbox',{name:'Songs'});
    await input.fill('Huntin Koch');await expect.poll(()=>Boolean(delayed)).toBe(true);
    await expect(list).toContainText('Searching…');
    await input.press('Escape');await expect(list).toBeHidden();
    await delayed.fulfill({json:{results:tracks}});delayed=undefined;
    await expect(page.locator('#source-songs [role="option"]')).toHaveCount(2);await expect(list).toBeHidden();
    await input.press('ArrowDown');await expect(list).toBeVisible();
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected','true');
    await expect(input).toHaveAttribute('aria-activedescendant',await page.getByRole('option').first().getAttribute('id'));
    await input.press('ArrowDown');await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected','true');
    await input.press('Enter');await expect(input).toHaveValue("Huntin' Koch (remix) — File artist: De köchunterzZ");
    await expect(list).toBeHidden();
    expect(f.requests.filter(r=>r.path==='/api/jobs'&&r.method==='POST')).toHaveLength(0);
    await input.fill('Later');await expect.poll(()=>Boolean(delayed)).toBe(true);
    await input.press('Tab');await expect(list).toBeHidden();
    await delayed.fulfill({json:{results:tracks}});delayed=undefined;
    await expect(page.locator('#source-songs [role="option"]')).toHaveCount(2);await expect(list).toBeHidden();
    await input.focus();await expect(list).toBeVisible();
    await input.fill('');await expect(list).toBeHidden();
    expect(f.errors).toEqual([]);
  }finally{if(delayed)await delayed.abort().catch(()=>{});await f.close();}
});

test('song search shows empty and failed searches and ignores stale responses',async({page})=>{
  const f=await setup(page);let slow,latest,latestRequests=0;
  try {
    await page.goto(f.origin);await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
    await page.route('**/api/music/search?*',route=>{
      const query=new URL(route.request().url()).searchParams.get('q');
      if(query==='Slow'){slow=route;return;}
      if(query==='Latest'){latestRequests++;latest=route;return;}
      return route.fulfill(query==='Empty'?{json:{results:[]}}:{status:502,json:{error:'Provider unavailable'}});
    });
    const input=page.getByRole('combobox',{name:'Song or link',exact:true}),list=page.getByRole('listbox',{name:'Songs'});
    await input.fill('Empty');await expect(list).toContainText('Try another song or artist.');
    await input.fill('Failure');await expect(list).toContainText('Search is temporarily unavailable. Try again.');
    await input.fill('Slow');await expect.poll(()=>Boolean(slow)).toBe(true);
    await input.fill('Latest');await expect.poll(()=>Boolean(latest)).toBe(true);
    await input.press('Enter');expect(latestRequests).toBe(1);
    await latest.fulfill({json:{results:[{id:'4zxjE',title:'Current match',artist:'Artist',durationSec:274}]}});latest=undefined;
    await expect(page.getByRole('option',{name:/Current match/})).toBeVisible();
    await slow.fulfill({status:502,json:{error:'Old failure'}});slow=undefined;
    await expect(page.getByRole('option',{name:/Current match/})).toBeVisible();
    await expect(list).not.toContainText('unavailable');
    expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
  }finally{if(slow)await slow.abort().catch(()=>{});if(latest)await latest.abort().catch(()=>{});await f.close();}
});

test.describe('song search on touch screens',()=>{
  test.use({hasTouch:true,viewport:{width:390,height:844}});
  test('song suggestions select with a tap while preserving the field layout',async({page})=>{
    const f=await setup(page);
    try {
      await page.goto(f.origin);await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
      const input=page.getByRole('combobox',{name:'Song or link',exact:true});
      const before=await page.locator('#stem-choice').boundingBox();
      await input.fill('Fixture Ensemble song');
      const suggestion=page.getByRole('option',{name:/Song fixture — Item creator: Fixture Ensemble/});await expect(suggestion).toBeVisible();
      expect(await page.locator('#stem-choice').boundingBox()).toEqual(before);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/song-search-touch.png`,animations:'disabled'});}
      await suggestion.tap();await expect(input).toHaveValue('Song fixture — Item creator: Fixture Ensemble');
      await expect(page.getByRole('listbox',{name:'Songs'})).toBeHidden();
      expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
    }finally{await f.close();}
  });
});

test('Archive results distinguish source credits and submit the exact choice on desktop and mobile',async({page})=>{
  const f=await setup(page),submissions=[];
  const tracks=[
    {id:'LostAndFound_929/1456.mp3',archiveId:'LostAndFound_929',archiveFile:'1456.mp3',title:'white rabbit',artist:'',itemCreator:'Jefferson Airplane',itemTitle:'white rabbit',itemDescription:'my best effort',durationSec:131},
    {id:'compilation/01 White Rabbit.mp3',archiveId:'compilation',archiveFile:'01 White Rabbit.mp3',title:'white rabbit',artist:'Jefferson Airplane',itemCreator:'Collection uploader',itemTitle:'Under The Influence Of Alice',durationSec:152},
    {id:'concert/white-rabbit-live.mp3',archiveId:'concert',archiveFile:'white-rabbit-live.mp3',title:'white rabbit',artist:'Jefferson Airplane',itemCreator:'Jefferson Airplane',itemTitle:'Live at the Fillmore',durationSec:152},
  ];
  try {
    await page.goto(f.origin);await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
    await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:tracks}}));
    await page.route(/\/api\/jobs$/,route=>{
      if(route.request().method()!=='POST')return route.continue();
      submissions.push(route.request().postDataJSON());
      return route.fulfill({status:400,json:{error:'Submission intercepted by test'}});
    });
    const input=page.getByRole('combobox',{name:'Song or link',exact:true});
    for(const width of [1280,390]) {
      await page.setViewportSize({width,height:900});
      for(let index=0;index<tracks.length;index++) {
        const before=await page.locator('#stem-choice').boundingBox();
        await input.fill('Jefferson Airplane white rabbit');
        const options=page.getByRole('option');await expect(options).toHaveCount(3);
        await expect(options.nth(0)).toContainText('Item creator: Jefferson Airplane');
        await expect(options.nth(0)).toContainText('Item note: my best effort');
        await expect(options.nth(0)).not.toContainText('File artist:');
        await expect(options.nth(1)).toContainText('File artist: Jefferson Airplane');
        await expect(options.nth(1)).toContainText('Under The Influence Of Alice');
        await expect(options.nth(2)).toContainText('Live at the Fillmore');
        expect(await page.locator('#stem-choice').boundingBox()).toEqual(before);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        if(index===0&&process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/archive-credits-${width}.png`,animations:'disabled'});}
        if(width===1280){for(let step=0;step<=index;step++)await input.press('ArrowDown');await input.press('Enter');}
        else await options.nth(index).click();
        await expect(page.getByRole('listbox',{name:'Songs'})).toBeHidden();
        const count=submissions.length;await page.locator('#yt-form button[type=submit]').click();
        await expect.poll(()=>submissions.length).toBe(count+1);
        expect(submissions.at(-1)).toMatchObject({archiveId:tracks[index].archiveId,archiveFile:tracks[index].archiveFile,archiveSearch:true});
        await expect(input).toBeEnabled();
      }
    }
    expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});


test('streamed song choices are usable before discovery finishes and stay in place as matches arrive',async({page})=>{
  const f=await setup(page);
  let release;
  const catalog=new Promise(resolve=>{release=resolve;});
  const music={identifier:'song-fixture',title:'Song fixture',creator:'Fixture Ensemble'};
  f.network.use(http.get('https://archive.org/advancedsearch.php',async({request})=>{
    if(new URL(request.url).searchParams.get('q').includes('creator:[* TO *]'))await catalog;
    return HttpResponse.json({response:{docs:[music]}});
  }));
  try {
    await page.goto(f.origin);await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
    const input=page.getByRole('combobox',{name:'Song or link',exact:true});
    await input.fill('Song fixture');
    const option=page.getByRole('option').first();
    await expect(option).toBeVisible();
    await expect(page.locator('#source-songs')).toHaveAttribute('aria-busy','true');
    await input.press('ArrowDown');const selected=await input.getAttribute('aria-activedescendant');
    release();
    await expect(page.locator('#source-songs')).not.toHaveAttribute('aria-busy');
    await expect(input).toHaveAttribute('aria-activedescendant',selected);
    await expect(option).toHaveAttribute('aria-selected','true');
    await input.press('Enter');await expect(input).toHaveValue('Song fixture — Item creator: Fixture Ensemble');
    await expect(page.locator('#source-songs')).toBeHidden();
    expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
  }finally{release();await f.close();}
});

test('partial song streams preserve visible choices through later updates and interruptions',async({page})=>{
  const f=await setup(page);
  try {
    await page.addInitScript(()=>{
      const original=window.fetch;
      window.fetch=(input,options)=>{
        if(!String(input).startsWith('/api/music/search?q=Streaming%20fixture'))return original(input,options);
        const encoder=new TextEncoder();
        return Promise.resolve(new Response(new ReadableStream({start(controller){
          window.pushSearch=packet=>controller.enqueue(encoder.encode(JSON.stringify(packet)+'\n'));
          window.endSearch=()=>controller.close();
        }}),{headers:{'Content-Type':'application/x-ndjson'}}));
      };
    });
    await page.goto(f.origin);await expect.poll(async()=>(await account(page)).account?.subject).toMatch(/^guest-/);
    const input=page.getByRole('combobox',{name:'Song or link',exact:true});await input.fill('Streaming fixture');
    await page.waitForFunction(()=>Boolean(window.pushSearch));
    const first={id:'first',title:'First song',artist:'Musician',durationSec:150};
    const second={id:'second',title:'Second song',artist:'Musician',durationSec:160};
    await page.evaluate(song=>window.pushSearch({results:[song],done:false}),first);
    await expect(page.getByRole('option')).toHaveCount(1);await input.press('ArrowDown');
    const selected=await input.getAttribute('aria-activedescendant');
    await page.evaluate(songs=>window.pushSearch({results:songs,done:false}),[second,first]);
    await expect(page.getByRole('option')).toHaveCount(2);
    await expect(page.getByRole('option').first()).toContainText('First song');
    await expect(input).toHaveAttribute('aria-activedescendant',selected);
    await page.evaluate(()=>window.endSearch());
    await expect(page.locator('#source-songs')).not.toHaveAttribute('aria-busy');
    await expect(page.getByRole('option')).toHaveCount(2);
    await input.press('Enter');await expect(input).toHaveValue('First song — File artist: Musician');
    expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

const sampleTrack = { id: 'sample-jazz', title: 'Piano sample', artist: 'Fixture ensemble', durationSec: 120, archiveId: 'sample', archiveFile: 'sample.mp3' };

test('sample query streams translucently and Tab reveals preloaded results without another request', async ({page}) => {
  const f = await setup(page); let searches = 0;
  try {
    await page.route('**/api/music/search?*', route => { searches++; return route.fulfill({json: {results: [sampleTrack]}}); });
    await page.goto(f.origin);
    const input = page.locator('#yt-url'), hint = page.locator('#source-sample-hint');
    await expect(hint).toBeVisible();
    await expect.poll(() => searches).toBe(1);
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', 'jazz piano');
    expect(await input.evaluate(el => getComputedStyle(el, '::placeholder').opacity)).toBe('0.5');
    await expect(page.locator('#source-songs')).toBeHidden();
    await input.focus();
    if (process.env.STEM_SCREENSHOT_DIR) await page.screenshot({path: `${process.env.STEM_SCREENSHOT_DIR}/search-sample-desktop.png`,animations:'disabled'});
    await input.press('Tab');
    await expect(input).toHaveValue('jazz piano');
    await expect(input).toBeFocused();
    await expect(page.getByRole('option', {name: /Piano sample/})).toBeVisible();
    await expect(hint).toBeHidden();
    expect(searches).toBe(1);
    expect(f.requests.filter(r => r.path === '/api/jobs' && r.method === 'POST')).toHaveLength(0);
    await input.press('ArrowDown'); await input.press('Enter');
    await expect(input).toHaveValue('Piano sample — File artist: Fixture ensemble');
    await input.press('Tab'); await expect(page.locator('#yt-form button[type=submit]')).toBeFocused();
    expect(f.counts().providerStarts).toBe(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('Tab during sample animation reuses an in-flight preload; later typing rejects stale results', async ({page}) => {
  const f = await setup(page); let delayed, searches = 0;
  try {
    await page.route('**/api/music/search?*', route => { searches++; delayed = route; });
    await page.goto(f.origin);
    await expect.poll(() => Boolean(delayed)).toBe(true);
    const input = page.locator('#yt-url'); await input.focus(); await input.press('Tab');
    await expect(input).toHaveValue('jazz piano');
    expect(searches).toBe(1);
    await input.fill('https://example.com/song.mp3');
    await delayed.fulfill({json: {results: [sampleTrack]}}).catch(() => {}); delayed = null;
    await expect(page.locator('#source-songs')).toBeHidden();
    await expect(page.locator('#source-songs [role=option]')).toHaveCount(0);
    await expect(input).toHaveValue('https://example.com/song.mp3');
    await expect(page.locator('#source-sample-hint')).toBeHidden();
    expect(f.counts().providerStarts).toBe(0); expect(f.errors).toEqual([]);
  } finally { if(delayed) await delayed.abort().catch(()=>{}); await f.close(); }
});

test('failed background search stays silent and acceptance retries through normal search', async ({page}) => {
  const f = await setup(page); let searches = 0;
  try {
    await page.route('**/api/music/search?*', route => ++searches === 1
      ? route.fulfill({status:403,json:{error:{code:'guest_verification_required'}}})
      : route.fulfill({json:{results:[sampleTrack]}}));
    await page.goto(f.origin); await expect.poll(()=>searches).toBe(1);
    await expect.poll(()=>page.evaluate(()=>sampleCache === null)).toBe(true);
    await expect(page.locator('#source-songs')).toBeHidden();
    expect(f.counts().widgetLoads).toBe(0);
    const input=page.locator('#yt-url'); await input.focus(); await input.press('Tab');
    await expect(page.getByRole('option',{name:/Piano sample/})).toBeVisible();
    expect(searches).toBe(2);expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('sample respects reduced motion, touch acceptance, Escape and Shift-Tab', async ({page}) => {
  const f = await setup(page);
  try {
    await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});
    await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:[sampleTrack]}}));
    await page.goto(f.origin);
    const input=page.locator('#yt-url'),hint=page.locator('#source-sample-hint');
    await expect(hint).toBeVisible();await expect(input).toHaveAttribute('placeholder','jazz piano');
    await input.focus();await input.press('Shift+Tab');await expect(input).not.toBeFocused();await expect(input).toHaveValue('');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.STEM_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/search-sample-mobile.png`,animations:'disabled'});
    await hint.click();await expect(page.getByRole('option',{name:/Piano sample/})).toBeVisible();
    if(process.env.STEM_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/search-results-mobile.png`,animations:'disabled'});
    await input.fill('');await expect(hint).toBeVisible();await input.press('Escape');await expect(hint).toBeHidden();
    await input.press('Tab');await expect(page.locator('#yt-form button[type=submit]')).toBeFocused();
    expect(f.errors).toEqual([]);
  }finally{await f.close();}
});

test('accepting a partial sample preload reveals cached choices and keeps streaming without duplication', async ({page}) => {
  const f=await setup(page);
  try {
    await page.addInitScript(()=>{
      const original=window.fetch;
      window.sampleSearches=0;
      window.fetch=(input,options)=>{
        if(!String(input).startsWith('/api/music/search?q=jazz%20piano'))return original(input,options);
        window.sampleSearches++;
        const encoder=new TextEncoder();
        return Promise.resolve(new Response(new ReadableStream({start(controller){
          window.pushSample=packet=>controller.enqueue(encoder.encode(JSON.stringify(packet)+'\n'));
          window.endSample=()=>controller.close();
          options.signal.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});
        }}),{headers:{'Content-Type':'application/x-ndjson'}}));
      };
    });
    await page.goto(f.origin);await page.waitForFunction(()=>Boolean(window.pushSample));
    await page.evaluate(track=>window.pushSample({results:[track],done:false}),sampleTrack);
    await page.waitForFunction(()=>sampleCache.batches.length===1);
    await expect(page.locator('#source-songs')).toBeHidden();
    const input=page.locator('#yt-url');await input.focus();await input.press('Tab');
    await expect(page.getByRole('option')).toHaveCount(1);await expect(page.locator('#source-songs')).toHaveAttribute('aria-busy','true');
    await input.press('ArrowDown');const selected=await input.getAttribute('aria-activedescendant');
    await page.evaluate(track=>{
      window.pushSample({results:[track,{...track,id:'sample-2',title:'Another piano sample'}],done:true});window.endSample();
    },sampleTrack);
    await expect(page.getByRole('option')).toHaveCount(2);await expect(input).toHaveAttribute('aria-activedescendant',selected);
    await expect(page.locator('#source-songs')).not.toHaveAttribute('aria-busy');
    expect(await page.evaluate(()=>window.sampleSearches)).toBe(1);
    expect(f.counts().providerStarts).toBe(0);expect(f.errors).toEqual([]);
  }finally{await f.close();}
});
