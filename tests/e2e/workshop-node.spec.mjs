import { test as base, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';

const CLASS_CODE = 'workshop-test-class';
const test = base.extend({
  host: async ({}, use) => {
    const issuer = await createTestIdentityIssuer();
    const identityHeaders = {
      'x-cail-identity-jwt': await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter' }),
      'x-cail-gateway-identity-jwt': await issuer.mintIdentityJwt({ audience: 'cail:gateway' }),
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'stem-workshop-'));
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/workshop-node-host.mts'], {
      env: {
        PATH: process.env.PATH, DATA_DIR: dataDir, PORT: String(port), PUBLIC_BASE_URL: url,
        CLASS_CODE, WEBHOOK_SECRET: 'workshop-test-only-secret',
        ASSISTANT_MODEL: 'gpt-oss-120b', CAIL_GATEWAY_URL: 'https://tools.ailab.gc.cuny.edu',
        CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer,
        CAIL_SOURCE_VERSION: 'a'.repeat(40),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(output);
        try { return (await fetch(`${url}/healthz`)).status; } catch { return 0; }
      }).toBe(200);
      await use({ url, dataDir, identityHeaders });
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  baseURL: async ({ host }, use) => use(host.url),
  // A controlled edge fixture supplies the signed legs, outside page scripts.
  extraHTTPHeaders: async ({ host }, use) => use(host.identityHeaders),
});

async function openExistingJob(page) {
  await page.addInitScript((code) => localStorage.setItem('classCode', code), CLASS_CODE);
  await page.goto('/?job=workshop-source', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /SEND TO REMIXER/ })).toBeVisible();
}

