import base from './playwright.config.mjs';

// Explicit opt-in only: never part of CI or the default fixture suite.
export default {
  ...base,
  testMatch: ['audio-search-live.spec.mjs'],
  workers: 1,
  timeout: 45000,
  use: { ...base.use, browserName: 'chromium', channel: undefined, launchOptions: { args: ['--mute-audio'] } },
};
