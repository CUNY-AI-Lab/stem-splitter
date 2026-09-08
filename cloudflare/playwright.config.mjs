import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: ['browser.spec.mjs', 'layout.spec.mjs'], workers: 1, timeout: 45000,
  use: { channel: 'chrome', headless: true, screenshot: 'only-on-failure' }, reporter: 'line' });