test('existing class work reaches the deck and captured takes remain available after clearing it', async ({ page, request }, testInfo) => {
  await openExistingJob(page);
  const before = await (await request.get('/api/jobs/workshop-source')).json();
  await page.getByRole('button', { name: /SEND TO REMIXER/ }).click();
  await expect(page.getByRole('tab', { name: /REMIXER/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.rlayer')).toHaveCount(4);
  await expect(page.locator('.rlayer-name').first()).toHaveText('Class lead voice');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /DEVIL’S ADVOCATE/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('workshop-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  const first = page.locator('.rlayer').first();
  await first.getByRole('button', { name: 'LOOP', exact: true }).click();
  await first.getByRole('button', { name: 'REV', exact: true }).click();
  await expect(first.getByRole('button', { name: 'REV', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByRole('button', { name: 'TAPE', exact: true })).toBeDisabled();
  await first.getByRole('combobox', { name: 'Layer speed' }).selectOption('0.75');
  await first.getByRole('spinbutton', { name: 'Entry time in seconds' }).fill('0.5');
  await first.getByRole('spinbutton', { name: 'Entry time in seconds' }).press('Tab');
  await page.getByRole('button', { name: /CAPTURE/ }).click();
  await expect(page.locator('#remix-tc')).not.toHaveText('0:00');
  await page.getByRole('button', { name: /END TAKE/ }).click();
  await expect(page.getByRole('link', { name: /SAVE/ })).toBeVisible();
  await page.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await page.getByRole('button', { name: 'SURE?', exact: true }).click();
  await expect(page.locator('.rlayer')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /SAVE/ })).toBeVisible();
  const saved = page.waitForEvent('download');
  await page.getByRole('link', { name: /SAVE/ }).click();
  const take = await saved;
  const path = testInfo.outputPath(take.suggestedFilename());
  await take.saveAs(path);
  // Real MediaRecorder output must contain decodable, audible samples.
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-']);
  let peak = 0;
  for (let i = 0; i + 4 <= pcm.length; i += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(i)));
  expect(pcm.length).toBeGreaterThan(16000);
  expect(peak).toBeGreaterThan(0.001);
  const after = await (await request.get('/api/jobs/workshop-source')).json();
  expect(after.labels).toEqual(before.labels);
  expect(after.annotations).toEqual(before.annotations);
  expect(after.stems).toEqual(before.stems);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tab', { name: /REMIXER/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'STACK ALL' })).toBeVisible();
  await page.getByRole('tab', { name: /REMIXER/ }).press('ArrowLeft');
  await expect(page.getByRole('tab', { name: /SPLITTER/ })).toBeFocused();
  await expect(page.locator('.note-text')).toContainText('Keep the class note.');
});

test('remix chat crosses the Node route, narrows returned tools, and preserves shared annotations', async ({ page, request, host }) => {
  await openExistingJob(page);
  await page.getByRole('button', { name: /SEND TO REMIXER/ }).click();
  await page.getByRole('button', { name: /DEVIL’S ADVOCATE/ }).click();
  await page.getByRole('textbox', { name: /Defend your mix/ }).fill('How does the voice change this mix?');
  await page.getByRole('button', { name: 'ARGUE', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Try the vocals alone.');
  await expect(page.getByRole('log')).toContainText('soloed vocals');
  await expect(page.locator('.rlayer').first().getByRole('button', { name: 'MUTE', exact: true })).toHaveAttribute('aria-pressed', 'false');
  for (let i = 1; i < 4; i++) {
    await expect(page.locator('.rlayer').nth(i).getByRole('button', { name: 'MUTE', exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  const job = await (await request.get('/api/jobs/workshop-source')).json();
  expect(job.annotations).toHaveLength(1);
  expect(job.annotations[0].text).toBe('Keep the class note.');
  const requests = (await readFile(join(host.dataDir, 'provider-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(requests).toHaveLength(1);
  const [provider] = requests;
  expect(provider.tools.map((tool) => tool.function.name)).toEqual(['solo', 'set_mute']);
  expect(provider.messages[0].content).toContain('WHAT THE SYSTEM KNOWS ABOUT THE REMIX DECK');
  expect(provider.messages[0].content).toContain('Class lead voice');
  const endpoint = '/api/jobs/workshop-source/chat';
  const data = { messages: [{ role: 'user', content: 'Critique this.' }], mode: 'remix', deck: 'vocals' };
  expect((await request.post(endpoint, { data })).status()).toBe(401);
  expect((await request.post(endpoint, { data: { ...data, mode: 'invalid' }, headers: { 'x-class-code': CLASS_CODE } })).status()).toBe(400);
  expect((await request.post(endpoint, { data: { ...data, deck: [] }, headers: { 'x-class-code': CLASS_CODE } })).status()).toBe(400);
});

test('Gateway quota refusal displays safe support information and makes no second request', async ({ page, host }) => {
  await openExistingJob(page);
  await page.getByRole('button', { name: /SEND TO REMIXER/ }).click();
  await page.getByRole('button', { name: /DEVIL’S ADVOCATE/ }).click();
  await page.getByRole('textbox', { name: /Defend your mix/ }).fill('Quota fixture');
  await page.getByRole('button', { name: 'ARGUE', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('The CAIL model usage limit has been reached.');
  await expect(page.getByRole('log')).toContainText('Support ID: 018f1f50-7c21-7abc-9def-0123456789ab');
  await expect(page.getByRole('log')).not.toContainText('PRIVATE');
  await expect(page.getByRole('log')).not.toContainText('Try again');
  const requests = (await readFile(join(host.dataDir, 'provider-requests.jsonl'), 'utf8')).trim().split('\n');
  expect(requests).toHaveLength(1);
  await expect(page.locator('.rlayer')).toHaveCount(4);
});

test('a delayed critique cannot overwrite changes made while it is replying', async ({ page }) => {
  await openExistingJob(page);
  await page.getByRole('button', { name: /SEND TO REMIXER/ }).click();
  await page.getByRole('button', { name: /DEVIL’S ADVOCATE/ }).click();
  await page.getByRole('textbox', { name: /Defend your mix/ }).fill('Wait while I change the arrangement.');
  const sent = page.waitForRequest((request) => request.url().endsWith('/chat'));
  await page.getByRole('button', { name: 'ARGUE', exact: true }).click();
  await sent;
  await page.locator('.rlayer').first().getByRole('button', { name: 'Remove layer' }).click();
  await expect(page.getByRole('log')).toContainText('the deck changed while I replied');
  await expect(page.locator('.rlayer')).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(page.locator('.rlayer').nth(i).getByRole('button', { name: 'MUTE', exact: true })).toHaveAttribute('aria-pressed', 'false');
  }
});
