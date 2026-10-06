import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: ['browser.spec.mjs', 'remix.spec.mjs', 'layout.spec.mjs', 'account.spec.mjs', 'account-rack.spec.mjs', 'gateway.spec.mjs', 'sharing.spec.mjs', 'playback.spec.mjs', 'classroom.spec.mjs'], workers: 1, timeout: 45000,
  use: { browserName: process.env.STEM_BROWSER || 'chromium', channel: process.env.STEM_BROWSER ? undefined : 'chrome', headless: true, screenshot: 'only-on-failure' }, reporter: 'line' });
