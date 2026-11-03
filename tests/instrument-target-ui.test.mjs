import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Transport fixtures prove UI mechanics only. No model, playback, or public
// endpoint is used. Audio elements remain muted and are never played.
async function fixture(t, width, mode = 'success') {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ['--mute-audio'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const state = { targets: [], posts: 0, reads: 0, initialFailure: mode === 'initial-failure' };
  await page.route('https://fixture.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/component.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync('public/instrument-targets.js', 'utf8') });
    if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: readFileSync('public/styles.css', 'utf8') });
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() === 'POST') {
        state.posts++;
        const target = route.request().postDataJSON().target;
        state.targets = [{ id: 'saved', target, status: 'processing', needsConfirmation: mode === 'lost', outputAvailable: false }];
        if (mode === 'lost') return route.fulfill({ status: 503, json: { error: 'Reply interrupted' } });
        await new Promise(resolve => setTimeout(resolve, 75));
        return route.fulfill({ json: state.targets[0] });
      }
      state.reads++;
      if (state.initialFailure) { state.initialFailure = false; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }); }
      if (url.pathname.endsWith('/saved')) Object.assign(state.targets[0], { status: 'succeeded', outputAvailable: true });
      return route.fulfill({ json: { targets: state.targets, maximumTargets: 2 } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><main style="max-width:800px;margin:auto"><div id="panel"></div></main><script type="module">import {mountInstrumentTargets} from "/component.js";await mountInstrumentTargets(document.querySelector("#panel"),{jobId:"fixture",request:async(path,options)=>{const r=await fetch(path,options),d=await r.json();if(!r.ok)throw new Error(d.error);return d}});window.ready=true;</script>' });
  });
  await page.goto('https://fixture.test/');
  await page.waitForFunction(() => window.ready);
  return { page, state };
}
for (const width of [390, 1280]) test(`silent target workflow, keyboard and dimensions at ${width}px`, async t => {
  const { page, state } = await fixture(t, width);
  const input = page.getByRole('textbox', { name: 'Instrument or sound' });
  await input.fill('saxophone');
  await input.press('Enter');
  await page.getByText('Requested: saxophone', { exact: true }).waitFor();
  assert.equal(state.posts, 1);
  assert.equal(await page.getByRole('button', { name: 'Request extraction' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  const audio = page.locator('audio');
  await audio.waitFor();
  assert.deepEqual(await audio.evaluate(el => ({ muted: el.muted, paused: el.paused, preload: el.preload, autoplay: el.autoplay })), { muted: true, paused: true, preload: 'none', autoplay: false });
  assert.match(await page.locator('.instrument-targets').innerText(), /not a detected instrument list/);
  const measurements = await page.locator('.instrument-targets').evaluate(el => ({ overflow: document.documentElement.scrollWidth > innerWidth, controls: [...el.querySelectorAll('input,button')].map(c => c.getBoundingClientRect().height) }));
  assert.equal(measurements.overflow, false);
  assert.ok(measurements.controls.every(h => h >= 44));
  assert.equal(state.posts, 1);
});
test('lost submission preserves draft and durable uncertain result without repeating POST', async t => {
  const { page, state } = await fixture(t, 390, 'lost');
  const input = page.getByRole('textbox', { name: 'Instrument or sound' });
  await input.fill('piano'); await input.press('Enter');
  await page.getByText('The request could not be confirmed. Do not submit it again; ask for support.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'piano');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  assert.equal(state.posts, 1);
  assert.equal(await page.getByRole('button', { name: 'Request extraction' }).isDisabled(), true);
});
test('initial availability failure recovers through explicit status refresh', async t => {
  const { page, state } = await fixture(t, 390, 'initial-failure');
  const submit = page.getByRole('button', { name: 'Request extraction' });
  assert.equal(await submit.isDisabled(), true);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await submit.waitFor();
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
  assert.equal(state.posts, 0);
});

test('saved queued target has an explicit start action, never automatic refresh dispatch', async t => {
  const { page, state } = await fixture(t, 390);
  state.targets = [{ id: 'saved', target: 'piano', status: 'queued', needsConfirmation: false, outputAvailable: false }];
  await page.getByRole('button', { name: 'Refresh status' }).click();
  const start = page.getByRole('button', { name: 'Start saved request: piano' });
  await start.waitFor();
  assert.equal(state.posts, 0);
  await page.getByRole('textbox', { name: 'Instrument or sound' }).fill('preserve draft');
  await start.click();
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').disabled);
  await page.getByText('Extraction is being prepared. Refresh to check its status.', { exact: true }).waitFor();
  assert.equal(state.posts, 1);
  assert.equal(await page.getByRole('textbox', { name: 'Instrument or sound' }).inputValue(), 'preserve draft');
});
