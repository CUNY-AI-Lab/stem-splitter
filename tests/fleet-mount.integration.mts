import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

test('actual Node host preserves root and mounted browser class entry and teacher navigation', async () => {
  const data = await mkdtemp(join(tmpdir(), 'stem-mount-'));
  const host = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '18894', DATA_DIR: data, CLASS_CODE: 'mount-test-code', WEBHOOK_SECRET: 'mount-test-secret', PUBLIC_BASE_URL: 'http://127.0.0.1:18894' }, stdio: 'pipe',
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
      await page.close();
    }
  } finally {
    await browser.close();
    host.kill();
    await new Promise<void>((resolve) => host.once('exit', () => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
