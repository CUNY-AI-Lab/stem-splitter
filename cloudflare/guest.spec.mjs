import { test,expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setupServer } from 'msw/node';
import { http,HttpResponse } from 'msw';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
test.use({ignoreHTTPSErrors:true});

async function setup(page, chatAvailable = false) {
  let origin = '', providerStarts = 0, verifications = 0, widgetLoads = 0;
  const issuer = await createTestIdentityIssuer();
  const mp3 = await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  const network = setupServer(
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
  return { origin, errors, requests, counts: () => ({ providerStarts, verifications, widgetLoads }),
    close: async () => { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await harness.close(); network.close(); } };
}
const account = page => page.evaluate(async () => (await fetch('/api/account')).json());
async function startUpload(page) {
  const uploaded = page.waitForResponse(response => response.url().includes('/api/local-uploads/'));
  await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../tests/fixtures/audio/source.wav', import.meta.url)));
  expect((await uploaded).status()).toBe(204);
}
async function completed(page, count) {
  await expect(page.locator('.badge.ready')).toHaveCount(count, { timeout: 25000 });
  await expect.poll(async () => (await account(page)).splitAllowance.completed).toBe(count);
}
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
