import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';

test('actual Node browser preserves class credentials across CAIL auth failures at root and mount', async () => {
  const issuer = await createTestIdentityIssuer();
  const data = await mkdtemp(join(tmpdir(), 'stem-mount-'));
  const host = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '18894', DATA_DIR: data, CLASS_CODE: 'mount-test-code', WEBHOOK_SECRET: 'mount-test-secret', PUBLIC_BASE_URL: 'http://127.0.0.1:18894', CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer, CAIL_SOURCE_VERSION: 'a'.repeat(40), CAIL_GATEWAY_URL: 'https://tools.ailab.gc.cuny.edu', ASSISTANT_MODEL: 'test'  }, stdio: 'pipe',
  });
  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    host.stdout.on('data', (chunk) => { output += chunk; if (output.includes('listening on')) resolve(); });
    host.once('exit', (code) => reject(new Error(`Node host exited ${code}`)));
    host.once('error', reject);
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await ready;
    const db = new SqliteD1(join(data, 'stem-splitter.sqlite'));
    await db.prepare("INSERT INTO jobs (id, filename, source_key, status, stems) VALUES (?, ?, ?, 'done', ?)")
      .bind('auth-fixture', 'Auth fixture song', 'source', JSON.stringify([{ name: 'vocals', key: 'stems/auth-fixture/vocals.mp3' }])).run();
    const audio = new FsR2Bucket(join(data, 'audio'));
    await audio.put('stems/auth-fixture/vocals.mp3', await readFile('tests/fixtures/audio/vocals.mp3'));
    const expiredApp = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', expiresInSeconds: -600 });
    const expiredGateway = await issuer.mintIdentityJwt({ audience: 'cail:gateway', expiresInSeconds: -600 });
    assert.equal((await fetch('http://127.0.0.1:18894/stem-splitter', { redirect: 'manual' })).status, 308);
    for (const prefix of ['', '/stem-splitter']) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:18894${prefix}/`);
      await page.getByLabel('Class code', { exact: true }).fill('mount-test-code');
      await page.getByRole('button', { name: 'CONTINUE' }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Upload a song' })).toBeVisible();
      await page.getByRole('link', { name: 'INSTRUCTOR', exact: true }).click();
      await expect(page).toHaveURL(`http://127.0.0.1:18894${prefix}/teacher.html`);
      await page.goto(`http://127.0.0.1:18894${prefix}/?job=auth-fixture`);
      await page.getByRole('button', { name: /LISTENING GUY/ }).click();
      for (const identityHeaders of [{}, { 'x-cail-identity-jwt': expiredApp, 'x-cail-gateway-identity-jwt': expiredGateway }]) {
        await page.setExtraHTTPHeaders(identityHeaders);
        const guideResponse = page.waitForResponse(response => response.url().endsWith('/guide') && response.request().method() === 'POST');
        await page.getByRole('button', { name: 'CUE THE LISTENING GUIDE' }).click();
        const response = await guideResponse;
        assert.equal(response.status(), 401);
        assert.deepEqual(await response.json(), { error: { code: 'authentication_required', message: 'Sign in through CAIL to use the Listening Guide.' } });
        await expect(page.getByRole('paragraph').filter({ hasText: 'Sign in through CAIL to use the Listening Guide.' })).toBeVisible();
        assert.equal(await page.evaluate(() => localStorage.getItem('classCode')), 'mount-test-code');
        await expect(page.getByRole('dialog')).not.toBeVisible();
        const chatResponse = page.waitForResponse(response => response.url().endsWith('/chat') && response.request().method() === 'POST');
        await page.getByRole('textbox', { name: 'Ask the Listening Guide' }).fill('What should I hear?');
        await page.getByRole('textbox', { name: 'Ask the Listening Guide' }).press('Enter');
        assert.equal((await chatResponse).status(), 401);
        await expect(page.getByRole('log')).toContainText('Sign in through CAIL to use the Listening Guide.');
        assert.equal(await page.evaluate(() => localStorage.getItem('classCode')), 'mount-test-code');
        await expect(page.getByRole('dialog')).not.toBeVisible();
      }
      await page.evaluate(() => localStorage.setItem('classCode', 'wrong-class-code'));
      const wrongResponse = page.waitForResponse(response => response.url().endsWith('/guide') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'CUE THE LISTENING GUIDE' }).click();
      assert.deepEqual(await (await wrongResponse).json(), { error: 'Invalid class code', code: 'invalid_class_code' });
      await expect(page.getByRole('dialog')).toBeVisible();
      assert.equal(await page.evaluate(() => localStorage.getItem('classCode')), null);
      await page.getByLabel('Class code', { exact: true }).fill('mount-test-code');
      await page.getByRole('button', { name: 'CONTINUE' }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await page.evaluate(() => localStorage.setItem('classCode', 'wrong-class-code'));
      const wrongChat = page.waitForResponse(response => response.url().endsWith('/chat') && response.request().method() === 'POST');
      await page.getByRole('textbox', { name: 'Ask the Listening Guide' }).fill('Try another question');
      await page.getByRole('textbox', { name: 'Ask the Listening Guide' }).press('Enter');
      assert.deepEqual(await (await wrongChat).json(), { error: 'Invalid class code', code: 'invalid_class_code' });
      await expect(page.getByRole('dialog')).toBeVisible();
      assert.equal(await page.evaluate(() => localStorage.getItem('classCode')), null);
      await page.close();
    }
  } finally {
    await browser.close();
    host.kill();
    await new Promise<void>((resolve) => host.once('exit', () => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
