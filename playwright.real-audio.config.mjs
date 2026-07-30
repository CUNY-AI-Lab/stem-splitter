import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'live-real-audio.spec.mjs',
  timeout: 30 * 60_000,
  expect: { timeout: 20 * 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.REAL_AUDIO_BASE_URL || 'http://127.0.0.1:8787',
    channel: 'chrome',
    headless: true,
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
