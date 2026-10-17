import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Only the fully-mocked suite: the live real-audio spec runs through its
  // own config and must never ride along in `test:e2e`.
  testMatch: 'local-hosting.spec.mjs',
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    channel: 'chrome',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
