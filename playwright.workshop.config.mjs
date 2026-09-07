import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'workshop-node.spec.mjs',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: 'line',
  use: { channel: 'chrome', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
